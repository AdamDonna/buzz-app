import type { Agent } from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { savedAgentStore } from "../../features/solo/default-agent";

/** The saved Bestie in the connected community, across reconnections. */
export function savedBestie(relay: RelayData) {
  let current:
    | Readonly<{
        snapshot: RelaySnapshot;
        store: ReturnType<typeof savedAgentStore>;
      }>
    | undefined;
  const store = () => {
    const snapshot = relay.snapshot();
    if (
      current?.snapshot.session !== snapshot.session ||
      current.snapshot.scope !== snapshot.scope
    )
      current = {
        snapshot,
        store: savedAgentStore(snapshot.session, snapshot.scope ?? ""),
      };
    return current.store;
  };
  return {
    snapshot: () => store().snapshot(),
    subscribe(listener: () => void) {
      // The saved choice's sources also change for unrelated view state, so
      // only a different Bestie, or community, is passed on.
      let following = store();
      let last = following.snapshot();
      const changed = () => {
        const next = following.snapshot();
        if (next === last) return;
        last = next;
        listener();
      };
      let stop = following.subscribe(changed);
      const stopRelay = relay.subscribe(() => {
        if (store() === following) return;
        stop();
        following = store();
        last = following.snapshot();
        stop = following.subscribe(changed);
        listener();
      });
      return () => {
        stopRelay();
        stop();
      };
    },
  };
}

export function inCommunity(agent: Agent, { scope }: RelaySnapshot) {
  try {
    return relayPartition(relayOrigin(agent.relay), agent.owner) === scope;
  } catch {
    return false;
  }
}
