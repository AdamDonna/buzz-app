import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  parseRelayPolicy,
  communityDestination,
  assertRelayRemovable,
} from "./destination";

const raw = JSON.stringify({
  pinned: "relay.example",
  allowlist: ["other.example:8443"],
});
const policy = parseRelayPolicy(raw);

it("leaves builds without a policy unrestricted", () => {
  expect(parseRelayPolicy()).toBeUndefined();
  expect(
    communityDestination("wss://arbitrary.example", {}, undefined).url,
  ).toBe("https://arbitrary.example");
  expect(() => assertRelayRemovable("wss://arbitrary.example")).not.toThrow();
});

it.each([
  "",
  "{}",
  '{"pinned":"relay.example"}',
  '{"pinned":"relay.example","allowlist":[42]}',
  '{"pinned":"wss://relay.example","allowlist":[]}',
  '{"pinned":"relay.example","allowlist":["other.example/path"]}',
])("fails closed for malformed policy %j", (value) => {
  expect(() => parseRelayPolicy(value)).toThrow("BUZZ_BUILD_RELAY_POLICY");
});

it("matches policy hosts on either scheme and only on their port", () => {
  for (const allowed of [
    "wss://relay.example",
    "https://RELAY.example:443/",
    "wss://other.example:8443",
    "https://other.example:8443",
  ])
    expect(() => communityDestination(allowed, {}, policy)).not.toThrow();
  for (const blocked of [
    "wss://other.example",
    "wss://relay.example:8443",
    "wss://sub.relay.example",
    "wss://relay.example.evil",
  ])
    expect(() => communityDestination(blocked, {}, policy)).toThrow(
      /not allowed/,
    );
});

const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function startup(saved?: unknown) {
  vi.stubEnv("VITE_BUZZ_RELAY_POLICY", raw);
  vi.resetModules();
  const { createCommunities } = await import("./service");
  const viewer = "a".repeat(64);
  const key = `buzz-client.v1:${viewer}`;
  const stored = new Map(
    saved === undefined ? [] : [[key, JSON.stringify(saved)]],
  );
  vi.stubGlobal("localStorage", {
    getItem: (id: string) => stored.get(id) ?? null,
    setItem: (id: string, value: string) => stored.set(id, value),
  });
  const connect = vi.fn(async (_id: string, _signal: AbortSignal) => {
    throw new Error("fixture offline");
  });
  const root = new Context();
  roots.push(root);
  const client = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
    connect,
  );
  await vi.waitFor(() => expect(client.snapshot().status).toBe("ready"));
  return { client, connect };
}

it("starts a fresh identity on the pin, refuses blocked joins and leaving the pin", async () => {
  const { client } = await startup();
  expect(client.snapshot().selected).toBe("https://relay.example");
  const profile = { name: "", picture: "" };
  expect(() =>
    client.joined({ id: "wss://evil.example", name: "Evil" }, profile),
  ).toThrow(/not allowed/);
  await expect(client.leave("https://relay.example")).rejects.toThrow(
    /pinned relay/,
  );
  client.joined({ id: "wss://other.example:8443", name: "Other" }, profile);
  expect(client.snapshot().selected).toBe("https://other.example:8443");
  const { parseInviteLink } = await import("./invite-link");
  expect(
    parseInviteLink("buzz://connect?relay=wss%3A%2F%2Fevil.example"),
  ).toBeNull();
});

it("drops a saved blocked relay without connecting to it", async () => {
  const { client, connect } = await startup({
    memberships: [
      { id: "https://evil.example", name: "Evil" },
      { id: "https://other.example:8443", name: "Other" },
    ],
    selected: "https://evil.example",
  });
  expect(client.snapshot().selected).toBe("https://relay.example");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://relay.example",
    "https://other.example:8443",
  ]);
  await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  expect(
    connect.mock.calls.every(([id]) => id === "https://relay.example"),
  ).toBe(true);
});

it("keeps a saved Personal space choice", async () => {
  const { client, connect } = await startup({
    memberships: [],
    selected: null,
  });
  expect(client.snapshot().selected).toBeNull();
  expect(connect).not.toHaveBeenCalled();
});

it("keeps blocked unfinished joins stored while allowed joins stay usable", async () => {
  await startup({ memberships: [], selected: null });
  const { createJoinJournal } = await import("./join-journal");
  const key = `buzz-community-joins.v1:${"a".repeat(64)}`;
  const blocked = { id: "blocked", community: "https://evil.example" };
  const allowed = { id: "allowed", community: "https://relay.example" };
  localStorage.setItem(key, JSON.stringify([allowed, blocked]));
  const journal = createJoinJournal("a".repeat(64));
  expect(journal.latest()).toEqual(allowed);
  journal.finish(allowed);
  expect(journal.latest()).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual([blocked]);
});
