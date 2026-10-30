import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentExecutions, type AgentExecutionTarget } from "./execution";
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
const input = { id: "remote", target: "guest-1", workspace: "/work/task" };
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
    spawn: vi.fn(async () => process),
    readFile: vi.fn(async () => new Uint8Array([1, 2])),
    resolveDirectory: vi.fn(async (path) => path),
    dispose: vi.fn(async () => {}),
  };
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
        connect: () => target,
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
    process,
    fiber,
    deactivate: () => {
      active = false;
      for (const listener of listeners) listener();
    },
  };
}

it("keeps a write-once workspace binding across restarts and rejects another harness", async () => {
  const f = await setup();
  await f.registry.bind(f.plugin, agent, harness, input);
  await f.registry.bind(f.plugin, agent, harness, input);
  await expect(
    f.registry.bind(f.plugin, agent, harness, {
      ...input,
      workspace: "/other",
    }),
  ).rejects.toThrow("another execution binding");
  const restarted = await setup(f.storage);
  expect(restarted.registry.read(agent)).toEqual({
    provider: "internal/remote",
    target: "guest-1",
    workspace: "/work/task",
  });
  expect(() => restarted.registry.check(agent, "buzz.codex/codex")).toThrow(
    "does not support",
  );
  expect(restarted.registry.read(agent)?.workspace).toBe("/work/task");
  expect(() => f.registry.open(f.plugin, agent, harness)).toThrow(
    "Only the native harness",
  );
  expect(() =>
    f.registry.register(f.native, {
      id: "bad",
      harnesses: [harness],
      connect: () => f.target,
    }),
  ).toThrow("Declare host.agentExecution");
});

it("retires owned processes on adapter unload and never opens local execution for a saved binding", async () => {
  const f = await setup();
  await f.registry.bind(f.plugin, agent, harness, input);
  const execution = f.registry.open(f.native, agent, harness);
  if (!execution) throw new Error("Missing bound execution");
  const process = await execution.spawn("node");
  f.deactivate();
  expect(execution.signal.aborted).toBe(true);
  await expect(process.write("prompt")).rejects.toThrow("stopped");
  await expect(execution.readFile("result")).rejects.toThrow();
  expect(() => f.registry.open(f.native, agent, harness)).toThrow(
    "unavailable",
  );
  await execution.dispose();
  expect(f.process.kill).toHaveBeenCalledOnce();
  expect(f.target.dispose).toHaveBeenCalledOnce();
  expect(f.registry.read(agent)?.target).toBe("guest-1");
});

it("kills a process that finishes starting after its adapter unloads", async () => {
  const f = await setup();
  const starting = deferred<typeof f.process>();
  vi.mocked(f.target.spawn).mockReturnValueOnce(starting.promise);
  await f.registry.bind(f.plugin, agent, harness, input);
  const execution = f.registry.open(f.native, agent, harness);
  if (!execution) throw new Error("Missing bound execution");
  const spawned = execution.spawn("node");
  f.deactivate();
  starting.resolve(f.process);
  await expect(spawned).rejects.toThrow("stopped");
  expect(f.process.kill).toHaveBeenCalledOnce();
});

it("blocks runtime access until the binding is saved and propagates a failed save", async () => {
  const saved = deferred<void>();
  const disk = sharedFiles();
  const f = await setup(disk.open(saved.promise));
  const binding = f.registry.bind(f.plugin, agent, harness, input);
  expect(() => f.registry.open(f.native, agent, harness)).toThrow(
    "being saved",
  );
  saved.resolve();
  await binding;
  expect(f.registry.open(f.native, agent, harness)?.binding.target).toBe(
    "guest-1",
  );

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
  expect(f.registry.open(f.native, agent, harness)).toBeUndefined();
  await expect(
    f.registry.bind(f.plugin, agent, harness, input),
  ).rejects.toThrow("before the agent first runs");
  expect(f.registry.read(agent)).toBeUndefined();
});
