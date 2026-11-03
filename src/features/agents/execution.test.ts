import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAgentExecutions,
  type AgentExecutionProvider,
  type AgentExecutionTarget,
} from "./execution";
import { memoryStorage, sharedFiles } from "./test-fakes";
import type { AgentStore } from "./store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agent = "a".repeat(64);
const harness = "buzz.pi/pi";
const input = { id: "remote", config: { profile: "scratch" } };
const session = { key: "session-1", intent: "new" as const };
const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
});

async function setup(storage: AgentStore = memoryStorage()) {
  const root = new Context();
  roots.push(root);
  let active = true;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const registry = createAgentExecutions(root, storage);
  const ended = deferred<number | null>();
  const process = {
    write: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    kill: vi.fn(async () => {
      ended.resolve(null);
    }),
    exited: ended.promise,
  };
  const target: AgentExecutionTarget = {
    workspace: "/work/task",
    spawn: vi.fn(async () => process),
    readFile: vi.fn(async () => new Uint8Array([1, 2])),
    resolveDirectory: vi.fn(async (path) => path),
    dispose: vi.fn(async () => {}),
  };
  const connect = vi.fn<AgentExecutionProvider["connect"]>(async () => target);
  let plugin!: Context;
  const fiber = root
    .extend({
      pluginOwner: { id: "internal", revision: "1", agentExecution: [harness] },
    })
    .plugin((ctx) => {
      plugin = ctx;
      registry.register(ctx, {
        id: "remote",
        harnesses: [harness],
        connect,
      });
    });
  await fiber.await();
  const native = root.extend({ pluginOwner: { id: "buzz.pi", revision: "1" } });
  return {
    root,
    registry,
    storage,
    plugin,
    native,
    target,
    connect,
    process,
    fiber,
    deactivate: () => {
      active = false;
      for (const listener of listeners) listener();
    },
  };
}

it("keeps a write-once provider selection across restarts and rejects another harness", async () => {
  const f = await setup();
  await f.registry.bind(f.plugin, agent, harness, input);
  await f.registry.bind(f.plugin, agent, harness, input);
  await expect(
    f.registry.bind(f.plugin, agent, harness, {
      ...input,
      config: { profile: "other" },
    }),
  ).rejects.toThrow("another execution binding");
  const restarted = await setup(f.storage);
  expect(restarted.registry.read(agent)).toEqual({
    provider: "internal/remote",
    config: { profile: "scratch" },
  });
  await expect(
    restarted.registry.check(agent, "buzz.codex/codex"),
  ).rejects.toThrow("does not support");
  expect(restarted.registry.read(agent)?.config).toEqual(input.config);
  await expect(
    f.registry.open(f.plugin, agent, harness, session),
  ).rejects.toThrow("Only the native harness");
  expect(() =>
    f.registry.register(f.native, {
      id: "bad",
      harnesses: [harness],
      connect: async () => f.target,
    }),
  ).toThrow("Declare host.agentExecution");
});

it("shares each session open, isolates new sessions, and forwards resume after restart", async () => {
  const f = await setup();
  f.connect.mockImplementation(async (_binding, requested) => ({
    ...f.target,
    workspace: `/work/${requested.key}`,
  }));
  await f.registry.bind(f.plugin, agent, harness, input);
  const [first, same] = await Promise.all([
    f.registry.open(f.native, agent, harness, session),
    f.registry.open(f.native, agent, harness, session),
  ]);
  expect(first).toBe(same);
  expect(first?.workspace).toBe("/work/session-1");
  expect(f.connect).toHaveBeenCalledOnce();
  const next = await f.registry.open(f.native, agent, harness, {
    key: "session-2",
    intent: "new",
  });
  expect(next).not.toBe(first);
  expect(next?.workspace).toBe("/work/session-2");
  await first?.dispose();
  expect(next?.signal.aborted).toBe(false);
  await expect(next?.readFile("proof.bin")).resolves.toEqual(
    new Uint8Array([1, 2]),
  );
  const restarted = await setup(f.storage);
  await restarted.registry.open(restarted.native, agent, harness, {
    ...session,
    intent: "existing",
  });
  expect(restarted.connect).toHaveBeenCalledWith(
    { provider: "internal/remote", config: input.config },
    expect.objectContaining({ agent, key: session.key, intent: "existing" }),
  );
});

it.each(["caller abort", "joined caller abort", "adapter unload"] as const)(
  "cancels a pending target on %s and disposes a late result",
  async (reason) => {
    const f = await setup();
    const started = deferred<void>();
    const target = deferred<AgentExecutionTarget>();
    f.connect.mockImplementation(() => {
      started.resolve();
      return target.promise;
    });
    await f.registry.bind(f.plugin, agent, harness, input);
    const lifetime = new AbortController();
    const opening = f.registry.open(f.native, agent, harness, {
      ...session,
      ...(reason === "joined caller abort" ? {} : { signal: lifetime.signal }),
    });
    const failed = expect(opening).rejects.toThrow();
    await started.promise;
    const joined =
      reason === "joined caller abort"
        ? expect(
            f.registry.open(f.native, agent, harness, {
              ...session,
              signal: lifetime.signal,
            }),
          ).rejects.toThrow()
        : Promise.resolve();
    if (reason !== "adapter unload")
      lifetime.abort(new Error("Session retired"));
    else f.deactivate();
    await failed;
    await joined;
    target.resolve(f.target);
    await vi.waitFor(() => expect(f.target.dispose).toHaveBeenCalledOnce());
    expect(f.target.spawn).not.toHaveBeenCalled();
  },
);

