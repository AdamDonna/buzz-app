import { afterEach, assert, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import cases from "../../../tests/relay-policy-cases.json";
import {
  parseRelayPolicy,
  communityDestination,
  assertRelayRemovable,
} from "./destination";

const raw = JSON.stringify({
  pinned: "wss://relay.example",
  allowlist: [
    "wss://other.example:8443",
    "https://bücher.example",
    "https://[2001:db8::1]",
  ],
});
const policy = parseRelayPolicy(raw);

it("leaves OSS builds unrestricted only when policy is absent", () => {
  expect(parseRelayPolicy()).toBeUndefined();
  expect(
    communityDestination("wss://arbitrary.example", {}, undefined).url,
  ).toBe("https://arbitrary.example");
  expect(() => assertRelayRemovable("wss://arbitrary.example")).not.toThrow();
});

it.each([
  "",
  " ",
  "null",
  "{}",
  "[]",
  "not-json",
  '{"pinned":"wss://relay.example"}',
  '{"pinned":"wss://relay.example","allowlist":null}',
  '{"pinned":"wss://relay.example","allowlist":[42]}',
  '{"pinned":"wss://relay.example","allowlist":[],"enabled":false}',
])("fails closed for malformed configured policy (%#)", (value) => {
  expect(() => parseRelayPolicy(value)).toThrow("BUZZ_BUILD_RELAY_POLICY");
});

it.each(cases.allowed)("allows canonical exact matching for %s", (value) => {
  expect(() => communityDestination(value, {}, policy)).not.toThrow();
});
it.each([...cases.blocked, ...cases.invalid])("blocks %j", (value) => {
  expect(() => communityDestination(value, {}, policy)).toThrow();
});
it.each(cases.invalid)(
  "rejects invalid configured URLs without echoing them (%#)",
  (value) => {
    for (const config of [
      { pinned: value, allowlist: [] },
      { pinned: "wss://relay.example", allowlist: [value] },
    ])
      expect(() => parseRelayPolicy(JSON.stringify(config))).toThrow(
        /^BUZZ_BUILD_RELAY_POLICY must/,
      );
  },
);
it("accepts an empty allowlist and protects the pin through normalized URLs and aliases", () => {
  const pinnedOnly = parseRelayPolicy(
    '{"pinned":"wss://RELAY.example:443/","allowlist":[]}',
  );
  expect(pinnedOnly).toEqual({
    pinned: "https://relay.example",
    allowlist: [],
  });
  expect(() =>
    assertRelayRemovable("https://RELAY.example.:443/", pinnedOnly),
  ).toThrow(/pinned relay/);
  expect(() =>
    assertRelayRemovable("https://other.example:8443", policy),
  ).not.toThrow();
  expect(() =>
    communityDestination("old", { old: "https://evil.example" }, policy),
  ).toThrow(/not allowed/);
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
  return { client, connect, stored, key };
}

it("pins a fresh identity, rejects replacement/addition/removal, and leaves the allowlist optional", async () => {
  const { client, stored, key } = await startup();
  expect(client.snapshot().selected).toBe("https://relay.example");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://relay.example",
  ]);
  const before = stored.get(key);
  expect(() =>
    client.joined(
      { id: "wss://evil.example", name: "Replacement" },
      { name: "", picture: "" },
    ),
  ).toThrow(/not allowed/);
  await expect(client.leave("https://RELAY.example.:443/")).rejects.toThrow(
    /pinned relay/,
  );
  expect(stored.get(key)).toBe(before);
  client.joined(
    { id: "wss://other.example:8443", name: "Other" },
    { name: "", picture: "" },
  );
  expect(client.snapshot().selected).toBe("https://other.example:8443");
  await client.leave("https://other.example:8443", { purge: false });
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://relay.example",
  ]);
});

it("filters persisted disallowed relays before startup and preserves allowed settings", async () => {
  const { client, connect } = await startup({
    profile: { name: "Local", picture: "" },
    memberships: [
      { id: "https://evil.example", name: "Old" },
      { id: "https://other.example:8443", name: "Other" },
    ],
    selected: "https://evil.example",
  });
  expect(client.snapshot().selected).toBe("https://relay.example");
  expect(client.snapshot().profile.name).toBe("Local");
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://relay.example",
    "https://other.example:8443",
  ]);
  await vi.waitFor(() => expect(connect).toHaveBeenCalled());
  expect(
    connect.mock.calls.every(([id]) => id === "https://relay.example"),
  ).toBe(true);
  expect(() => client.select("https://evil.example")).toThrow(/not allowed/);
  expect(() => client.open("https://evil.example")).toThrow(/not allowed/);
});

it("keeps a saved Personal space choice while restoring a missing pin", async () => {
  const { client, connect } = await startup({
    memberships: [],
    selected: null,
  });
  expect(client.snapshot().selected).toBeNull();
  expect(client.snapshot().memberships).toHaveLength(1);
  expect(connect).not.toHaveBeenCalled();
});

it("blocks invites and direct connection/leave APIs before any network or signer use", async () => {
  await startup({ memberships: [], selected: null });
  const { parseInviteLink } = await import("./invite-link");
  const { requestLeave } = await import("./api");
  const { connectSignedTransport } = await import("../relay/transport");
  const { subscribeRelayTraffic } = await import("../relay/live");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(
    parseInviteLink("buzz://connect?relay=wss%3A%2F%2Fevil.example"),
  ).toBeNull();
  expect(
    parseInviteLink("buzz://join?relay=wss%3A%2F%2Frelay.example&code=invite"),
  ).toMatchObject({ community: "https://relay.example" });
  await expect(requestLeave("https://relay.example")).rejects.toThrow(
    /pinned relay/,
  );
  const signer = {
    request: vi.fn(),
    getPublicKey: vi.fn(async () => "a".repeat(64)),
    signEvent: vi.fn(),
  };
  await expect(
    connectSignedTransport(signer, "https://evil.example", "b".repeat(64)),
  ).rejects.toThrow(/not allowed/);
  expect(() =>
    subscribeRelayTraffic("wss://evil.example", vi.fn(), "a".repeat(64), {
      event: vi.fn(),
      state: vi.fn(),
    } as never),
  ).toThrow(/not allowed/);
  expect(fetcher).not.toHaveBeenCalled();
  expect(signer.signEvent).not.toHaveBeenCalled();
  expect(signer.getPublicKey).not.toHaveBeenCalled();
});

it("reports pinned leave policy failures without offering device removal", async () => {
  const { client } = await startup({ memberships: [], selected: null });
  const { leaveCommunity, leaveUnsettled, departureFailureText } = await import(
    "./departure"
  );
  const pinned = client.snapshot().memberships[0];
  assert.exists(pinned);
  const error = await leaveCommunity(client, pinned).catch(
    (error: unknown) => error,
  );
  expect(leaveUnsettled(error)).toBe(false);
  expect(departureFailureText("Pinned", "leave", error)).toBe(
    "The pinned relay cannot be removed from this build.",
  );
});

it("retains an allowed saved selection and checks account-sync additions", async () => {
  const { client } = await startup({
    memberships: [{ id: "https://other.example:8443", name: "Other" }],
    selected: "https://other.example:8443",
  });
  expect(client.snapshot().selected).toBe("https://other.example:8443");
  const sync = client.snapshot().sync;
  await expect(
    client.applySync(sync, ["https://evil.example"]),
  ).rejects.toThrow(/not allowed/);
  expect(client.snapshot().memberships.map((m) => m.id)).toEqual([
    "https://relay.example",
    "https://other.example:8443",
  ]);
});
