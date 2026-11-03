# Required-community client support and acceptance

BUZZ-518 adds guidance from the host-specific `requires_nip_fi` discovery field.
It does not reinterpret `limitation.federated_identity`: that remains capability
advertisement, and the native client retains its existing attachment and denial
behavior when the requirement field is absent. Malformed requirement discovery
offers retry and administrator/build guidance rather than implying free access.

The first-run Welcome component accepts the existing native FI service and uses
the bundled Builderlab authority grant for account checks and explicit linking.
It reuses the existing linked-account/import/create choices. Account tokens stay
native; requests carry only the public session revision. Native validation still
checks the enabled artifact, authority, operation and current session. A conflicting
binding stops before a challenge is requested; no automatic unlink is added.

**Draft integration gate:** `App.tsx` must pass
`federatedIdentity={services.federatedIdentity}` to `Welcome`. That FOUNDATION edit
needs explicit human guidance under `AGENTS.md`; until supplied, the app's first-run
FI path is not wired. Component tests alone do not establish packaged support.

## Configuration and artifacts

| Artifact or integration | Supported configuration and limits |
| --- | --- |
| Candidate V1 desktop | Compile the same validated `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` into Vite and Cargo. `communityHosts` must match the exact target host/port, or its configured single-label wildcard. `identityOrigin` is a bare HTTPS origin; `adapterBase` is its adapter prefix. Builderlab first run requires its `/api/goose/` API shape. |
| Existing V1 desktop releases | Inspect the actual build descriptor. A Block-only descriptor does not cover bb-public. Preview 233.1 had no FI descriptor; code support does not add configuration to an old artifact. |
| Runtime-descriptor proposal | PR #2152 is separate and is not assumed here. Its presence does not establish first-run or bundled-plugin configuration. |
| Local agents and bundled Builderlab agents | Existing native FI grants/assertions and NIP-OA attestation remain authoritative. Explicit linking uses the configured FI origin, derived by `crates/plugin-manager/build.rs`, plus the signer's existing production-origin allowance. A relay-advertised origin cannot expand that trust. |
| Agent Git evidence | PR #2240 is separate; this change does not claim its behavior. |
| CLI | This repository does not add an interactive CLI account flow. A CLI/agent needs its own supported assertion path and exact authority/host configuration. |
| Mobile | This repository does not produce the separate mobile client. Dogfood rc.17 (`b5b69d3d`) supports issuer-selected lifetimes but its inspected configuration covered the Block tenant, not bb-public. Mobile needs its own exact-host candidate and acceptance evidence. |

For bb-public staging, the planned origin is `https://app.builderlabstaging.xyz`,
the adapter prefix is `/api/goose`, and the API base is `/api/goose/`. Match only
the intended community hosts; do not infer support from a build's name. Candidate
packaging and service activation belong to BUZZ-514–516. No shipped candidate or
successful live flow is asserted by this document.

## Required live acceptance

Use disposable accounts and keys in an isolated OS account. Do not overwrite an
operator's saved identity. Record build hash, descriptor, exact relay host, issuer,
and assertion lifetime without recording credentials or private keys.

1. Fresh signup: sign in from Welcome, confirm the account is unlinked, create
   and link a key, then join the originally entered required community. Exercise
   backup only where the build/service explicitly supports it.
2. Returning account: confirm its bound npub is shown before import/restore.
   A different key must be refused. Cancel and change account without creating a key.
3. Existing device key: record its npub, sign in and bind it, reconnect the same
   community, and confirm the npub is unchanged after restart.
4. Conflict: retain the conflicting mapping and device key. Review the mapping
   or explicitly select another account. Never silently unbind or regenerate.
5. Keep a required-community connection active across at least two actual
   assertion lifetimes. Disconnect/reconnect and rediscover policy. Revoke the
   account, key, and agent separately; protected access must stop and recover only
   after permitted fresh authentication.
6. Check a free community, an old relay without the new field, an unsupported
   host/authority, malformed discovery, storage refusal, browser cancellation,
   expired session and network recovery. No relay may choose a new sign-in origin.

Socket renewal already belongs to the native FI/socket owners (including #2142).
Audio acceptance remains BUZZ-457; this change adds no audio renewal mechanism.
Server membership checks remain independent of sponsor billing membership.

Local component/service tests and the public-state recovery fixture do not prove
native credential custody, packaged SSO, mobile behavior or the live two-lifetime
contract. Keep those gaps explicit on the draft PR.

Sources: [BUZZ-518 and its artifact correction](https://linear.app/squareup/issue/BUZZ-518/v1-clients-complete-account-signuplinking-and-auth-recovery-for),
[native session foundation](https://github.com/block/buzz-app/pull/1424),
[Builderlab FI forwarding](https://github.com/block/buzz-app/pull/1461),
[quiet socket renewal](https://github.com/block/buzz-app/pull/2142),
and the local [identity contract](identity.md) and [build configuration](configuration.md).
