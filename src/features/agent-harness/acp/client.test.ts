// The shared ACP client driving a plain-ACP harness, one without hooks.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeSpawn as fakeGoose,
  flush,
} from "../../../bundled/goose/goose-testing";
import { GOOSE } from "../../../bundled/goose/goose";
import { SharedProcess } from "../../../bundled/goose/sessions";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../../host/service";
import {
  AgentSessions,
  type SavedConversation,
  ServerPool,
  SHARED_POOL,
} from "./agent-sessions";
import { AcpProcess, REQUEST_TIMEOUT_MS } from "./process";
import { readTranscript } from "./transcript";
import type { AcpHooks, Mark, Pinned, ToolServer } from "./types";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const HOOKS: AcpHooks = {
  label: "Harness",
  program: "harness",
  missing: "Install the harness CLI.",
  env: { HOOK: "hook", SHARED: "hook" },
};

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

/** A plain-ACP harness: `capabilities` is what `initialize` advertises. */
function fakeHarness(
  options: Readonly<{
    capabilities?: Record<string, unknown>;
    /** Requests it never answers. */
    silent?: readonly string[];
    /** Exits with this code as soon as it starts, as `env` does for a
     * missing program. */
    exitCode?: number;
    /** Turns stay open until finished. */
    hold?: boolean;
    /** Session ids name their process, and a cancel ends its session's turn. */
    cancels?: boolean;
    /** Kill asks it to stop, and it never exits. */
    holdExit?: boolean;
    /** Rejects this many prompts first, as a harness signed out does. */
    rejectPrompts?: number;
    /** Every prompt is answered with this error. */
    promptError?: { code: number; message: string };
    /** Why a turn that ran ends. */
    stopReason?: string;
    /** The option state sessions open, resume and load with. */
    configOptions?: Record<string, unknown>[];
    /** Updates `session/load` replays before it answers. */
    replay?: Record<string, unknown>[];
    /** What `session/load` and `session/resume` answer, instead of the
     * option state. */
    reopened?: Record<string, unknown>;
    /** `session/load` and `session/resume` wait in `reopens` until called. */
    holdReopen?: boolean;
  }> = {},
) {
  const started: {
    options: HostProcessOptions;
    killed: boolean;
    kills: number;
  }[] = [];
  const received: Message[] = [];
  const turns: {
    sessionId: string;
    text: string;
    steered: string[];
    finish(stopReason?: string): void;
  }[] = [];
  const reopens: (() => void)[] = [];
  let servers = 0;
  let rejectPrompts = options.rejectPrompts ?? 0;
  const serve = async (): Promise<HostMcpServer> => {
    const index = ++servers;
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => (stopped = resolve));
    return {
      url: `http://127.0.0.1:${40_000 + index}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer token-${index}` }],
      close: async () => stopped(),
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
    const record = { options: process, killed: false, kills: 0 };
    started.push(record);
    const send = (message: Record<string, unknown>) =>
      queueMicrotask(() => {
        if (alive)
          process.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
          );
      });
    const reply = (id: Message["id"], result: unknown) => send({ id, result });
    /** Each session's running turn. */
    const running = new Map<string, (typeof turns)[number]>();
    const run = (sessionId: string, runId: string | null) =>
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "run", runId } },
      });
    const end = (code: number | null) => {
      if (!alive) return;
      alive = false;
      exit(code);
    };
    if (options.exitCode !== undefined) {
      const code = options.exitCode;
      queueMicrotask(() => {
        process.onStderr?.("env: harness: No such file or directory\n");
        end(code);
      });
    }
    let sessions = 0;
    return {
      write: async (data) => {
        if (!alive) throw new Error("Broken pipe");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as Message;
          received.push(message);
          const { id, method, params = {} } = message;
          if (!method || options.silent?.includes(method)) continue;
          if (method === "initialize")
            reply(id, {
              protocolVersion: 1,
              agentCapabilities: options.capabilities ?? {
                mcpCapabilities: { http: true },
              },
            });
          else if (method === "session/new")
            reply(id, {
              sessionId: options.cancels
                ? `session-${started.indexOf(record) + 1}-${++sessions}`
                : `session-${++sessions}`,
              configOptions: options.configOptions,
            });
          else if (method === "session/resume" || method === "session/load") {
            const answer = () => {
              for (const update of options.replay ?? [])
                send({
                  method: "session/update",
                  params: { sessionId: params.sessionId, update },
                });
              reply(
                id,
                options.reopened ?? { configOptions: options.configOptions },
              );
            };
            if (options.holdReopen) reopens.push(answer);
            else answer();
          } else if (method === "session/set_config_option") {
            for (const option of options.configOptions ?? [])
              if (option.id === params.configId)
                option.currentValue = params.value;
            reply(id, { configOptions: options.configOptions });
          } else if (method === "session/close") reply(id, {});
          else if (method === "session/prompt" && rejectPrompts > 0) {
            rejectPrompts--;
            send({ id, error: { code: -32000, message: "Sign in first" } });
          } else if (method === "session/prompt" && options.promptError)
            send({ id, error: options.promptError });
          else if (method === "session/prompt") {
            const sessionId = String(params.sessionId);
            const text = (params.prompt as { text: string }[])[0]?.text ?? "";
            const runId = `run-${turns.length + 1}`;
            const turn = {
              sessionId,
              text,
              steered: [] as string[],
              finish: (stopReason = options.stopReason ?? "end_turn") => {
                running.delete(sessionId);
                run(sessionId, null);
                reply(id, { stopReason });
              },
            };
            turns.push(turn);
            running.set(sessionId, turn);
            run(sessionId, runId);
            if (!options.hold) turn.finish();
          } else if (method === "session/cancel" && options.cancels)
            running.get(String(params.sessionId))?.finish("cancelled");
          else if (method === "steer") {
            const turn = running.get(String(params.sessionId));
            if (turn && `run-${turns.indexOf(turn) + 1}` === params.runId) {
              turn.steered.push(String(params.text));
              reply(id, {});
            } else
              send({ id, error: { code: -32602, message: "No active run" } });
          }
        }
      },
      end: async () => undefined,
      kill: async () => {
        record.killed = true;
        record.kills++;
        if (!options.holdExit) end(null);
      },
      exited,
    };
  };
  const sent = (method: string) =>
    received.filter((message) => message.method === method);
  return { spawn, serve, started, received, turns, sent, reopens };
}

