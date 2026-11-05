import { useEffect, useState } from "react";
import type { Navigation } from "../../features/navigation/controller";
import type { NavigationScope } from "../../features/navigation/targets";
import type { VisibleEvent } from "../../features/relay/projection";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { RelaySession } from "../../features/relay/session";
import { useChannelList } from "../../features/relay/react";
import { channelIcon, channelText } from "../../features/channels/channel-icon";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import styles from "./Inbox.module.css";

const pageSize = 50;

/** Authored history uses the same authorized finite reads as message search.
 * Opening a result resolves its current content and thread through navigation. */
export function SentView({
  session,
  scope,
  navigator,
}: {
  session: RelaySession;
  scope: NavigationScope;
  navigator: Navigation;
}) {
  const channels = useChannelList(session.channels);
  const [request, setRequest] = useState({ page: 1, attempt: 0 });
  const [events, setEvents] = useState<readonly VisibleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void session
      .readPage(
        [
          {
            kinds: [9],
            authors: [scope.viewer],
            limit: pageSize,
            ...(request.page > 1 ? { page: request.page } : {}),
          },
        ],
        { signal: controller.signal, priority: "foreground", fresh: true },
      )
      .then(({ events: incoming, relayCount }) => {
        if (controller.signal.aborted) return;
        setEvents((previous) =>
          [
            ...new Map(
              [...(request.page === 1 ? [] : previous), ...incoming]
                .filter(
                  (event) =>
                    event.kind === 9 &&
                    event.pubkey === scope.viewer &&
                    (!event.delivery ||
                      event.delivery === "accepted" ||
                      event.delivery === "seen"),
                )
                .map((event) => [event.id, event]),
            ).values(),
          ].sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          ),
        );
        setMore(relayCount >= pageSize);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("Could not load sent messages. Try again.");
        setLoading(false);
      });
    return () => controller.abort();
  }, [session, scope.viewer, request]);
  const visible = events.flatMap((event) => {
    const destinations = event.tags.filter(([name]) => name === "h");
    const channel = channels.channels.find(
      (item) => item.id === destinations[0]?.[1],
    );
    return destinations.length === 1 &&
      channel &&
      !channel.huddle &&
      !channel.metadataPending &&
      !channel.cached
      ? [{ event, channel }]
      : [];
  });
  const open = async (channelId: string, messageId: string) => {
    setOpenError(undefined);
    try {
      const result = await navigator.open({
        version: 1,
        kind: "conversation",
        scope,
        channelId,
        messageId,
      });
      if (result.status === "failed")
        setOpenError("Could not open this message. Try again.");
    } catch {
      setOpenError("Could not open this message. Try again.");
    }
  };
  return (
    <div className={styles.sent}>
      <div className={styles.toolbar}>
        <span className="text-caption text-subtle">
          Your messages, newest first
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() =>
            setRequest((value) => ({ page: 1, attempt: value.attempt + 1 }))
          }
        >
          Refresh
        </Button>
      </div>
      <div className={styles.scroll} aria-busy={loading}>
        {openError && (
          <p className={styles.notice} role="alert">
            {openError}
          </p>
        )}
        {error && (
          <div className={styles.notice} role="alert">
            <span className="text-body">{error}</span>
            <Button
              size="sm"
              onClick={() =>
                setRequest((value) => ({
                  ...value,
                  attempt: value.attempt + 1,
                }))
              }
            >
              Retry sent messages
            </Button>
          </div>
        )}
        {loading && (
          <p className={`${styles.notice} text-body text-subtle`} role="status">
            Loading sent messages…
          </p>
        )}
        {!loading && !error && !visible.length && (
          <div className={styles.empty}>
            <EmptyState
              icon={<ChatCircleIcon />}
              title="No sent messages"
              description="Messages you send in this community appear here."
            />
          </div>
        )}
        <ul className={styles.list} aria-label="Sent messages">
          {visible.map(({ event, channel }) => {
            const Icon = channelIcon(channel);
            return (
              <li key={event.id} className={styles.row}>
                <NavigationItem
                  icon={<Icon size="1.25rem" aria-hidden="true" />}
                  label={
                    <span className={styles.content}>
                      <span className={`${styles.heading} text-label-sm`}>
                        <span className={styles.sender}>
                          {channelText(channel)}
                        </span>
                        <time
                          className="text-caption text-subtle"
                          dateTime={new Date(
                            event.created_at * 1000,
                          ).toISOString()}
                        >
                          {relativeTimestamp(event.created_at)}
                        </time>
                      </span>
                      <span
                        className={`${styles.preview} text-body text-subtle`}
                      >
                        {event.content
                          .replace(/\s+/g, " ")
                          .trim()
                          .slice(0, 240) || "Attachment"}
                      </span>
                    </span>
                  }
                  onClick={() => void open(channel.id, event.id)}
                />
              </li>
            );
          })}
        </ul>
        {more && !error && (
          <div className={styles.notice}>
            <Button
              size="sm"
              loading={loading}
              onClick={() =>
                setRequest((value) => ({
                  page: value.page + 1,
                  attempt: value.attempt,
                }))
              }
            >
              Show more sent messages
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
