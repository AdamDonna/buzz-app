import type { OpenTarget } from "../navigation/targets";
import { conversationTarget } from "./routes";

/** The channels the sidebar would offer next, nearest first: those after the
 * one being left, then those before it, nearest first. */
export function channelNeighbors(
  ids: readonly string[],
  leaving: string,
): string[] {
  const at = ids.indexOf(leaving);
  return at < 0
    ? [...ids]
    : [...ids.slice(at + 1), ...ids.slice(0, at).reverse()];
}

/** Which listed channel takes the place of one the viewer left or lost: the
 * nearest neighbor still listed, else the first other listed channel. */
export function successorChannel(
  neighbors: readonly string[],
  listed: readonly string[],
  leaving: string,
): string | undefined {
  return (
    neighbors.find((id) => id !== leaving && listed.includes(id)) ??
    listed.find((id) => id !== leaving)
  );
}

/** The channels page with nothing selected, for when no channel is left. */
export function emptyChannelsTarget(): OpenTarget {
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    route: { version: 1, params: "empty" },
  };
}

/** Where leaving a channel lands: its successor, else the empty channels page. */
export function channelSuccessorTarget(
  scope: string,
  neighbors: readonly string[],
  listed: readonly string[],
  leaving: string,
): OpenTarget {
  const next = successorChannel(neighbors, listed, leaving);
  return next ? conversationTarget(scope, next) : emptyChannelsTarget();
}
