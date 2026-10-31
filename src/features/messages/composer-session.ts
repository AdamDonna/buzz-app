import type { RelaySession } from "../relay/session";

type AsyncResult<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => R | Promise<R>
  : never;
/** The editor consumes presentation and explicit chat operations, never a relay transport. */
export type ComposerSession = Pick<
  RelaySession,
  "viewer" | "media" | "scope"
> & {
  names?: import("../identity-names/service").IdentityNameView | undefined;
  recovery?: RelaySession["recovery"];
  repositories: Pick<
    RelaySession["repositories"],
    "home" | "load" | "peekHome"
  >;
  channels: Pick<
    RelaySession["channels"],
    | "list"
    | "subscribeList"
    | "get"
    | "ensureList"
    | "refreshList"
    | "searchPublic"
    | "matchPublic"
    | "openDirectory"
  > &
    Partial<Pick<RelaySession["channels"], "subscribeWindow" | "window">>;
  profiles: RelaySession["profiles"];
  emoji: Pick<
    RelaySession["emoji"],
    "snapshot" | "subscribe" | "ensure" | "refresh"
  >;
  agentChoices: Pick<
    RelaySession["agentChoices"],
    "snapshot" | "subscribe" | "ensure" | "retain" | "refresh"
  >;
  agentLibrary: RelaySession["agentLibrary"];
  archives: Pick<
    RelaySession["archives"],
    "snapshot" | "subscribe" | "ensure" | "state" | "refresh"
  >;
  typing: Pick<RelaySession["typing"], "snapshot" | "subscribe"> &
    Partial<Pick<RelaySession["typing"], "send">>;
  presence?: Pick<NonNullable<RelaySession["presence"]>, "status"> | undefined;
  directMessages: Pick<RelaySession["directMessages"], "people"> &
    Partial<
      Pick<
        RelaySession["directMessages"],
        "available" | "open" | "delivered" | "delivery"
      >
    >;
  /** Rename and mute for slash commands; a detached editor has neither. */
  channelDetails?: Pick<
    RelaySession["channelDetails"],
    "available" | "load" | "save"
  >;
  /** Saved sidebar arrangement and mute list, for commands that follow the
   * sidebar's order or change what it mutes. */
  sidebarPreferences?: Pick<
    RelaySession["sidebarPreferences"],
    "muteWritable" | "setMute" | "snapshot"
  >;
  memberAdditions: Pick<RelaySession["memberAdditions"], "add">;
  channelWrites: Pick<
    RelaySession["channelWrites"],
    "refreshMembership" | "addAgents"
  >;
  /** Join and leave for slash commands, the permission read behind /archive,
   * and the hidden direct messages the sidebar leaves out; a detached editor
   * has none. */
  channelLifecycle?: Pick<
    RelaySession["channelLifecycle"],
    "available" | "load"
  > & {
    run(
      action: "join" | "leave",
      channelId: string,
      signal?: AbortSignal,
    ): Promise<void>;
    snapshot(): Pick<
      ReturnType<RelaySession["channelLifecycle"]["snapshot"]>,
      "hidden"
    >;
  };
  memberAdministration?: Pick<
    RelaySession["memberAdministration"],
    "available" | "refresh" | "run" | "snapshot"
  >;
  outbox:
    | (Pick<
        NonNullable<RelaySession["outbox"]>,
        "supports" | "snapshot" | "subscribe" | "retry"
      > &
        Partial<Pick<NonNullable<RelaySession["outbox"]>, "dismiss">>)
    | undefined;
  attachments:
    | (NonNullable<RelaySession["attachments"]> & {
        /** A detached editor delegates native file preparation to its owning window. */
        prepare?(file: File, signal: AbortSignal): Promise<File>;
        release?(file: import("../relay/attachments").UploadedAttachment): void;
      })
    | undefined;
  messages: {
    send: AsyncResult<RelaySession["messages"]["send"]>;
    reply: AsyncResult<RelaySession["messages"]["reply"]>;
    edit: RelaySession["messages"]["edit"];
  };
};

export function fullSession(
  session: RelaySession | ComposerSession | undefined,
): RelaySession | undefined {
  return session && "unread" in session ? session : undefined;
}
