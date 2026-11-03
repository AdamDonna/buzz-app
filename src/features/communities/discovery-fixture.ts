/** Selected discovery fields emitted for a required host by BUZZ-511.
 * Producer: https://github.com/block/buzz/pull/8988
 * Pinned head: d3ae4935b11e207f0736833cd5220f207be359fd
 * Spec: docs/nips/NIP-FI.md, Discovery (line 891).
 * Source: crates/buzz-relay/src/nip11.rs, nip11_document/RelayInfo::build.
 * Producer test: nip_fi_policy/tests.rs,
 * discovery_is_host_specific_compatible_uncached_and_consistent.
 * This projection omits unrelated NIP-11 fields and conveys no issuer trust.
 */
export const requiredFiDiscovery = {
  requires_nip_fi: true,
  limitation: { federated_identity: true },
  federated_identity: {
    core: "client-attached",
    assertion_freshness: {
      class: "offline-jwt",
      maximum_residual_upstream_revocation_seconds: null,
    },
  },
} as const;
