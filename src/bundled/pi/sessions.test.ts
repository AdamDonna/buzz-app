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
import { memoryStorage } from "../../features/agents/test-fakes";
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
  storage = memoryStorage(),
  options: { pending?: boolean; holdOpen?: boolean } = {},
) {
  const local = fakeHost({
    unfinished: () => ({ submissions: [] }),
    place: () => ({ seen: 0 }),
    deliver: () => ({ submission: 1, conversation: 1 }),
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
        storage
          .keys()
          .some(
            (key) =>
              storage.get(key) === session.key ||
              storage.get(key)?.includes(`"key":"${session.key}"`),
          ),
      ).toBe(true);
      let held = targets.get(session.key);
      if (!held) {
        held = target(session.key);
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
    executionBinding: () => ({ provider: "test/remote" }),
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
  const result = (turn: Delivery) =>
    vi.mocked(turn.workingUntil).mock.calls[0]?.[0];
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

it("keeps local Pi turns local after the atomic execution claim", async () => {
  const f = fixture();
  f.inspect.mockResolvedValue(undefined);
  f.execute.mockResolvedValue(undefined);
  const turn = f.delivery();
  await f.runtime.run(turn);
  await expect(f.result(turn)).resolves.toMatchObject({ ok: true });
  expect(f.execute).toHaveBeenCalledWith(self, {
    key: expect.any(String),
    intent: "new",
  });
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
    const running = f.runtime.run(next);
    // In-memory admission work finishes before the next event-loop task.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(old?.host.requests("deliver")).toHaveLength(1);
    expect(f.targets.size).toBe(1);
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
