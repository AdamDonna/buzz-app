import type { FoundCommunity } from "../communities/find-community.ts";

/**
 * The relays Builderlab deployments host: hostname, then relay key (NIP-11
 * `self`), so a deployment stays recognisable while its DNS is reshuffled.
 */
const HOSTED = [
  {
    host: "communities.buzz.xyz",
    self: "12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3",
  },
  {
    host: "block.builderlab.xyz",
    self: "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01",
  },
  {
    host: "test.blockstaging.build",
    self: "f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1",
  },
] as const;

/**
 * Whether a community URL given before setup is Builderlab-hosted, so it needs
 * Builderlab sign-in rather than a key the person brings.
 *
 * Hostname first (exact or label-boundary suffix: `design.communities.buzz.xyz`
 * and the apex match `communities.buzz.xyz`; `notcommunities.buzz.xyz` and
 * `communities.buzz.xyz.evil.com` do not), then the relay's `self`. Block's
 * deployments serve on 443, so a non-default port never matches. Sign-in is
 * always at `BUZZ_BUILDERLAB_URL`, whichever deployment matched: nothing a
 * relay publishes names its portal.
 */
export function isBuilderlabHosted(found: FoundCommunity): boolean {
  // Canonical already: relayOrigin() lower-cased the host and dropped a final dot.
  const url = new URL(found.url);
  if (url.port !== "") return false;
  return HOSTED.some(
    ({ host, self }) =>
      url.hostname === host ||
      url.hostname.endsWith(`.${host}`) ||
      found.self === self,
  );
}
