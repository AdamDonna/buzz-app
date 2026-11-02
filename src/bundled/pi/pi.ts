// The Pi host (host.mjs): one process for every Pi agent here, started when
// something needs it, spoken to over stdio, one JSON message a line. Requests
// go both ways: the plugin asks the host to run turns, and the host asks the
// plugin to run the Buzz tools, so the process holds no Buzz key.
import type { Context } from "../../buzz-mcp/client";
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";
import packageJson from "./deps/package.json?raw";
import packageLock from "./deps/package-lock.json?raw";
import host from "./host.mjs?raw";
import launch from "./launch.mjs?raw";
import script from "./pi.sh?raw";

type Spawn = (id: string, options?: HostProcessOptions) => Promise<HostProcess>;

export type ToolCall = Readonly<{
  agent: string;
  /** The Pi conversation whose run called. */
  conversation: number;
  /** Where the tools default to for that conversation. */
  context: Context;
  name: string;
  arguments: Record<string, unknown>;
}>;
/** An MCP tool result; `final` ends the run that called it. */
export type ToolResult = Readonly<{
  content: readonly unknown[];
  isError?: boolean;
  final?: boolean;
}>;
export type PiEvent = Readonly<
  { agent: string; conversation: number } & (
    | { type: "placed"; request: string; entry: number }
    | { type: "step"; tool: string; target?: string }
  )
>;
export type PiHookCall = Readonly<{
  agent: string;
  conversation: number;
  event: "beforeTool" | "afterTool";
  input: unknown;
}>;
type Handlers = Readonly<{
  hook?(call: PiHookCall): Promise<unknown>;
  tool(call: ToolCall): Promise<ToolResult>;
  event(event: PiEvent): void;
  prompt?(call: {
    agent: string;
    request: string;
  }): Promise<{ text: string; steer: string } | undefined>;
}>;

/** The host stopped after it started; its runs continue in the next one. */
export class PiStopped extends Error {}

/** What the host's stderr says last, for an error that names a cause. */
const TAIL = 2_000;
/** The line of the host's stderr that says why it stopped: Node's error,
 * else its last line, past Node's version and npm's log path. */
const cause = (stderr: string) => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^Node\.js v|^npm error A complete log/.test(line),
    );
  return lines.find((line) => /^[A-Z]\w*Error\b/.test(line)) ?? lines.at(-1);
};
/** How long a stopping host has to close each agent's storage. */
const STOP_MS = 2_000;

type Message = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
};
type Connection = {
  process: HostProcess;
  calls: Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >;
  /** Set once it has exited, with why. */
  gone?: Error;
};

export class Pi {
  private connection: Promise<Connection> | undefined;
  private requests = 0;
  private stopped = false;

  constructor(
    private readonly spawn: () => Spawn,
    private readonly handlers: Handlers,
  ) {}

