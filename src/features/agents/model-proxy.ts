import type { Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import { withTimeout } from "../../plugins/timeout";

/** Native wire body without authentication headers. Path is relative to upstream. */
export type ModelProxyRequest = Readonly<{ path: string; body: string }>;
/** A request transformation, looked up anew for every model request. */
export type AgentModelProxy = Readonly<{
  id: string;
  harness: string;
  run(
    request: ModelProxyRequest,
  ): Promise<string | undefined> | string | undefined;
}>;

export function createModelProxies(root: Context) {
  const contributions = createContributions<AgentModelProxy>(root);
  return {
    register(ctx: Context, proxy: AgentModelProxy) {
      if (!ctx.pluginOwner?.modelProxies?.includes(proxy.harness))
        throw new Error(
          `Declare host.modelProxies access for ${proxy.harness}`,
        );
      if (typeof proxy.run !== "function")
        throw new Error("A proxy needs a callback");
      contributions.register(ctx, proxy);
    },
    async dispatch(harness: string, request: ModelProxyRequest) {
      // Snapshot before awaiting. An admitted callback finishes even after unload.
      const handlers = contributions
        .snapshot()
        .filter((p) => p.harness === harness)
        .sort((a, b) => a.key.localeCompare(b.key));
      return withTimeout(
        (async () => {
          let body = request.body;
          for (const handler of handlers) {
            const next = await handler.run({ ...request, body });
            if (next !== undefined) {
              if (typeof next !== "string")
                throw new Error("Invalid model proxy body");
              body = next;
            }
          }
          return body;
        })(),
        "Model proxy callback timed out",
        25000,
      );
    },
  };
}