it("preserves an adapter's reset error and permits a new session", async () => {
  const f = await setup();
  const error = Object.assign(
    new Error("The saved target expired. Start a new session."),
    {
      code: "EXECUTION_SESSION_RESET_REQUIRED",
    },
  );
  f.connect.mockRejectedValueOnce(error);
  await f.registry.bind(f.plugin, agent, harness, input);
  await expect(
    f.registry.open(f.native, agent, harness, {
      ...session,
      intent: "existing",
    }),
  ).rejects.toBe(error);
  expect(f.target.spawn).not.toHaveBeenCalled();
  const next = await f.registry.open(f.native, agent, harness, {
    key: "replacement-session",
    intent: "new",
  });
  expect(next?.workspace).toBe("/work/task");
});

it("retires owned processes on adapter unload and never opens local execution for a saved binding", async () => {
  const f = await setup();
  await f.registry.bind(f.plugin, agent, harness, input);
  const execution = await f.registry.open(f.native, agent, harness, session);
  if (!execution) throw new Error("Missing bound execution");
  const process = await execution.spawn("node");
  f.deactivate();
  expect(execution.signal.aborted).toBe(true);
  await expect(process.write("prompt")).rejects.toBe(execution.signal.reason);
  await expect(execution.readFile("result")).rejects.toThrow();
  await expect(
    f.registry.open(f.native, agent, harness, session),
  ).rejects.toThrow("unavailable");
  await execution.dispose();
  expect(f.process.kill).toHaveBeenCalledOnce();
  expect(f.target.dispose).toHaveBeenCalledOnce();
  expect(f.registry.read(agent)?.config).toEqual(input.config);
});

it("kills a process that finishes starting after its adapter unloads", async () => {
  const f = await setup();
  const starting = deferred<typeof f.process>();
  vi.mocked(f.target.spawn).mockReturnValueOnce(starting.promise);
  await f.registry.bind(f.plugin, agent, harness, input);
  const execution = await f.registry.open(f.native, agent, harness, session);
  if (!execution) throw new Error("Missing bound execution");
  const spawned = execution.spawn("node");
  f.deactivate();
  starting.resolve(f.process);
  await expect(spawned).rejects.toBe(execution.signal.reason);
  expect(f.process.kill).toHaveBeenCalledOnce();
});

it("blocks runtime access until the binding is saved and propagates a failed save", async () => {
  const saved = deferred<void>();
  const disk = sharedFiles();
  const f = await setup(disk.open(saved.promise));
  const binding = f.registry.bind(f.plugin, agent, harness, input);
  await expect(
    f.registry.open(f.native, agent, harness, session),
  ).rejects.toThrow("being saved");
  saved.resolve();
  await binding;
  expect(
    (await f.registry.open(f.native, agent, harness, session))?.workspace,
  ).toBe("/work/task");

  const failed = await setup({
    ...memoryStorage(),
    add: async () => {
      throw new Error("disk full");
    },
  });
  await expect(
    failed.registry.bind(failed.plugin, agent, harness, input),
  ).rejects.toThrow("disk full");
  expect(failed.registry.read(agent)).toBeUndefined();
});

it("refuses to redirect an agent whose local runtime is already open", async () => {
  const f = await setup();
  expect(
    await f.registry.open(f.native, agent, harness, session),
  ).toBeUndefined();
  await expect(
    f.registry.bind(f.plugin, agent, harness, input),
  ).rejects.toThrow("another execution binding");
  expect(f.registry.read(agent)).toBeUndefined();
});

it("reads a binding saved after another window loads, and keeps local selection after restart", async () => {
  const disk = sharedFiles();
  const stale = await setup(disk.open());
  const writer = await setup(disk.open());
  await writer.registry.bind(writer.plugin, agent, harness, input);
  await expect(stale.registry.check(agent, "buzz.codex/codex")).rejects.toThrow(
    "does not support",
  );
  expect(
    (await stale.registry.open(stale.native, agent, harness, session))
      ?.workspace,
  ).toBe("/work/task");

  const localAgent = "b".repeat(64);
  await stale.registry.check(localAgent, harness);
  expect(disk.disk.has(`buzz.agent.execution.v1:${localAgent}`)).toBe(false);
  expect(
    await stale.registry.open(stale.native, localAgent, harness, session),
  ).toBeUndefined();
  const restarted = await setup(disk.open());
  await expect(
    restarted.registry.bind(restarted.plugin, localAgent, harness, input),
  ).rejects.toThrow("another execution binding");
});

it("does not start local work while its durable claim is pending or failed", async () => {
  const saved = deferred<void>();
  const disk = sharedFiles();
  const f = await setup(disk.open(saved.promise));
  const first = f.registry.open(f.native, agent, harness, session);
  const otherRegistry = await setup(f.storage);
  const second = otherRegistry.registry.open(
    otherRegistry.native,
    agent,
    harness,
    session,
  );
  let completed = false;
  void second.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  saved.resolve();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();

  const failed = await setup({
    ...memoryStorage(),
    add: async () => {
      throw new Error("disk full");
    },
  });
  await expect(
    failed.registry.open(failed.native, agent, harness, session),
  ).rejects.toThrow("disk full");
  expect(failed.target.spawn).not.toHaveBeenCalled();
});
