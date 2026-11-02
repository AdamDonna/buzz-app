// What the shared ACP client exchanges with the harness plugins built on it.
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
  McpHandler,
} from "../../host/service";
import type { AcpProcess } from "./process";
import type { ConfigOptions } from "./session";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;
export type ServeMcp = (handler: McpHandler) => Promise<HostMcpServer>;
/** The host's absolute path for a directory, resolving `~/…`. */
export type ResolveDirectory = (path: string) => Promise<string>;

/** How a burst of work ended: every message sent so far has been answered,
 * or the session or its process is gone. One message of the burst owns its
 * `error` and `text`, to post them once; the others get only `ok`. */
export type Settled = Readonly<{
  ok: boolean;
  error?: string;
  /** The JSON-RPC code of the harness's error answer behind `error`. */
  code?: number;
  /** Buzz's own advice for a failure it raised (`HintedError`). */
  hint?: string;
  /** What the harness wrote, when it answered nowhere in Buzz. Nobody saw it. */
  text?: string;
  /** The message gave up before any turn took it in. */
  undelivered?: true;
  /** The owner's interrupt ended the turn. */
  stopped?: true;
  /** For `auth_required` (-32000): the sign-in methods `initialize`
   * advertised, as text from the harness. Never run. */
  authMethods?: readonly AuthMethod[];
}>;

export type AuthMethod = Readonly<{
  id: string;
  name: string;
  description?: string;
}>;

/** What a session has been shown: the newest second it covers, and the
 * message ids at or near it, so messages sharing a second stay distinct. */
export type Mark = Readonly<{ at: number; ids: readonly string[] }>;
/** The boundary of a session that has been shown nothing yet: below every
 * plugin mark, so a prompt built from it carries the whole conversation. */
export const FRESH: Mark = { at: -1, ids: [] };

/** Builds a turn's prompt when it is sent, carrying every message after
 * `from`; `through` is the last one it carries. Undefined skips the turn:
 * nothing is left to send. */
export type BuildPrompt<S = unknown> = (
  from: Mark,
  pinned: S,
) => Promise<Readonly<{ text: string; through: Mark }> | undefined>;

/** One ACP session config option, groups flattened. */
export type ConfigOption = Readonly<{
  id: string;
  name: string;
  /** `model` and `thought_level` are used; any other is ignored. */
  category?: string;
  /** Only `select` is used. */
  type: string;
  currentValue: string;
  options: readonly ConfigValue[];
}>;
export type ConfigValue = Readonly<{
  value: string;
  name: string;
  description?: string;
}>;

/** What a session runs on now, from the harness's latest option state. */
export type OptionState = Readonly<{
  options: readonly ConfigOption[];
  /** The one usable select per category: undefined when there are none, or
   * several. */
  model?: ConfigOption;
  effort?: ConfigOption;
}>;

/** A turn's model and thinking level; empty is the harness's default. */
export type Pick = Readonly<{ model?: string; effort?: string }>;
/** Where each field of a pick came from. Only a "synced" field refuses a
 * value the session doesn't offer; the others fall back. */
export type Source = Readonly<{
  model?: "synced" | "device" | "message";
  effort?: "synced" | "device" | "message";
}>;
/** Whether Buzz ever set that field on the session. Only ever turns on. */
export type Overridden = Readonly<{ model: boolean; effort: boolean }>;

/** One accepted launch: executable, argv, env, workspace and approval, all
 * from one settings read. A save makes a new one. */
export type Generation = Readonly<{ id: number; launch: unknown }>;

/** A live session's settings, taken once, synchronously, before any await. */
export type Pinned<S = unknown> = Readonly<{
  /** The accepted config and each setting's provenance. */
  snapshot: S;
  /** The hash a saved record must match to resume, from this same read. */
  context: string;
  /** Changes on an accepted local save, never on a remote edit. */
  localKey: string;
  generation: Generation;
}>;

/** Starts the agent's confirmed launch, as a run does; with no `serve`
 * there are no Buzz tools. */
export type StartConfirmed = (
  o: Readonly<{ signal: AbortSignal }>,
) => Promise<AcpProcess>;

/** A transcript read: one short-lived process, `initialize` and
 * `session/load`, never a prompt. */
