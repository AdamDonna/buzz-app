import { useProfileGeneration } from "../../features/relay/react";
import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { useIdentityNames } from "../../features/identity-names/react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { UsersIcon, RobotIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { PROFILE_CACHE_BASE } from "../../features/relay/budget";

/** Preview people in channels/DMs and participating agents in Solo chats. */
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
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    // Three avatars need no more than the base cache. An open channel reserves
    // room for its whole roster, but only the mention menu reads all of it.
    if (memberKey)
      void session.profiles
        .ensure(memberKey.split(":").slice(0, PROFILE_CACHE_BASE), "background")
        .catch(() => {});
  }, [session, memberKey, profileGeneration]);
  const agents = new Map(
    choices.identities.map((agent) => [agent.pubkey, agent]),
  );
  const solo = channel?.channelType === "solo";
  const preview = members
    .filter((id) =>
      solo
        ? agents.has(id) || profiles.get(id)?.isAgent
        : !agents.has(id) && !profiles.get(id)?.isAgent,
    )
    // Prefer recognizable photos over key-only placeholders.
    .sort(
      (a, b) =>
        Number(!!profiles.get(b)?.picture) - Number(!!profiles.get(a)?.picture),
    );
  if (!preview.length) {
    const Icon = solo ? RobotIcon : UsersIcon;
    return (
      <Avatar
        size="small"
        shape="circle"
        alt=""
        fallback={solo ? "Agents" : "Members"}
        fallbackContent={<Icon size="1rem" aria-hidden="true" />}
      />
    );
  }
  const shown = 3;
  return (
    <AvatarStack
      size="small"
      max={shown}
      items={preview.map((id, index) =>
        // Members past the shown ones only count.
        index < shown
          ? {
              id,
              name: resolveName(
                id,
                profiles.get(id)?.name ??
                  agents.get(id)?.name ??
                  formatPublicKey(id) ??
                  "Member",
              ),
              src: avatarMedia(
                profiles.get(id)?.picture ?? agents.get(id)?.avatar,
                session.media,
              ),
              shape: solo ? "squircle" : "circle",
            }
          : { id, name: "", shape: solo ? "squircle" : "circle" },
      )}
    />
  );
}