const start = (
  harness: ReturnType<typeof fakeHarness>,
  launch: Partial<Parameters<typeof AcpProcess.start>[2]> = {},
  hooks: AcpHooks = HOOKS,
) =>
  AcpProcess.start(harness.spawn, hooks, {
    cwd: "/work",
    serve: harness.serve,
    ...launch,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a harness", () => {
  it("passes the plugin's argv unchanged, with the Buzz identity removed last", async () => {
    const harness = fakeHarness();
    await start(harness, {
      args: ["cursor-agent", "acp", "--model", "x y"],
      env: {
        SHARED: "launch",
        BUZZ_PRIVATE_KEY: "nsec1leak",
        BUZZ_RELAY_URL: "wss://leak",
      },
    });
    const options = harness.started[0]?.options;
    expect(options?.args).toEqual(["cursor-agent", "acp", "--model", "x y"]);
    expect(options?.env).toEqual({
      HOOK: "hook",
      SHARED: "launch",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
    });
  });

  it("refuses a harness that cannot take Buzz tools over HTTP MCP", async () => {
    for (const http of [false, undefined, "yes"]) {
      const harness = fakeHarness({
        capabilities: { mcpCapabilities: { http } },
      });
      await expect(start(harness)).rejects.toThrow(
        "This Harness cannot reach Buzz tools (no HTTP MCP support)",
      );
      expect(harness.started[0]?.killed).toBe(true);
    }
  });

  const diagnosing: AcpHooks = { ...HOOKS, diagnoseStartup: true };

  it("names the install hint when the program is missing or cannot run", async () => {
    for (const exitCode of [127, 126]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, diagnosing)).rejects.toThrow(
        "Install the harness CLI.",
      );
    }
  });

  it("reports another early exit as itself", async () => {
    const harness = fakeHarness({ exitCode: 1 });
    await expect(start(harness, {}, diagnosing)).rejects.toThrow(
      "env: harness: No such file or directory",
    );
  });

  it("reports goose's early exit by its code alone", async () => {
    for (const exitCode of [1, 127]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, GOOSE)).rejects.toThrow(
        new Error(`goose exited (${exitCode})`),
      );
    }
  });

  it("stops a harness that never answers initialize", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"] });
    const starting = start(harness);
    const failed = expect(starting).rejects.toThrow(
      "Harness did not answer initialize in 60s",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("rejects at once when cancelled while it starts, even if it never exits", async () => {
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("leaves no request deadline behind when cancelled while it starts", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    // Only the background stop's own wait is left.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(harness.started[0]?.kills).toBe(1);
  });

  it("rejects at once when cancelled while the host is still starting it, and stops the late harness", async () => {
    const harness = fakeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spawn: typeof harness.spawn = async (...args) => {
      await gate;
      return harness.spawn(...args);
    };
    const controller = new AbortController();
    const starting = AcpProcess.start(spawn, HOOKS, {
      cwd: "/work",
      serve: harness.serve,
      signal: controller.signal,
    });
    const outcome = starting.then(
      () => "started",
      (error: Error) => error.message,
    );
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await flush();
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(
      "Check was cancelled",
    );
    expect(harness.started).toEqual([]);
    release();
    await flush();
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("starts nothing when already cancelled", async () => {
    const harness = fakeHarness();
    const controller = new AbortController();
    controller.abort(new Error("Removed"));
    await expect(start(harness, { signal: controller.signal })).rejects.toThrow(
      "Removed",
    );
    expect(harness.started).toEqual([]);
  });

  it("stops within its time limit, for a check that opens no session", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    expect(acp.agentCapabilities).toEqual({ mcpCapabilities: { http: true } });
    await acp.stop();
    expect(harness.started[0]?.killed).toBe(true);
    expect(acp.running).toBe(false);
  });

  it("gives up waiting at the time limit for a harness that never exits", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ holdExit: true });
    const acp = await start(harness);
    let stopped = false;
    const stopping = acp.stop(1_000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(harness.started[0]?.killed).toBe(true);
    expect(harness.sent("session/new")).toEqual([]);
  });
});

