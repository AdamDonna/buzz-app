import { invoke } from "@tauri-apps/api/core";
import manifest from "../../bundled/builderlab/manifest.json";
import { createNativeSession } from "../../bundled/builderlab/session";
import type { FederatedIdentity } from "../federated-identity/service";

/** Welcome uses the bundled plugin's existing grant before its UI is mounted.
 * Native rechecks enabled artifact, authority, operation and session revision.
 * Each bounded native request releases its registration when it settles. */
export function createFederatedFirstRun(identity: FederatedIdentity) {
  return createNativeSession({
    apiAvailable: identity.apiAvailable,
    snapshot: identity.snapshot,
    subscribe: identity.subscribe,
    signIn: () => identity.signIn(),
    cancelSignIn: () => identity.cancelSignIn(),
    signOut: () => identity.signOut(),
    async request(request) {
      const session = identity.snapshot().revision;
      const registration = crypto.randomUUID();
      const owner = { id: manifest.id, revision: "bundled", registration };
      try {
        await invoke("federated_identity_register", owner);
        return await invoke("federated_identity_request", {
          ...owner,
          session,
          request,
        });
      } finally {
        await invoke("federated_identity_unregister", { registration }).catch(
          () => {},
        );
      }
    },
  });
}
