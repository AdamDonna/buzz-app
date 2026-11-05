import { expect, it } from "vitest";
import {
  agentHistoryRoute,
  agentHistoryTarget,
  agentProviderRoute,
  agentProviderTarget,
  agentRoute,
  agentTarget,
  availableAgentProviderRoute,
} from "./routes";

it("admits provider-shaped routes and preserves the Agents page scope", () => {
  const route = { provider: "test/echo" };
  expect(agentProviderRoute(route)).toBe("test/echo");
  expect(availableAgentProviderRoute(route)).toBe(true);
  expect(availableAgentProviderRoute({ provider: "test/gone" })).toBe(true);
  for (const invalid of [
    null,
    "test/echo",
    { provider: "echo" },
    { provider: "test/echo", extra: true },
  ] as const)
    expect(agentProviderRoute(invalid)).toBeUndefined();

  const base = {
    version: 1,
    kind: "page",
    pluginId: "buzz.agents",
    pageId: "agents",
    scope: null,
  } as const;
  const opened = agentProviderTarget(base, "test/echo");
  expect(opened).toEqual({
    ...base,
    route: { version: 1, params: route },
  });
  expect(agentProviderTarget(opened)).toEqual(base);
});

it("admits an agent of yours to open, by its key", () => {
  const pubkey = "a".repeat(64);
  expect(agentRoute(agentTarget(pubkey).route.params)).toBe(pubkey);
  expect(availableAgentProviderRoute({ agent: pubkey })).toBe(true);
  for (const invalid of [
    { agent: "Ada" },
    { agent: pubkey, provider: "test/echo" },
    { agent: 1 },
  ] as const)
    expect(agentRoute(invalid)).toBeUndefined();
  expect(agentProviderRoute({ agent: pubkey })).toBeUndefined();
});

it("validates a version locator without treating it as authority or accepting extra route fields", () => {
  const base = { ...agentTarget("a".repeat(64)), scope: null };
  const selected = { side: "settings", id: "b".repeat(64) } as const;
  const opened = agentHistoryTarget(base, "a".repeat(64), selected);
  expect(agentRoute(opened.route?.params)).toBe("a".repeat(64));
  expect(agentHistoryRoute(opened.route?.params)).toEqual(selected);
  expect(agentHistoryTarget(opened, "a".repeat(64))).toEqual(
    agentHistoryTarget(base, "a".repeat(64)),
  );
  expect(availableAgentProviderRoute(opened.route?.params ?? null)).toBe(true);
  for (const revision of [
    "settings/bad",
    `memory/${"b".repeat(64)}`,
    "instructions/",
  ]) {
    expect(agentRoute({ agent: "a".repeat(64), revision })).toBeUndefined();
  }
  expect(
    agentRoute({
      agent: "a".repeat(64),
      revision: `settings/${"b".repeat(64)}`,
      extra: true,
    }),
  ).toBeUndefined();
});
