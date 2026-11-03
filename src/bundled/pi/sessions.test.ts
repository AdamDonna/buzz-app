import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentExecution,
  AgentExecutionBinding,
} from "../../features/agents/execution";
import type {
  Agent,
  AgentHandle,
  Delivery,
  StandaloneTurn,
} from "../../features/agents/service";
import type { AgentStore } from "../../features/agents/store";
import { sharedFiles, memoryStorage } from "../../features/agents/test-fakes";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { deferred, fakeHost } from "./pi-testing";
import { DEFAULT_CONFIG, PiRuntime } from "./runtime";
import { PiSessions } from "./sessions";

const owner = "a".repeat(64);
const self = "b".repeat(64);
const channelId = "channel";
const root = "d".repeat(64);
const runtimes: PiSessions[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

function fixture(
  storage: AgentStore = memoryStorage(),
  options: {
    pending?: boolean;
    holdOpen?: boolean;
    staleSnapshot?: boolean;
    recorded?: () => object | Promise<object>;
  } = {},
) {
  const local = fakeHost({
    unfinished: () => ({ submissions: [] }),
    place: () => ({ seen: 0 }),
    places: () => ({
      places: [{ key: `${channelId}/${root}`, conversation: 1, seen: 100 }],
    }),
    deliver: () => ({ submission: 1, conversation: 1 }),
    once: () => ({ submission: 1, conversation: 1 }),
    wait: () => ({ status: "done" }),
  });
  const wait = deferred<object>();
  const allocation = deferred<AgentExecution>();
  const allocated = deferred();
  const targets = new Map<string, ReturnType<typeof target>>();
  const agent = {
    key: self,
    pubkey: self,
    owner,
    name: "Pi",
    publish: vi.fn(async () => ({})),
  } as unknown as AgentHandle;
  const hook = vi.fn(async () => null);
  const file: AddedTool = {
    name: "test_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    call: async (client) => {
      if (!client.read) throw new Error("Missing file reader");
      return Array.from(await client.read("result")).join(",");
    },
  };
  function target(key: string) {
    const places = new Map<string, { conversation: number; seen: number }>();
    const lifetime = new AbortController();
    const host = fakeHost({
      unfinished: () => ({ submissions: [] }),
      places: () => ({
        places: [...places].map(([key, value]) => ({ key, ...value })),
      }),
      place: ({ key }) => ({ seen: places.get(String(key))?.seen ?? 0 }),
      deliver: ({ key, at, request, agent }, process) => {
        places.set(String(key), { conversation: 1, seen: Number(at) });
        process.send({
          method: "event",
          params: { type: "placed", agent, request, conversation: 1, entry: 1 },
        });
        return { conversation: 1, submission: 1 };
      },
      recorded: () => options.recorded?.() ?? { models: {} },
      entries: () => ({
        entries: [
          {
            id: 1,
            kind: "pi.assistant",
            model: [
              {
                role: "assistant",
                content: "Done",
                timestamp: 110000,
                model: "test",
                usage: { input: 1 },
              },
            ],
          },
        ],
      }),
      once: () => ({ conversation: 1, submission: 1 }),
      wait: () => (options.pending ? wait.promise : { status: "done" }),
      session: ({ action }) => {
        if (action === "interrupt")
          wait.resolve({ status: "unanswered", reason: "aborted" });
      },
      abort: () => wait.resolve({ status: "unanswered", reason: "aborted" }),
      protectionContext: ({ conversation }) => {
        if (
          ![...places.values()].some(
            (place) => place.conversation === conversation,
          )
        )
          throw new Error("Conversation is unavailable");
        return [];
      },
    });
    const execution: AgentExecution = {
      workspace: `/remote/${key}`,
      signal: lifetime.signal,
      spawn: host.spawn,
      readFile: vi.fn(async () => new Uint8Array([42])),
      resolveDirectory: vi.fn(async (path) => path),
      dispose: vi.fn(async () => {
        lifetime.abort();
        for (const process of host.processes) process.exit(0);
      }),
    };
    return { host, execution, places, lifetime };
  }
  const execute = vi.fn(
    async (
      _agent: string,
      session: { key: string; intent: string; signal?: AbortSignal },
    ): Promise<AgentExecution | undefined> => {
      // The key must reach durable storage before the adapter sees it.
      expect(
        Object.values(await storage.scan("buzz.pi.sessions.v1:")).some(
          (value) =>
            value === session.key || value.includes(`"key":"${session.key}"`),
        ),
      ).toBe(true);
      let held = targets.get(session.key);
      if (!held || held.lifetime.signal.aborted) {
        const places = held?.places;
        held = target(session.key);
        for (const [key, place] of places ?? []) held.places.set(key, place);
        targets.set(session.key, held);
      }
      allocated.resolve();
      if (options.holdOpen) return allocation.promise;
      return held.execution;
    },
  );
  const inspect = vi.fn(
    async (): Promise<AgentExecutionBinding | undefined> => ({
      provider: "test/remote",
    }),
  );
  const services = {
    storage,
    execution: execute,
    inspectExecution: inspect,
    executionBinding: vi.fn((): AgentExecutionBinding | undefined =>
      options.staleSnapshot ? undefined : { provider: "test/remote" },
    ),
  };
  const runtime = new PiSessions(
    services as never,
    (execution, options) =>
      new PiRuntime(
        { spawn: local.spawn },
        () => undefined,
        async () => undefined,
        () => [file],
        undefined,
        () => agent,
        hook,
        undefined,
        execution,
        { ...options, inspectExecution: inspect },
      ),
  );
  runtime.sync([{ ...agent, config: DEFAULT_CONFIG }] as unknown as Agent[]);
  let request = 0;
  const delivery = (root = "d".repeat(64), pubkey = owner): Delivery =>
    ({
      agent,
      config: DEFAULT_CONFIG,
      channelId,
      trigger: {
        type: "mention",
        event: {
          id: `request-${++request}`,
          pubkey,
          kind: 9,
          created_at: 100 + request,
          content: "Please inspect",
          tags: [
            ["h", channelId],
            ["e", root, "", "reply"],
          ],
        },
      },
      signal: new AbortController().signal,
      workingUntil: vi.fn(),
      ignored: vi.fn(),
    }) as unknown as Delivery;
  const result = async (turn: Delivery) => {
    const calls = vi.mocked(turn.workingUntil).mock.calls;
    let outcome: unknown;
    for (let index = 0; index < calls.length; index++) {
      const value = await calls[index]?.[0];
      if (value !== undefined) outcome = value;
    }
    return outcome;
  };
  const f = {
    runtime,
    services,
    storage,
    targets,
    execute,
    inspect,
    delivery,
    result,
    agent,
    local,
    wait,
    hook,
    allocation,
    allocated,
  };
  runtimes.push(runtime);
  return f;
}

