import type {
  Agent,
  Agents,
  RegisteredAgentType,
  AgentVoiceConnection,
} from "../agents/service";
import { relayOrigin } from "../communities/destination";
import type { RelayData } from "../relay/service";
import type { HuddleBridge, HuddleDestination } from "./bridge";
import type { Huddles } from "./service";

type Seat = {
  call: string;
  agent: Agent;
  voice: RegisteredAgentType["voice"];
  stop(): Promise<void>;
};

/** The connected human call is the sole roster source on this desktop.
 * Membership is the room's signed roster; parent membership never seats an agent. */
export function createHuddleVoices(
  huddles: Pick<Huddles, "snapshot" | "subscribe" | "voiceListening">,
  agents: Pick<Agents, "snapshot" | "subscribe" | "types">,
  relay: RelayData,
  bridge: HuddleBridge,
  report: (error: string) => void,
) {
  const seats = new Map<string, Seat>();
  let session = relay.snapshot().session;
  let offMembers = session.channels.subscribeList(sync);
  let disposed = false;
  let resolvedCall: string | undefined;
  function open(
    agent: Agent,
    voice: NonNullable<RegisteredAgentType["voice"]>,
    call: string,
    destination: HuddleDestination,
    room: string,
  ): Seat {
    const id = crypto.randomUUID();
    const abort = new AbortController();
    let connection: AgentVoiceConnection | undefined;
    let opening: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let starting: Promise<void> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let sending = false;
    const fail = (error?: unknown) => {
      if (abort.signal.aborted) return;
      void stop();
      report(
        `${agent.name}: ${error instanceof Error ? error.message : error || "Voice disconnected"}. Leave and rejoin the Huddle to retry.`,
      );
    };
    function stop() {
      if (closing) return closing;
      abort.abort();
      clearInterval(heartbeat);
      closing = Promise.allSettled([
        starting,
        Promise.resolve().then(() => connection?.close()),
        Promise.resolve(opening)
          .catch(() => {})
          .then(() => opening && bridge.close(id)),
      ]).then((results) => {
        for (const result of results)
          if (result.status === "rejected")
            report(`${agent.name}: ${String(result.reason)}`);
      });
      // Publishing re-enters sync: closing must already guard stop().
      huddles.voiceListening(call, agent.pubkey, false);
      return closing;
    }
    // Start in a microtask so the seat is recorded before callbacks can re-enter sync.
    starting = Promise.resolve()
      .then(async () => {
        if (abort.signal.aborted) return;
        opening = bridge.open(
          id,
          destination,
          room,
          (event) => {
            if (abort.signal.aborted) return;
            if (event.type === "ended") return fail(event.error);
            if (
              (event.type === "participants" || event.type === "connected") &&
              !event.participants.includes(agent.owner)
            )
              return fail("The owner left the Huddle");
            // Defense in depth; privacy tests count at the native decode site.
            if (event.type === "audio" && event.peer === agent.owner) {
              try {
                connection?.input(event.samples);
              } catch (error) {
                fail(error);
              }
            }
          },
          agent.pubkey,
        );
        await opening;
        if (abort.signal.aborted) return;
        heartbeat = setInterval(() => {
          void bridge.touch(id).catch(fail);
        }, 5000);
        const opened = await voice({
          agent,
          conversation: { channelId: room },
          signal: abort.signal,
          ended: fail,
          async output(samples) {
            if (abort.signal.aborted || sending) return;
            sending = true;
            try {
              await bridge.send(id, samples);
            } catch (error) {
              fail(error);
            } finally {
              sending = false;
            }
          },
        });
        if (abort.signal.aborted) await opened.close();
        else {
          connection = opened;
          huddles.voiceListening(call, agent.pubkey, true);
        }
      })
      .catch(fail);
    return { call, agent, voice, stop };
  }
  function sync() {
    if (disposed) return;
    const current = relay.snapshot();
    if (session !== current.session) {
      offMembers();
      session = current.session;
      offMembers = session.channels.subscribeList(sync);
    }
    const call = huddles.snapshot();
    const destination = call.destination;
    const room = call.room;
    if (call.phase === "connected" && room && call.id !== resolvedCall) {
      resolvedCall = call.id;
      void session.channels
        .resolve?.([room])
        .then(sync, (error: unknown) => report(String(error)));
    }
    if (call.phase !== "connected") resolvedCall = undefined;
    // relay/discovery.ts projects members from verified relay-authored 39002 p tags.
    const channel = room ? session.channels.get?.(room) : undefined;
    const available =
      bridge.available &&
      call.phase === "connected" &&
      call.id &&
      room &&
      destination &&
      current.status === "ready" &&
      !current.cached &&
      current.scope === destination.scope &&
      current.viewer === destination.viewer &&
      channel &&
      !channel.pending &&
      !channel.cached &&
      !channel.archived &&
      !channel.readOnly &&
      call.participants.includes(destination.viewer);
    const running =
      available && agents.snapshot().status === "ready"
        ? agents
            .snapshot()
            .running.filter(
              (agent) =>
                agent.place === "here" &&
                agent.owner === destination.viewer &&
                relayOrigin(agent.relay) ===
                  relayOrigin(destination.relayUrl) &&
                channel.members?.includes(agent.pubkey),
            )
        : [];
    const types = agents.types();
    for (const [key, seat] of seats) {
      const agent = running.find((agent) => agent.pubkey === key);
      if (
        !agent ||
        seat.call !== call.id ||
        agent.key !== seat.agent.key ||
        agent.protectionRevision !== seat.agent.protectionRevision ||
        types.find((type) => type.key === agent.type)?.voice !== seat.voice
      ) {
        // Keep closing seats reserved: native permits only one connection per agent.
        void seat.stop().then(() => {
          if (seats.get(key) !== seat) return;
          seats.delete(key);
          sync();
        });
      }
    }
    if (!available) return;
    for (const agent of running) {
      const voice = types.find((type) => type.key === agent.type)?.voice;
      if (voice && !seats.has(agent.pubkey))
        seats.set(agent.pubkey, open(agent, voice, call.id, destination, room));
    }
  }
  const stops = [
    huddles.subscribe(sync),
    agents.subscribe(sync),
    relay.subscribe(sync),
  ];
  sync();
  return async () => {
    disposed = true;
    offMembers();
    for (const stop of stops) stop();
    await Promise.all([...seats.values()].map((seat) => seat.stop()));
    seats.clear();
  };
}
