import type { SlashCommand } from "../../features/conversation/contracts";
import { discoverHuddles } from "../../features/huddle/discovery";
import type { Huddles } from "../../features/huddle/service";
import type { RelayData } from "../../features/relay/service";

/** Brings the running call forward: its mini player if shown, else its window. */
export async function showActiveHuddle(showWindow: () => Promise<void>) {
  const capsule = document.getElementById("huddle-capsule");
  if (capsule) capsule.focus();
  else await showWindow();
}

/**
 * `/huddle` takes the same path as the channel's headphone button: join the
 * newest running huddle, else start one. A thread belongs to its channel's
 * huddle, as the button in a thread's channel header does.
 */
export function huddleCommand(deps: {
  relay: RelayData;
  huddles: Huddles;
  showWindow(): Promise<void>;
}): SlashCommand {
  const { relay, huddles, showWindow } = deps;
  return {
    id: "huddle",
    name: "huddle",
    usage: "/huddle",
    description: "Start a huddle here, or join the one running",
    async run({ session, scope, channelId, args, signal }) {
      if (args) throw new Error("Usage: /huddle");
      const connection = relay.snapshot();
      const viewer = connection.viewer;
      if (
        connection.status !== "ready" ||
        connection.scope !== scope ||
        !viewer ||
        !connection.origin
      )
        throw new Error("Connect to this community before starting a huddle.");
      const channel =
        session.channels.list().channels.find((c) => c.id === channelId) ??
        session.channels.get?.(channelId);
      if (!channel)
        throw new Error("This chat is not loaded yet. Try again in a moment.");
      if (channel.archived)
        throw new Error("Huddles are not available in an archived channel.");
      if (channel.cached)
        throw new Error("Reconnect to this channel before starting a huddle.");
      if (channel.readOnly)
        throw new Error("Huddles are not available in a read-only channel.");
      if (!channel.members?.includes(viewer))
        throw new Error("Join this channel before starting a huddle.");
      if (
        ["connecting", "connected", "leaving"].includes(
          huddles.snapshot().phase,
        )
      ) {
        await showActiveHuddle(showWindow);
        return { done: true, notice: "Showing your active huddle" };
      }
      const destination = {
        scope,
        viewer,
        relayUrl: connection.origin,
        channelId,
        channelName: channel.name,
      };
      const rooms = await discoverHuddles(
        connection.session,
        channelId,
        signal,
      );
      signal.throwIfAborted();
      const room = rooms.find((candidate) =>
        huddles.canJoin(scope, candidate.id),
      );
      await (room
        ? huddles.join(destination, room.id)
        : huddles.start(destination));
      const call = huddles.snapshot();
      if (call.phase === "error")
        throw new Error(call.error ?? "The huddle could not start.");
      if (call.phase !== "connecting" && call.phase !== "connected")
        throw new Error("The huddle ended before it connected.");
      return {
        done: true,
        notice: room ? "Joining the huddle" : "Starting a huddle",
      };
    },
  };
}
