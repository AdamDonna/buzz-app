// Reads a saved session's transcript through standard ACP: a short-lived
// harness process replays it with `session/load`, and its updates become
// `Transcript` turns. Nothing is prompted, and no Buzz tools are given.
import type {
  ToolItem,
  Transcript,
  TranscriptItem,
  TranscriptTurn,
} from "../../agents/activity-transcript";
import { abortable } from "./agent-sessions";
import { optionState } from "./options";
import type { AcpProcess } from "./process";
import type { OptionState, StartConfirmed, TranscriptRead } from "./types";

const DEADLINE_MS = 20_000;
const CLEANUP_MS = 3_000;
/** The most of one text item or tool payload kept. */
const ITEM_LIMIT = 64 * 1024;
/** The most of a turn's prompt held, for `threadOf`. */
const PREFIX_LIMIT = 4 * 1024;
/** What an item or list entry costs before its text: its fields, and room for the
 * truncation marker its text may take. */
const ITEM_BYTES = 64;
const LIMITS = { turns: 200, items: 5_000, bytes: 2 * 1024 * 1024 };

/** The transcript, or undefined when the harness can't replay one. */
export async function readTranscript(
  read: TranscriptRead,
): Promise<Transcript | undefined> {
  const { sessionId, cwd } = read;
  return withProcess(read.start, read, async (acp, signal) => {
    if (acp.agentCapabilities.loadSession !== true) return undefined;
    const rebuild = new Rebuild(sessionId, { ...LIMITS, ...read.limits });
    const stop = acp.listen(sessionId, (update) => rebuild.add(update));
    try {
      await abortable(
        acp.request("session/load", { sessionId, cwd, mcpServers: [] }),
        signal,
      );
    } finally {
      stop();
    }
    return rebuild.result(read.threadOf);
  });
}

/** A Check's look at the options a new session offers, with no Buzz tools
 * and no prompt; undefined on any failure. */
export async function probeOptions(
  start: StartConfirmed,
  cwd: string,
  signal?: AbortSignal,
): Promise<OptionState | undefined> {
  return withProcess(
    start,
    { ...(signal ? { signal } : {}) },
    async (acp, signal) => {
      const { sessionId, configOptions } = (await abortable(
        acp.request("session/new", { cwd, mcpServers: [] }),
        signal,
      )) as { sessionId: string; configOptions?: unknown };
      if (acp.advertises("close"))
        await abortable(acp.request("session/close", { sessionId }), signal);
      return optionState(configOptions);
    },
  ).catch(() => undefined);
}

/** Runs `work` on a process started for it, within one deadline for every
 * step, and always stops the process. */
