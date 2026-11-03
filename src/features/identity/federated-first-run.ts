import { invoke } from "@tauri-apps/api/core";
import manifest from "../../bundled/builderlab/manifest.json";
import { createNativeSession } from "../../bundled/builderlab/session";
import type { FederatedIdentity } from "../federated-identity/service";
import type { HostResponse } from "../host/service";

/** Welcome uses the bundled plugin's existing grant before its UI is mounted.
 * Native rechecks enabled artifact, authority, operation and session revision.
 * Each bounded native request releases its registration when it settles. */
export function createFederatedFirstRun(identity: FederatedIdentity) {
  let active = true;
  const session = createNativeSession({
    apiAvailable: identity.apiAvailable,
    snapshot: identity.snapshot,
    subscribe: identity.subscribe,
    signIn: () => identity.signIn(),
    cancelSignIn: () => identity.cancelSignIn(),
    signOut: () => identity.signOut(),
    async request(request) {
      const session = identity.snapshot().revision;
      for (let attempt = 0; ; attempt++) {
        if (!active) throw new DOMException("First run closed", "AbortError");
        const registration = crypto.randomUUID();
        const owner = { id: manifest.id, revision: "bundled", registration };
        let response: HostResponse;
        try {
          await invoke("federated_identity_register", owner);
          if (!active) throw new DOMException("First run closed", "AbortError");
          response = await invoke<HostResponse>("federated_identity_request", {
            ...owner,
            session,
            request,
          });
        } catch (error) {
          // Native emits this only before forwarding a request. Re-register once,
          // retaining the original session revision; never replay other failures.
          if (
            active &&
            error === "Plugin registration retired" &&
            attempt === 0
          )
            continue;
          throw typeof error === "string" ? new Error(error) : error;
        } finally {
          await invoke("federated_identity_unregister", { registration }).catch(
            () => {},
          );
        }
        if (!active) throw new DOMException("First run closed", "AbortError");
        return response;
      }
    },
  });
  return {
    ...session,
    dispose() {
      active = false;
      session.dispose();
    },
  };
}
