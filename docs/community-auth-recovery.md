# Required-community client support and acceptance

BUZZ-518 adds guidance from the host-specific `requires_nip_fi` discovery field.
It does not reinterpret `limitation.federated_identity`: that remains capability
advertisement, and the native client retains its existing attachment and denial
behavior when the requirement field is absent. Malformed requirement discovery
offers administrator/build guidance rather than implying free access.
An incompatible descriptor preserves `required=true` with compatibility reported
separately. A non-FI build or incompatible descriptor shows supported-build guidance
and does not offer a sign-in or join action it cannot complete.

Account recovery uses native sign-in renewal, which keeps an existing valid
shared FI session until replacement succeeds. Cancel or browser failure does not
first sign the user out globally. A successful account change applies to all
communities and derived agent access. Welcome detects a browser returning the
same account instead of pretending that it switched accounts.

The traced adapter contract has no account-selection parameter:
`EnterpriseAdapterLoginStartAction.start` accepts `return_to` and the handoff
challenge fields; `BbidentityAuthService.startLogin` builds the Auth0 URL without
an explicit chooser hint (cash-server main `51533fb7bd3d071f06f06484675f5d0d722609d2`). Changing the browser's provider
account may therefore be required before **Sign in again**. No unsupported hint
is added, and a real chooser/cancel run is still a readiness gate.

First-run account requests obtain the latest credential for the same account
subject on each request and reject a different subject, including a response
arriving after an account change. Backup uses the latest public native revision.
Registration retirement permits one re-registration before dispatch; it does not
replay arbitrary failures or change the request's original session revision.

## Producer prerequisite and rollout

[BUZZ-511](https://linear.app/squareup/issue/BUZZ-511) owns the discovery producer
and specification. Its local, unvalidated checkpoint is
`c7661f64302cad3208676deb6ed20fb43ea8208a`, pending the revised BUZZ-510 parent;
it is not a published prerequisite release. The proposed contract text is
`block/buzz/docs/community-auth-upgrades.md`, section **Request enforcement and
discovery (BUZZ-511)**. It specifies the same host-specific boolean on root NIP-11
and `/info`, `no-store`, generic 404 for a non-serving host, and 503 on policy lookup
failure. `required=true` implies FI capability and a compatible descriptor, while
optional hosts may still advertise FI capability. This is a Buzz extension to
discovery, not a field already specified by NIP-FI itself.

Pin the client fixtures to the final committed producer output after its handoff.
Until that happens, the fixtures express the proposed contract and do not prove
producer interoperability. This prerequisite and the live checks below block
readiness; BUZZ-510's operator receipt alone is not a discovery producer.

1. Finalize and publish the BUZZ-511 producer/specification on the revised parent,
   then pin and validate fixtures from that exact head.
2. Produce exact-host clients and verify discovery, signup/linking and recovery.
   With the field absent, both shipped and new clients retain legacy discovery
   and denial behavior. Shipped FI clients still use the existing capability
   fields; new non-FI clients show upgrade/configuration guidance for required hosts.
3. Verify free controls and supported-client access before enabling a durable
   requirement. Old non-FI clients still need the separate BUZZ-517 upgrade path.
   Publishing the new field does not grant membership or change issuer trust.

Observe success using the exact build/descriptor and host, the unchanged device
npub, successful admission to the original community, and renewal/reconnection
through two actual assertion lifetimes. Record timestamps and results, never
tokens or authentication headers. The procedure below is required live evidence;
CI and component tests are not substitutes.

Client rollback is a revert or replacement with a verified compatible build.
It does not clear the relay's durable requirement, reverse an identity binding,
erase the device key, or reset saved backup consent or the native FI session.
Those remain in their existing stores and formats. Do not use a data wipe or
automatic unlink as rollback. Restoring access after a bad client rollout still
requires a client that can satisfy the active policy; reverting guidance alone
does not make a required community free.

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
   Verify provider account selection and cancellation/failure with an existing
   shared session. Cancel/failure must leave that session usable; a provider
   returning the same account must not be reported as an account switch.
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