  /** Asks the host, starting it first if it is not running. */
  async request<T>(method: string, params: object = {}): Promise<T> {
    const connection = await this.connect();
    if (connection.gone) throw connection.gone;
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) =>
      connection.calls.set(id, { resolve, reject }),
    );
    void connection.process
      .write(`${JSON.stringify({ id, method, params })}\n`)
      .catch((error: unknown) => {
        connection.calls
          .get(id)
          ?.reject(new Error(`Pi did not take that: ${error}`));
        connection.calls.delete(id);
      });
    return answer as Promise<T>;
  }

  /** Stops the host: it closes each agent's storage, then it is killed. */
  async dispose() {
    this.stopped = true;
    const connection = await this.connection?.catch(() => undefined);
    if (!connection || connection.gone) return;
    await connection.process.end().catch(() => undefined);
    const timer = setTimeout(() => void connection.process.kill(), STOP_MS);
    await connection.process.exited;
    clearTimeout(timer);
  }

  private connect(): Promise<Connection> {
    if (this.stopped) return Promise.reject(new Error("Pi has stopped"));
    if (!this.connection) {
      const connecting = this.start();
      this.connection = connecting;
      // One that failed to start is tried again by the next request.
      connecting.catch(() => {
        if (this.connection === connecting) this.connection = undefined;
      });
    }
    return this.connection;
  }

  private async start(): Promise<Connection> {
    let ready!: () => void;
    let isReady = false;
    const started = new Promise<void>((resolve) => {
      ready = () => {
        isReady = true;
        resolve();
      };
    });
    let buffer = "";
    let stderr = "";
    const connection: Connection = {
      calls: new Map(),
      process: undefined as unknown as HostProcess,
    };
    const handle = (message: Message) => {
      if (message.method === "ready") ready();
      else if (message.method === "event")
        this.handlers.event(message.params as PiEvent);
      else if (
        (message.method === "tool" ||
          message.method === "prompt" ||
          message.method === "hook") &&
        message.id !== undefined
      )
        void this.answer(
          connection,
          message.id,
          message.method,
          message.params,
        );
      else if (typeof message.id === "number") {
        const call = connection.calls.get(message.id);
        connection.calls.delete(message.id);
        if (message.error) call?.reject(new Error(message.error));
        else call?.resolve(message.result);
      }
    };
    // Windows has no bash, and starts Node from its own PATH. The host and
    // its packages go on stdin: together they are past Windows' 32 KB
    // command line.
    const windows = /^Win/i.test(globalThis.navigator?.platform ?? "");
    const starting = this.spawn()(windows ? "node" : "pi-sh", {
      args: windows ? [launch] : [script, "pi.sh", launch],
      cwd: "~",
      onStdout: (data) => {
        buffer += data;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          try {
            handle(JSON.parse(line));
          } catch (error) {
            console.warn("Pi sent a message Buzz could not read", error);
          }
        }
      },
      onStderr: (data) => {
        stderr = (stderr + data).slice(-TAIL);
      },
    });
    connection.process = await starting.catch((error: unknown) => {
      // pi.sh says so itself; Windows cannot start a `node` it lacks.
      throw windows && /Could not start/.test(String(error))
        ? new Error(
            "Pi needs Node.js 22.19 or later. Install it from nodejs.org, then try again.",
          )
        : error;
    });
    void connection.process
      .write(
        `${JSON.stringify({ host, package: packageJson, lock: packageLock })}\n`,
      )
      // A host that never has its source waits for it; it stops instead.
      .catch(() => void connection.process.kill().catch(() => undefined));
    void connection.process.exited.then((code) => {
      // Before it is ready, its last words are why it could not start, such
      // as Node missing.
      const why = cause(stderr);
      const exit = `exit ${code ?? "signal"}`;
      connection.gone = isReady
        ? new PiStopped(why ? `Pi stopped: ${why}` : `Pi stopped (${exit})`)
        : new Error(why ?? `Pi could not start (${exit})`);
      for (const call of connection.calls.values())
        call.reject(connection.gone);
      connection.calls.clear();
      // The next request starts another.
      this.connection = undefined;
      ready();
    });
    await started;
    if (connection.gone) throw connection.gone;
    return connection;
  }

  /** Runs a Buzz tool the host called, and sends it the result. */
  private async answer(
    connection: Connection,
    id: number | string,
    method: "tool" | "prompt" | "hook",
    params: unknown,
  ) {
    let message: Message;
    try {
      message = {
        id,
        result:
          method === "hook"
            ? ((await this.handlers.hook?.(params as PiHookCall)) ?? null)
            : method === "tool"
              ? await this.handlers.tool(params as ToolCall)
              : ((await this.handlers.prompt?.(
                  params as { agent: string; request: string },
                )) ?? false),
      };
    } catch (error) {
      message = {
        id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!connection.gone)
      await connection.process
        .write(`${JSON.stringify(message)}\n`)
        .catch(() => undefined);
  }
}
