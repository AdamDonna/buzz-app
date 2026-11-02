import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import { conversationTarget } from "../../features/channel-navigation/routes";
import { ownSolo, soloChatLinkName } from "../../features/solo/labels";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { subscribeView, viewRevision } from "../../shared/view-state";
import { UnreadBadge } from "../channels/UnreadBadge";
import { RowIndicators } from "../channels/ChannelSidebarRow";
import { archiveIndex, archiveKey, isArchived, readArchives } from "./archive";

/** Someone else's Solo chats that tagged the viewer, nested under Inbox. A
 * shared chat opened without a tag adds nothing; the viewer's place holds. */
export function SharedChatRows({
  relay,
  navigator,
}: {
  relay: RelayData;
  navigator: Navigation;
}) {
  const connection = useRelayConnection(relay);
  // Held above the session, so a reconnect never drops the row being read.
  const [held, setHeld] = useState<string>();
  return connection.status === "ready" && connection.scope ? (
    <Rows
      key={`${connection.scope}:${connection.generation}`}
      session={connection.session}
      scope={connection.scope}
      navigator={navigator}
      held={held}
      setHeld={setHeld}
    />
  ) : null;
}

function Rows({
  session,
  scope,
  navigator,
  held,
  setHeld,
}: {
  session: RelaySession;
  scope: string;
  navigator: Navigation;
  held: string | undefined;
  setHeld: (channelId: string | undefined) => void;
}) {
  const list = useChannelList(session.channels);
  const inbox = useSyncExternalStore(
    session.unread.subscribeInbox,
    session.unread.inbox,
  );
  const target = useSyncExternalStore(
    navigator.subscribe,
    () => navigator.snapshot().entry.target,
  );
  const open = target.kind === "conversation" ? target.channelId : undefined;
  const subscribeArchives = useCallback(
    (listener: () => void) => subscribeView(session.scope, listener),
    [session.scope],
  );
  const archiveRevision = useSyncExternalStore(subscribeArchives, () =>
    viewRevision(session.scope, archiveKey),
  );
  const archives = useMemo(
    () => archiveIndex(readArchives(archiveRevision)),
    [archiveRevision],
  );
  // The unread engine gives each shared chat one row, built only from tags;
  // archiving it in Inbox clears it here too, even while it is open.
  const archived = new Set(
    inbox.items
      .filter((item) => isArchived(archives, item))
      .map((item) => item.channelId),
  );
  const tagged = new Set(
    inbox.items
      .filter((item) => item.unreadCount > 0 && !archived.has(item.channelId))
      .map((item) => item.channelId),
  );
  const chats = list.channels.filter(
    (channel) => channel.channelType === "solo" && !ownSolo(channel),
  );
  // Reading the open chat clears its tag; keep its row until the viewer
  // moves on, so it doesn't vanish underfoot.
  const holding =
    open && (tagged.has(open) || (held === open && !archived.has(open)))
      ? open
      : undefined;
  useEffect(() => setHeld(holding), [holding, setHeld]);
  return chats
    .filter((channel) => tagged.has(channel.id) || channel.id === holding)
    .map((channel) => (
      <NavigationItem
        key={channel.id}
        variant="row"
        inset
        label={soloChatLinkName(channel)}
        title={soloChatLinkName(channel)}
        icon={<ChatCircleIcon size={16} />}
        trailing={
          <RowIndicators>
            <UnreadBadge session={session} channelId={channel.id} />
          </RowIndicators>
        }
        selected={open === channel.id}
        onClick={() =>
          void navigator.open(conversationTarget(scope, channel.id))
        }
      />
    ));
}
