import type { ChannelSummary } from "../relay/contracts.ts";

/** Presentation provenance in the relay's existing NIP-CL labels, never access. */
export const SOLO_NAMED_LABEL = "buzz.session.named";
/** NIP-CL label marking a Solo chat: a channel whose owner talks with
 * their agents at top level. Every member and agent reads it from channel
 * metadata. Presentation and composition only; ordinary channel permissions
 * remain the access authority. Conversion to a channel clears it. */
export const SOLO_LABEL = "buzz.solo";

export const SOLO_ACCESS_DISCLOSURE =
  "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.";

/** Switching an open Solo chat to Private never removes its members. */
export function soloRetainedAccessWarning(
  base: Pick<ChannelSummary, "visibility" | "joinRole">,
  mayHaveGuestMembers = true,
): string {
  if (base.visibility !== "public") return "";
  if (base.joinRole !== "guest")
    return "People who already joined remain members and keep their access until you remove them in People.";
  return mayHaveGuestMembers
    ? "People who joined while it was View only are members and keep reading until you remove them in People."
    : "";
}

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

/** Who owns a Solo chat, for presentation: its creator while still an owner,
 * else the roster's first owner, or the creator for an older chat whose roster
 * names none. Never access. */
export function soloOwner(
  channel:
    | Readonly<{
        channelType?: string | undefined;
        owners?: readonly string[] | undefined;
        creator?: string | undefined;
      }>
    | undefined,
): string | undefined {
  if (channel?.channelType !== "solo") return undefined;
  const { owners, creator } = channel;
  if (!owners?.length) return creator;
  return creator && owners.includes(creator) ? creator : owners[0];
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
