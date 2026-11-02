// One agent's sessions in an ACP harness: one ACP session per conversation (a
// thread, a whole DM, or a channel), in the process its source gives. A quiet
// conversation's session is closed; its next message opens a new one, shown
// the conversation again. A one-off turn (a watch or timer wake) gets a
// session of its own, closed when it ends. Every session holds one of the
// host's MCP servers, in one pool every ACP plugin's agents share, and the
// least recently used idle session closes to make room, whichever plugin's.
// Sessions live as long as the app does; only when each conversation last used
// one is saved, so its sessions stay listed after they close.
import { absoluteWorkspace } from "../../../bundled/codex/config";
import type { SessionAction } from "../../agents/service";
import { offers } from "./options";
import type { AcpProcess } from "./process";
import type { AcpSession, Parity, Turn } from "./session";
import { codeOf, HintedError } from "./steps";
import {
  type ActivityReceipt,
  type BuildPrompt,
  type Choice,
  FRESH,
  type Generation,
  type Mark,
  type OptionState,
  type Overridden,
  type Pick,
  type Pinned,
  type ResolveDirectory,
  type RouteMatch,
  type Settled,
  type Source,
  type ToolServer,
} from "./types";

/** A conversation's session closes after this long without a message. */
export const IDLE_MS = 15 * 60_000;
/** The most MCP servers the pool's sessions hold at once, below the host's 64
 * for every plugin, so plugins not on this client keep room. */
export const POOL_LIMIT = 48;

/** What is saved for one conversation: when its session last took in a
 * message or ended a turn, and, once a prompt in it succeeded, how to resume
 * it. */
export type SavedConversation = Readonly<{
  at: number;
  /** The harness's session id. */
  id?: string;
  /** What the harness definitely received; a number from older records. */
  covered?: Mark | number;
  /** The pinned `context` it was opened with. */
  context?: string;
  overridden?: Overridden;
}>;
/** A saved `covered`; an older record's bare second covers no ids. */
function markOf(covered: Mark | number | undefined): Mark {
  if (typeof covered === "number") return { at: covered, ids: [] };
  return covered ?? FRESH;
}

export type SessionStore = {
  set(key: string, saved: SavedConversation): void;
  load?(key: string): SavedConversation | undefined;
  /** Updates `at` only, keeping the rest. Used instead of `set` when given. */
  touch?(key: string, at: number): void;
  /** A prompt succeeded: the first writes every field, later ones `covered`. */
  advance?(
    key: string,
    commit: Readonly<{
      id: string;
      covered: Mark;
      context: string;
      overridden: Overridden;
    }>,
  ): void;
  drop?(key: string): void;
};

/** Where a pinned session's process comes from. */
export type ProcessSource = Readonly<{
  /** Without an argument, the process sessions open in now. With one, a
   * process started from exactly that generation's launch. */
  get(generation?: Generation): Promise<AcpProcess>;
  /** Keeps a generation's process alive until released; release is
   * idempotent. A process stops only once no hold on it remains. */
  hold?(generation: Generation): Readonly<{ release(): void }>;
  /** Stops the current process and starts it again from the confirmed
   * launch, read afresh: after the owner signs in. */
  restart?(o: RestartOptions): Promise<Settled>;
}>;
export type RestartOptions = Readonly<{
  signal?: AbortSignal;
  /** 30s by default, for every try together. */
  deadlineMs?: number;
  /** 3 by default. */
  tries?: number;
  /** 1s by default, doubling. */
  backoffMs?: number;
}>;

/** A session's hold on one MCP server in the pool. */
export type Slot = {
  /** Whether it can be closed to make room: no turn runs in it. */
  idle(): boolean;
  /** Closes the session, and resolves once its server has stopped. */
  evict(): Promise<unknown>;
};

/** The MCP servers agents' sessions hold, least recently used first. */
export class ServerPool {
  private readonly slots = new Set<Slot>();
  constructor(private readonly limit = POOL_LIMIT) {}

  get size() {
    return this.slots.size;
  }
  /** Holds a server for `slot`, first closing idle sessions to keep below the
   * limit. Busy ones are never closed, so it can go over. Resolves once the
   * closed sessions' servers have stopped: the host counts them until then. */
  take(slot: Slot) {
    const evicted: Promise<unknown>[] = [];
    while (this.slots.size >= this.limit) {
      const stopped = this.evict();
      if (!stopped) break;
      evicted.push(stopped);
    }
    this.slots.add(slot);
    return Promise.all(evicted);
  }
  /** Marks `slot` as used now. */
  touch(slot: Slot) {
    if (this.slots.delete(slot)) this.slots.add(slot);
  }
  release(slot: Slot) {
    this.slots.delete(slot);
  }
  /** Closes the least recently used idle session, and resolves once its
   * server has stopped; undefined when every session is busy. */
  evict() {
    for (const slot of this.slots)
      if (slot.idle()) {
        this.slots.delete(slot);
        return slot.evict();
      }
    return undefined;
  }
}

