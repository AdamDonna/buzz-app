import { expect, it } from "vitest";
import { relayOrigin } from "../communities/destination";
import type { FoundCommunity } from "../communities/find-community";
import { isBuilderlabHosted } from "./builderlab-hosted";

const BLOCK_SELF =
  "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01";
/** As `findCommunity` reports it: the canonical origin, plus `self` when given. */
const found = (input: string, self?: string): FoundCommunity => ({
  url: relayOrigin(input),
  host: new URL(relayOrigin(input)).host,
  self,
  policy: null,
});

it.each([
  "wss://communities.buzz.xyz",
  "https://design.communities.buzz.xyz",
  "wss://buzz.block.builderlab.xyz",
  "wss://acme.communities.block.builderlab.xyz",
  "wss://buzz.test.blockstaging.build",
  "WSS://Design.Communities.BUZZ.xyz.",
  "https://communities.buzz.xyz:443",
])("%s is Builderlab-hosted", (input) => {
  expect(isBuilderlabHosted(found(input))).toBe(true);
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
  expect(isBuilderlabHosted(found(input))).toBe(false);
});

it("falls back to the relay key when the hostname is unknown, on the default port only", () => {
  // A deployment moved to a new domain keeps its relay key.
  expect(
    isBuilderlabHosted(found("wss://buzz.block.example", BLOCK_SELF)),
  ).toBe(true);
  expect(
    isBuilderlabHosted(found("https://buzz.block.example:8443", BLOCK_SELF)),
  ).toBe(false);
  expect(
    isBuilderlabHosted(found("wss://buzz.block.example", "ab".repeat(32))),
  ).toBe(false);
});
