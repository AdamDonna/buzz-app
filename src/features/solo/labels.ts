import type { ChannelSummary } from "../relay/contracts.ts";

/** Presentation provenance in the relay's existing NIP-CL labels, never access. */
export const SOLO_NAMED_LABEL = "buzz.session.named";
/** NIP-CL label marking a Solo chat: a private channel whose owner talks with
 * their agents at top level. Every member and agent reads it from channel
 * metadata. Presentation and composition only; membership stays the access
 * authority. Conversion to a channel clears it. */
export const SOLO_LABEL = "buzz.solo";

export function soloLabels(labels: readonly string[] | undefined): boolean {
  return !!labels?.includes(SOLO_LABEL);
}

/** The viewer's own Solo chat: the relay-signed roster makes them its owner.
 * Anyone else in a shared Solo chat sees its flat treatment and finds it where
 * it was shared. An unknown role is not ownership. */
export function ownSolo(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        viewerRole?: ChannelSummary["viewerRole"];
      }>
    | undefined,
): boolean {
  return channel?.channelType === "solo" && channel.viewerRole === "owner";
}

/** Who owns a Solo chat, for presentation: the roster's owner, or its
 * creator for an older chat whose roster names none. Never access. */
export function soloOwner(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        owner?: string | undefined;
        creator?: string | undefined;
      }>
    | undefined,
): string | undefined {
  return channel?.channelType === "solo"
    ? (channel.owner ?? channel.creator)
    : undefined;
}

export function soloChatLinkName(channel: { id: string; name: string }) {
  // Unnamed chats still carry their starting title from the first prompt.
  return channel.name.trim() || channel.id.slice(0, 8);
}

/** The sidebar's Solo inventory: the viewer's own unarchived chats. A chat
 * shared with the viewer is reachable from where it was shared, never listed;
 * unknown metadata never implies Solo or ownership. */
export function eligibleSolo(channel: ChannelSummary) {
  return !channel.archived && ownSolo(channel);
}
