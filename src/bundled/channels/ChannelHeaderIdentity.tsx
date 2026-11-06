import type { ComponentProps } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import { ChannelMemberAvatars } from "./ChannelMemberAvatars";
import styles from "./ChannelHeaderIdentity.module.css";

type AccessChannel = Pick<
  ChannelSummary,
  "channelType" | "viewerRole" | "readOnly" | "joinRole"
>;

/** What the viewer can do in a conversation's access dialog: its title, and
 * the name of a control that opens it. */
export function memberAccess(channel: AccessChannel | undefined) {
  const solo = channel?.channelType === "solo";
  const readOnly =
    channel?.viewerRole === "guest" ||
    (channel?.readOnly && channel.joinRole === "guest");
  if (solo && readOnly)
    return {
      title: "Chat access",
      label: (name: string) => `Chat access for ${name}`,
    };
  if (solo)
    return {
      title: "Share access",
      label: (name: string) => `Share access to ${name}`,
    };
  if (readOnly)
    return {
      title: "Channel access",
      label: (name: string) => `Channel access for ${name}`,
    };
  return {
    title: "Manage members",
    label: (name: string) => `Manage members of ${name}`,
  };
}

/** One artwork/name target opens the conversation's existing access dialog. */
export function ChannelHeaderIdentity({
  session,
  channelId,
  name,
  detail,
  access,
  ...props
}: Omit<
  ComponentProps<typeof SurfaceButton>,
  "children" | "className" | "aria-label" | "title" | "aria-haspopup"
> & {
  session: RelaySession;
  channelId: string;
  name: string;
  /** Extra context, such as a Solo chat's owner, for the name and hint. */
  detail?: string | undefined;
  /** From `memberAccess`, so the name matches the dialog it opens. */
  access: ReturnType<typeof memberAccess>;
}) {
  return (
    <SurfaceButton
      {...props}
      aria-label={`${access.label(name)}${detail ? `, ${detail}` : ""}`}
      title={detail ?? access.title}
      aria-haspopup="dialog"
      className={styles.identity}
    >
      <span className={styles.avatars} aria-hidden="true">
        <ChannelMemberAvatars session={session} channelId={channelId} />
      </span>
      <span className={styles.label}>
        <span className={`${styles.name} text-body-sm`}>{name}</span>
      </span>
    </SurfaceButton>
  );
}