describe("a session with a steering hook", () => {
  it("steers a message sent while the next turn picks its model into that turn, not the finished one", async () => {
    let selecting: (() => void) | undefined;
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        runId: (update) =>
          update.sessionUpdate !== "run"
            ? null
            : typeof update.runId === "string"
              ? update.runId
              : undefined,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
      // The second turn's model pick waits until released.
      select: (_acp, session, want) =>
        want.model === "slow"
          ? new Promise<void>((resolve) => {
              selecting = () => {
                session.chosen = want;
                resolve();
              };
            })
          : Promise.resolve(),
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      choice: () => ({ provider: "", model: "" }),
    });
    const first = session.send("first");
    await flush();
    // Another model: queued as the next turn rather than steered.
    const second = session.send("second", {}, "slow");
    await flush();
    harness.turns[0]?.finish();
    await flush();
    expect(selecting).toBeDefined();
    const third = session.send("third");
    await flush();
    selecting?.();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    expect(harness.turns[1]?.steered).toEqual(["third"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });
  it("never steers a message stopped while it waits for the run's id", async () => {
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        // The run's id comes only when the test announces it.
        runId: (update) =>
          update.sessionUpdate === "announce" ? String(update.runId) : null,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    session.interrupt();
    session.update({ sessionUpdate: "announce", runId: "run-1" });
    await flush();
    expect(harness.sent("steer")).toEqual([]);
    harness.turns[0]?.finish();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe("a session without hooks", () => {
  it("leads the first prompt with the instructions, once, when ACP's systemPrompt is not advertised", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    const [opened] = harness.sent("session/new");
    expect(opened?.params).not.toHaveProperty("systemPrompt");
    expect(opened?.params).not.toHaveProperty("_meta");
    await session.send("first");
    await session.send("second");
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nfirst",
      "second",
    ]);
  });

  it("keeps the instructions for the next prompt when the first is rejected", async () => {
    const harness = fakeHarness({ rejectPrompts: 1 });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    await expect(session.send("first")).resolves.toMatchObject({
      ok: false,
      error: "Sign in first",
    });
    await expect(session.send("second")).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nsecond",
    ]);
  });

  it("sends the instructions as ACP's systemPrompt when advertised", async () => {
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    expect(harness.sent("session/new")[0]?.params?.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: "Be Buzz." }],
    });
    await session.send("first");
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
  });

  it("queues a message sent mid-turn as the next turn", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
    harness.turns[0]?.finish();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("keeps the harness's error code on a failed turn", async () => {
    const harness = fakeHarness({
      promptError: { code: -32000, message: "Authentication required" },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    await expect(session.send("first")).resolves.toEqual({
      ok: false,
      error: "Authentication required",
      code: -32000,
    });
  });

  it("drops an earlier prompt's error code when a later one is refused", async () => {
    const harness = fakeHarness({ rejectPrompts: 1, stopReason: "refusal" });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    void session.send("first");
    // The latest message owns the burst's error.
    await expect(session.send("second")).resolves.toEqual({
      ok: false,
      error: "Harness refused the request",
    });
  });

  it("asks the harness to close a session only when it advertises close", async () => {
    for (const close of [undefined, {}]) {
      const harness = fakeHarness({
        capabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: close ? { close } : {},
        },
      });
      const acp = await start(harness);
      const session = await acp.open({ cwd: "/work", systemPrompt: "" });
      await acp.close(session);
      expect(harness.sent("session/cancel")).toHaveLength(1);
      expect(harness.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(session.open).toBe(false);
    }
  });
});

describe("the shared server pool", () => {
  it("is used by every agent's sessions unless one is given", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const before = SHARED_POOL.size;
    await sessions.deliver("conversation", "hello", 1);
    expect(SHARED_POOL.size).toBe(before + 1);
    sessions.dispose();
    await flush();
    expect(SHARED_POOL.size).toBe(before);
  });

  it("closes the idle session of either plugin to make room for the other", async () => {
    const pool = new ServerPool(1);
    const goose = fakeGoose({ home: "/home/test" });
    const harness = fakeHarness();
    const launch = async () => ({ workspace: "/work", systemPrompt: "" });
    const choice = () => ({ provider: "", model: "" });
    const gooseSessions = new AgentSessions({
      label: "goose",
      resolveDirectory: goose.resolveDirectory,
      tools,
      process: new SharedProcess(goose, goose.serve),
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });
    const acp = await start(harness);
    const genericSessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });

    await gooseSessions.deliver("goose chat", "hello", 1);
    expect(gooseSessions.snapshot().map((item) => item.key)).toEqual([
      "goose chat",
    ]);
    await genericSessions.deliver("generic chat", "hello", 1);
    expect(gooseSessions.snapshot()).toEqual([]);
    expect(genericSessions.snapshot().map((item) => item.key)).toEqual([
      "generic chat",
    ]);
    expect(goose.geese[0]?.closed).toEqual(["session-1"]);

    await gooseSessions.deliver("goose chat", "again", 2);
    expect(genericSessions.snapshot()).toEqual([]);
    expect(pool.size).toBe(1);
    gooseSessions.dispose();
    genericSessions.dispose();
  });
});