/** The pool every ACP plugin's sessions share. */
export const SHARED_POOL = new ServerPool();

/** What a session is opened with. */
export type Launch = Readonly<{
  /** The agent's working directory, absolute or `~/…`. */
  workspace: string;
  systemPrompt: string;
}>;

export type SessionsOptions<S = unknown> = Readonly<{
  /** Names the harness in errors. */
  label: string;
  /** The host's, for the workspace's absolute path. */
  resolveDirectory: ResolveDirectory;
  /** Answers the agent's Buzz tools. */
  tools: ToolServer;
  /** The process its sessions open in, started when needed. */
  process: ProcessSource;
  /** The servers its sessions hold: the shared pool unless given. */
  pool?: ServerPool;
  /** The agent's current settings, for a new session. */
  launch(): Promise<Launch>;
  /** The agent's provider, model and thinking level now, which each new
   * turn runs on. */
  choice(): Choice;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  /** Where each conversation's last use is saved. */
  store?: SessionStore;
  /** Called when a conversation's session opens, is sent a message, or
   * closes. */
  onChange?(): void;
  /** Opt-in: an opening conversation resumes its saved record, through
   * `store.load`, when its `context` matches the pinned one. */
  resume?: true;
  /** Opt-in: picks go through ACP `session/set_config_option`, in place of
   * `hooks.select`, and a field Buzz set reopens fresh for the default. */
  configOptions?: true;
  /** Opt-in: each session pins its settings once, which then replace
   * `fingerprint`, `launch` and `choice` for it. */
  pin?(): Pinned<S>;
  launchFor?(pinned: S): Promise<Launch>;
  /** A turn's pick from the pinned snapshot and the message's own. */
  pickFor?(
    pinned: S,
    override: Pick | undefined,
  ): Readonly<{ pick: Pick; source: Source }>;
  /** Why a turn may not run on `pick`, checked before its prompt. */
  refuse?(state: OptionState, pick: Pick, source: Source): string | undefined;
  /** Every live option-state replacement for a launch, never during replay. */
  onState?(state: OptionState, pinned: S): void;
}>;

/** A conversation's current owner, with `pin`: the live or opening session
 * that alone may write its record. A retired one is no longer in `claims`. */
type Claim<S> = Readonly<{ epoch: number; pinned: Pinned<S> }>;
type Lease = Readonly<{ release(): void }>;

