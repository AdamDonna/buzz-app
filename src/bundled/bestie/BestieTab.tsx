import type { Agent, AgentAddedTab } from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { savedAgentStore } from "../../features/solo/default-agent";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { bestieName, useBestieChoice } from "../agents/BestieChoice";

/** The Bestie tab, on the agent saved as Bestie in its community. */
export function bestieTab(relay: RelayData): AgentAddedTab {
  const bestie = savedBestie(relay);
  return {
    id: "bestie",
    title: "Bestie",
    when: (agent) =>
      agent.pubkey === bestie.snapshot() &&
      inCommunity(agent, relay.snapshot()),
    subscribe: bestie.subscribe,
    component: ({ agent }) => <BestieTab relay={relay} agent={agent} />,
  };
}

/** The saved Bestie in the connected community, across reconnections. */
function savedBestie(relay: RelayData) {
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

function inCommunity(agent: Agent, { scope }: RelaySnapshot) {
  try {
    return relayPartition(relayOrigin(agent.relay), agent.owner) === scope;
  } catch {
    return false;
  }
}

function BestieTab({ relay, agent }: { relay: RelayData; agent: Agent }) {
  const { session, scope } = useRelayConnection(relay);
  const bestie = useBestieChoice(session, scope ?? "");
  const others = bestie.choices.selectable.filter(
    (choice) => choice.pubkey !== agent.pubkey,
  );
  return (
    // Its own size container: rows wrap their buttons to the panel's width,
    // as each agent type's settings form does, and nothing widens the tab.
    <div className="grid gap-6 [container-type:inline-size]">
      <SettingsGroup>
        <PreferenceRow
          icon={<BestieIcon size="1rem" />}
          title="This is your Bestie"
          subtitle="It's pinned at the top of Buzz, with your DM as its home."
          trailing={
            <MenuRoot>
              <MenuTrigger
                disabled={!others.length}
                render={<Button variant="outline">Change</Button>}
              />
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Make your Bestie</MenuGroupLabel>
                  {others.map((choice) => (
                    <MenuItem
                      key={choice.pubkey}
                      onClick={() => bestie.make(choice.pubkey)}
                    >
                      {bestieName(choice)}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </MenuRoot>
          }
        />
      </SettingsGroup>
      <InlineHeader title="Settings" />
      <SettingsGroup>
        <PreferenceRow title="Remembers you" subtitle="Not set up yet." />
        <PreferenceRow
          title="Check-ins"
          subtitle="Every hour. Not set up yet."
        />
        <PreferenceRow
          title="Private channels Bestie can read"
          subtitle="Not set up yet. Bestie can already read every public channel."
        />
      </SettingsGroup>
      {bestie.view}
    </div>
  );
}
