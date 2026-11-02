import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { soloOwner } from "../../features/solo/labels";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";
import { UsersIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";

/** The members control previews people in a capsule that grows with them. */
export function ChannelMembersTrigger({
  session,
  channelId,
  ...props
}: Omit<IconButtonProps, "icon" | "variant" | "size" | "style"> & {
  session: RelaySession;
  channelId: string;
}) {
  return (
    <IconButton
      {...props}
      size="sm"
      variant="avatar"
      style={{
        width: "auto",
        minWidth: "var(--size-control-sm)",
        paddingInline: "var(--space-1)",
      }}
      icon={<ChannelMemberAvatars session={session} channelId={channelId} />}
    />
  );
}

/** The members trigger previews people; the dialog still includes every member.
 * A Solo chat leads with its owner and keeps the people icon until it is
 * shared with someone besides the viewer. */
export function ChannelMemberAvatars({
  session,
  channelId,
}: {
  session: RelaySession;
  channelId: string;
}) {
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
    session.agentChoices.snapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const members = channel?.members ?? [];
  const memberKey = members.join(":");
  useEffect(() => {
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":"), "background")
        .catch(() => {});
  }, [session, memberKey]);
  const agents = new Set(choices.identities.map((agent) => agent.pubkey));
  const owner = soloOwner(channel);
  const people = members
    .filter((id) => !agents.has(id) && !profiles.get(id)?.isAgent)
    // The owner first, then recognizable photos over key-only placeholders.
    .sort(
      (a, b) =>
        Number(b === owner) - Number(a === owner) ||
        Number(!!profiles.get(b)?.picture) - Number(!!profiles.get(a)?.picture),
    );
  const unshared =
    channel?.channelType === "solo" &&
    people.every((id) => id === session.viewer);
  if (!people.length || unshared)
    return <UsersIcon size="1rem" aria-hidden="true" />;
  const shown = 3;
  return (
    <AvatarStack
      size="small"
      max={shown}
      items={people.map((id, index) =>
        // Members past the shown ones only count.
        index < shown
          ? {
              id,
              name: resolveName(
                id,
                profiles.get(id)?.name ?? formatPublicKey(id) ?? "Member",
              ),
              src: avatarMedia(profiles.get(id)?.picture, session.media),
              shape: "circle",
            }
          : { id, name: "", shape: "circle" },
      )}
    />
  );
}