type Live = {
  session: AcpSession;
  process: AcpProcess;
  fingerprint: string;
  slot: Slot;
  claim?: Claim<unknown>;
  /** Its hold on its generation's process, released when it closes. */
  lease?: Lease;
  /** When it last took in a message or ended a turn. */
  at: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Opened = Promise<{ live: Live; settled?: Promise<Settled> }>;

export class AgentSessions<S = unknown> {
  /** The processes its sessions opened in, whose exit drops them. */
  private readonly watched = new WeakSet<AcpProcess>();
  /** With `pin`: each conversation's current owner. */
  private readonly claims = new Map<string, Claim<S>>();
  private epochs = 0;
  private readonly live = new Map<string, Live>();
  /** One-off turns running or starting, by label. */
  private readonly once = new Map<string, Live | undefined>();
  private onceCount = 0;
  /** Conversations whose session is opening, and the turn it opened for. */
  /** Messages waiting, in arrival order, for a turn ahead to free their
   * conversation's session. Stop clears them. */
  private readonly lines = new Map<
    string,
    { tail: Promise<void>; stop: AbortController; waiting: number }
  >();
  private readonly opening = new Map<string, Opened>();
  /** created_at of the newest event each conversation's session was shown. */
  private readonly shown = new Map<string, number>();
  /** With `pin`: retired sessions still opening or mid-turn, by conversation,
   * which Stop still reaches until they close. */
  private readonly retired = new Map<string, Set<Opened | Live>>();
  /** Conversations that have had a session, whose next new one may have been
   * prompted for the old one. */
  private readonly had = new Set<string>();
  private disposed = false;

  private readonly stopped: Settled;
  private readonly late: Settled;

  constructor(private readonly options: SessionsOptions<S>) {
    this.stopped = { ok: false, error: `${options.label} was stopped` };
    this.late = {
      ok: false,
      error: `${options.label} did not start in time`,
      undelivered: true,
    };
  }

  /** What this conversation's session has been shown. */
  seen(key: string) {
    const live = this.live.get(key);
    if (live?.claim) return live.session.covered.at;
    return this.shown.get(key) ?? 0;
  }
  active(key: string) {
    return this.opening.has(key) || !!this.live.get(key)?.session.working;
  }
  /** Conversations with a session, whether each is working, and when each
   * last took in a message or ended a turn. */
  snapshot(): {
    key: string;
    busy: boolean;
    sessionId?: string;
    at?: number;
  }[] {
    return [
      ...[...this.live].map(([key, live]) => ({
        key,
        busy: live.session.busy,
        sessionId: live.session.id,
        at: live.at,
      })),
      ...[...this.once.keys()].map((key) => ({ key, busy: true })),
    ];
  }

  /** Sends `text` into the conversation `key`, and resolves when the session
   * has answered it. `steer` replaces `text` when the session is mid-turn;
   * `fresh` builds it again when the session it was built for was closed;
   * `title` names a session opened for it, except that the conversation's
   * first one is left for the harness to name, if it names sessions, when `named`
   * takes that name;
   * `model`, one of the agent's
   * provider's, and `effort`, one of its thinking levels, are what its turn
   * runs on, and `kept`, a synced level, one it must run on. Once `signal` aborts, it stops
   * waiting for a session to open, which is then kept for the next message,
   * and sends nothing. */
  async deliver(
    key: string,
    text: string,
    seen: number,
    {
      steer = text,
      current,
      fresh,
      title,
      named,
      signal,
      model,
      effort,
      kept,
      build,
      ...activity
    }: Readonly<{
      /** With `pin`: builds the turn's prompt when it is sent, from the
       * session's boundary, in place of `text`. */
      build?: BuildPrompt<S>;
      steer?: string;
      current?: () => boolean;
      fresh?: () => Promise<string>;
      title?: string;
      named?: (title: string) => void;
      signal?: AbortSignal;
      model?: string;
      effort?: string;
      kept?: string;
    }> &
      ActivityReceipt = {},
  ): Promise<Settled> {
    // Once taken, this message's place in line, left as it is admitted.
    let place: ReturnType<typeof this.join> | undefined;
    try {
      for (;;) {
        if (current && !current()) return { ok: true, undelivered: true };
        if (this.disposed) return { ...this.stopped, undelivered: true };
        if (!place && this.lines.has(key)) {
          place = this.join(key);
          const left = await this.wait(place.ahead, place.stop, signal);
          if (left) return left;
          continue;
        }
        // A message that arrives while its conversation's session opens uses it.
        const opening = this.opening.get(key);
        if (opening) {
          // The session stays shared; only this message gives up on it.
          try {
            await abortable(
              opening.catch(() => undefined),
              signal,
            );
          } catch {
            return this.late;
          }
          continue;
        }
        const live = this.live.get(key);
        if (!live) break;
        // A pinned session opened before a local save takes no new message.
        if (live.claim && this.stale(live)) {
          this.retire(key);
          break;
        }
        const turn = this.turn(live.claim, model, effort, build);
        // A turn on a harness default runs only on a session Buzz never moved
        // off it, which a turn still ahead of it may yet do: decide when it can
        // run.
        if (live.session.busy && this.waits(live.session, turn)) {
          place ??= this.join(key);
          const left = await this.wait(live.session.idle(), place.stop, signal);
          if (left) return left;
          continue;
        }
        if (
          !live.session.open ||
          (!live.session.busy &&
            (this.stale(live) ||
              this.leveled(live, effort) ||
              !this.fits(live.session, turn)))
        ) {
          if (live.session.open && live.claim) this.forget(key, live.claim);
          this.drop(key, live);
          break;
        }
        return this.answer(
          key,
          live,
          seen,
          live.session.busy ? steer : text,
          { ...activity, ...(current ? { current } : {}) },
          turn.model,
          turn.effort,
          kept,
          turn,
        );
      }
    } finally {
      // Admitted, or gone: what arrived behind it may go on. Nothing is
      // awaited before a session opening for it is reserved.
      place?.leave();
    }
    // Pinned, owned and leased before anything is awaited.
    const pinned = this.options.pin?.();
    const claim = pinned && { epoch: ++this.epochs, pinned };
    if (claim) this.claims.set(key, claim);
    const lease = pinned && this.options.process.hold?.(pinned.generation);
    const turn = this.turn(claim, model, effort, build);
    // Reserved before anything is awaited, so a message that comes meanwhile
    // waits for this session instead of opening another.
    const starting = (async () => {
      const first = !this.had.has(key);
      // Perhaps built for a session closed since, which had been shown the rest.
      if (!first && fresh) text = await fresh();
      // Naming costs a model call: the harness names only the conversation's start.
      const naming = first ? named : undefined;
      let live: Live;
      try {
        live = await this.open(
          key,
          title,
          (live) => this.disposed || this.adopt(key, live),
          naming,
          claim && { claim, fits: (session) => this.fits(session, turn) },
        );
      } catch (error) {
        lease?.release();
        if (claim && this.claims.get(key) === claim) this.claims.delete(key);
        throw error;
      }
      if (lease) live.lease = lease;
      if (this.disposed) {
        void this.close(live);
        throw new Error(`${this.options.label} was stopped`);
      }
      // Retired while it opened: it serves only its own message, then closes.
      const orphan = !!claim && this.live.get(key) !== live;
      const closeOrphan = () => {
        if (orphan)
          this.hold(
            key,
            live,
            live.session.idle().then(() => this.close(live)),
          );
      };
      if (signal?.aborted) {
        closeOrphan();
        return { live };
      }
      if (current && !current()) {
        closeOrphan();
        return {
          settled: Promise.resolve({ ok: true, undelivered: true } as Settled),
          live,
        };
      }
      const refresh = activity.refresh;
      const settled = this.answer(
        key,
        live,
        seen,
        text,
        {
          ...activity,
          ...(current ? { current } : {}),
          ...(refresh
            ? {
                refresh: () => refresh(!first),
              }
            : {}),
        },
        turn.model,
        turn.effort,
        kept,
        turn,
      );
      closeOrphan();
      return { settled, live };
    })();
    this.opening.set(key, starting);
    const opened = () => {
      if (this.opening.get(key) === starting) this.opening.delete(key);
    };
    starting.then(opened, opened);
    // Every failure here comes before a turn takes the message in.
    let started: Awaited<typeof starting>;
    try {
      started = await abortable(starting, signal);
    } catch (error) {
      if (this.disposed) return { ...this.stopped, undelivered: true };
      if (signal?.aborted) return this.late;
      console.warn(`${this.options.label} could not start`, error);
      const code = codeOf(error);
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
        ...(code === undefined ? {} : { code }),
        undelivered: true,
        ...(error instanceof HintedError ? { hint: error.hint } : {}),
      };
    }
    return started.settled ?? this.late;
  }

  /** Stops the turn running in conversation `key`, if any, once a session
   * opening for it has taken its message. */
  async interrupt(key: string) {
    this.lines.get(key)?.stop.abort();
    this.lines.delete(key);
    const stopped = new Set<Live>();
    const stop = (item?: Promise<unknown> | Live) => {
      if (item && !(item instanceof Promise) && !stopped.has(item)) {
        stopped.add(item);
        item.session.interrupt();
      }
    };
    const retired = [...(this.retired.get(key) ?? [])];
    for (const item of [this.live.get(key), ...retired]) stop(item);
    // An opening stops only the session it produced, never a later one.
    await Promise.all(
      [this.opening.get(key), ...retired].map((item) =>
        item instanceof Promise
          ? item.catch(() => null).then((o) => stop(o?.live))
          : item,
      ),
    );
  }
  /** Includes the model call after a final send has answered the turn. */
  async idle(key: string) {
    await this.opening.get(key)?.catch(() => undefined);
    await this.live.get(key)?.session.idle();
  }
  /** Waits for the conversation's session to finish its work, then compacts
   * it or closes it, so the message opens a new one. Without an open session
   * there is nothing to do. */
  async reset(key: string, action: SessionAction): Promise<Settled> {
    const live = this.live.get(key);
    if (!live?.session.open) return { ok: true };
    await live.session.idle();
    if (this.disposed) return this.stopped;
    if (this.live.get(key) !== live || !live.session.open) return { ok: true };
    if (action === "new") {
      // Or the next message would resume the session the owner just left.
      if (live.claim && this.options.resume) this.forget(key, live.claim);
      this.drop(key, live);
      return { ok: true };
    }
    const result = await this.answer(
      key,
      live,
      this.seen(key),
      "/compact",
      {},
      undefined,
    );
    // goose ends the turn either way, and says which in its text.
    if (!result.ok || result.text === "Compaction complete") return result;
    return {
      ok: false,
      error:
        result.text || `${this.options.label} could not compact the session`,
    };
  }

  /** Runs one turn in a new session, then closes it. `label` names it in the
   * snapshot. It gives up, and stops the turn, once `signal` aborts.
   * `prompt` is asked for the turn's text once the session is open, so a turn
   * that should no longer run by then returns undefined and sends nothing. */
  async runOnce(
    label: string,
    prompt: () => string | undefined | Promise<string | undefined>,
    {
      signal,
      title,
      current,
      kept,
    }: Readonly<{
      signal?: AbortSignal;
      current?: () => boolean;
      title?: string;
      kept?: string;
    }> = {},
  ): Promise<Settled> {
    if (this.disposed) return this.stopped;
    const key = `${label} #${++this.onceCount}`;
    this.once.set(key, undefined);
    this.options.onChange?.();
    // Pinned like a conversation's, but never an owner: it saves nothing.
    const pinned = this.options.pin?.();
    const lease = pinned && this.options.process.hold?.(pinned.generation);
    const opening = this.open(
      key,
      title,
      (live) => {
        if (lease) live.lease = lease;
        return this.once.has(key) && this.once.set(key, live);
      },
      undefined,
      pinned && { claim: { epoch: 0, pinned }, fits: () => true },
    );
    opening.catch(() => lease?.release());
    let live: Live | undefined;
    try {
      live = await abortable(opening, signal);
      if (this.disposed) return this.stopped;
      const text = await abortable(Promise.resolve(prompt()), signal);
      if (text === undefined || this.disposed) return { ok: true };
      return await abortable(
        live.session.send(
          text,
          { ...(current ? { current } : {}) },
          undefined,
          undefined,
          kept,
        ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) return { ok: false, error: message(signal.reason) };
      console.warn(
        `${this.options.label} could not start a one-off session`,
        error,
      );
      return {
        ok: false,
        error: `${this.options.label} could not start: ${message(error)}`,
      };
    } finally {
      this.once.delete(key);
      // One that opens after the turn was given up is closed once it has.
      if (live) await this.close(live);
      else void opening.then((late) => this.close(late)).catch(() => undefined);
      this.options.onChange?.();
    }
  }

  /** Closes idle sessions opened with old settings; busy ones close when they
   * next fall idle. With `pin`, every session pinned before a local save is
   * retired at once, opening and busy ones included. */
  reconfigure() {
    if (this.options.pin) {
      const { localKey } = this.options.pin();
      for (const [key, claim] of [...this.claims])
        if (claim.pinned.localKey !== localKey) this.retire(key);
      return;
    }
    for (const [key, live] of this.live)
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
  }

  /** With `pin`: the live or opening route a message belongs to, under each
   * route's own pinned scope. Retired routes never match, an exact thread
   * route beats a channel route, and the newest wins a tie. */
  route(
    match: (pinned: S) => RouteMatch | undefined,
  ): Readonly<{ key: string; pinned: Pinned<S> }> | undefined {
    let best: { key: string; exact: boolean; claim: Claim<S> } | undefined;
    for (const [key, claim] of this.claims) {
      const found = match(claim.pinned.snapshot);
      // A route answers only for its own conversation.
      if (found?.key !== key) continue;
      if (
        !best ||
        (found.exact && !best.exact) ||
        (found.exact === best.exact && claim.epoch > best.claim.epoch)
      )
        best = { key, exact: found.exact, claim };
    }
    return best && { key: best.key, pinned: best.claim.pinned };
  }
  /** With `pin`: retires every session, even when the settings are unchanged;
   * the next message opens on the plugin's current generation. Busy and
   * opening ones finish their own turn first. */
  restart(): void {
    for (const key of [...this.claims.keys()]) this.retire(key);
  }
  /** After sign-in: fails live sessions, keeping their records, and restarts
   * the process through `process.restart`. */
  async reconnect(o: RestartOptions = {}): Promise<Settled> {
    const { process } = this.options;
    if (!process.restart)
      return { ok: false, error: "Restart isn't available for this agent" };
    for (const [key, live] of [...this.live]) {
      live.session.fail("Restarting after sign-in");
      this.drop(key, live);
    }
    return process.restart(o);
  }

  /** Closes its sessions, ending their turns; the process keeps serving other
   * agents. */
  dispose() {
    this.disposed = true;
    this.claims.clear();
    for (const [key, live] of this.live) this.drop(key, live);
    for (const live of this.once.values()) if (live) void this.close(live);
  }

  private get pool() {
    return this.options.pool ?? SHARED_POOL;
  }

  /** Opened with old settings, which only a new session runs on. */
  private stale(live: Live) {
    const { pin } = this.options;
    if (live.claim && pin) return live.claim.pinned.localKey !== pin().localKey;
    return live.fingerprint !== this.options.fingerprint();
  }
  /** A turn's model, effort and their sources: from its session's pinned
   * snapshot and the message's own pick when it pins. */
  private turn(
    claim: Claim<unknown> | undefined,
    model: string | undefined,
    effort: string | undefined,
    build: BuildPrompt<S> | undefined,
  ): Turn & Pick {
    const own = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    const { pickFor } = this.options;
    const picked =
      claim && pickFor
        ? pickFor(claim.pinned.snapshot as S, model || effort ? own : undefined)
        : { pick: own, source: {} };
    return {
      ...picked.pick,
      source: picked.source,
      ...(build ? { build: build as BuildPrompt<never> } : {}),
    };
  }
  /** Whether a session can take a turn on `pick`, with `configOptions`: only
   * a new session goes back to a default Buzz overrode, and a resumed one
   * reopens new when the pick is no longer offered. */
  private fits(session: AcpSession, pick: Pick) {
    if (!this.options.configOptions) return true;
    return (["model", "effort"] as const).every((field) => {
      const value = pick[field];
      if (!value) return !session.overridden[field];
      const control = session.state[field];
      return !session.resumed || !control || offers(control, value);
    });
  }
  /** With `configOptions`, whether `pick` leaves a field on its default that
   * the session is on, or a turn ahead of it moves, off its default. */
  /** Takes the last place in `key`'s line: `ahead` resolves at its head. */
  private join(key: string) {
    let line = this.lines.get(key);
    if (!line) {
      line = {
        tail: Promise.resolve(),
        stop: new AbortController(),
        waiting: 0,
      };
      this.lines.set(key, line);
    }
    const joined = line;
    const ahead = joined.tail;
    let pass!: () => void;
    joined.tail = new Promise<void>((resolve) => (pass = resolve));
    joined.waiting++;
    let left = false;
    return {
      ahead,
      stop: joined.stop.signal,
      leave: () => {
        if (left) return;
        left = true;
        // One that leaves early lets those behind it go only after those
        // ahead of it.
        void ahead.then(pass);
        // Stop reaches the line while anyone is still in it.
        if (--joined.waiting === 0 && this.lines.get(key) === joined)
          this.lines.delete(key);
      },
    };
  }

  /** Waits in line for `work`: a result once Stop or `signal` ends it. */
  private async wait(
    work: Promise<unknown>,
    stop: AbortSignal,
    signal?: AbortSignal,
  ): Promise<Settled | undefined> {
    try {
      await abortable(abortable(work, signal), stop);
    } catch {
      return stop.aborted ? { ok: true, stopped: true } : this.late;
    }
  }

  private waits(session: AcpSession, pick: Pick) {
    if (!this.options.configOptions) return false;
    return (["model", "effort"] as const).some(
      (field) =>
        !pick[field] && (session.overridden[field] || session.sets(field)),
    );
  }
  /** Drops `key`'s saved record, only while `claim` owns it. */
  private forget(key: string, claim: Claim<unknown>) {
    if (this.claims.get(key) === claim) this.options.store?.drop?.(key);
  }
  /** Takes `key` from its owner: it takes no new message and writes nothing.
   * Its record stays only when its session is open and idle; one still
   * opening or mid-turn may yet use it, so the next owner must not. */
  private retire(key: string) {
    const live = this.live.get(key);
    const opening = this.opening.get(key);
    this.claims.delete(key);
    if (opening) this.hold(key, opening, opening);
    if (this.opening.delete(key) || live?.session.working)
      this.options.store?.drop?.(key);
    if (!live) return;
    clearTimeout(live.timer);
    this.live.delete(key);
    this.shown.delete(key);
    this.options.onChange?.();
    const closed = live.session.idle().then(() => this.close(live));
    this.hold(key, live, closed);
  }
  /** Keeps `item` reachable by Stop for `key` until `done` settles. */
  private hold(key: string, item: Opened | Live, done: Promise<unknown>) {
    const held = this.retired.get(key) ?? new Set();
    this.retired.set(key, held.add(item));
    void done
      .catch(() => undefined)
      .finally(() => {
        held.delete(item);
        if (!held.size && this.retired.get(key) === held)
          this.retired.delete(key);
      });
  }
  /** On a thinking level, when a turn with neither a pick nor a saved level
   * wants the harness's own. goose names no value for its own, so only a new
   * session runs on it; checked as that turn comes, so a session put on a
   * picked level keeps its conversation until then. */
  private leveled(live: Live, effort?: string) {
    if (this.options.configOptions) return false;
    return Boolean(
      live.session.effort && !effort && !this.options.choice().effort,
    );
  }

  /** Opens a session for `key` in the agent's workspace, which `use` records
   * as its user's. */
  /** With `pinned`, its launch and process come from that claim's snapshot
   * and generation alone, and it resumes the saved record while the claim
   * owns `key`. */
  private async open(
    key: string,
    title: string | undefined,
    use: (live: Live) => unknown,
    named?: (title: string) => void,
    pinned?: Readonly<{
      claim: Claim<S>;
      fits(session: AcpSession): boolean;
    }>,
  ): Promise<Live> {
    const { resolveDirectory, launchFor } = this.options;
    const { pool } = this;
    const claim = pinned?.claim;
    // Read before `launch` reads the settings, so it never describes newer ones.
    const fingerprint = claim ? "" : this.options.fingerprint();
    const launch =
      claim && launchFor
        ? await launchFor(claim.pinned.snapshot)
        : await this.options.launch();
    // Removed meanwhile: a process started now would outlive it.
    if (this.disposed) throw new Error(`${this.options.label} was stopped`);
    const [process, cwd] = await Promise.all([
      claim
        ? this.options.process.get(claim.pinned.generation)
        : this.options.process.get(),
      absolute(resolveDirectory, launch.workspace),
    ]);
    if (!this.watched.has(process)) {
      this.watched.add(process);
      void process.exited.then(() => {
        for (const [key, live] of this.live)
          if (live.process === process) this.drop(key, live);
      });
    }
    // Busy until it is adopted as a conversation's.
    const slot: Slot = { idle: () => false, evict: async () => undefined };
    const room = pool.take(slot);
    const start = (resume?: string) =>
      process.open({
        cwd,
        systemPrompt: launch.systemPrompt,
        ...(title ? { title } : {}),
        ...(named && !resume ? { named } : {}),
        tools: this.options.tools,
        choice: this.options.choice,
        ...(resume ? { resume } : {}),
      });
    let session: AcpSession | undefined;
    try {
      await room;
      if (pinned) session = await this.resume(key, pinned, process, start);
      session ??= await start().catch(async (error: unknown) => {
        // Other plugins hold servers too: make room once, and try again.
        const room = /too many mcp servers/i.test(message(error))
          ? pool.evict()
          : undefined;
        if (!room) throw error;
        await room;
        return start();
      });
    } catch (error) {
      pool.release(slot);
      throw error;
    }
    const released = () => pool.release(slot);
    void (session.server?.closed ?? Promise.resolve()).then(released, released);
    session.conversation = key;
    const live: Live = { session, process, fingerprint, slot, at: Date.now() };
    if (claim) {
      live.claim = claim;
      session.parity = this.parity(key, claim, session);
      session.parity.onState?.(session.state);
    } else if (fingerprint !== this.options.fingerprint() && !this.disposed) {
      // Settings saved while it opened: it would work with the old ones.
      void this.close(live);
      return this.open(key, title, use, named);
    }
    use(live);
    return live;
  }

  /** The saved session for `key`, reopened, when its record matches the
   * claim's pinned context and the turn can run on it; otherwise the record
   * is dropped and undefined means open a new one. */
  private async resume(
    key: string,
    {
      claim,
      fits,
    }: Readonly<{ claim: Claim<S>; fits(session: AcpSession): boolean }>,
    process: AcpProcess,
    start: (resume: string) => Promise<AcpSession>,
  ) {
    const { store } = this.options;
    // A retired opening must never read its successor's record.
    if (!this.options.resume || this.claims.get(key) !== claim) return;
    const saved = store?.load?.(key);
    if (!saved) return;
    if (!saved.id || saved.context !== claim.pinned.context) {
      this.forget(key, claim);
      return;
    }
    let session: AcpSession | undefined;
    try {
      session = await start(saved.id);
      session.covered = markOf(saved.covered);
      session.overridden = saved.overridden ?? { model: false, effort: false };
      if (fits(session)) return session;
    } catch (error) {
      console.warn(`${this.options.label} could not resume a session`, error);
    }
    if (session) void process.close(session);
    this.forget(key, claim);
    return undefined;
  }
  /** What a pinned session does for its owner: every write checks that the
   * claim still owns `key`. */
  private parity(key: string, claim: Claim<S>, session: AcpSession): Parity {
    const { store, refuse, onState } = this.options;
    return {
      pinned: claim.pinned.snapshot,
      configOptions: !!this.options.configOptions,
      setting: () => this.forget(key, claim),
      commit: (covered) => {
        if (this.claims.get(key) === claim)
          store?.advance?.(key, {
            id: session.id,
            covered,
            context: claim.pinned.context,
            overridden: session.overridden,
          });
      },
      lost: () => this.forget(key, claim),
      ...(refuse ? { refuse } : {}),
      ...(onState
        ? { onState: (state) => onState(state, claim.pinned.snapshot) }
        : {}),
    };
  }

  private adopt(key: string, live: Live) {
    // Retired while it opened: it serves its message unadopted.
    if (live.claim && this.claims.get(key) !== live.claim) return;
    this.had.add(key);
    this.live.set(key, live);
    // Not idle while the message it opened for is still on its way to it.
    live.slot.idle = () =>
      !live.session.busy &&
      this.live.get(key) === live &&
      !this.opening.has(key);
    live.slot.evict = async () => {
      this.drop(key, live);
      await live.session.server?.closed;
    };
    // Not saved until a message is handed to it: its own may have given up.
    this.countdown(key, live);
    this.options.onChange?.();
  }
  private async answer(
    key: string,
    live: Live,
    seen: number,
    text: string,
    activity: ActivityReceipt,
    model: string | undefined,
    effort?: string,
    kept?: string,
    turn?: Turn,
  ) {
    const sent = live.session.send(
      text,
      {
        ...activity,
        delivered: () => {
          if (this.live.get(key) === live) this.touch(key, live, seen);
          activity.delivered?.();
        },
      },
      model,
      effort,
      kept,
      turn,
    );
    // A final Buzz send can answer before the harness finishes its model work.
    void live.session.idle().then(() => {
      if (this.live.get(key) === live) this.options.onChange?.();
    });
    // Sending made it busy; a snapshot read when it opened is not.
    this.options.onChange?.();
    const settled = await sent;
    if (this.live.get(key) === live) {
      this.touch(key, live);
      if (!live.session.busy && this.stale(live)) this.drop(key, live);
    }
    return settled;
  }
  /** Notes that the session took in a message or ended a turn, and what it
   * has been shown, and restarts its idle countdown. */
  private touch(key: string, live: Live, seen?: number) {
    live.at = Date.now();
    const { store } = this.options;
    if (store?.touch) store.touch(key, live.at);
    else store?.set(key, { at: live.at });
    this.countdown(key, live);
    if (seen !== undefined)
      this.shown.set(key, Math.max(seen, this.shown.get(key) ?? 0));
  }
  /** Closes the session after IDLE_MS, or waits again while it is busy: a
   * long turn is not new use. */
  private countdown(key: string, live: Live) {
    this.pool.touch(live.slot);
    clearTimeout(live.timer);
    live.timer = setTimeout(() => {
      if (live.session.busy) this.countdown(key, live);
      else if (this.live.get(key) === live) this.drop(key, live);
    }, IDLE_MS);
  }
  private drop(key: string, live: Live) {
    clearTimeout(live.timer);
    if (this.live.get(key) === live) {
      this.live.delete(key);
      this.shown.delete(key);
      this.options.onChange?.();
    }
    if (live.claim && this.claims.get(key) === live.claim)
      this.claims.delete(key);
    void this.close(live);
  }
  private close(live: Live) {
    const closing = live.process.close(live.session);
    // Its process may stop once no session holds it.
    void closing.finally(() => live.lease?.release());
    return closing;
  }
}

/** `workspace` as an absolute path, which ACP sessions need. One already
 * absolute stays as written, as the sessions started in it recorded it. */
export async function absolute(
  resolveDirectory: ResolveDirectory,
  workspace: string,
) {
  return absoluteWorkspace(workspace) ? workspace : resolveDirectory(workspace);
}

/** `work`, or a rejection with `signal`'s reason once it aborts. */
export function abortable<T>(
  work: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