/** A pinned agent's sessions over `harness`: `settings` is what `pin` reads
 * now, and `gates` delays an opening's launch until released. */
function pinnedSessions(
  harness: ReturnType<typeof fakeHarness>,
  o: Readonly<{
    saved?: Record<string, SavedConversation>;
    configOptions?: true;
    restart?: () => Promise<{ ok: true }>;
  }> = {},
) {
  const settings = { localKey: "a", context: "ctx", generation: 1 };
  const records = new Map(Object.entries(o.saved ?? {}));
  const writes: string[] = [];
  const holds: { generation: number; released: number }[] = [];
  const gates: Promise<void>[] = [];
  const processes = new Map<number, Promise<AcpProcess>>();
  const sessions = new AgentSessions<{ scope: string }>({
    label: "Harness",
    resolveDirectory: async (path) => path,
    tools,
    pool: new ServerPool(),
    process: {
      get: async (generation) => {
        const id = generation?.id ?? 0;
        if (!processes.has(id)) processes.set(id, start(harness));
        return processes.get(id) as Promise<AcpProcess>;
      },
      hold: (generation) => {
        const hold = { generation: generation.id, released: 0 };
        holds.push(hold);
        return { release: () => void hold.released++ };
      },
      ...(o.restart ? { restart: o.restart } : {}),
    },
    launch: async () => ({ workspace: "/work", systemPrompt: "" }),
    choice: () => ({ provider: "", model: "" }),
    fingerprint: () => "",
    resume: true,
    ...(o.configOptions ? { configOptions: true } : {}),
    store: {
      set: () => undefined,
      load: (key) => records.get(key),
      touch: () => undefined,
      advance: (key, commit) => {
        writes.push(`advance ${key} ${commit.id} ${commit.covered.at}`);
        records.set(key, { at: 0, ...commit });
      },
      drop: (key) => {
        writes.push(`drop ${key}`);
        records.delete(key);
      },
    },
    pin: (): Pinned<{ scope: string }> => ({
      snapshot: { scope: settings.localKey },
      context: settings.context,
      localKey: settings.localKey,
      generation: { id: settings.generation, launch: settings.generation },
    }),
    launchFor: async () => {
      await gates.shift();
      return { workspace: "/work", systemPrompt: "" };
    },
    pickFor: (_pinned, override) => ({ pick: override ?? {}, source: {} }),
  });
  const gate = () => {
    let open!: () => void;
    gates.push(new Promise<void>((resolve) => (open = resolve)));
    return () => open();
  };
  return { sessions, settings, records, writes, holds, gate };
}

