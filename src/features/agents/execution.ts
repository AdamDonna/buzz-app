import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import type { HostProcess, HostProcessOptions } from "../host/service";
import { AGENT_KEY, type AgentKey } from "./membership";
import type { AgentStore } from "./store";

export type AgentExecutionBinding = Readonly<{
  provider: string;
  target: string;
  workspace: string;
}>;

export type AgentExecutionTarget = Readonly<{
  spawn(program: string, options?: HostProcessOptions): Promise<HostProcess>;
  readFile(
    path: string,
    options?: Readonly<{ cwd?: string }>,
  ): Promise<Uint8Array>;
  resolveDirectory(path: string): Promise<string>;
  /** Stops owned processes. Repeated calls have the same result. */
  dispose(): Promise<void>;
}>;

export type AgentExecutionProvider = Readonly<{
  id: string;
  harnesses: readonly string[];
  connect(binding: AgentExecutionBinding): AgentExecutionTarget;
}>;

export type AgentExecution = AgentExecutionTarget &
  Readonly<{
    binding: AgentExecutionBinding;
    signal: AbortSignal;
  }>;

const PREFIX = "buzz.agent.execution.v1:";
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const TYPE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
function validate(binding: AgentExecutionBinding) {
  if (
    !TYPE.test(binding?.provider) ||
    typeof binding.target !== "string" ||
    !binding.target.trim() ||
    binding.target.length > 1024 ||
    typeof binding.workspace !== "string" ||
    !binding.workspace.startsWith("/") ||
    [...(binding.target + binding.workspace)].some(
      (character) => character.charCodeAt(0) < 32,
    )
  )
    throw new Error("Invalid agent execution binding");
}

export function createAgentExecutions(root: Context, storage: AgentStore) {
  const providers = createContributions<AgentExecutionProvider>(root);
  const local = new Set<AgentKey>();
  const bindingInFlight = new Set<AgentKey>();
  const opened = new Map<
    AgentKey,
    { revision: string; execution: AgentExecution }
  >();
  const read = (agent: AgentKey): AgentExecutionBinding | undefined => {
    if (!AGENT_KEY.test(agent)) throw new Error("Invalid agent membership key");
    const text = storage.get(PREFIX + agent);
    if (text === null) return;
    const binding = JSON.parse(text) as AgentExecutionBinding;
    validate(binding);
    return Object.freeze(binding);
  };
  const providerFor = (binding: AgentExecutionBinding, harness: string) => {
    const provider = providers
      .snapshot()
      .find((item) => item.key === binding.provider);
    if (!provider)
      throw new Error(
        `Agent execution provider ${binding.provider} is unavailable`,
      );
    if (!provider.harnesses.includes(harness))
      throw new Error(`Agent execution provider does not support ${harness}`);
    return provider;
  };
  const retire = (agent: AgentKey, execution: AgentExecution) => {
    opened.delete(agent);
    void execution
      .dispose()
      .catch((error) =>
        console.error(`Agent ${agent} execution cleanup failed`, error),
      );
  };
  root.effect(() =>
    providers.subscribe(() => {
      for (const [agent, { execution, revision }] of opened)
        if (
          !providers
            .snapshot()
            .some(
              (provider) =>
                provider.key === execution.binding.provider &&
                provider.revision === revision,
            )
        )
          retire(agent, execution);
    }),
  );
  root.effect(() => () => {
    for (const [agent, { execution }] of opened) retire(agent, execution);
  });
  return {
    read,
    register(ctx: Context, provider: AgentExecutionProvider) {
      if (
        !ID.test(provider.id) ||
        !provider.harnesses.length ||
        typeof provider.connect !== "function"
      )
        throw new Error(
          "An execution provider needs an id, harnesses and connect",
        );
      for (const harness of provider.harnesses)
        if (!ctx.pluginOwner?.agentExecution?.includes(harness))
          throw new Error(`Declare host.agentExecution access for ${harness}`);
      providers.register(ctx, {
        ...provider,
        harnesses: Object.freeze([...provider.harnesses]),
      });
    },
    async bind(
      ctx: Context,
      agent: AgentKey,
      harness: string,
      input: Readonly<{ id: string; target: string; workspace: string }>,
    ) {
      if (!ctx.pluginOwner || !ID.test(input.id))
        throw new Error("Invalid execution provider");
      const binding = Object.freeze({
        provider: `${ctx.pluginOwner.id}/${input.id}`,
        target: input.target,
        workspace: input.workspace,
      });
      validate(binding);
      providerFor(binding, harness);
      if (!AGENT_KEY.test(agent))
        throw new Error("Invalid agent membership key");
      if (local.has(agent))
        throw new Error(
          "Bind execution before the agent first runs on this device",
        );
      const text = JSON.stringify(binding);
      if (bindingInFlight.has(agent))
        throw new Error("The execution binding is being saved");
      bindingInFlight.add(agent);
      try {
        const saved = await storage.add(PREFIX + agent, text);
        if (saved !== text)
          throw new Error("The agent already has another execution binding");
      } finally {
        bindingInFlight.delete(agent);
      }
    },
    check(agent: AgentKey, harness: string) {
      if (bindingInFlight.has(agent))
        throw new Error("The execution binding is being saved");
      const binding = read(agent);
      if (binding) providerFor(binding, harness);
    },
    open(
      ctx: Context,
      agent: AgentKey,
      harness: string,
    ): AgentExecution | undefined {
      if (!ctx.pluginOwner || !harness.startsWith(`${ctx.pluginOwner.id}/`))
        throw new Error("Only the native harness can open its agent execution");
      if (bindingInFlight.has(agent))
        throw new Error("The execution binding is being saved");
      const binding = read(agent);
      if (!binding) {
        local.add(agent);
        return;
      }
      const provider = providerFor(binding, harness);
      const held = opened.get(agent);
      if (held && !held.execution.signal.aborted) return held.execution;
      const target = provider.connect(binding);
      const lifetime = new AbortController();
      const processes = new Set<HostProcess>();
      const check = () => {
        lifetime.signal.throwIfAborted();
        if (!providers.snapshot().includes(provider))
          throw new Error("The agent execution provider changed");
      };
      let disposed: Promise<void> | undefined;
      const execution: AgentExecution = Object.freeze({
        binding,
        signal: lifetime.signal,
        spawn: async (program, options) => {
          check();
          if (options?.mcp || options?.protection)
            throw new Error(
              "This execution path does not support native MCP servers or containment",
            );
          const process = await target.spawn(program, options);
          if (lifetime.signal.aborted) {
            await process.kill();
            lifetime.signal.throwIfAborted();
          }
          processes.add(process);
          void process.exited.then(() => processes.delete(process));
          return Object.freeze({
            write: async (data: string) => {
              check();
              await process.write(data);
            },
            end: async (data?: string) => {
              check();
              await process.end(data);
            },
            kill: () => process.kill(),
            exited: process.exited,
          });
        },
        readFile: async (path, options) => {
          check();
          const data = await target.readFile(path, options);
          check();
          return data;
        },
        resolveDirectory: async (path) => {
          check();
          const directory = await target.resolveDirectory(path);
          check();
          return directory;
        },
        dispose: () => {
          lifetime.abort(new Error("The agent execution stopped"));
          disposed ??= Promise.all(
            [...processes].map((process) => process.kill()),
          )
            .then(() => undefined)
            .finally(() => target.dispose());
          return disposed;
        },
      });
      opened.set(agent, { revision: provider.revision, execution });
      return execution;
    },
  };
}
