import type { FoundCommunity } from "../communities/find-community.ts";

/** Block's public Builderlab, the one deployment that creates communities during first run. */
const PUBLIC = {
  host: "communities.buzz.xyz",
  self: "12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3",
  portal: "https://app.builderlab.xyz",
} as const;

/**
 * The relays a Builderlab deployment hosts, and the portal it signs in at:
 * hostname, then relay key (NIP-11 `self`), so a deployment stays
 * recognisable while its DNS is reshuffled.
 */
const HOSTED = [PUBLIC] as const;

/**
 * Whether this build signs in at the public Builderlab portal, so a first-run
 * sign-in is an account there. Exact origin: a build that signs in anywhere
 * else (unconfigured, or another deployment's portal) never is. A
 * federated-identity build is only when its identity origin is that portal.
 */
export function atPublicBuilderlab(
  build = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
): boolean {
  return originOf(build) === PUBLIC.portal;
}

/**
 * Whether a community URL given before setup is hosted by this build's
 * Builderlab, so first run signs in for it at once rather than asking. A
 * build has one Builderlab; one whose `BUZZ_BUILDERLAB_URL` is not a listed
 * portal (including an unconfigured or federated-identity build) treats every
 * community as unhosted.
 *
 * Hostname first (exact or label-boundary suffix: `design.communities.buzz.xyz`
 * and the apex match `communities.buzz.xyz`; `notcommunities.buzz.xyz` and
 * `communities.buzz.xyz.evil.com` do not), then the relay's `self`. Block's
 * deployments serve on 443, so a non-default port never matches.
 */
export function hostedByThisBuilderlab(
  found: Pick<FoundCommunity, "url" | "self">,
  build = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
): boolean {
  // Canonical already: relayOrigin() lower-cased the host and dropped a final dot.
  const url = new URL(found.url);
  if (url.port !== "") return false;
  const row =
    HOSTED.find(
      ({ host }) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    ) ?? HOSTED.find(({ self }) => found.self === self);
  return row !== undefined && row.portal === originOf(build);
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