/** Lets the fake harness run until `ready` holds. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await flush();
  expect(ready()).toBe(true);
}

const build =
  (at: number) => async (): Promise<{ text: string; through: Mark }> => ({
    text: `through ${at}`,
    through: { at, ids: [`e${at}`] },
  });

describe("a pinned session's record", () => {
  it("is kept by the replacement when a retired opening finishes after it", async () => {
    const harness = fakeHarness({
      holdReopen: true,
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    const saved = {
      chat: { at: 0, id: "saved-S", covered: 0, context: "ctx" },
    };
    const { sessions, records, writes, holds } = pinnedSessions(harness, {
      saved,
    });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.reopens.length === 1);
    sessions.restart();
    expect(await sessions.deliver("chat", "b", 2, { build: build(2) })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    harness.reopens[0]?.();
    expect(await a).toEqual(expect.objectContaining({ ok: true }));
    await flush();
    // B opened new while A still loaded saved-S: they never share it.
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "saved-S",
    ]);
    expect(writes).toEqual(["drop chat", "advance chat session-1 2"]);
    expect(records.get("chat")?.id).toBe("session-1");
    expect(holds[0]).toEqual({ generation: 1, released: 1 });
    sessions.dispose();
  });

  it("is never written by a busy session retired mid-turn, in either finish order", async () => {
    for (const aFirst of [true, false]) {
      const harness = fakeHarness({ hold: true });
      const { sessions, records, writes } = pinnedSessions(harness);
      const a = sessions.deliver("chat", "a", 1, { build: build(1) });
      await until(() => harness.turns.length === 1);
      sessions.restart();
      expect(writes).toEqual(["drop chat"]);
      const b = sessions.deliver("chat", "b", 2, { build: build(2) });
      await until(() => harness.turns.length === 2);
      const [first, second] = aFirst ? [0, 1] : [1, 0];
      harness.turns[first]?.finish();
      await flush();
      harness.turns[second]?.finish();
      await Promise.all([a, b]);
      await flush();
      // B opened new: it never resumed A's running session.
      expect(harness.sent("session/resume")).toEqual([]);
      expect(writes).toEqual(["drop chat", "advance chat session-2 2"]);
      expect(records.get("chat")?.id).toBe("session-2");
      sessions.dispose();
    }
  });

  it("resumes a saved session whose context matches, and drops one that doesn't", async () => {
    const saved = { chat: { at: 0, id: "old", covered: 4, context: "ctx" } };
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {} },
      },
    });
    const one = pinnedSessions(harness, { saved });
    await one.sessions.deliver("chat", "hi", 5, {
      build: async (from) => ({
        text: `from ${from.at}`,
        through: { at: 5, ids: ["e5"] },
      }),
    });
    expect(harness.sent("session/resume")[0]?.params?.sessionId).toBe("old");
    expect(harness.turns[0]).toEqual(
      expect.objectContaining({ sessionId: "old", text: "from 4" }),
    );
    one.sessions.dispose();

    const other = pinnedSessions(harness, {
      saved: { chat: { ...saved.chat, context: "other" } },
    });
    await other.sessions.deliver("chat", "hi", 5, { build: build(5) });
    expect(other.writes[0]).toBe("drop chat");
    expect(harness.sent("session/new")).toHaveLength(1);
    other.sessions.dispose();
  });

  it("is dropped by a new-session reset", async () => {
    const harness = fakeHarness();
    const { sessions, writes } = pinnedSessions(harness);
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    await sessions.reset("chat", "new");
    expect(writes).toEqual(["advance chat session-1 1", "drop chat"]);
    sessions.dispose();
  });
});

describe("a pinned session's launch generation", () => {
  it("opens on the generation pinned before a save, and releases its hold once, after idle", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("chat", "a", 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    late();
    await until(() => harness.turns.length === 1);
    expect(holds).toEqual([{ generation: 1, released: 0 }]);
    // A final Buzz send would settle early; the hold waits for the prompt.
    harness.turns[0]?.finish();
    await a;
    await flush();
    expect(holds).toEqual([{ generation: 1, released: 1 }]);
    const b = sessions.deliver("chat", "b", 2);
    await until(() => harness.turns.length === 2);
    harness.turns[1]?.finish();
    await b;
    expect(harness.started).toHaveLength(2);
    expect(holds[1]?.generation).toBe(2);
    sessions.dispose();
  });

  it("releases the hold of an opening that fails", async () => {
    const harness = fakeHarness({ silent: [], exitCode: 1 });
    const { sessions, holds } = pinnedSessions(harness);
    const result = await sessions.deliver("chat", "a", 1);
    expect(result.ok).toBe(false);
    expect(holds).toEqual([{ generation: 1, released: 1 }]);
    sessions.dispose();
  });
});

describe("Stop after a pinned session is retired", () => {
  const cancelled = (harness: ReturnType<typeof fakeHarness>) =>
    harness.sent("session/cancel").map((m) => m.params?.sessionId);

  it("still cancels the retired turn of a thread-scoped conversation", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings } = pinnedSessions(harness);
    const a = sessions.deliver("thread T1", "a", 1);
    await until(() => harness.turns.length === 1);
    settings.localKey = "b";
    sessions.reconfigure();
    await sessions.interrupt("thread T1");
    expect(cancelled(harness)).toEqual(["session-1"]);
    for (const turn of harness.turns) turn.finish();
    await a;
    sessions.dispose();
  });

  it("cancels both the retired turn and its replacement in a channel-scoped conversation", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings } = pinnedSessions(harness);
    const a = sessions.deliver("channel", "a", 1);
    await until(() => harness.turns.length === 1);
    settings.localKey = "b";
    sessions.reconfigure();
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 2);
    await sessions.interrupt("channel");
    expect(cancelled(harness).sort()).toEqual(["session-1", "session-2"]);
    for (const turn of harness.turns) turn.finish();
    await Promise.all([a, b]);
    sessions.dispose();
  });

  it("cancels a turn whose session was still opening when a synced change retired it", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("chat", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const stop = sessions.interrupt("chat");
    late();
    await until(() => harness.turns.length === 1);
    await stop;
    expect(cancelled(harness)).toEqual(["session-1"]);
    for (const turn of harness.turns) turn.finish();
    await a;
    sessions.dispose();
  });

  it("cancels a running replacement without waiting on a retired opening", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("channel", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 1);
    const stop = sessions.interrupt("channel");
    await until(() => cancelled(harness).length === 1);
    expect(cancelled(harness)).toEqual(["session-1"]);
    late();
    await stop;
    // Then the retired session, which also closes: each process numbers from 1.
    expect(cancelled(harness).length).toBeGreaterThan(1);
    for (const turn of harness.turns) turn.finish();
    await Promise.all([a, b]);
    sessions.dispose();
  });

  it("leaves a message sent after Stop running when a retired opening finishes", async () => {
    const harness = fakeHarness({ hold: true, cancels: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("channel", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const stop = sessions.interrupt("channel");
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 1);
    late();
    await stop;
    await until(() => harness.turns.length === 2);
    // B came after Stop: only the retired session is cancelled, after its prompt.
    const [replacement, retired] = harness.turns;
    expect([replacement?.text, retired?.text]).toEqual(["b", "a"]);
    expect(replacement?.sessionId).not.toBe(retired?.sessionId);
    // Its close cancels it again.
    expect(new Set(cancelled(harness))).toEqual(new Set([retired?.sessionId]));
    replacement?.finish();
    expect(await b).toEqual(expect.objectContaining({ ok: true }));
    expect(await b).not.toHaveProperty("stopped");
    await a;
    sessions.dispose();
  });
});

describe("routing a pinned message", () => {
  it("keeps a thread's message on its own session after the scope moves to the channel", async () => {
    const harness = fakeHarness();
    const { sessions, settings } = pinnedSessions(harness);
    await sessions.deliver("thread T1", "a", 1);
    settings.localKey = "channel";
    await sessions.deliver("channel", "b", 2);
    // T1's session matches exactly; the channel's matches every thread.
    const match = ({ scope }: { scope: string }) =>
      scope === "a"
        ? { key: "thread T1", exact: true }
        : { key: "channel", exact: false };
    expect(sessions.route(match)?.key).toBe("thread T1");
    sessions.dispose();
  });

  it("never routes to a session Restart retired", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions } = pinnedSessions(harness);
    void sessions.deliver("chat", "a", 1);
    await flush();
    sessions.restart();
    expect(sessions.route(() => ({ key: "chat", exact: true }))).toBe(
      undefined,
    );
    harness.turns[0]?.finish();
    sessions.dispose();
  });
});

describe("a pinned session's options", () => {
  const configOptions = () => [
    {
      id: "m",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    },
    {
      id: "e",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];

  it("sets the model, then the effort, before the prompt, and saves both as Buzz's", async () => {
    const harness = fakeHarness({ configOptions: configOptions() });
    const { sessions, records } = pinnedSessions(harness, {
      configOptions: true,
    });
    await sessions.deliver("chat", "a", 1, {
      model: "smart",
      effort: "high",
      build: build(1),
    });
    expect(
      harness.received
        .filter(
          (m) =>
            m.method?.startsWith("session/s") || m.method === "session/prompt",
        )
        .map((m) => `${m.method} ${m.params?.configId ?? ""}`.trim()),
    ).toEqual([
      "session/set_config_option m",
      "session/set_config_option e",
      "session/prompt",
    ]);
    expect(records.get("chat")?.overridden).toEqual({
      model: true,
      effort: true,
    });
    sessions.dispose();
  });
});

describe("a pinned session's queued default", () => {
  const options = () => [
    {
      id: "m",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    },
    {
      id: "e",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];

  for (const pick of [{ model: "smart" }, { effort: "high" }])
    it(`opens new after a running turn on ${JSON.stringify(pick)}`, async () => {
      const harness = fakeHarness({ hold: true, configOptions: options() });
      const { sessions } = pinnedSessions(harness, { configOptions: true });
      const a = sessions.deliver("chat", "a", 1, { ...pick, build: build(1) });
      await until(() => harness.turns.length === 1);
      const b = sessions.deliver("chat", "b", 2, {
        build: async (from) => ({
          text: `from ${from.at}`,
          through: { at: 2, ids: ["e2"] },
        }),
      });
      await flush();
      harness.turns[0]?.finish();
      await until(() => harness.turns.length === 2);
      harness.turns[1]?.finish();
      await Promise.all([a, b]);
      // The default turn ran on a new session, rebuilt from its start.
      expect(harness.sent("session/new")).toHaveLength(2);
      expect(harness.turns[1]).toEqual(
        expect.objectContaining({ sessionId: "session-2", text: "from -1" }),
      );
      expect(harness.sent("session/set_config_option")).toHaveLength(1);
      sessions.dispose();
    });

  it("queues default turns behind a default turn on the same session", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.turns.length === 1);
    const queued = [2, 3].map((at) =>
      sessions.deliver("chat", `m${at}`, at, { build: build(at) }),
    );
    await flush();
    // Queued without waiting for the running turn to end.
    expect(harness.sent("session/prompt")).toHaveLength(1);
    let done = false;
    const all = Promise.all([a, ...queued]).then(() => (done = true));
    for (let finished = 0; !done; await flush())
      while (finished < harness.turns.length)
        harness.turns[finished++]?.finish();
    await all;
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.sent("session/set_config_option")).toHaveLength(0);
    sessions.dispose();
  });

  it("runs before an explicit turn that arrives while it waits", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    const c = sessions.deliver("chat", "c", 3, {
      model: "smart",
      build: build(3),
    });
    await flush();
    harness.turns[0]?.finish();
    await until(() => harness.turns.length === 2);
    harness.turns[1]?.finish();
    await until(() => harness.turns.length === 3);
    harness.turns[2]?.finish();
    await Promise.all([a, b, c]);
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "through 1",
      "through 2",
      "through 3",
    ]);
    expect(harness.turns[1]?.sessionId).toBe("session-2");
    sessions.dispose();
  });

  it("is cleared by Stop while it waits", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    await flush();
    await sessions.interrupt("chat");
    harness.turns[0]?.finish();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    await a;
    await flush();
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);
    sessions.dispose();
  });

  it("keeps its place when a later waiter is cancelled", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const smart = (at: number, signal?: AbortSignal) =>
      sessions.deliver("chat", `m${at}`, at, {
        model: "smart",
        build: build(at),
        ...(signal ? { signal } : {}),
      });
    const a = smart(1);
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "m2", 2, { build: build(2) });
    const cancel = new AbortController();
    const c = smart(3, cancel.signal);
    const d = smart(4);
    await flush();
    cancel.abort();
    await c;
    await flush();
    let done = false;
    const all = Promise.all([a, b, d]).then(() => (done = true));
    for (let finished = 0; !done; await flush())
      while (finished < harness.turns.length)
        harness.turns[finished++]?.finish();
    await all;
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "through 1",
      "through 2",
      "through 4",
    ]);
    expect(harness.turns[1]?.sessionId).toBe("session-2");
    sessions.dispose();
  });

  it("is still cleared by Stop after the last waiter is cancelled", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    const cancel = new AbortController();
    const c = sessions.deliver("chat", "c", 3, {
      model: "smart",
      build: build(3),
      signal: cancel.signal,
    });
    await flush();
    cancel.abort();
    await c;
    await sessions.interrupt("chat");
    harness.turns[0]?.finish();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    await a;
    await flush();
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);
    sessions.dispose();
  });
});

describe("a load's replayed options", () => {
  it("are kept when the load answers without options, so a pick is set", async () => {
    const model = {
      id: "m",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    };
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [
        { sessionUpdate: "config_option_update", configOptions: [model] },
      ],
      reopened: {},
    });
    const { sessions } = pinnedSessions(harness, {
      configOptions: true,
      saved: { chat: { at: 0, id: "old", covered: 0, context: "ctx" } },
    });
    await sessions.deliver("chat", "a", 1, { model: "smart", build: build(1) });
    expect(harness.sent("session/load")).toHaveLength(1);
    expect(
      harness.sent("session/set_config_option").map((m) => m.params?.value),
    ).toEqual(["smart"]);
    sessions.dispose();
  });
});

describe("reconnecting after sign-in", () => {
  it("fails live sessions, keeps their records, and restarts the process", async () => {
    const harness = fakeHarness();
    const restart = vi.fn(async () => ({ ok: true }) as const);
    const { sessions, writes } = pinnedSessions(harness, { restart });
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    expect(await sessions.reconnect()).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledOnce();
    // Called on the process, which a restart reads its own state from.
    expect(restart.mock.contexts[0]).toBeDefined();
    expect(writes).toEqual(["advance chat session-1 1"]);
    sessions.dispose();
  });
});

describe("reading a transcript", () => {
  it("replays a saved session into turns, giving threadOf only the prompt's start", async () => {
    const long = `thread:t1 ${"x".repeat(10_000)}`;
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: long },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
      ],
    });
    const prefixes: number[] = [];
    const transcript = await readTranscript({
      start: () => start(harness),
      cwd: "/work",
      sessionId: "old",
      threadOf: (prefix) => {
        prefixes.push(prefix.length);
        return prefix.startsWith("thread:t1") ? "t1" : undefined;
      },
    });
    expect(prefixes).toEqual([4096]);
    expect(transcript?.turns).toHaveLength(1);
    expect(transcript?.turns[0]?.threadRootId).toBe("t1");
    expect(harness.sent("session/prompt")).toEqual([]);
    expect(harness.started[0]?.killed).toBe(true);
  });

  const read = (replay: Record<string, unknown>[]) => {
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay,
    });
    return readTranscript({
      start: () => start(harness),
      cwd: "/work",
      sessionId: "old",
      threadOf: () => undefined,
      limits: { turns: 2, items: 2, bytes: 1024 },
    });
  };
  const said = (text: string, messageId: string) => ({
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });

  it("keeps a single turn within its item limit", async () => {
    const replay = [...Array(8).keys()].map((i) => said("hi", `m${i}`));
    const transcript = await read(replay);
    expect(transcript?.turns.flatMap((turn) => turn.items)).toHaveLength(2);
  });

  it("counts a message id and multibyte text in UTF-8 bytes", async () => {
    const long = await read([said("hi", "x".repeat(20_000))]);
    expect(long?.turns.flatMap((turn) => turn.items)).toEqual([]);
    const wide = await read([said("é".repeat(1_000), "m")]);
    const [item] = wide?.turns.flatMap((turn) => turn.items) ?? [];
    const text = item?.type === "message" ? item.text : "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
    expect(text).toContain("…[elided 1000 chars]");
  });

  const size = (transcript: unknown) =>
    new TextEncoder().encode(JSON.stringify(transcript)).length;
  const tool = (fields: Record<string, unknown>) => ({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    ...fields,
  });

  it("counts a tool's metadata and every diff entry", async () => {
    const kind = await read([tool({ kind: "k".repeat(20_000) })]);
    expect(size(kind)).toBeLessThan(4096);
    const diff = { type: "diff", path: "", newText: "" };
    const diffs = await read([
      tool({ content: Array.from({ length: 20_000 }, () => diff) }),
    ]);
    expect(size(diffs)).toBeLessThan(4096);
  });

  it("marks a turn partial when it drops the turn's own content", async () => {
    const at = { _meta: { timestamp: 1_000 } };
    const transcript = await read([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "go" },
        ...at,
      },
      ...[...Array(8).keys()].map((i) => ({ ...said("hi", `m${i}`), ...at })),
    ]);
    expect(transcript?.turns.at(-1)?.partial).toBe(true);
  });

  it("counts a user message id in UTF-8 bytes", async () => {
    const transcript = await read([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "x".repeat(20_000),
        content: { type: "text", text: "go" },
        _meta: { timestamp: 1_000 },
      },
    ]);
    const [turn] = transcript?.turns ?? [];
    expect(turn?.items).toEqual([]);
    expect(turn?.partial).toBe(true);
  });
});
