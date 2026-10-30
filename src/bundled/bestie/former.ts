import type { Agent, Agents } from "../../features/agents/service";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { FEATURES, featureState, memory } from "./features";
import { privateChannels } from "./PrivateChannels";
import {
  cannotEdit,
  type FeatureAgents,
  featurePresent,
  instructionsOf,
  saveFeature,
} from "./save";
import { inCommunity, savedBestie } from "./saved";
import { readView, writeView } from "../../shared/view-state";

type ReconcileAgents = FeatureAgents & Pick<Agents, "snapshot" | "subscribe">;

const FORMER = "bestie:former";
/** The agents this device has seen as the community's Bestie, newest last. */
function seenAsBestie(scope: string) {
  const value = readView<unknown>(scope, FORMER, []);
  return Array.isArray(value)
    ? value.filter((pubkey): pubkey is string => typeof pubkey === "string")
    : [];
}
function rememberBestie(scope: string, pubkey: string) {
  const seen = seenAsBestie(scope);
  if (!seen.includes(pubkey))
    writeView(scope, FORMER, [...seen, pubkey].slice(-20));
}

/** Whether `agent`, which isn't Bestie, was one and still has something on
 * that the Former Bestie tab can turn off. A Bestie section in its
 * instructions shows it was Bestie, on any device, and is on. Membership of
 * one of the viewer's private channels counts only for an agent this device
 * saw as Bestie: nothing records which channels Bestie's switches added. */
export function formerWithSettings(
  agent: Agent,
  { session, scope }: RelaySnapshot,
) {
  const instructions = instructionsOf(agent);
  if (FEATURES.some((feature) => featureState(instructions, feature) !== "off"))
    return true;
  return (
    !!scope &&
    seenAsBestie(scope).includes(agent.pubkey) &&
    privateChannels(
      session.channels.list().channels,
      session.viewer ?? "",
      agent.pubkey,
    ).joined.length > 0
  );
}

/** Calls `listener` when who is in the viewer's private channels changes,
 * across reconnections, but not for each new message in them. */
export function subscribePrivateMembers(
  relay: RelayData,
  listener: () => void,
) {
  const members = (session: RelaySession) =>
    privateChannels(session.channels.list().channels, session.viewer ?? "", "")
      .others.map(({ id, members = [] }) => `${id}:${[...members].sort()}`)
      .sort()
      .join(" ");
  let session = relay.snapshot().session;
  let last = members(session);
  const changed = () => {
    const next = members(session);
    if (next === last) return;
    last = next;
    listener();
  };
  const follow = () => {
    session.channels.ensureList();
    return session.channels.subscribeList(changed);
  };
  let stop = follow();
  const stopRelay = relay.subscribe(() => {
    const next = relay.snapshot().session;
    if (next === session) return;
    stop();
    session = next;
    stop = follow();
    changed();
  });
  return () => {
    stopRelay();
    stop();
  };
}

/** Stops the check-ins of each agent here that isn't the community's Bestie,
 * whenever the saved Bestie or the agents change, wherever the change was
 * made. It acts only on a Bestie saved to the account and read: while the
 * choice is loading or unknown, or kept only on this device, where an
 * automatic pick looks the same, nobody counts as former. An agent also in
 * another community, where it may be Bestie, loses only its timer here, as
 * its instructions are shared. Memory and channels stay as they are. */
export function stopFormerCheckIns(relay: RelayData, agents: ReconcileAgents) {
  const bestie = savedBestie(relay);
  const checkIns = FEATURES.filter(({ timer }) => timer);
  /** Agents being saved, and what each was like when last tried, so a state
   * is tried once per connection, and a save that left it as it was doesn't
   * loop. */
  const saving = new Set<string>();
  const tried = new Map<string, string>();
  let session = relay.snapshot().session;
  const reconcile = () => {
    const relaySnapshot = relay.snapshot();
    if (relaySnapshot.session !== session) {
      session = relaySnapshot.session;
      tried.clear();
    }
    const current = session.mainAgent ? bestie.snapshot() : undefined;
    if (!current) return;
    if (relaySnapshot.scope) rememberBestie(relaySnapshot.scope, current);
    const { agents: here, running = [] } = agents.snapshot();
    for (const agent of here) {
      const on = checkIns.filter((feature) => featurePresent(agent, feature));
      const seen = JSON.stringify([instructionsOf(agent), agent.attention]);
      if (
        !on.length ||
        agent.pubkey === current ||
        agent.place !== "here" ||
        saving.has(agent.key) ||
        tried.get(agent.key) === seen ||
        cannotEdit(agents, agent) ||
        !inCommunity(agent, relaySnapshot)
      )
        continue;
      const timerOnly = running.some(
        (other) =>
          other.pubkey === agent.pubkey && !inCommunity(other, relaySnapshot),
      );
      saving.add(agent.key);
      tried.set(agent.key, seen);
      // Not while the agents are telling their listeners of a change.
      void Promise.resolve()
        .then(async () => {
          for (const feature of on) {
            // Each save starts from the agent as the last one left it, and
            // stops if it was made Bestie again meanwhile.
            const fresh = agents
              .snapshot()
              .agents.find((each) => each.key === agent.key);
            if (!fresh || bestie.snapshot() === agent.pubkey) return;
            await saveFeature(agents, fresh, feature, false, { timerOnly });
          }
        })
        .catch((error: unknown) =>
          console.warn("A former Bestie's check-ins didn't stop", error),
        )
        .finally(() => {
          saving.delete(agent.key);
          // What changed while it saved.
          reconcile();
        });
    }
  };
  const stopBestie = bestie.subscribe(reconcile);
  const stopAgents = agents.subscribe(reconcile);
  const stopRelay = relay.subscribe(reconcile);
  reconcile();
  return () => {
    stopBestie();
    stopAgents();
    stopRelay();
  };
}

/** Turns Remembers you on for a local agent this device just made Bestie,
 * unless its type can't take it or it already has it. */
export function rememberNewBestie(
  relay: RelayData,
  agents: ReconcileAgents,
  pubkey: string,
) {
  const agent = agents
    .snapshot()
    .agents.find(
      (candidate) =>
        candidate.pubkey === pubkey &&
        candidate.place === "here" &&
        inCommunity(candidate, relay.snapshot()),
    );
  if (
    !agent ||
    cannotEdit(agents, agent) ||
    // Never a second section, even beside one edited by hand.
    featureState(instructionsOf(agent), memory) !== "off"
  )
    return Promise.resolve();
  return saveFeature(agents, agent, memory, true);
}
