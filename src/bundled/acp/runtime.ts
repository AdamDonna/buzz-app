// Turns Agents deliveries into turns in each ACP agent's own harness. An
// agent's harness runs the launch its owner confirmed; each conversation is
// one ACP session in it, and a watch or timer wake runs as a one-off session.
// The run returns once the turn is handed over. The harness acts in Buzz with
// the in-process Buzz tools over loopback HTTP MCP, signed by the agent's
// native-held key; the runtime only reports a turn that fails.
// The Buzz side (owner check, conversation context, memory, replies) follows
// the goose runtime's.
import type { Context, Memories } from "../../buzz-mcp/client";
import {
  abortable,
  READ_TIMEOUT_MS,
} from "../../features/agent-harness/core-memory";
import { respond } from "../../buzz-mcp/rpc";
import { appClient } from "../../buzz-mcp/app-client";
import {
  type AddedTool,
  addedKey,
  turnNote,
} from "../../buzz-mcp/session-tools";
import {
  AgentSessions,
  type SessionsOptions,
} from "../../features/agent-harness/acp/agent-sessions";
import { readTranscript } from "../../features/agent-harness/acp/transcript";
import { ownerCanvas, readProject } from "../../features/agent-harness/project";
import {
  FRESH,
  type Generation,
  type Mark,
  type Pick,
  type Pinned,
  type RouteMatch,
  type ServeMcp,
  type Source,
  type Spawn,
  type ToolServer,
} from "../../features/agent-harness/acp/types";
import type { Transcript } from "../../features/agents/activity-transcript";
import {
  fromOwner,
  type Agent,
  type AgentHandle,
  type Agents,
  type Delivery,
  type StandaloneTurn,
  type TurnResult,
} from "../../features/agents/service";
import { soloChat } from "../../features/agents/solo-chat";
import type { Host } from "../../features/host/service";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { threadReference } from "../../features/relay/thread-reference";
import {
  CONTEXT_LIMIT,
  type Scope,
  systemPrompt,
  turnPrompt,
} from "../claude-code/prompt";
import { standalonePrompt } from "../goose/runtime";
import { type Config, config } from "./config";
import { HarnessProcess, start } from "./harness";
import { launchKey, type ModelCache } from "./models";
import { preset } from "./presets";
import { localOwed, localSessions } from "./sessions";
import type { Conversation, SignIn } from "./tabs";

const NAMES_TIMEOUT_MS = 2_000;
const CHAT = [9, 40002];
/** No extension picks a model: the launch's args or env do. */
const HARNESS_CHOICE = Object.freeze({ provider: "", model: "" });
const LABEL = "ACP agent";
/** ACP's error code for a harness that needs its user to sign in. */
const AUTH_REQUIRED = -32000;
/** What a failed turn says in the channel. The harness's own error can carry
 * anything, secrets included, so it stays in the turn's local activity. */
const FAILED = "⚠️ I couldn't finish that. Details are in my activity.";

/** The settings a harness process is started with; a change makes a new
 * launch generation. */
const launchOf = ({ command, args, env, workspace, approval }: Config) =>
  JSON.stringify([command, args, env, workspace, approval]);

/** What a live session pins when it opens, and runs on until it closes. */
type Snap = Readonly<{
  config: Config;
  team: string;
  name?: string;
  /** The tools plugins added, as `addedKey`. */
  added: string;
}>;

/** A short, stable digest of `text`, so a saved record holds no
 * instructions or launch details (53-bit cyrb53). */
