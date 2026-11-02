import { expect, it } from "vitest";
import { relayOrigin } from "../communities/destination";
import type { FoundCommunity } from "../communities/find-community";
import { builderlabHosting } from "./builderlab-hosted";

const PUBLIC = "https://app.builderlab.xyz";
const BLOCK = "https://block.builderlab.xyz";
const STAGING = "https://test.blockstaging.build";
const BLOCK_SELF =
  "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01";
/** As `findCommunity` reports it: the canonical origin, plus `self` when given. */
const found = (input: string, self?: string): FoundCommunity => ({
  url: relayOrigin(input),
  host: new URL(relayOrigin(input)).host,
  self,
  policy: null,
});
/** The portal hosting `input`, whatever the build. */
const portal = (input: string, self?: string) =>
  builderlabHosting(found(input, self), "")?.portal;

it.each([
  ["wss://communities.buzz.xyz", PUBLIC],
  ["https://design.communities.buzz.xyz", PUBLIC],
  ["wss://buzz.block.builderlab.xyz", BLOCK],
  ["wss://acme.communities.block.builderlab.xyz", BLOCK],
  ["wss://buzz.test.blockstaging.build", STAGING],
  ["WSS://Design.Communities.BUZZ.xyz.", PUBLIC],
  ["https://communities.buzz.xyz:443", PUBLIC],
])("%s is hosted by %s", (input, expected) => {
  expect(portal(input)).toBe(expected);
});

it.each([
  "wss://communities.buzz.xyz.evil.com",
  "wss://notcommunities.buzz.xyz",
  "wss://xcommunities.buzz.xyz",
  "wss://buzz.xyz",
  "wss://buzz.acme.builderlab.xyz",
  "wss://relay.example.com",
  "https://communities.buzz.xyz:8443",
])("%s is not Builderlab-hosted", (input) => {
  expect(builderlabHosting(found(input), PUBLIC)).toBeUndefined();
});

it.each(
  [
    "wss://design.communities.buzz.xyz",
    "wss://buzz.block.builderlab.xyz",
    "wss://buzz.test.blockstaging.build",
  ].flatMap((input, row) =>
    [PUBLIC, BLOCK, STAGING].map(
      (build, column) => [input, build, row === column] as const,
    ),
  ),
)("%s in a %s build is here: %s", (input, build, here) => {
  expect(builderlabHosting(found(input), build)?.here).toBe(here);
});

it.each([
  ["", false],
  ["not a url", false],
  // Only the origin counts: the build URL carries the API's base path.
  ["https://app.builderlab.xyz/api/goose/", true],
])("a build URL of %j is this portal: %s", (build, here) => {
  expect(builderlabHosting(found("wss://communities.buzz.xyz"), build)).toEqual(
    { portal: PUBLIC, here },
  );
});

it("falls back to the relay key when the hostname is unknown, on the default port only", () => {
  // A deployment moved to a new domain keeps its relay key.
  expect(portal("wss://buzz.block.example", BLOCK_SELF)).toBe(BLOCK);
  expect(portal("https://buzz.block.example:8443", BLOCK_SELF)).toBeUndefined();
  expect(portal("wss://buzz.block.example", "ab".repeat(32))).toBeUndefined();
});
