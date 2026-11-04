import type { Context } from "@deepseek-ai/cordis";

/** One listener per upstream for the harness's entire activation, independent of
 * transform plugins. Failed openings stay failed, never silently bypassed. */
export function modelProxyEndpoints(ctx: Context, harness: string) {
  const listeners = new Map<string, Promise<string>>();
  return (upstream: string): Promise<string> => {
    let opening = listeners.get(upstream);
    if (!opening) {
      const serve = ctx.host.serveModelProxy?.bind(ctx.host);
      if (!serve) throw new Error("This Buzz host cannot serve model proxies");
      opening = serve(upstream, (request) =>
        ctx.agents.dispatchModelProxy(harness, request),
      ).then((server) => server.url);
      listeners.set(upstream, opening);
    }
    return opening;
  };
}