function digest(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Everything a session is opened with, so a saved one resumes only while
 * none of it changed. The launch counts by its confirmation digest, never
 * its env values. */
const contextOf = ({ config: c, team, name, added }: Snap) =>
  digest(
    JSON.stringify([
      c.approval,
      c.workspace,
      c.instructions,
      team,
      name ?? "",
      added,
      c.scope,
    ]),
  );

/** Where a message sits: its channel, its thread root, and whether the
 * channel is one conversation whatever the scope (a DM or Solo chat). */
type Place = Readonly<{ channel: string; root: string; whole: boolean }>;

/** The conversation `place` belongs to under `scope`. Only a thread key
 * names exactly one thread. */
const keyOf = (
  scope: Config["scope"],
  { channel, root, whole }: Place,
): RouteMatch =>
  whole || scope === "channel"
    ? { key: channel, exact: false }
    : { key: `${channel}/${root}`, exact: true };

type Entry = {
  sessions: AgentSessions<Snap>;
  /** The current launch generation; a launch change makes the next one. */
  generation: Generation;
  /** The agent's saved conversations on this device. */
  store: ReturnType<typeof localSessions>;
  /** The sign-in its last failed turn asked for, until a turn succeeds or
   * Recheck restarts the harness. */
  signIn?: SignIn | undefined;
  /** Whether its harness replays sessions, once a transcript read found out. */
  replays?: boolean;
  /** The agent's own harness, running its confirmed launch. */
  harness: HarnessProcess;
  config: Config;
  /** The team sections of the latest run; a change reopens idle sessions. */
  team: string;
  /** The agent's name, for its prompt; a rename reopens idle sessions. */
  name?: string;
  /** The agent's handle from its latest delivery, for the tools to act with. */
  handle?: AgentHandle;
  /** Where each session's tools default to: its current turn's thread. */
  places: WeakMap<Snap, Context>;
};

export class AcpRuntime {
  private readonly agents = new Map<string, Entry>();
  private readonly reading = new Map<string, Promise<Memories>>();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<
    string,
    ReturnType<AgentSessions["snapshot"]>
  >();
  private readonly lists = new Map<string, readonly Conversation[]>();
  private generations = 0;

  constructor(
    private readonly host: Host,
    /** The owner's connection to each agent's own community. */
    private readonly relay: (pubkey: string) => RelayData | undefined,
    /** The agent's `core` memory as the host keeps it (`Agents.core`). */
    private readonly core: Agents["core"],
    /** The tools plugins add to every session now. */
    private readonly added: () => readonly AddedTool[] = () => [],
    /** Each launch's models, fed by its sessions' option state. */
    private readonly cache?: ModelCache,
    /** Where saved conversations are kept on this device. */
    private readonly storage: Storage = globalThis.localStorage,
  ) {}

  private get spawn(): Spawn {
    const spawn = this.host.spawn?.bind(this.host);
    if (!spawn) throw new Error("ACP agents run only in the desktop app");
    return spawn;
  }
  private resolveDirectory(path: string): Promise<string> {
    if (!this.host.resolveDirectory)
      throw new Error("ACP agents run only in the desktop app");
    return this.host.resolveDirectory(path);
  }
  private readFile(path: string, cwd: string): Promise<Uint8Array> {
    if (!this.host.readFile)
      throw new Error("ACP agents run only in the desktop app");
    return this.host.readFile(path, { cwd });
  }
  private get serve(): ServeMcp {
    const serve = this.host.serveMcp?.bind(this.host);
    if (!serve) throw new Error("ACP agents run only in the desktop app");
    return serve;
  }

  /** Brings the runtime in line with this type's agents. A saved change
   * closes idle sessions and busy ones once their turn ends; a changed launch
   * starts the next generation, while a session still on the old one keeps
   * its process until it is done. Removed agents stop theirs. */
  sync(agents: readonly Agent[]) {
    const current = new Set(agents.map((agent) => agent.pubkey));
    for (const [pubkey, entry] of this.agents)
      if (!current.has(pubkey)) {
        this.stop(entry);
        this.agents.delete(pubkey);
      }
    for (const agent of agents) {
      const next = config(agent.config);
      const entry = this.agents.get(agent.pubkey);
      if (!entry) this.entry(agent.pubkey, next).name = agent.name;
      else if (
        JSON.stringify(entry.config) !== JSON.stringify(next) ||
        entry.name !== agent.name
      ) {
        if (launchOf(entry.config) !== launchOf(next))
          entry.generation = { id: ++this.generations, launch: next };
        entry.config = next;
        entry.name = agent.name;
        entry.sessions.reconfigure();
        entry.harness.reap();
      }
    }
    this.notify();
  }

  /** Conversations each agent has a session for, for its status view. */
  sessions(pubkey: string) {
    let view = this.views.get(pubkey);
    if (!view) {
      view = this.agents.get(pubkey)?.sessions.snapshot() ?? [];
      this.views.set(pubkey, view);
    }
    return view;
  }
  /** A field, so React can call it unbound. */
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify() {
    this.views.clear();
    this.lists.clear();
    for (const listener of this.listeners) listener();
  }

  dispose() {
    for (const entry of this.agents.values()) this.stop(entry);
    this.agents.clear();
  }
  private stop(entry: Entry) {
    entry.sessions.dispose();
    entry.harness.stop();
  }

  async run({
    trigger,
    agent,
    config: raw,
    channelId,
    team,
    workingUntil,
    ignored,
    signal,
    step,
    acknowledged,
    superseded,
    interruptible,
    model,
    effort,
    named,
  }: Delivery) {
    const settings = config(raw);
    // Watches and timers come as standalone turns (`runOnce`).
    if (trigger.type !== "mention") return ignored?.();
    // The harness runs commands as you; mentions need owner or delegated
    // authority.
    {
      const snapshot = this.relay(agent.pubkey)?.snapshot();
      if (
        !(await fromOwner(trigger.event, agent.owner, {
          agent: agent.pubkey,
          authority:
            snapshot?.status === "ready"
              ? snapshot.session.workflowAuthority
              : undefined,
          profiles:
            snapshot?.status === "ready"
              ? snapshot.session.profiles
              : undefined,
        }))
      ) {
        ignored?.();
        return;
      }
      signal.throwIfAborted();
    }
    const entry = this.entry(agent.pubkey, settings);
    entry.handle = agent;
    entry.team = team ?? "";
    const { event } = trigger;
    const channel =
      channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1] ?? undefined;
    if (!channel) return;
    // Frozen for the turn: its key, prompt, tools and posts all follow it.
    const topLevel = await soloChat(
      () => this.relay(agent.pubkey),
      agent.owner,
      channel,
      signal,
    );
    const place = this.place(agent.pubkey, event, channel, topLevel);
    // A live or opening session keeps the conversation it was opened for,
    // under its own pinned scope; only otherwise does today's scope decide.
    const key =
      entry.sessions.route((pinned) => keyOf(pinned.config.scope, place))
        ?.key ?? keyOf(entry.config.scope, place).key;
    const context: Context = topLevel
      ? { channel, topLevel }
      : place.whole
        ? { channel }
        : { channel, root: place.root };
    // A new session's first turn is where a harness asks to sign in.
    const first = !entry.sessions.seen(key);
    // Owed from now until a committed prompt has carried it: a turn that
    // fails, is refused or is stopped leaves it for the next prompt.
    const owed = localOwed(this.storage, agent.pubkey);
    owed.set(key, [...owed.get(key).filter((id) => id !== event.id), event.id]);
    const done = entry.sessions.deliver(key, "", event.created_at, {
      // Built when it is sent, from what the session has definitely seen.
      build: async (from, pinned) => {
        // The serving session's tools act here from now on; a replacement
        // session on the same key never moves them.
        entry.places.set(pinned, context);
        // Only a commit adds to `from`, so what it holds was delivered.
        const unpaid = owed.get(key).filter((id) => !from.ids.includes(id));
        owed.set(key, unpaid);
        if (from.ids.includes(event.id)) return undefined;
        const turn = await this.turn(
          agent.pubkey,
          event,
          channel,
          topLevel,
          key,
          from,
          unpaid,
        );
        return {
          text: this.review(
            entry,
            turnPrompt({ ...turn, agent: agent.pubkey, label: "@mention" }),
          ),
          // Only what the prompt shows counts as seen.
          through: cover(from, [...turn.context.slice(-CONTEXT_LIMIT), event]),
        };
      },
      signal,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(topLevel && named ? { named } : {}),
      activityScope: topLevel ? channel : place.root,
      ...(step ? { step } : {}),
      ...(acknowledged ? { acknowledged } : {}),
      ...(superseded ? { superseded } : {}),
    });
    // The whole error reaches the turn's local activity through `done`.
    workingUntil(done);
    interruptible?.(() => entry.sessions.interrupt(key));
    this.notify();
    void done
      .then((result) => {
        if (result.ok) entry.signIn = undefined;
        else if (result.code === AUTH_REQUIRED)
          entry.signIn = {
            methods: (result.authMethods ?? []).map(
              ({ name, description }) => ({
                name,
                ...(description ? { description } : {}),
              }),
            ),
          };
        // Of the messages one turn answered, only one has its error. A
        // delivery cancelled by its own signal says nothing; it stays owed.
        if (result.error !== undefined && !signal.aborted)
          return this.report(
            agent,
            channel,
            event,
            topLevel,
            result.hint ??
              (first && result.code === AUTH_REQUIRED
                ? preset(entry.config.preset)?.login
                : undefined),
          );
      })
      .catch((error) => console.warn("ACP agent turn failed", error))
      .finally(() => this.notify());
  }

  /** Runs a standalone turn, such as a watch's or a timer's, in a one-off
   * session that joins no conversation. Its failure goes only to the app log,
   * whole (`wake` in `agent-harness/wakes.ts`). */
  async runOnce({
    delivery,
    key,
    signal,
    prompt,
  }: StandaloneTurn): Promise<TurnResult> {
    const { agent, team } = delivery;
    const entry = this.entry(agent.pubkey, config(delivery.config));
    entry.handle = agent;
    entry.team = team ?? "";
    const done = entry.sessions.runOnce(
      key,
      async () => {
        const text = await prompt();
        return text === undefined
          ? undefined
          : standalonePrompt(agent.pubkey, text);
      },
      { signal },
    );
    this.notify();
    return done.finally(() => this.notify());
  }

  /** `text` with the Buzz tools' end-of-turn note, when they have one. */
  private review(entry: Entry, text: string) {
    const note = turnNote(entry.handle);
    return note ? `${text}\n\n${note}` : text;
  }

  /** Says in the thread that a turn failed, so nobody waits on it. */
  private report(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    topLevel: boolean,
    /** What to do about it, in words of our own: none of the harness's.
     * Signing in is asked on a new session's first turn. */
    hint?: string,
  ) {
    return this.post(
      agent,
      channel,
      event,
      hint ? `${FAILED} ${hint}` : FAILED,
      topLevel,
      [["p", agent.owner]],
    );
  }

  /** Replies as the agent in the event's thread, or at a Me chat's top
   * level. */
  private post(
    agent: AgentHandle,
    channel: string,
    event: EventData,
    content: string,
    topLevel: boolean,
    tags: string[][] = [],
  ) {
    return agent
      .publish({
        kind: 9,
        content,
        tags: [
          ["h", channel],
          ...(topLevel
            ? []
            : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ...tags,
        ],
      })
      .catch((failure) => console.warn("ACP agent could not post", failure));
  }

  /** Where a message sits, from the channel list as it is now. A Me chat is
   * one conversation, as a DM is. */
  private place(
    self: string,
    event: EventData,
    channel: string,
    topLevel: boolean,
  ): Place {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channel) ??
      session?.channels.get?.(channel);
    return {
      channel,
      root: threadReference(event)?.rootId ?? event.id,
      whole: topLevel || summary?.channelType === "dm",
    };
  }

  /** What the event's turn in conversation `key` needs for its prompt: the
   * messages after `from`, which a fresh session (`FRESH`) is shown all of. */
  private async turn(
    self: string,
    event: EventData,
    channelId: string,
    topLevel: boolean,
    key: string,
    from: Mark,
    owed: readonly string[] = [],
  ) {
    const snapshot = this.relay(self)?.snapshot();
    const session = snapshot?.status === "ready" ? snapshot.session : undefined;
    const summary =
      session?.channels.list().channels.find((item) => item.id === channelId) ??
      session?.channels.get?.(channelId);
    const dm = summary?.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    // The conversation it was admitted to, not the scope as it is now.
    const scope: Scope = key === channelId ? "channel" : "thread";
    const fresh = from.at === FRESH.at;
    // Read alongside the conversation: only a Solo chat's Canvas is handed over.
    const owner = this.agents.get(self)?.handle?.owner;
    const reading = topLevel
      ? readProject(
          session && owner
            ? () =>
                ownerCanvas(
                  session.canvas,
                  owner,
                  channelId,
                  session.channelWrites.startingCanvas(channelId),
                )
            : undefined,
        )
      : Promise.resolve(undefined);
    let earlier: readonly EventData[] = [];
    const window = thread || dm || topLevel;
    const inRoot = (item: EventData) =>
      item.id === rootId ||
      item.tags.some(([name, value]) => name === "e" && value === rootId);
    if (session && (window || owed.length))
      try {
        const inThread = thread && !topLevel;
        const events = await session.read(
          [
            ...(!window
              ? []
              : inThread
                ? [
                    { ids: [rootId], limit: 1 },
                    {
                      kinds: CHAT,
                      "#h": [channelId],
                      "#e": [rootId],
                      limit: 200,
                    },
                  ]
                : [
                    {
                      kinds: CHAT,
                      "#h": [channelId],
                      limit: CONTEXT_LIMIT + 1,
                    },
                  ]),
            // Owed messages by id, however far back the window has moved.
            ...(owed.length
              ? [{ ids: [...owed], "#h": [channelId], limit: owed.length }]
              : []),
          ],
          { signal: AbortSignal.timeout(NAMES_TIMEOUT_MS * 2) },
        );
        const seen = new Set<string>();
        earlier = events
          .filter(
            (item) =>
              !seen.has(item.id) &&
              seen.add(item.id) &&
              CHAT.includes(item.kind) &&
              item.tags.some(
                ([name, value]) => name === "h" && value === channelId,
              ) &&
              // Owed messages follow the conversation's scope, not the trigger's.
              (owed.includes(item.id)
                ? scope !== "thread" || inRoot(item)
                : !inThread || inRoot(item)) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        console.warn("ACP agent could not read the conversation", error);
      }
    // A session already has its own replies; a new one is shown them too.
    const candidates = earlier.filter(
      (item) =>
        (item.created_at >= from.at || owed.includes(item.id)) &&
        !from.ids.includes(item.id) &&
        (fresh || item.pubkey !== self),
    );
    // Owed messages come first; the newest others fill what is left.
    const others = candidates.filter((item) => !owed.includes(item.id));
    const room = CONTEXT_LIMIT - (candidates.length - others.length);
    const recent = new Set(room > 0 ? others.slice(-room) : []);
    const unseen = candidates.filter(
      (item) => owed.includes(item.id) || recent.has(item),
    );
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags
          .filter((tag) => tag[0] === "p")
          .map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    if (session)
      await Promise.race([
        session.profiles.ensure(pubkeys, "foreground").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, NAMES_TIMEOUT_MS)),
      ]);
    const members = summary?.members ?? [];
    const project = (await reading)?.section;
    return {
      key,
      event,
      scope,
      topLevel,
      channel: {
        id: channelId,
        ...(summary?.name ? { name: summary.name } : {}),
        dm,
      },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) =>
        session?.names.resolve(pubkey, undefined, members) ??
        session?.profiles.snapshot().get(pubkey)?.name ??
        undefined,
      ...(project ? { project } : {}),
    };
  }

  /** The agent's entry, made from `initial` if it has none. */
  private entry(pubkey: string, initial: Config): Entry {
    const existing = this.agents.get(pubkey);
    if (existing) return existing;
    const entry: Entry = {
      config: initial,
      team: "",
      generation: { id: ++this.generations, launch: initial },
      store: localSessions(this.storage, pubkey),
      sessions: undefined as unknown as AgentSessions<Snap>,
      harness: new HarnessProcess(
        (id, options) => this.spawn(id, options),
        (handler) => this.serve(handler),
        () => entry.generation,
      ),
      places: new WeakMap(),
    };
    // Every session of the agent shares them, so they read the handle as it is
    // when called, and the place and workspace of the serving session.
    const tools: ToolServer = async (_conversation, message, pinned) => {
      const handle = entry.handle;
      const workspace =
        (pinned as Snap | undefined)?.config.workspace ??
        entry.config.workspace;
      const client = handle && {
        ...appClient(handle, {
          relayAuthor: this.relay(pubkey)?.snapshot().session.relayAuthor,
          signingAuthority:
            this.relay(pubkey)?.snapshot().session.workflowAuthority,
          read: (path) => this.readFile(path, workspace),
          memories: (slug) => this.memories(pubkey, slug),
        }),
        remember: async (slug: string, body: string, after: number) => {
          await handle.remember(slug, body, after);
          this.forgetMemories(pubkey);
        },
      };
      const context = (pinned && entry.places.get(pinned as Snap)) || {};
      return respond(client, context, message, this.added());
    };
    const snap = (): Snap => ({
      config: entry.config,
      team: entry.team,
      ...(entry.name ? { name: entry.name } : {}),
      added: addedKey(this.added()),
    });
    const launchFor = async ({ config: c, team, name }: Snap) => {
      const memory = await this.core(pubkey);
      return {
        workspace: c.workspace,
        systemPrompt: systemPrompt({
          scope: c.scope,
          cwd: c.workspace,
          ...(name ? { agent: { name, pubkey } } : {}),
          instructions: c.instructions,
          team,
          ...(memory === undefined ? {} : { memory }),
        }),
      };
    };
    const options: SessionsOptions<Snap> = {
      label: LABEL,
      resolveDirectory: (path) => this.resolveDirectory(path),
      tools,
      process: entry.harness,
      store: entry.store,
      onChange: () => this.notify(),
      resume: true,
      configOptions: true,
      // Each session runs on the settings it opened with. Only a saved change
      // (a new `localKey`) closes it; a new launch is a new generation.
      pin: (): Pinned<Snap> => {
        const snapshot = snap();
        return {
          snapshot,
          context: contextOf(snapshot),
          localKey: JSON.stringify([
            snapshot.config,
            snapshot.team,
            snapshot.name,
            snapshot.added,
          ]),
          generation: entry.generation,
        };
      },
      launchFor,
      pickFor: (pinned, override) => pickFor(pinned.config, override),
      onState: (state, pinned) => {
        const key = launchKey(pinned.config);
        if (key) this.cache?.record(key, state);
      },
      // Unused with `pin`, which replaces them for every session.
      choice: () => HARNESS_CHOICE,
      fingerprint: () => contextOf(snap()),
      launch: () => launchFor(snap()),
    };
    entry.sessions = new AgentSessions<Snap>(options);
    this.agents.set(pubkey, entry);
    return entry;
  }

  /** Whether the agent's last turn asked its owner to sign in. */
  signIn(pubkey: string) {
    return this.agents.get(pubkey)?.signIn;
  }

  /** Restarts the agent's harness after its owner signed in; the error, if
   * it still can't start. */
  async recheck(pubkey: string): Promise<string | undefined> {
    const entry = this.agents.get(pubkey);
    if (!entry) return "This agent isn't running.";
    const result = await entry.sessions.reconnect();
    if (result.ok) entry.signIn = undefined;
    this.notify();
    return result.ok ? undefined : (result.error ?? "The harness didn't start");
  }

  /** The agent's conversations on this device, most recent first, with the
   * live ones' status. */
  conversations(pubkey: string): readonly Conversation[] {
    let list = this.lists.get(pubkey);
    if (list) return list;
    const entry = this.agents.get(pubkey);
    const live = new Map(this.sessions(pubkey).map((view) => [view.key, view]));
    const saved = new Map(
      (entry?.store ?? localSessions(this.storage, pubkey)).list(),
    );
    const keys = new Set([...saved.keys(), ...live.keys()]);
    list = [...keys]
      .flatMap((key): Conversation[] => {
        const view = live.get(key);
        const at = view?.at ?? saved.get(key)?.at;
        // A one-off turn joins no conversation.
        if (at === undefined) return [];
        const [channelId = key, root] = key.split("/");
        return [
          {
            key,
            channelId,
            ...(root ? { root } : {}),
            at,
            ...(view ? { status: view.busy ? "Working" : "Idle" } : {}),
            replayable: Boolean(saved.get(key)?.id),
          },
        ];
      })
      .sort((a, b) => b.at - a.at);
    this.lists.set(pubkey, list);
    return list;
  }

  replays(pubkey: string) {
    return this.agents.get(pubkey)?.replays;
  }

  /** A saved conversation's transcript, replayed by a short-lived harness
   * process on the current launch; undefined if the harness can't. */
  async transcript(
    pubkey: string,
    key: string,
    signal: AbortSignal,
  ): Promise<Transcript | undefined> {
    const entry = this.agents.get(pubkey);
    const sessionId = entry?.store.load(key)?.id;
    if (!entry || !sessionId) return undefined;
    const launch = entry.config;
    const cwd = await this.resolveDirectory(launch.workspace);
    const [, root] = key.split("/");
    const transcript = await readTranscript({
      start: (o) => start(this.spawn, launch, o),
      cwd,
      sessionId,
      signal,
      threadOf: (prefix) => root ?? threadIn(prefix),
    });
    entry.replays = transcript !== undefined;
    this.notify();
    return transcript;
  }

  /** The agent's memory, or only entry `slug`, read back through the owner's
   * session: it is encrypted to the owner, so no agent key is needed. */
  private memories(pubkey: string, slug?: string): Promise<Memories> {
    const key = `${pubkey}\0${slug ?? ""}`;
    let reading = this.reading.get(key);
    if (!reading) {
      const started = this.readMemories(pubkey, slug).finally(() => {
        if (this.reading.get(key) === started) this.reading.delete(key);
      });
      this.reading.set(key, started);
      reading = started;
    }
    // The shared read keeps its own bound, so a caller that stops waiting
    // sooner cannot cut it short for the others.
    return abortable(reading, AbortSignal.timeout(READ_TIMEOUT_MS));
  }
  /** After a memory write, a read that may have started before it is not
   * shared with later callers. */
  private forgetMemories(pubkey: string) {
    for (const key of this.reading.keys())
      if (key.startsWith(`${pubkey}\0`)) this.reading.delete(key);
  }
  private async readMemories(pubkey: string, slug?: string): Promise<Memories> {
    const snapshot = this.relay(pubkey)?.snapshot();
    if (snapshot?.status !== "ready") throw new Error("Buzz is not connected");
    return snapshot.session.agentMemories.read(
      pubkey,
      AbortSignal.timeout(READ_TIMEOUT_MS),
      slug,
    );
  }
}

