// A stand-in for a plain-ACP harness run by `env`, for tests.
import {
  answerMcp,
  type HostMcpServer,
  type HostProcess,
  type HostProcessOptions,
  type McpHandler,
} from "../../features/host/service";

type Message = {
  jsonrpc?: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export type FakeHarness = {
  options: HostProcessOptions;
  received: Message[];
  /** Each `session/new`'s params. */
  opened: Record<string, unknown>[];
  /** Each turn's prompt text, in order, with its session. */
  turns: {
    sessionId: string;
    text: string;
    finish(stopReason?: string): void;
    fail(code: number, message: string): void;
  }[];
  killed: boolean;
  sent(method: string): Message[];
  /** An MCP message for the Buzz tools from `sessionId`, sent to the server
   * its `session/new` declared. */
  mcp(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Message>;
};

/** A spawn whose `harness` processes answer like a plain-ACP harness, whose
 * `workspace` process prints `/home/test` for `~`, and a `serve` for the Buzz
 * tools those processes reach. */
export function fakeHarness(
  options: Readonly<{
    /** What `initialize` advertises. */
    capabilities?: Record<string, unknown>;
    /** Requests it never answers. */
    silent?: readonly string[];
    /** Exits with this code at once, as `env` does for a missing program. */
    exitCode?: number;
    /** Turns stay open until finished. */
    hold?: boolean;
    /** `session/new` is answered only once this settles. */
    opening?: Promise<void>;
    /** Kill asks it to stop, and it never exits. */
    holdExit?: boolean;
    /** Prompts from the `from`th (0-based, default 0) are answered with
     * this error. */
    promptError?: { code: number; message: string; from?: number };
    /** Text each prompt streams as an `agent_message_chunk` before it ends. */
    chunk?: string;
    /** The `configOptions` every session answers with; a set replaces the
     * chosen value. */
    configOptions?: readonly Record<string, unknown>[];
  }> = {},
) {
  const harnesses: FakeHarness[] = [];
  const servers: { url: string; handler: McpHandler; closed: boolean }[] = [];
  const serve = async (handler: McpHandler): Promise<HostMcpServer> => {
    const server = {
      url: `http://127.0.0.1:${40_001 + servers.length}/mcp`,
      handler,
      closed: false,
    };
    servers.push(server);
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => (stopped = resolve));
    return {
      url: server.url,
      headers: [{ name: "Authorization", value: `Bearer t${servers.length}` }],
      close: async () => {
        server.closed = true;
        stopped();
      },
      closed,
    };
  };
  const spawn = async (
    _id: string,
    process: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    let alive = true;
    const end = (code: number | null) => {
      if (!alive) return;
      alive = false;
      exit(code);
    };
    const send = (message: Message) =>
      queueMicrotask(() => {
        if (alive)
          process.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
          );
      });
    const declared = new Map<string, string>();
    let sessions = 0;
    const options_ = () =>
      options.configOptions ? { configOptions: [...chosen.values()] } : {};
    const chosen = new Map(
      (options.configOptions ?? []).map((o) => [String(o.id), o]),
    );
    let mcpIds = 0;
    const fake: FakeHarness = {
      options: process,
      received: [],
      opened: [],
      turns: [],
      killed: false,
      sent: (method) => fake.received.filter((m) => m.method === method),
      mcp: async (sessionId, method, params = {}) => {
        const server = servers.find((s) => s.url === declared.get(sessionId));
        if (!server || server.closed)
          throw new Error(`No Buzz MCP server for ${sessionId}`);
        const body = { jsonrpc: "2.0", id: ++mcpIds, method, params };
        return (await answerMcp(
          server.handler,
          JSON.stringify(body),
        )) as Message;
      },
    };
    harnesses.push(fake);
    if (options.exitCode !== undefined) {
      const code = options.exitCode;
      queueMicrotask(() => {
        process.onStderr?.("env: harness: No such file or directory\n");
        end(code);
      });
    }
    return {
      write: async (data) => {
        if (!alive) throw new Error("Broken pipe");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as Message;
          fake.received.push(message);
          const { id, method, params = {} } = message;
          if (!method || id === undefined || options.silent?.includes(method))
            continue;
          if (method === "initialize")
            send({
              id,
              result: {
                protocolVersion: 1,
                agentCapabilities: options.capabilities ?? {
                  mcpCapabilities: { http: true },
                },
              },
            });
          else if (method === "session/new") {
            fake.opened.push(params);
            const sessionId = `session-${++sessions}`;
            const [buzz] = (params.mcpServers ?? []) as { url: string }[];
            if (buzz) declared.set(sessionId, buzz.url);
            const opened = () =>
              send({ id, result: { sessionId, ...options_() } });
            if (options.opening) void options.opening.then(opened);
            else opened();
          } else if (method === "session/prompt") {
            const sessionId = String(params.sessionId);
            const text = (params.prompt as { text: string }[])
              .map((block) => block.text)
              .join("");
            const turn = {
              sessionId,
              text,
              finish: (stopReason = "end_turn") =>
                send({ id, result: { stopReason } }),
              fail: (code: number, message: string) =>
                send({ id, error: { code, message } }),
            };
            fake.turns.push(turn);
            if (options.chunk)
              send({
                method: "session/update",
                params: {
                  sessionId,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: options.chunk },
                  },
                },
              });
            const failing = options.promptError;
            if (failing && fake.turns.length > (failing.from ?? 0)) {
              turn.fail(failing.code, failing.message);
            } else if (!options.hold) turn.finish();
          } else if (method === "session/load" || method === "session/resume") {
            const [buzz] = (params.mcpServers ?? []) as { url: string }[];
            if (buzz) declared.set(String(params.sessionId), buzz.url);
            send({ id, result: options_() });
          } else if (method === "session/set_config_option") {
            const option = chosen.get(String(params.configId));
            if (option)
              chosen.set(String(params.configId), {
                ...option,
                currentValue: params.value,
              });
            send({ id, result: options_() });
          } else if (method === "session/close") send({ id, result: {} });
          else
            send({ id, error: { code: -32601, message: `Unknown ${method}` } });
        }
      },
      end: async () => undefined,
      kill: async () => {
        fake.killed = true;
        if (!options.holdExit) end(null);
      },
      exited,
    };
  };
  return { spawn, serve, harnesses, servers };
}