async function withProcess<T>(
  start: StartConfirmed,
  o: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>,
  work: (acp: AcpProcess, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(o.deadlineMs ?? DEADLINE_MS);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const acp = await start({ signal });
  try {
    signal.throwIfAborted();
    return await work(acp, signal);
  } finally {
    await acp.stop(CLEANUP_MS);
  }
}

type Json = Record<string, unknown>;
type Turn = TranscriptTurn & {
  /** Bytes it holds. */
  size: number;
  /** Its first prompt's start, held until `threadOf` reads it. */
  prefix: string;
};
type Text = Extract<TranscriptItem, { type: "message" | "thought" }>;

/** Turns rebuilt from replayed updates, within the read's limits: the oldest
 * turn goes first, and a single item over its share is cut. */
class Rebuild {
  private readonly turns: Turn[] = [];
  private readonly tools = new Map<string, ToolItem>();
  private bytes = 0;
  private items = 0;
  private evicted = false;
  /** The kind and message id of the latest text item, which a chunk joins. */
  private last: { kind: string; messageId?: string; item: Text } | undefined;
  /** The current turn's prompt, which user chunks join. */
  private prompt: Extract<TranscriptItem, { type: "prompt" }> | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly limits: Readonly<{
      turns: number;
      items: number;
      bytes: number;
    }>,
  ) {}

  add(update: Json) {
    const kind = String(update.sessionUpdate ?? "");
    const at = time(update);
    if (kind === "user_message_chunk") return this.user(update, at);
    const turn = this.current(at);
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk")
      this.text(turn, kind, update, at);
    else if (kind === "tool_call" || kind === "tool_call_update")
      this.tool(turn, update, at);
    else if (kind === "plan") this.plan(turn, update, at);
    else return;
    this.prompt = undefined;
    if (at) turn.endedAt = at;
  }

  result(threadOf: TranscriptRead["threadOf"]): Transcript {
    const turns = this.turns.map(({ size: _size, prefix, ...turn }) => {
      const threadRootId = prefix ? threadOf(prefix) : undefined;
      return { ...turn, threadRootId, partial: turn.partial || this.evicted };
    });
    return { turns };
  }

  private user(update: Json, at: number) {
    const text = chunk(update);
    const messageId = str(update.messageId) || undefined;
    // A user message after anything else starts a turn.
    if (!this.prompt && (!this.turns.at(-1) || this.last || this.tail()))
      this.start(at, false);
    const turn = this.turns.at(-1) as Turn;
    const joins =
      this.prompt &&
      this.last?.kind === "user" &&
      (messageId === undefined || this.last.messageId === messageId);
    if (!joins || !this.prompt) {
      if (!this.admit(turn, ITEM_BYTES + bytes(messageId ?? ""), true)) return;
      this.prompt = {
        id: this.itemId(turn),
        at,
        type: "prompt",
        text: "",
        sections: [],
        steer: false,
      };
      turn.items.push(this.prompt);
      this.items++;
    }
    this.last = {
      kind: "user",
      ...(messageId ? { messageId } : {}),
      item: this.prompt as unknown as Text,
    };
    // Only a prompt's start is kept: enough for `threadOf`, never the whole.
    const room = PREFIX_LIMIT - this.prompt.text.length;
    const kept = text.slice(0, Math.max(0, room));
    if (kept && this.admit(turn, bytes(kept))) {
      this.prompt.text += kept;
      if (turn.prefix.length < PREFIX_LIMIT && turn.items[0] === this.prompt)
        turn.prefix = this.prompt.text;
    }
  }

  /** Whether the latest turn has anything but prompts. */
  private tail() {
    return this.turns.at(-1)?.items.some((item) => item.type !== "prompt");
  }

  private text(turn: Turn, kind: string, update: Json, at: number) {
    const type = kind === "agent_message_chunk" ? "message" : "thought";
    const messageId = str(update.messageId) || undefined;
    const last = this.last;
    let item =
      last &&
      last.kind === type &&
      last.item.type === type &&
      turn.items.at(-1) === last.item &&
      last.messageId === messageId
        ? last.item
        : undefined;
    if (!item) {
      if (!this.admit(turn, ITEM_BYTES + bytes(messageId ?? ""), true)) return;
      item = {
        id: this.itemId(turn),
        at,
        type,
        text: "",
        ...(messageId ? { messageId } : {}),
      };
      turn.items.push(item);
      this.items++;
      this.last = { kind: type, ...(messageId ? { messageId } : {}), item };
    }
    item.text = this.grow(turn, item.text, chunk(update));
  }

  private tool(turn: Turn, update: Json, at: number) {
    const id = str(update.toolCallId);
    let item = this.tools.get(id);
    if (!item || !turn.items.includes(item)) {
      if (!this.admit(turn, 2 * ITEM_BYTES + bytes(id), true)) return;
      item = {
        id: this.itemId(turn),
        at,
        type: "tool",
        toolCallId: id,
        title: "",
        kind: "",
        status: "",
        input: "",
        output: "",
        diffs: [],
        paths: [],
        truncated: false,
      };
      turn.items.push(item);
      this.items++;
      this.tools.set(id, item);
    }
    this.last = undefined;
    if (typeof update.title === "string")
      item.title = this.set(turn, item.title, update.title, item);
    if (typeof update.kind === "string")
      item.kind = this.set(turn, item.kind, update.kind, item);
    if (typeof update.status === "string") {
      item.status = this.set(turn, item.status, update.status, item);
      if (at && (update.status === "completed" || update.status === "failed"))
        item.completedAt = at;
    }
    if (update.rawInput !== undefined)
      item.input = this.set(turn, item.input, display(update.rawInput), item);
    const content = Array.isArray(update.content) ? update.content : undefined;
    if (content) {
      const text: string[] = [];
      for (const entry of content) {
        const value = (entry ?? {}) as Json;
        const block = (value.content ?? {}) as Json;
        if (value.type === "diff" && typeof value.newText === "string") {
          const path = str(value.path);
          const newText = this.cut(value.newText, item);
          const oldText =
            typeof value.oldText === "string"
              ? this.cut(value.oldText, item)
              : undefined;
          const size =
            ITEM_BYTES + bytes(path) + bytes(newText) + bytes(oldText ?? "");
          if (!this.admit(turn, size)) {
            item.truncated = true;
            continue;
          }
          item.diffs.push({
            path,
            newText,
            ...(oldText === undefined ? {} : { oldText }),
          });
        } else if (block.type === "text" && typeof block.text === "string")
          text.push(block.text);
      }
      if (text.length)
        item.output = this.set(turn, item.output, text.join("\n"), item);
    } else if (update.rawOutput !== undefined)
      item.output = this.set(
        turn,
        item.output,
        display(update.rawOutput),
        item,
      );
    if (Array.isArray(update.locations))
      for (const location of update.locations) {
        const path = str((location as Json | null)?.path);
        if (
          path &&
          !item.paths.includes(path) &&
          this.admit(turn, ITEM_BYTES + bytes(path))
        )
          item.paths.push(path);
      }
  }

  private plan(turn: Turn, update: Json, at: number) {
    const entries = (Array.isArray(update.entries) ? update.entries : []).map(
      (entry) => ({
        content: str((entry as Json | null)?.content).slice(0, ITEM_LIMIT),
        status: str((entry as Json | null)?.status),
      }),
    );
    const index = turn.items.findIndex((item) => item.type === "plan");
    const old = index < 0 ? undefined : turn.items[index];
    const freed =
      old?.type === "plan" ? planBytes(old.entries) + ITEM_BYTES : 0;
    this.last = undefined;
    if (!this.admit(turn, planBytes(entries) + ITEM_BYTES - freed, index < 0))
      return;
    const item: TranscriptItem = {
      id: old?.id ?? this.itemId(turn),
      at,
      type: "plan",
      entries,
    };
    // Each plan replaces the turn's last one.
    if (index < 0) {
      turn.items.push(item);
      this.items++;
    } else turn.items[index] = item;
  }

  /** The turn an agent update joins: a partial one when none has started. */
  private current(at: number) {
    return this.turns.at(-1) ?? this.start(at, true);
  }
  private start(at: number, partial: boolean) {
    const index = this.turns.length + (this.dropped ?? 0);
    const turnId = `${this.sessionId}:${index}`;
    const turn: Turn = {
      turnId,
      channelId: null,
      threadRootId: undefined,
      triggeringEventIds: [],
      sessionId: this.sessionId,
      newSession: false,
      config: [],
      startedAt: at,
      partial: partial || !at,
      items: [],
      size: 0,
      prefix: "",
    };
    this.turns.push(turn);
    this.last = undefined;
    this.prompt = undefined;
    while (this.turns.length > this.limits.turns) this.evict();
    return turn;
  }
  private dropped = 0;

  private itemId(turn: Turn) {
    return `${turn.turnId}:${turn.items.length}`;
  }
  /** `text` extended by `more`, cut to its item's share with the marker. */
  private grow(turn: Turn, text: string, more: string) {
    if (text.length >= ITEM_LIMIT) return elide(text, more.length);
    const kept = more.slice(0, ITEM_LIMIT - text.length);
    if (!this.admit(turn, bytes(kept))) return elide(text, more.length);
    const grown = text + kept;
    return kept.length < more.length
      ? elide(grown, more.length - kept.length)
      : grown;
  }
  /** Replaces a tool field with `next`, cut to its share. */
  private set(turn: Turn, old: string, next: string, item: ToolItem) {
    const cut = this.cut(next, item);
    if (!this.admit(turn, bytes(cut) - bytes(old))) {
      item.truncated = true;
      return old;
    }
    return cut;
  }
  private cut(text: string, item: ToolItem) {
    if (text.length <= ITEM_LIMIT) return text;
    item.truncated = true;
    return elide(text.slice(0, ITEM_LIMIT), text.length - ITEM_LIMIT);
  }
  /** Makes room for `size` more bytes in `turn`, and with `item` one more
   * item, evicting older turns; false when even then it doesn't fit. */
  private admit(turn: Turn, size: number, item = false) {
    const over = () =>
      this.bytes + size > this.limits.bytes ||
      (item && this.items + 1 > this.limits.items);
    while (over() && this.turns[0] !== turn) this.evict();
    if (over()) {
      // What it couldn't keep leaves the turn incomplete.
      turn.partial = true;
      return false;
    }
    turn.size += size;
    this.bytes += size;
    return true;
  }
  private evict() {
    const turn = this.turns.shift();
    if (!turn) return;
    this.dropped++;
    this.evicted = true;
    this.bytes -= turn.size;
    this.items -= turn.items.length;
    for (const [id, item] of this.tools)
      if (turn.items.includes(item)) this.tools.delete(id);
  }
}

const encoder = new TextEncoder();
/** `text`'s size in UTF-8. */
const bytes = (text: string) => encoder.encode(text).length;
const planBytes = (entries: readonly { content: string; status: string }[]) =>
  entries.reduce(
    (sum, entry) =>
      sum + ITEM_BYTES + bytes(entry.content) + bytes(entry.status),
    0,
  );
const str = (value: unknown) => (typeof value === "string" ? value : "");
const chunk = (update: Json) => str((update.content as Json | null)?.text);
const elide = (text: string, count: number) =>
  text.endsWith("]") && text.includes("…[elided ")
    ? text.replace(
        /…\[elided (\d+) chars\]$/,
        (_, n) => `…[elided ${Number(n) + count} chars]`,
      )
    : `${text}…[elided ${count} chars]`;
const display = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
/** A `_meta` timestamp in ms, or 0 when the harness sent none. */
function time(update: Json) {
  const value = (update._meta as Json | undefined)?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
