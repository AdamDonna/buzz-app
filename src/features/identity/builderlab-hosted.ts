import type { FoundCommunity } from "../communities/find-community.ts";

/**
 * The relays Builderlab deployments host, and the portal each one signs in
 * at: hostname, then relay key (NIP-11 `self`), so a deployment stays
 * recognisable while its DNS is reshuffled.
 */
const HOSTED = [
  {
    host: "communities.buzz.xyz",
    self: "12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3",
    portal: "https://app.builderlab.xyz",
  },
  {
    host: "block.builderlab.xyz",
    self: "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01",
    portal: "https://block.builderlab.xyz",
  },
  {
    host: "test.blockstaging.build",
    self: "f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1",
    portal: "https://test.blockstaging.build",
  },
] as const;

/**
 * The Builderlab deployment hosting a community URL given before setup: its
 * portal, and whether that is this build's `BUZZ_BUILDERLAB_URL`. Only then
 * does first run sign in for it; this build never signs in, links or backs up
 * for another deployment's community, so its person brings a key.
 * `undefined` for a relay no listed deployment hosts.
 *
 * Hostname first (exact or label-boundary suffix: `design.communities.buzz.xyz`
 * and the apex match `communities.buzz.xyz`; `notcommunities.buzz.xyz` and
 * `communities.buzz.xyz.evil.com` do not), then the relay's `self`. Block's
 * deployments serve on 443, so a non-default port never matches.
 */
export function builderlabHosting(
  found: Pick<FoundCommunity, "url" | "self">,
  build = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
): { portal: string; here: boolean } | undefined {
  // Canonical already: relayOrigin() lower-cased the host and dropped a final dot.
  const url = new URL(found.url);
  if (url.port !== "") return undefined;
  const row =
    HOSTED.find(
      ({ host }) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    ) ?? HOSTED.find(({ self }) => found.self === self);
  return row && { portal: row.portal, here: row.portal === originOf(build) };
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