it("keeps targets, controls, files and hooks with their Pi session", async () => {
  const f = fixture(undefined, { pending: true });
  const first = f.delivery();
  await f.runtime.run(first);
  const other = f.delivery("e".repeat(64));
  await f.runtime.run(other);
  const [a, b] = [...f.targets.values()];
  expect(f.targets.size).toBe(2);
  const active = f.runtime.working(self);
  expect(active).toHaveLength(2);
  expect(new Set(active).size).toBe(2);
  // useSyncExternalStore reads the same snapshot until a notification.
  expect(f.runtime.working(self)).toBe(active);
  expect(f.local.processes).toHaveLength(0);
  const keys = [...f.targets.keys()];
  expect(a?.host.processes[0]?.launched).toMatchObject({ session: keys[0] });
  const callback = {
    agent: self,
    conversation: 1,
    context: { channel: channelId, root },
    name: "test_file",
    arguments: {},
  };
  expect(await a?.host.processes[0]?.tool(callback)).toMatchObject({
    result: { content: [{ type: "text", text: "42" }] },
  });
  expect(a?.execution.readFile).toHaveBeenCalledWith("result", {
    cwd: a?.execution.workspace,
  });
  await a?.host.processes[0]?.tool(
    { agent: self, conversation: 1, event: "beforeTool", input: {} },
    "hook",
  );
  expect(f.hook).toHaveBeenCalledWith(self, keys[0], "beforeTool", {});
  await expect(b?.host.processes[0]?.tool(callback)).resolves.toMatchObject({
    error: "Pi callback changes its conversation scope",
  });
  const again = f.delivery();
  await f.runtime.run(again);
  expect(f.targets.size).toBe(2);
  expect(a?.host.processes).toHaveLength(1);
  await expect(
    f.runtime.session(
      { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
      { channelId, root },
      "compact",
    ),
  ).rejects.toThrow("active turn");
  await f.runtime.session(
    { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    { channelId, root },
    "interrupt",
  );
  expect(a?.host.requests("session").at(-1)?.params.action).toBe("interrupt");
  expect(b?.host.requests("session")).toHaveLength(0);
  await Promise.all([f.result(first), f.result(other), f.result(again)]);
  await f.runtime.session(
    { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    { channelId, root },
    "compact",
  );
  expect(a?.host.requests("session").at(-1)?.params.action).toBe("compact");
  expect(b?.host.requests("session")).toHaveLength(0);
  await f.runtime.retire(self);
  expect(a?.execution.dispose).toHaveBeenCalledOnce();
  expect(b?.execution.dispose).toHaveBeenCalledOnce();
});

it("restores the saved key after restart and replaces it on New", async () => {
  const f = fixture();
  await f.runtime.run(f.delivery());
  const key = [...f.targets.keys()][0];
  await f.runtime.retire(self);
  const restored = fixture(f.storage);
  // Use the same target disk, as an adapter that restores a session does.
  restored.execute.mockImplementation(async (_agent, session) => {
    expect(session).toMatchObject({ key, intent: "existing" });
    const disk = f.targets.get(session.key);
    if (!disk) throw new Error("Missing target disk");
    return { ...disk.execution, signal: new AbortController().signal };
  });
  const resumed = restored.delivery();
  await restored.runtime.run(resumed);
  await expect(restored.result(resumed)).resolves.toMatchObject({ ok: true });
  const agent = {
    ...restored.agent,
    config: DEFAULT_CONFIG,
  } as unknown as Agent;
  await restored.runtime.session(agent, { channelId, root }, "new");
  restored.execute.mockReset();
  const connect = f.execute.getMockImplementation();
  if (!connect) throw new Error("Missing target adapter");
  restored.execute.mockImplementation(connect);
  await restored.runtime.run(restored.delivery());
  expect(f.targets.size).toBe(2);
  expect([...f.targets.keys()][1]).not.toBe(key);
});

it("preserves a saved key when allocation fails and refuses missing resumed state", async () => {
  const f = fixture();
  f.execute.mockRejectedValueOnce(new Error("Allocation failed"));
  const failed = f.delivery();
  await f.runtime.run(failed);
  await expect(f.result(failed)).resolves.toMatchObject({
    ok: false,
    error: "Allocation failed",
  });
  const key = f.execute.mock.calls[0]?.[1].key;
  const retry = f.delivery();
  await f.runtime.run(retry);
  await expect(f.result(retry)).resolves.toMatchObject({ ok: true });
  expect(f.execute.mock.calls.every(([, session]) => session.key === key)).toBe(
    true,
  );
  await f.runtime.retire(self);
  const restored = fixture(f.storage);
  const turn = restored.delivery();
  await restored.runtime.run(turn);
  await expect(restored.result(turn)).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("restore this session"),
  });
  expect(
    [...restored.targets.values()][0]?.host.requests("deliver"),
  ).toHaveLength(0);
});

it("does not allocate for settings, models, listing or rejected mentions", async () => {
  const f = fixture();
  await expect(
    f.runtime.setupFor(self).login("provider", "unused-test-key"),
  ).rejects.toThrow("execution target");
  await expect(
    f.runtime.models({ ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent<
      typeof DEFAULT_CONFIG
    >),
  ).resolves.toEqual({ current: "", models: [] });
  expect(f.runtime.sessions(self)).toEqual([]);
  expect(await f.runtime.places(self)).toEqual([]);
  const before = f.storage.keys();
  await expect(
    f.runtime.transcript(
      self,
      { key: `${channelId}/${root}`, channelId, root, at: 0, conversation: 1 },
      false,
      new AbortController().signal,
    ),
  ).rejects.toThrow("no conversation");
  expect(f.storage.keys()).toEqual(before);
  const rejected = f.delivery(root, "c".repeat(64));
  await f.runtime.run(rejected);
  expect(rejected.ignored).toHaveBeenCalledOnce();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.local.processes).toHaveLength(0);
});

it("cancels an adapter open on retirement and disposes its late target", async () => {
  const f = fixture(undefined, { holdOpen: true });
  const turn = f.delivery();
  const running = f.runtime.run(turn);

  await f.allocated.promise;
  const target = [...f.targets][0];
  if (!target) throw new Error("Missing target");
  const [key, remote] = target;
  await f.runtime.retire(self);
  expect(f.execute.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  f.allocation.resolve(remote.execution);
  await running;
  expect(remote.execution.dispose).toHaveBeenCalled();
  expect(remote.host.processes).toHaveLength(0);
  expect(key).toBeTruthy();
});

it("gives standalone turns their own target and closes each target", async () => {
  const f = fixture();
  const turn = {
    delivery: f.delivery(),
    key: "watch",
    signal: new AbortController().signal,
    prompt: async () => "Inspect",
  } as unknown as StandaloneTurn;
  await expect(f.runtime.runOnce(turn)).resolves.toEqual({ ok: true });
  await expect(f.runtime.runOnce(turn)).resolves.toEqual({ ok: true });
  expect(f.targets.size).toBe(2);
  for (const { execution } of f.targets.values())
    expect(execution.dispose).toHaveBeenCalledOnce();
  expect(f.storage.keys()).toEqual([]);
});

it("New invalidates a pending route before the adapter opens", async () => {
  const storage = memoryStorage();
  const read = storage.read;
  const reading = deferred();
  const release = deferred();
  let first = true;
  vi.spyOn(storage, "read").mockImplementation(async (key) => {
    if (first) {
      first = false;
      reading.resolve();
      await release.promise;
    }
    return read(key);
  });
  const f = fixture(storage);
  const running = f.runtime.run(f.delivery());
  const retired = expect(running).rejects.toThrow("retired");
  try {
    await reading.promise;
    await f.runtime.session(
      { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
      { channelId, root },
      "new",
    );
    release.resolve();
    await retired;
    expect(f.execute).not.toHaveBeenCalled();
    await f.runtime.run(f.delivery());
    expect(f.targets.size).toBe(1);
  } finally {
    release.resolve();
  }
});

it("keeps default local Pi turns free of session writes and adapter calls", async () => {
  const f = fixture(undefined, { staleSnapshot: true });
  const add = vi.spyOn(f.storage, "add");
  const set = vi.spyOn(f.storage, "set");
  f.inspect.mockResolvedValue(undefined);
  f.execute.mockResolvedValue(undefined);
  const turn = f.delivery();
  await f.runtime.run(turn);
  await expect(f.result(turn)).resolves.toMatchObject({ ok: true });
  await expect(
    f.runtime.runOnce({
      delivery: f.delivery(),
      key: "watch",
      signal: new AbortController().signal,
      prompt: async () => "Inspect",
    } as unknown as StandaloneTurn),
  ).resolves.toEqual({ ok: true });
  expect(f.execute).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
  expect(f.targets.size).toBe(0);
  expect(f.local.processes).toHaveLength(1);
});

it("uses one target for channel scope across different threads", async () => {
  const f = fixture();
  const config = { ...DEFAULT_CONFIG, scope: "channel" as const };
  f.runtime.sync([{ ...f.agent, config }] as unknown as Agent[]);
  const first = { ...f.delivery(), config };
  const next = { ...f.delivery("e".repeat(64)), config };
  await f.runtime.run(first);
  await f.runtime.run(next);
  expect(f.targets.size).toBe(1);
  expect([...f.targets.values()][0]?.host.requests("deliver")).toHaveLength(2);
});

it("holds deliveries until New saves its pointer and closes the old runtime", async () => {
  const f = fixture();
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  const old = [...f.targets.values()][0];
  const writing = deferred();
  const release = deferred();
  const set = f.storage.set;
  let hold = true;
  vi.spyOn(f.storage, "set").mockImplementation(async (key, text) => {
    if (hold && key.includes(":session:") && text && !JSON.parse(text).opened) {
      hold = false;
      writing.resolve();
      await release.promise;
    }
    await set(key, text);
  });
  const changing = f.runtime.session(
    { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    { channelId, root },
    "new",
  );
  try {
    await writing.promise;
    const next = f.delivery();
    let handed = false;
    const running = f.runtime.run(next).then(() => {
      handed = true;
    });
    // In-memory admission work finishes before the next event-loop task.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(old?.host.requests("deliver")).toHaveLength(1);
    expect(f.targets.size).toBe(1);
    expect(handed).toBe(true);
    expect(next.workingUntil).toHaveBeenCalledOnce();
    release.resolve();
    await changing;
    await running;
    await expect(f.result(next)).resolves.toMatchObject({ ok: true });
    expect(f.targets.size).toBe(2);
    expect(old?.execution.dispose).toHaveBeenCalledOnce();
    expect(old?.host.requests("deliver")).toHaveLength(1);
  } finally {
    release.resolve();
    await changing;
  }
});

it("cancels standalone adapter setup without retiring the agent", async () => {
  const f = fixture();
  const entered = deferred<AbortSignal>();
  const allocation = deferred<AgentExecution>();
  f.execute.mockImplementationOnce(async (_agent, session) => {
    const signal = session.signal;
    if (!signal) throw new Error("Missing setup signal");
    entered.resolve(signal);
    const stop = () => allocation.reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    try {
      return await allocation.promise;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  });
  const lifetime = new AbortController();
  const running = f.runtime.runOnce({
    delivery: f.delivery(),
    key: "watch",
    signal: lifetime.signal,
    prompt: async () => "Inspect",
  } as unknown as StandaloneTurn);
  try {
    const signal = await entered.promise;
    lifetime.abort(new Error("Stop standalone"));
    expect(signal.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({
      ok: false,
      error: "Stop standalone",
    });
    expect(f.storage.keys()).toEqual([]);
    const next = f.delivery();
    await f.runtime.run(next);
    await expect(f.result(next)).resolves.toMatchObject({ ok: true });
    expect(f.targets.size).toBe(1);
  } finally {
    allocation.reject(new Error("Release setup"));
    await running;
  }
});

it("uses confirmed selection for stale-window listings and controls", async () => {
  const f = fixture(undefined, { pending: true, staleSnapshot: true });
  const inspection = deferred<AgentExecutionBinding | undefined>();
  f.inspect.mockImplementationOnce(() => inspection.promise);
  expect(f.runtime.sessions(self)).toEqual([]);
  const pending = f.runtime.working(self);
  expect(pending).toEqual([]);
  expect(f.runtime.working(self)).toBe(pending);
  expect(f.local.processes).toHaveLength(0);
  inspection.resolve({ provider: "test/remote" });
  await f.runtime.places(self);
  const turn = f.delivery();
  await f.runtime.run(turn);
  const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
  expect(f.runtime.sessions(self)).toMatchObject([
    { channelId, root, status: "Working" },
  ]);
  expect(f.runtime.working(self)).toHaveLength(1);
  expect(f.runtime.sessionState(agent, { channelId, root })).toBe("active");
  await expect(
    f.runtime.session(agent, { channelId, root }, "new"),
  ).rejects.toThrow("active turn");
  expect(f.local.processes).toHaveLength(0);
  f.wait.resolve({ status: "done" });
  await f.result(turn);
});

it("keeps equal conversation numbers distinct in usage from two targets", async () => {
  const f = fixture();
  const first = f.delivery();
  const second = f.delivery("e".repeat(64));
  await f.runtime.run(first);
  await f.runtime.run(second);
  await Promise.all([f.result(first), f.result(second)]);
  const usage = await f.runtime.usage(self, 0, new AbortController().signal);
  expect(usage.map((session) => session.id).sort()).toEqual(
    [...f.targets.keys()].map((key) => `${key}/1`).sort(),
  );
  expect(usage).toHaveLength(2);
  expect(
    usage.every((session) => session.observations[0]?.tokens.input === 1),
  ).toBe(true);
});

it("shows a later remote selection after confirmed local use", async () => {
  const f = fixture(undefined, { staleSnapshot: true });
  f.inspect.mockResolvedValue(undefined);
  f.execute.mockResolvedValue(undefined);
  const turn = f.delivery();
  await f.runtime.run(turn);
  await f.result(turn);
  await f.runtime.places(self);
  expect(f.runtime.sessions(self)).toHaveLength(1);
  f.services.executionBinding.mockReturnValue({ provider: "test/remote" });
  expect(f.runtime.sessions(self)).toEqual([]);
  expect(f.runtime.working(self)).toEqual([]);
  const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
  expect(f.runtime.sessionState(agent, { channelId, root })).toBe("idle");
  expect(f.execute).not.toHaveBeenCalled();
});

it("tracks a submitted turn until it settles when session metadata cannot be saved", async () => {
  const f = fixture(undefined, { pending: true });
  const set = f.storage.set;
  vi.spyOn(f.storage, "set").mockImplementation(async (key, text) => {
    if (text && JSON.parse(text).conversation !== undefined)
      throw new Error("Metadata write failed");
    return set(key, text);
  });
  const turn = f.delivery();
  try {
    await f.runtime.run(turn);
    // Handover and its failure handlers finish before the next event-loop task.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const remote = [...f.targets.values()][0];
    expect(remote?.host.requests("wait")).toHaveLength(1);
    expect(
      f.runtime.sessionState(
        { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
        { channelId, root },
      ),
    ).toBe("active");
    f.wait.resolve({ status: "done" });
    await expect(f.result(turn)).resolves.toMatchObject({
      ok: false,
      error: "Metadata write failed",
    });
  } finally {
    f.wait.resolve({ status: "done" });
  }
});

it("includes replaced conversations in usage", async () => {
  const f = fixture();
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  const oldKey = [...f.targets.keys()][0];
  await f.runtime.session(
    { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    { channelId, root },
    "new",
  );
  const next = f.delivery();
  await f.runtime.run(next);
  await f.result(next);
  expect(f.runtime.sessions(self)).toHaveLength(1);
  const usage = await f.runtime.usage(self, 0, new AbortController().signal);
  expect(usage.map((session) => session.id).sort()).toEqual(
    [...f.targets.keys()].map((key) => `${key}/1`).sort(),
  );
  expect(usage).toHaveLength(2);
  expect(usage.some((session) => session.id === `${oldKey}/1`)).toBe(true);
});

it("filters old sessions before restoring targets for usage", async () => {
  const f = fixture();
  const turn = f.delivery();
  await f.runtime.run(turn);
  await f.result(turn);
  await f.runtime.retire(self);
  f.execute.mockClear();
  await expect(
    f.runtime.usage(self, 200000, new AbortController().signal),
  ).resolves.toEqual([]);
  expect(f.execute).not.toHaveBeenCalled();
});

it("rejects New during a current turn after usage restores session history", async () => {
  const options = { pending: false };
  const f = fixture(undefined, options);
  const agent = { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent;
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  await f.runtime.session(agent, { channelId, root }, "new");
  const next = f.delivery();
  await f.runtime.run(next);
  await f.result(next);
  await f.runtime.retire(self);
  const restored = fixture(f.storage);
  const connect = f.execute.getMockImplementation();
  if (!connect) throw new Error("Missing target adapter");
  restored.execute.mockImplementation(connect);
  expect(
    await restored.runtime.usage(self, 0, new AbortController().signal),
  ).toHaveLength(2);
  options.pending = true;
  const active = restored.delivery();
  try {
    await restored.runtime.run(active);
    await expect(
      restored.runtime.session(agent, { channelId, root }, "new"),
    ).rejects.toThrow("active turn");
    expect(restored.runtime.sessionState(agent, { channelId, root })).toBe(
      "active",
    );
  } finally {
    f.wait.resolve({ status: "done" });
    await restored.result(active);
  }
});

it.each([
  {
    failure: "expired replaced target",
    code: "EXECUTION_SESSION_RESET_REQUIRED",
    omit: true,
    cancel: false,
  },
  {
    failure: "other replaced target error",
    code: "EXECUTION_UNAVAILABLE",
    omit: false,
    cancel: false,
  },
  {
    failure: "cancelled history read",
    code: "EXECUTION_SESSION_RESET_REQUIRED",
    omit: false,
    cancel: true,
  },
])("keeps healthy usage with $failure", async ({ code, omit, cancel }) => {
  const f = fixture();
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  const oldKey = [...f.targets.keys()][0];
  await f.runtime.session(
    { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
    { channelId, root },
    "new",
  );
  const next = f.delivery();
  await f.runtime.run(next);
  await f.result(next);
  const currentKey = [...f.targets.keys()][1];
  await f.runtime.retire(self);
  const connect = f.execute.getMockImplementation();
  if (!connect) throw new Error("Missing target adapter");
  const lifetime = new AbortController();
  const failure = Object.assign(new Error("Target unavailable"), { code });
  const stopped = new Error("Usage cancelled");
  f.execute.mockImplementation(async (agent, session) => {
    if (session.key === oldKey) {
      if (cancel) lifetime.abort(stopped);
      throw failure;
    }
    return connect(agent, session);
  });
  const usage = f.runtime.usage(self, 0, lifetime.signal);
  if (omit) {
    const snapshots = await usage;
    expect(
      snapshots.find((session) => session.id === `${currentKey}/1`),
    ).toMatchObject({ gaps: [], observations: [expect.any(Object)] });
    expect(
      snapshots.find((session) => session.id === `${oldKey}/1`),
    ).toMatchObject({ gaps: [expect.any(String)], observations: [] });
  } else {
    await expect(usage).rejects.toBe(cancel ? stopped : failure);
  }
});

it("keeps reset errors visible for current usage and resume", async () => {
  const f = fixture();
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  const key = [...f.targets.keys()][0];
  await f.runtime.retire(self);
  const failure = Object.assign(new Error("Start a new session"), {
    code: "EXECUTION_SESSION_RESET_REQUIRED",
  });
  f.execute.mockRejectedValue(failure);
  await expect(
    f.runtime.usage(self, 0, new AbortController().signal),
  ).rejects.toBe(failure);
  await expect(
    f.runtime.transcript(
      self,
      { key: `${channelId}/${root}`, channelId, root, at: 0, conversation: 1 },
      false,
      new AbortController().signal,
    ),
  ).rejects.toBe(failure);
  const resumed = f.delivery();
  await f.runtime.run(resumed);
  await expect(f.result(resumed)).resolves.toMatchObject({
    ok: false,
    error: failure.message,
  });
  expect(f.execute.mock.calls.every(([, session]) => session.key === key)).toBe(
    true,
  );
  expect(f.execute.mock.calls.at(-1)?.[1].intent).toBe("existing");
});

it("discovers another window's sessions through places and usage after handoff", async () => {
  const files = sharedFiles();
  const f = fixture(files.open());
  const reader = fixture(files.open());
  const usageReader = fixture(files.open());
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  await f.runtime.retire(self);
  expect(reader.runtime.sessions(self)).toEqual([]);
  expect(await reader.runtime.places(self)).toHaveLength(1);
  expect(reader.runtime.sessions(self)).toHaveLength(1);
  expect(reader.execute).not.toHaveBeenCalled();
  const connect = f.execute.getMockImplementation();
  if (!connect) throw new Error("Missing target adapter");
  usageReader.execute.mockImplementation(connect);
  const usage = await usageReader.runtime.usage(
    self,
    0,
    new AbortController().signal,
  );
  expect(usage).toHaveLength(1);
  expect(usage[0]?.observations).toHaveLength(1);
  expect(usageReader.runtime.sessions(self)).toHaveLength(1);
});

it.each(["success", "failure"])(
  "closes usage-only runtimes after %s",
  async (outcome) => {
    const options = {
      recorded: () => {
        if (outcome === "failure") throw new Error("Usage read failed");
        return { models: {} };
      },
    };
    const f = fixture(undefined, options);
    const turn = f.delivery();
    await f.runtime.run(turn);
    await f.result(turn);
    await f.runtime.retire(self);
    const reading = f.runtime.usage(self, 0, new AbortController().signal);
    if (outcome === "failure")
      await expect(reading).rejects.toThrow("Usage read failed");
    else expect(await reading).toHaveLength(1);
    const restored = [...f.targets.values()][0];
    expect(restored?.execution.dispose).toHaveBeenCalledOnce();
    expect(restored?.execution.signal.aborted).toBe(true);
  },
);

it("keeps a usage runtime when a delivery joins its held read", async () => {
  const entered = deferred();
  const release = deferred<object>();
  const options = {
    pending: false,
    recorded: () => {
      entered.resolve();
      return release.promise;
    },
  };
  const f = fixture(undefined, options);
  const first = f.delivery();
  await f.runtime.run(first);
  await f.result(first);
  await f.runtime.retire(self);
  const reading = f.runtime.usage(self, 0, new AbortController().signal);
  let active: Delivery | undefined;
  try {
    await entered.promise;
    options.pending = true;
    active = f.delivery();
    await f.runtime.run(active);
    release.resolve({ models: {} });
    expect(await reading).toHaveLength(1);
    const current = [...f.targets.values()][0];
    expect(current?.execution.dispose).not.toHaveBeenCalled();
    expect(f.runtime.working(self)).toHaveLength(1);
  } finally {
    release.resolve({ models: {} });
    f.wait.resolve({ status: "done" });
    await reading;
    if (active) await f.result(active);
  }
});

it.each(["interrupt", "activity", "admission"])(
  "cancels pending allocation on %s and retries its saved key",
  async (action) => {
    const f = fixture();
    const entered = deferred<AbortSignal>();
    const release = deferred<AgentExecution>();
    f.execute.mockImplementationOnce(async (_agent, session) => {
      const signal = session.signal;
      if (!signal) throw new Error("Missing allocation signal");
      const abort = () => release.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      entered.resolve(signal);
      try {
        return await release.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    const admission = new AbortController();
    const turn = {
      ...f.delivery(),
      signal: admission.signal,
      interruptible: vi.fn<NonNullable<Delivery["interruptible"]>>(),
    };
    const running = f.runtime.run(turn);
    let stopped: Promise<void> | undefined;
    try {
      const signal = await entered.promise;
      if (action === "interrupt") {
        stopped = f.runtime.session(
          { ...f.agent, config: DEFAULT_CONFIG } as unknown as Agent,
          { channelId, root },
          "interrupt",
        );
      } else if (action === "activity") {
        const stop = turn.interruptible.mock.calls[0]?.[0];
        if (!stop) throw new Error("Pending turn has no interrupt handler");
        stopped = stop();
      } else admission.abort(new Error("Admission ended"));
      // Memory-backed control reads finish before the next event-loop task.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signal.aborted).toBe(true);
      await stopped;
      await running;
      await f.result(turn);
      const saved = f.execute.mock.calls[0]?.[1].key;
      const retry = f.delivery();
      const retryCall = f.execute.mock.calls.length;
      await f.runtime.run(retry);
      await expect(f.result(retry)).resolves.toMatchObject({ ok: true });
      expect(f.execute.mock.calls[retryCall]?.[1]).toMatchObject({
        key: saved,
        intent: "new",
      });
    } finally {
      release.reject(new Error("Release allocation"));
      await running;
      await stopped?.catch(() => undefined);
    }
  },
);

it("keeps established execution alive after an admission deadline", async () => {
  const f = fixture(undefined, { pending: true });
  const admission = new AbortController();
  const turn = { ...f.delivery(), signal: admission.signal };
  try {
    await f.runtime.run(turn);
    admission.abort(new Error("Admission ended"));
    const current = [...f.targets.values()][0];
    expect(current?.execution.signal.aborted).toBe(false);
    expect(current?.execution.dispose).not.toHaveBeenCalled();
    f.wait.resolve({ status: "done" });
    await expect(f.result(turn)).resolves.toMatchObject({ ok: true });
  } finally {
    f.wait.resolve({ status: "done" });
  }
});

it("keeps a shared usage runtime until its final reader leaves", async () => {
  const entered = [deferred(), deferred()];
  const release = [deferred<object>(), deferred<object>()];
  let index = 0;
  const f = fixture(undefined, {
    recorded: () => {
      const reading = index++;
      entered[reading]?.resolve();
      const gate = release[reading];
      if (!gate) throw new Error("Unexpected usage read");
      return gate.promise;
    },
  });
  const turn = f.delivery();
  await f.runtime.run(turn);
  await f.result(turn);
  await f.runtime.retire(self);
  const first = f.runtime.usage(self, 0, new AbortController().signal);
  let second: ReturnType<PiSessions["usage"]> | undefined;
  try {
    await entered[0]?.promise;
    second = f.runtime.usage(self, 0, new AbortController().signal);
    await entered[1]?.promise;
    const current = [...f.targets.values()][0];
    release[0]?.resolve({ models: {} });
    await first;
    expect(current?.execution.dispose).not.toHaveBeenCalled();
    release[1]?.resolve({ models: {} });
    await second;
    expect(current?.execution.dispose).toHaveBeenCalledOnce();
  } finally {
    for (const gate of release) gate.resolve({ models: {} });
    await Promise.all([first, second]);
  }
});

it.each([false, true])(
  "releases a cancelled usage read with retained runtime %s",
  async (retained) => {
    const entered = deferred();
    const release = deferred<object>();
    const f = fixture(undefined, {
      recorded: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const first = f.delivery();
    await f.runtime.run(first);
    await f.result(first);
    if (!retained) await f.runtime.retire(self);
    const lifetime = new AbortController();
    const stopped = new Error("Usage read cancelled");
    let outcome: unknown;
    const reading = f.runtime.usage(self, 0, lifetime.signal).catch((error) => {
      outcome = error;
    });
    try {
      await entered.promise;
      const current = [...f.targets.values()][0];
      lifetime.abort(stopped);
      // Abort handlers and their cleanup finish before the next event-loop task.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe(stopped);
      expect(current?.execution.signal.aborted).toBe(!retained);
    } finally {
      release.resolve({ models: {} });
      await reading;
    }
  },
);

it("rejects usage from a guest conversation that differs from saved metadata", async () => {
  const f = fixture();
  const turn = f.delivery();
  await f.runtime.run(turn);
  await f.result(turn);
  const target = [...f.targets.values()][0];
  if (!target) throw new Error("Missing target");
  target.places.set(`${channelId}/${root}`, { conversation: 2, seen: 101 });
  await expect(
    f.runtime.usage(self, 0, new AbortController().signal),
  ).rejects.toThrow("saved conversation");
});
