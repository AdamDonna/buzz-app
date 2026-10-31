import type { OpenTarget } from "../navigation/targets";

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
