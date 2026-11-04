import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import { createModelProxies } from "./model-proxy";

it("requires a grant, chains active transforms and passes through after disposal", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  const request = { path: "/v1/messages", body: "original" };
  expect(() =>
    registry.register(root, {
      id: "x",
      harness: "claude/type",
      run: () => "bad",
    }),
  ).toThrow("Declare host.modelProxies");
  expect(await registry.dispatch("claude/type", request)).toBe("original");
  const fiber = root
    .extend({
      pluginOwner: {
        id: "trimmer",
        revision: "1",
        modelProxies: ["claude/type"],
      },
    })
    .plugin((ctx) => {
      registry.register(ctx, {
        id: "b",
        harness: "claude/type",
        run: ({ body }) => `${body}b`,
      });
      registry.register(ctx, {
        id: "a",
        harness: "claude/type",
        run: ({ body }) => `${body}a`,
      });
    });
  await fiber.await();
  expect(await registry.dispatch("claude/type", request)).toBe("originalab");
  expect(await registry.dispatch("other/type", request)).toBe("original");
  await fiber.dispose();
  expect(await registry.dispatch("claude/type", request)).toBe("original");
  await root.fiber.dispose();
});

it("finishes an admitted transform across replacement and propagates failures", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const registry = createModelProxies(root);
  let release!: (body: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const owner = root.extend({
    pluginOwner: { id: "trimmer", revision: "1", modelProxies: ["codex/type"] },
  });
  const fiber = owner.plugin((ctx) =>
    registry.register(ctx, {
      id: "trim",
      harness: "codex/type",
      run: () => {
        entered();
        return pending;
      },
    }),
  );
  await fiber.await();
  const request = { path: "/responses", body: "original" };
  const admitted = registry.dispatch("codex/type", request);
  await started;
  await fiber.dispose();
  const replacement = owner.plugin((ctx) =>
    registry.register(ctx, {
      id: "trim",
      harness: "codex/type",
      run: () => {
        throw new Error("failed");
      },
    }),
  );
  await replacement.await();
  release("trimmed");
  expect(await admitted).toBe("trimmed");
  await expect(registry.dispatch("codex/type", request)).rejects.toThrow(
    "failed",
  );
  await root.fiber.dispose();
});
