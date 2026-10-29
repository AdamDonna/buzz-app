/** A community is a secure origin, never a credential-bearing URL or an API path. */
export function relayOrigin(input: string): string {
  const value = input.trim();
  if (
    value.length > 2048 ||
    !/^(?:wss|https):\/\/[^/?#\\\s@]+\/?$/i.test(value)
  )
    throw new Error(
      "Enter a wss:// or https:// relay URL without credentials, a path, query, or fragment.",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Enter a valid relay URL, such as wss://relay.example.com.",
    );
  }
  url.protocol = "https:";
  if (url.hostname === "." || url.hostname.endsWith(".."))
    throw new Error("Enter a valid relay URL.");
  // DNS treats the final dot as the same host; keep storage and routing identical too.
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);
  return url.origin;
}

/**
 * A community address as a person types it: a bare host is assumed to be a
 * secure relay. Saved IDs never take this path, so an alias stays a non-URL.
 */
export function enteredRelayOrigin(input: string): string {
  const value = input.trim();
  return relayOrigin(value.includes("://") ? value : `wss://${value}`);
}

/** A short deployment ID is not a URL and must never acquire a session by itself. */
export function isCommunityAlias(value: string) {
  return (
    /^[a-z][a-z0-9-]{0,63}$/.test(value) &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

/** Optional deployment aliases preserve existing saved IDs without shipping a community list. */
export function parseCommunityAliases(
  raw = "",
): Readonly<Record<string, string>> {
  if (!raw.trim()) return {};
  try {
    const entries: unknown = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      throw new Error();
    const aliases: Record<string, string> = {};
    const origins = new Set<string>();
    for (const [id, value] of Object.entries(entries)) {
      if (!isCommunityAlias(id) || typeof value !== "string") throw new Error();
      const origin = relayOrigin(value);
      if (origins.has(origin)) throw new Error();
      origins.add(origin);
      aliases[id] = origin;
    }
    return Object.freeze(aliases);
  } catch {
    // Do not echo malformed input: an environment value might contain credentials.
    throw new Error(
      "BUZZ_COMMUNITY_ALIASES must be a JSON object of unique alias-to-secure-relay-origin mappings.",
    );
  }
}

const configuredAliases = parseCommunityAliases(
  import.meta.env?.VITE_BUZZ_COMMUNITY_ALIASES,
);

export type RelayPolicy = Readonly<{
  pinned: string;
  allowlist: readonly string[];
}>;

export class RelayPolicyError extends Error {}

/** A policy entry is `host` or `host:port`; it matches both `wss://` and `https://`. */
function hostOrigin(entry: unknown): string {
  if (typeof entry !== "string" || entry.includes("/")) throw new Error();
  return relayOrigin(`https://${entry}`);
}

/** Deployment policy is compiled configuration, never a saved user preference. */
export function parseRelayPolicy(raw?: string): RelayPolicy | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !("pinned" in value) ||
      !("allowlist" in value) ||
      !Array.isArray(value.allowlist)
    )
      throw new Error();
    const pinned = hostOrigin(value.pinned);
    const allowlist = value.allowlist.map(hostOrigin);
    return Object.freeze({
      pinned,
      allowlist: Object.freeze([...new Set(allowlist)]),
    });
  } catch {
    throw new Error(
      "BUZZ_BUILD_RELAY_POLICY must be a JSON object with a pinned relay host and an allowlist array of relay hosts, each as host or host:port.",
    );
  }
}

export const configuredRelayPolicy = parseRelayPolicy(
  import.meta.env?.VITE_BUZZ_RELAY_POLICY,
);

export function assertRelayAllowed(
  url: string,
  policy = configuredRelayPolicy,
) {
  if (policy && url !== policy.pinned && !policy.allowlist.includes(url))
    throw new RelayPolicyError(
      "This relay is not allowed by this build's relay policy.",
    );
}

export function assertRelayRemovable(
  value: string,
  policy = configuredRelayPolicy,
) {
  if (
    policy &&
    communityDestination(value, configuredAliases, policy).url === policy.pinned
  )
    throw new RelayPolicyError(
      "The pinned relay cannot be removed from this build.",
    );
}

export function communityDestination(
  value: string,
  aliases = configuredAliases,
  policy = configuredRelayPolicy,
) {
  const legacy = Object.hasOwn(aliases, value) ? aliases[value] : undefined;
  const url = legacy ?? relayOrigin(value);
  assertRelayAllowed(url, policy);
  const id = Object.keys(aliases).find((key) => aliases[key] === url) ?? url;
  return { id, url, name: new URL(url).host };
}

/** The account service's spelling of a destination: `wss://host[:port]` with a
 * lowercase host, no default port and no trailing slash. Aliases resolve to
 * their origin first, so a device-local ID never leaves the device. */
export function relayAddress(value: string) {
  return `wss://${new URL(communityDestination(value).url).host}`;
}