/** Newest event ids a mark remembers; an id that falls out can only repeat. */
const COVERED_IDS = 256;

/** `from` plus the events a prompt carried: identities, not just seconds, so
 * a distinct message in a covered second, or a late older one, still goes. */
export function cover(from: Mark, carried: readonly EventData[]): Mark {
  const added = new Set(carried.map((item) => item.id));
  return {
    at: Math.max(from.at, ...carried.map((item) => item.created_at)),
    ids: [...from.ids.filter((id) => !added.has(id)), ...added].slice(
      -COVERED_IDS,
    ),
  };
}

/** A turn's pick: the message's own fields win, and the rest come from the
 * session's pinned settings. Nothing syncs yet, so pinned fields are this
 * device's. */
export function pickFor(
  pinned: Config,
  override: Pick | undefined,
): Readonly<{ pick: Pick; source: Source }> {
  const field = (name: "model" | "effort") => {
    const own = override?.[name];
    if (own !== undefined) return { value: own, source: "message" as const };
    const value = pinned[name];
    return value ? { value, source: "device" as const } : undefined;
  };
  const model = field("model");
  const effort = field("effort");
  return {
    pick: {
      ...(model?.value ? { model: model.value } : {}),
      ...(effort?.value ? { effort: effort.value } : {}),
    },
    source: {
      ...(model ? { model: model.source } : {}),
      ...(effort ? { effort: effort.source } : {}),
    },
  };
}

/** The thread a channel-scoped turn replied in, from the reply instruction
 * its prompt carries; undefined when it names none. */
export const threadIn = (prompt: string) =>
  /pass `reply: "([0-9a-f]{64})"`/.exec(prompt)?.[1];
