import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";
import { avatarMedia } from "../../shared/avatar-source";
import { formatPublicKey } from "../../shared/identity/public-key";
import { useChannelIdentityNames } from "../identity-names/react";
import { useRowProfiles } from "../relay/react";
import { workflowLabel } from "../relay/workflow-attribution";
import type { ChannelMessage } from "../relay/contracts";
import type { ThreadSnapshot } from "../relay/threads";
import type { RelaySession } from "../relay/session";
import styles from "./Messages.module.css";

/** The same reply target in a thread or the channel's composer. */
export function ReplyContext({
  session,
  channelId,
  message,
  onCancel,
  status = "ready",
  onRetry,
}: {
  session: RelaySession;
  channelId: string;
  message: ChannelMessage | undefined;
  onCancel(): void;
  status?: ThreadSnapshot["status"];
  onRetry?: (() => void) | undefined;
}) {
  const profiles = useRowProfiles(session.profiles, message ? [message] : []);
  const resolveName = useChannelIdentityNames(session, channelId);
  if (!message)
    return (
      <div className={styles.replyContext}>
        <span role="status">
          {status === "idle" || status === "loading"
            ? "Loading reply target…"
            : status === "error"
              ? "Couldn’t load reply target."
              : "Reply target is no longer available."}
        </span>
        {status === "error" && onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry reply target
          </Button>
        )}
        <Button size="sm" onClick={onCancel}>
          Cancel reply target
        </Button>
      </div>
    );
  const id = message.workflowOwnerId ?? message.authorId;
  const resolved = resolveName(
    id,
    profiles.get(id)?.name ?? formatPublicKey(id) ?? "Unknown author",
  );
  const name = message.workflowOwnerId ? workflowLabel(resolved) : resolved;
  return (
    <div className={styles.replyContext}>
      <Avatar
        src={avatarMedia(
          profiles.get(message.authorId)?.picture,
          session.media,
        )}
        alt=""
        fallback={name}
        size="default"
      />
      <div>
        <span>Reply in thread</span>
        <p>{message.content}</p>
      </div>
      <IconButton
        size="sm"
        aria-label="Cancel reply target"
        onClick={onCancel}
        icon={<XIcon size={16} aria-hidden="true" />}
      />
    </div>
  );
}
