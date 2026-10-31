// FOUNDATION: Preview conversation contribution contract; data and delivery stay session-owned.
import type { ComponentType, ReactElement, ReactNode, Ref } from "react";
import type { Contribution, MatchOrder } from "../../plugins/contributions";
import type { VoiceRecording } from "../relay/voice-media";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ComposerSession } from "../messages/composer-session";

/**
 * Opens a target, such as a plugin panel URL, where the conversation host
 * places it. In a channel or thread, panel targets open as side-pane tabs.
 */
export type TargetOpener = Readonly<{
  /** Presentation only; the host re-resolves targets when opening. */
  canOpen(target: string): boolean;
  /** False when nothing can open the target, outside a conversation host,
   * or after this contribution or its placement retires. */
  open(target: string): boolean;
}>;
/** Editor-independent reference to plugin content. Not an access grant or recipient. */
export type ComposerResource = Readonly<{ uri: string; label: string }>;
export type ComposerToolProps = Readonly<{
  session: ComposerSession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Sessions may offer library agents; the host confirms channel admission before sending. */
  inviteAgents?: boolean | undefined;
  disabled: boolean;
  /** Read-only: who the draft mentions, in draft order. The tool re-renders when
   * this changes; the array keeps its identity while only the prose changes. */
  recipients: readonly Readonly<{ pubkey: string; name: string }>[];
  /** Solo, alone with agents: who hears the message. Inline mentions decide
   * when there are any; otherwise the toolbar's agents stand in. `only`
   * replaces those stand-ins with a non-empty list and `toggle` adds or
   * removes one, never the last; they also follow each send. While inline
   * mentions decide, `toggle` adds or removes that mention instead. Absent
   * elsewhere, where mentions alone decide. */
  audience?:
    | Readonly<{
        recipients: readonly Readonly<{ pubkey: string; name: string }>[];
        /** True while inline mentions in the text decide, so picks only change the stand-ins. */
        named: boolean;
        only(
          recipients: readonly Readonly<{ pubkey: string; name: string }>[],
        ): void;
        toggle(recipient: Readonly<{ pubkey: string; name: string }>): void;
      }>
    | undefined;
  /** False after removal, destination change, read-only state or a rejected edit. */
  insertText(text: string): boolean;
  /** Atomically insert display text and explicit notification intent at the caret.
   * Prose never resolves to identities. Membership is checked by session delivery.
   * Like insertText, this command is revoked with the tool/destination lifetime. */
  insertMention(recipient: Readonly<{ pubkey: string; name: string }>): boolean;
  /** All-or-nothing insertion of a saved selection as individual mentions. */
  insertMentions(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Replace all selected mentions in one undoable edit, preserving prose and focus.
   * An empty selection clears mentions. Rejected while editing a sent message. */
  replaceRecipients(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Automatic targeting only: reject when text outside selected mentions is nonempty.
   * Older hosts may omit this command. A rejected edit must not trigger unrestricted replacement. */
  replaceRecipientsIfEmpty?(
    recipients: readonly Readonly<{ pubkey: string; name: string }>[],
  ): boolean;
  /** Atomically insert a host-owned inline resource at the caret. The host validates
   * the link, escapes the label and sends exactly `[label](uri)` there; the draft
   * keeps it after tool removal. Otherwise returns the host's user-facing reason. */
  insertResource(resource: ComposerResource): true | string;
  capture?(
    component: ComponentType<ComposerCaptureProps>,
  ): (() => void) | false;
  focus(): void;
}> &
  TargetOpener;
export type ComposerCaptureProps = Readonly<{
  accept(recording: VoiceRecording): boolean;
  cancel(): void;
}>;
export type AttachmentRendererProps = Readonly<{
  attachment: Attachment;
  source: string;
  onRemove?: (() => void) | undefined;
}> &
  TargetOpener;
export type AttachmentRenderer = Readonly<{
  id: string;
  title: string;
  matches(attachment: Attachment): boolean;
  component: ComponentType<AttachmentRendererProps>;
}>;
export type ReactionToolProps = Readonly<{
  session: RelaySession;
  scope: string;
  disabled: boolean;
  /** Host-owned reaction intent; revoked when the tool or target is removed. */
  select(emoji: string): boolean;
}>;
export type ComposerTool = Readonly<{
  id: string;
  title: string;
  /** Lower values appear first; defaults to zero. Equal values sort by contribution key. */
  order?: number;
  component: ComponentType<ComposerToolProps>;
  /** Optional emoji-only chooser for the message reaction row. */
  reactionComponent?: ComponentType<ReactionToolProps>;
}>;
export type InlineContent = Readonly<{
  text: string;
  message: ChannelMessage;
  reaction?: ChannelMessage["reactions"][number] | undefined;
}>;
export type InlineRange = Readonly<{ start: number; end: number }>;
export type InlineRenderer = Readonly<{
  id: string;
  title: string;
  /** UTF-16 ranges within this plain-text segment. Links are never offered. */
  matches(content: InlineContent): readonly InlineRange[];
  component: ComponentType<
    TargetOpener & {
      text: string;
      content: InlineContent;
      media(url: string): string | undefined;
    }
  >;
}>;
/** Link presentation only. The host retains the anchor, destination and activation. */
export type LinkRenderer = Readonly<{
  id: string;
  title: string;
  matches(url: string): boolean;
  /** Claim strength when several renderers match a URL; see `MatchOrder`. */
  order?: MatchOrder | undefined;
  className?: string | undefined;
  component: ComponentType<{ url: string }>;
}>;
/** Presentation for a fenced code block, chosen by its info-string language.
 * The host retains the frame and copy action; failure or removal restores the code. */
export type CodeBlockRenderer = Readonly<{
  id: string;
  title: string;
  matches(language: string): boolean;
  component: ComponentType<{ code: string; language: string }>;
  /** A control the host places before its copy action, such as expanding the block. */
  action?: ComponentType<{ code: string; language: string }> | undefined;
}>;
export type ContributionReader<T> = Readonly<{
  snapshot(): readonly Contribution<T>[];
  subscribe(listener: () => void): () => void;
}>;
/** Optional presentation supplied to the host-owned thread button. */
export type MessageSummaryActivity = Readonly<{
  participants: readonly string[];
  content: ReactNode;
  label: string;
  ref: Ref<HTMLButtonElement>;
}>;
export type ComposerAccessoryProps = Readonly<{
  session: RelaySession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** Present only for message-placed accessories; the exact triggering row. */
  message?: ChannelMessage;
  /** A single selected decorator may wrap the host summary with its preview.
   * Render without activity when idle; the host owns reply counts/navigation. */
  renderMessageSummary?:
    | ((activity?: MessageSummaryActivity) => ReactElement | null)
    | undefined;
  /** Host-owned thread navigation from a timeline message, even before replies.
   * Absent inside the thread. False after this contribution or message retires. */
  openThread?: (() => boolean) | undefined;
  /** Return keyboard focus to a stable host control when a focused accessory retires. */
  onFocusedRemoval?: (() => void) | undefined;
  /** Presentation only; the host re-resolves targets. No editor or access grant. */
  canOpen(target: string): boolean;
  /** False after contribution removal or the originating composer retires. */
  open(target: string): boolean;
}>;
export type ComposerAccessory = Readonly<{
  /** Defaults to the composer. Message accessories render beside reactions. */
  placement?: "composer" | "message";
  /** Opt into decorating the message summary; only the first ordered owner wins. */
  decoratesMessageSummary?: boolean;
  id: string;
  title: string;
  order?: number;
  component: ComponentType<ComposerAccessoryProps>;
}>;
/** A whole message body, not an inline Markdown segment. No data or delivery ownership. */
export type MessageRenderer = Readonly<{
  id: string;
  title: string;
  matches(message: ChannelMessage): boolean;
  /** True for each attachment the component draws itself. The host leaves
   * those out of its attachment list only while it draws the component, and
   * lists them again if the component fails. A throwing claim is treated as
   * false. */
  ownsAttachment?(
    message: ChannelMessage,
    attachment: ChannelMessage["attachments"][number],
  ): boolean;
  component: ComponentType<TargetOpener & { message: ChannelMessage }>;
}>;
/** One ⋯ menu entry for a message. The host owns the menu, focus and row lifetime. */
export type MessageAction = Readonly<{
  id: string;
  title: string;
  icon?: ComponentType;
  matches(message: ChannelMessage, session: RelaySession): boolean;
  /** A menu contribution (such as a submenu) mounts inside the host menu. */
  placement?: "menu";
  /** Mounted after the menu closes by default; call close() to dismiss. */
  component: ComponentType<
    TargetOpener & {
      message: ChannelMessage;
      session: RelaySession;
      close(): void;
    }
  >;
  /**
   * Optional presentation beside the message timestamp, such as a state mark.
   * Rendered only while `matches` passes: hiding the menu entry hides the mark.
   */
  marker?: ComponentType<{ message: ChannelMessage; session: RelaySession }>;
}>;
/** What a command's `run` may read. The draft has not been sent or cleared. */
export type SlashCommandContext = Readonly<{
  session: ComposerSession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** The Markdown after the command token, trimmed. */
  args: string;
  /** Who the draft mentions, in draft order. */
  recipients: readonly Readonly<{ pubkey: string; name: string }>[];
  /** Aborts when the send is abandoned: the destination changes or the composer unmounts. */
  signal: AbortSignal;
}>;
/** `send` replaces the draft's content; the host sends it to the same channel
 * or thread, with the draft's mentions, through the ordinary send path.
 * `done` sends nothing: the host clears the draft and shows `notice`, if any,
 * as a short status confirmation. `after` runs once the draft is cleared, for
 * a command that moves the user to another conversation: that move unmounts
 * the composer, so it must not happen before the draft is gone. When the draft
 * changed while the command ran, the host keeps the newer draft, shows the
 * notice and still runs `after`, since the command's work is done. A `done`
 * result completes even if the destination stopped being writable while the
 * command ran (leaving a channel does that); only leaving the destination or
 * unmounting the composer cancels a run. */
export type SlashCommandResult =
  | Readonly<{ send: string; done?: never; notice?: never; after?: never }>
  | Readonly<{
      done: true;
      notice?: string | undefined;
      after?: (() => void) | undefined;
      send?: never;
    }>;
/** Where a draft is composed: a top-level message in a non-DM channel, a direct
 * message (including a reply in a thread there), or a reply in a thread in a
 * non-DM channel. */
export type SlashCommandScope = "channel" | "dm" | "thread";
/** What `available` may read: where the draft is composed, never the draft. */
export type SlashCommandAvailabilityContext = Readonly<{
  session: ComposerSession;
  scope: string;
  channelId: string;
  threadRootId?: string | undefined;
  /** The conversation kind the draft is composed in. */
  conversation: SlashCommandScope;
}>;
/** A typed entry point to an action the app already has. The first token of a
 * channel, DM or thread draft that is `/` plus a registered name or alias runs
 * the command on send; any other draft sends unchanged. */
export type SlashCommand = Readonly<{
  id: string;
  /** What follows `/`: lowercase letters, digits, `_` and `-`. */
  name: string;
  /** Names that run the command but never appear in the list. */
  aliases?: readonly string[];
  /** The list row's heading: the name and its argument hint, such as `/shrug [text]`. */
  usage: string;
  /** One line under the usage in the list. */
  description: string;
  /** Where the command is offered and runs; omitted means everywhere. Outside
   * these scopes the list hides it and running it fails visibly with the
   * draft kept. */
  scopes?: readonly SlashCommandScope[];
  /** Whether this viewer can run the command here, checked after `scopes`.
   * False hides it from the list; running it anyway fails visibly with the
   * draft kept, before `run`. Synchronous and cheap, since the list calls it
   * on every render, and it may only read what the session already holds. The
   * relay stays the authority: this hides what is known to be denied. A throw
   * counts as false. */
  available?(context: SlashCommandAvailabilityContext): boolean;
  /** Set when the command's @mentions are its arguments (`/invite @user`), not
   * people the message notifies. The host then skips what a send to those
   * people asks first (an old-agent or non-member prompt, the archived check),
   * since the command acts on them itself. Omitted, the mentions of a command
   * draft are checked like any message's: a `send` result publishes with them. */
  mentionsAreArguments?: true;
  /** Throw to fail: the host shows the message and keeps the draft and its
   * attachments. Nothing is retried. */
  run(
    context: SlashCommandContext,
  ): SlashCommandResult | Promise<SlashCommandResult>;
}>;
export type ConversationExtensions = Readonly<{
  attachments?: ContributionReader<AttachmentRenderer>;
  messages?: ContributionReader<MessageRenderer>;
  actions?: ContributionReader<MessageAction>;
  accessories?: ContributionReader<ComposerAccessory>;
  tools: ContributionReader<ComposerTool>;
  inline: ContributionReader<InlineRenderer>;
  completions?: ContributionReader<ComposerCompletion>;
  commands?: ContributionReader<SlashCommand>;
  links?: ContributionReader<LinkRenderer>;
  codeBlocks?: ContributionReader<CodeBlockRenderer>;
}>;

/** Immutable host-issued evidence, scoped to one live editor observation. */
export type ComposerObservation = Readonly<{
  revision: number;
  text: string;
  start: number;
  end: number;
}>;
export type CompletionContext = Pick<
  ComposerToolProps,
  "session" | "scope" | "channelId" | "threadRootId" | "inviteAgents"
> &
  Readonly<{
    /** Set only where a draft's first token can run a command. */
    slashScope?: SlashCommandScope | undefined;
  }>;
export type CompletionQuery = Readonly<{
  start: number;
  end: number;
  query: string;
}>;
/** A name the provider cannot decide on yet. The host may hold it as a chip
 * with no recipient and ask `resolve` for the recipient the terminator would
 * have selected once the provider's evidence is complete; null returns the
 * name to prose. `resolve` is headless: the provider has unmounted by then. */
export type CompletionPending = Readonly<{
  name: string;
  resolve(signal: AbortSignal): Promise<CompletionResolution>;
}>;
/** The recipient; null for prose; or, when only longer known names kept the
 * name from selecting over the complete choice set, those names, each
 * resolvable under the same rule. The host may extend the chip over the words
 * typed after it when they complete one of them, and ask that one. */
export type CompletionResolution =
  | Readonly<{ pubkey: string; name: string }>
  | Readonly<{ continued: readonly CompletionPending[] }>
  | null;
export type CompletionEdit =
  | Readonly<{
      text: string;
      mention?: never;
      mentions?: never;
      pending?: never;
    }>
  | Readonly<{
      mention: Readonly<{ pubkey: string; name: string }>;
      text?: never;
      mentions?: never;
      pending?: never;
    }>
  | Readonly<{
      mentions: readonly Readonly<{ pubkey: string; name: string }>[];
      text?: never;
      mention?: never;
      pending?: never;
    }>
  /** Host-only: the terminator typed over an undecided name. Never a suggestion's edit. */
  | Readonly<{
      pending: CompletionPending;
      text?: never;
      mention?: never;
      mentions?: never;
    }>;
export type CompletionSuggestion = Readonly<{
  id: string;
  label: string;
  detail?: string;
  /** Decorative presentation only; the host owns option semantics and interaction. */
  preview?: import("react").ReactNode;
  edit: CompletionEdit;
  /** Keep an installed identity in place after eligibility is revoked. */
  disabled?: string | undefined;
  /** Final synchronous evidence check; false never falls through to sending. */
  canSelect?: ((key: string) => boolean) | undefined;
}>;
export type CompletionResult = Readonly<{
  items: readonly CompletionSuggestion[];
  /** Provider-verified unique exact match across its uncapped candidate set. */
  spaceId?: string | undefined;
  /** No `spaceId` yet only because evidence is still arriving; the terminator
   * may hold the query as a pending mention instead of typing a literal. */
  spacePending?: CompletionPending | undefined;
  status?: string;
  /** Optional explicit recovery. A new query or disposal revokes this action. */
  retry?: () => void;
}>;
export type ComposerCompletionProps = CompletionContext &
  Readonly<{
    observation: ComposerObservation;
    query: CompletionQuery;
    /** Publishes only for this query/lifetime; returns false after revocation.
     * Cleanup of the returned disposer withdraws that exact publication. */
    publish(result: CompletionResult): (() => void) | false;
  }>;
export type ComposerCompletion = Readonly<{
  id: string;
  title: string;
  order?: number;
  /** Pure syntax matcher. Host prefers the closest trigger; order/key break ties. */
  match(
    observation: ComposerObservation,
    context: CompletionContext,
  ): CompletionQuery | null;
  component: ComponentType<ComposerCompletionProps>;
}>;

/** A conversation a page opens in a tab beside its own. `messageId` opens at
 * that message: in its thread when `threadId` is given, or else in the
 * conversation, or its thread if it is a reply or too old to find. Without
 * `messageId`, keyboard focus moves to the tab's composer once it is ready,
 * unless the user clicks or types first. */
export type PageTabTarget = {
  channelId: string;
  threadId?: string;
  messageId?: string;
};
/** `keep` opens a tab beside the others instead of in place of the last.
 * `markRead: false` keeps a conversation tab from marking what it shows read,
 * so the page decides; threads read as in Channels. */
export type PageTabOptions = { keep?: boolean; markRead?: boolean };
export type PageTabsProps = {
  /** Keys the page's tabs, which last as long as its community session. */
  id: string;
  session: RelaySession;
  scope: string;
  label: string;
  icon?: ReactNode;
  /** The page's own first tab. `open` shows a joined conversation in a host tab. */
  children(
    open: (target: PageTabTarget, options?: PageTabOptions) => boolean,
    close: (target: PageTabTarget) => boolean,
    isOpen: (target: PageTabTarget) => boolean,
  ): ReactNode;
  /** `false` keeps showing a tab out of its channel visit, so the page decides
   * what is read; tabs visit as Channels tabs do by default. */
  visits?: boolean | undefined;
};