export type TranscriptRead = Readonly<{
  start: StartConfirmed;
  cwd: string;
  sessionId: string;
  signal?: AbortSignal;
  /** 20s by default, for spawn, initialize and load together. */
  deadlineMs?: number;
  limits?: Readonly<{ turns: number; items: number; bytes: number }>;
  /** Reads a turn's thread from the first 4 KiB of its prompt: an id, null
   * for the channel itself, undefined when unknown. Stored as the turn's
   * `threadRootId`. */
  threadOf(promptPrefix: string): string | null | undefined;
}>;

/** A conversation route `route` matched: `exact` is a route naming exactly
 * this thread, which beats a channel route. */
export type RouteMatch = Readonly<{ key: string; exact: boolean }>;

export type ActivityReceipt = Readonly<{
  current?: () => boolean;
  /** Rebuilds an Attention prompt after startup or queue waits. */
  refresh?: (fresh?: boolean) => Promise<string>;
  /** The prompt was handed to the harness, after cancellation and provider
   * checks. */
  delivered?: () => void;
  /** Steps show on the latest acknowledged message of each scope. */
  activityScope?: string;
  step?: (tool: string, target?: string) => void;
  acknowledged?: () => void;
  superseded?: () => void;
}>;

/** Answers one MCP message from a session serving `conversation` with its
 * JSON-RPC response. */
export type ToolServer = (
  conversation: string | undefined,
  message: Readonly<{ id: string | number; method: string; params?: unknown }>,
  /** The serving session's pinned snapshot, when its sessions pin one. */
  pinned?: unknown,
) => Promise<unknown>;

/** The provider, model and thinking level a session's turns run on; empty is
 * what the harness's own config picks. */
export type Choice = Readonly<{
  provider: string;
  model: string;
  effort?: string;
}>;

/** The HTTP MCP server a session declares in `session/new`. */
export type McpServer = Readonly<{
  type: "http";
  name: string;
  url: string;
  headers: HostMcpServer["headers"];
}>;

/** What a harness adds to, or does in place of, plain ACP. Each hook is
 * optional: without it the client uses plain ACP's way, or none. */
export type AcpHooks = Readonly<{
  /** Names the harness in errors. */
  label: string;
  /** The manifest process it runs as. */
  program: string;
  /** The error when that program cannot be found, or cannot run. */
  missing: string;
  /** What to do about it, posted where others can read it: fixed text, never
   * the launch's own values. Without it, no hint is given. */
  missingHint?: string;
  /** Keeps stderr written before the host reports the spawn, and reads exit
   * 126 or 127 before `initialize` answers as `missing`: for a program the
   * owner launches through `env`. */
  diagnoseStartup?: boolean;
  /** Its environment, under the launch's own. The Buzz identity is always
   * removed, whatever either says. */
  env: Readonly<Record<string, string | null>>;
  /** Whether the harness names an untitled session itself, read once per
   * process. Without it, a session opened to be named keeps its title. */
  names?(process: AcpProcess): Promise<boolean>;
  /** `session/new`'s `_meta`. A session's `title` reaches the harness only
   * here: ACP has no standard field for it, so only a harness that sets this
   * hook (Goose) is given one. */
  newSessionMeta?(
    buzz: McpServer | undefined,
    open: Readonly<{ title?: string; provider: string }>,
  ): Record<string, unknown>;
  /** Appends `text` to a new session's system prompt; a throw closes it.
   * Without it, ACP's `systemPrompt` carries it when advertised, else it
   * leads the session's first prompt. */
  systemPrompt?(
    process: AcpProcess,
    sessionId: string,
    text: string,
  ): Promise<void>;
  /** Steers a message into the running turn. Without it, a message sent
   * mid-turn runs as the next turn. */
  steering?: Readonly<{
    /** The running turn's id from an update: undefined when none runs,
     * null when the update says nothing about it. */
    runId(update: Record<string, unknown>): string | undefined | null;
    steer(
      process: AcpProcess,
      sessionId: string,
      runId: string,
      text: string,
    ): Promise<void>;
  }>;
  /** Puts a session on `want` before a turn, keeping `session.chosen` to
   * what it now runs on, and handing `session.offer` each config answer.
   * Without it, the harness's own pick stands. */
  select?(
    process: AcpProcess,
    session: {
      readonly id: string;
      chosen: Choice;
      offer(options: ConfigOptions): void;
    },
    want: Choice,
  ): Promise<void>;
  /** Whether `session/close` is sent: always, or only when
   * `sessionCapabilities.close` is advertised (the default). */
  closeSession?: "always" | "advertised";
}>;
