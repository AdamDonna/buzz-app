import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import type { ConversationExtensions } from "../conversation/contracts";
import type { TaskDraft } from "../channel-navigation/solo-navigation-contract";
import { soloNavigationFor } from "../channel-navigation/solo-navigation";
import {
  taskDraftContext,
  TASK_MODE_LABEL,
  TASK_UNAVAILABLE,
  taskFirstEventRecovery,
  readTaskFirstEventRecovery,
  validateTaskPublication,
  recordTaskFirstEvent,
} from "./task-mode";
import { SoloDraftView } from "./SoloPresentation";
import { MessageComposer } from "../messages/MessageComposer";
import {
  mentionDraft,
  hasDraftContent,
  type MentionDraft,
} from "../messages/mention-draft";
import {
  attachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
} from "../messages/attachment-draft";
import { composerMarkdown } from "../messages/composer-markdown";
import {
  taskTokenFallback,
  taskTokenTags,
  readTaskTokens,
} from "../messages/task-tokens";
import {
  readView,
  writeView,
  viewRevision,
  replaceView,
} from "../../shared/view-state";
import { attachmentMessage } from "../relay/attachments";
import { startingChatTitle } from "./chat-title";
import type { SoloDraft as DraftRoute } from "../channel-navigation/routes";
import { ChatNotStarted } from "../relay/channel-writes";
import { taskHeaderUI } from "./TaskHeaderTitle";
import { regionLabels } from "./region-labels";
import { useDefaultAgent } from "./default-agent";
import composerStyles from "../messages/Messages.module.css";

const noopSubscribe = () => () => {};
const noSnapshot = () => undefined;

/** Task-only preparation reuses the host editor and Solo start. Workspace
 * setup defaults never enter this path. The plugin owns the durable creation intent. */
export function TaskSoloDraft({
  session,
  scope,
  route,
  agent,
  extensions,
  onStarted,
  onFailed,
  focusRequest,
}: {
  session: RelaySession;
  scope: string;
  route: NonNullable<DraftRoute["task"]>;
  agent?: string | undefined;
  extensions?: ConversationExtensions | undefined;
  onStarted(id: string): void;
  onFailed?: ((id: string, reason: string) => void) | undefined;
  focusRequest?: number | AbortSignal;
}) {
  const service = soloNavigationFor(session);
  useSyncExternalStore(
    service?.subscribe ?? noopSubscribe,
    service?.snapshot ?? noSnapshot,
  );
  const context = taskDraftContext(session, route.region);
  const key = `solo:task:${route.draftId}`;
  const [state, setState] = useState(() => {
    const identity = readView<{ revision?: number; primary?: string | null }>(
      scope,
      `${key}:identity`,
      {},
    );
    return {
      draft: mentionDraft(readView(scope, `${key}:new-draft`, "")),
      revision: Number.isSafeInteger(identity?.revision)
        ? (identity.revision ?? 0)
        : 0,
      primary:
        identity?.primary === null ? undefined : (identity?.primary ?? agent),
    };
  });
  const current = useRef(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => attempt.current?.abort(), []);
  const changed = useCallback(
    (draft: MentionDraft, selectedPrimary?: string) => {
      const previous = current.current;
      let primary = previous.primary;
      if (
        (draft.recipients.length || previous.draft.recipients.length) &&
        !draft.recipients.some((item) => item.pubkey === primary)
      )
        primary = draft.recipients[0]?.pubkey;
      primary = selectedPrimary ?? primary;
      if (
        JSON.stringify(draft) === JSON.stringify(previous.draft) &&
        primary === previous.primary
      )
        return;
      const next = { draft, primary, revision: previous.revision + 1 };
      if (
        !writeView(scope, `${key}:identity`, {
          revision: next.revision,
          primary: primary ?? null,
        })
      )
        throw new Error("The task draft could not be saved. Try again.");
      current.current = next;
      setState(next);
    },
    [scope, key],
  );
  const eligible = (key: string) => {
    try {
      return (
        !!context &&
        context.mode.participants.eligible(key) &&
        session.agentChoices
          .snapshot()
          .selectable.some((choice) => choice.pubkey === key)
      );
    } catch {
      return false;
    }
  };
  const eligiblePrimary = useDefaultAgent(
    session,
    scope,
    state.primary ?? agent,
    eligible,
  );
  const snapshot = (
    draft: MentionDraft,
    attachments: TaskDraft["attachments"] = [],
  ): TaskDraft | undefined => {
    const explicit = [...new Set(draft.recipients.map((item) => item.pubkey))];
    const primary = explicit.length
      ? explicit.includes(current.current.primary ?? "")
        ? current.current.primary
        : explicit[0]
      : eligiblePrimary?.pubkey;
    return context
      ? {
          draftId: route.draftId,
          revision: current.current.revision,
          binding: context.binding,
          text: composerMarkdown(draft),
          recipients: explicit.length ? explicit : primary ? [primary] : [],
          ...(primary ? { primary } : {}),
          tokens: draft.tokens?.map((item) => item.token) ?? [],
          attachments,
        }
      : undefined;
  };
  async function start(draft: MentionDraft, files: AttachmentDraft) {
    if (attempt.current || !context) return;
    const selection = snapshot(draft);
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setError(undefined);
    const signal = AbortSignal.any([controller.signal, context.signal]);
    try {
      if (!session.outbox) throw new Error("Task messaging is unavailable.");
      await session.outbox.ready();
      signal.throwIfAborted();
      const operations = session.outbox.snapshot();
      const pending = operations.filter(
        (item) => item.recovery?.key === `solo-task:${route.draftId}`,
      );
      if (pending.length > 1)
        throw new Error(
          "More than one saved first message needs review in Outbox.",
        );
      const saved = pending[0];
      if (saved?.recovery) {
        const recovery = readTaskFirstEventRecovery(
          saved.event,
          saved.recovery,
        );
        if (
          saved.event.pubkey !== session.viewer ||
          recovery.draftId !== route.draftId ||
          recovery.regionLabel !== context.label
        )
          throw new Error("The saved task message does not match this draft.");
        const creates = operations.filter(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([key, value]) => key === "h" && value === recovery.channelId,
            ),
        );
        if (creates.length > 1)
          throw new Error(
            "More than one saved task creation needs review in Outbox.",
          );
        const create = creates[0];
        const members =
          create?.event.tags
            .filter(([key]) => key === "p")
            .map((tag) => tag[1] ?? "") ?? [];
        const recipients = saved.event.tags
          .filter(([key]) => key === "p")
          .map((tag) => tag[1] ?? "");
        const tokens = readTaskTokens(saved.event.tags);
        if (
          tokens.some(
            (token) =>
              token.kind === "nexus.skill" &&
              !recipients.includes(token.target),
          )
        )
          throw new Error("The saved skill belongs to another task agent.");
        const active = () => {
          try {
            return (
              !context.signal.aborted &&
              taskDraftContext(session, context.label)?.binding.incarnation ===
                context.binding.incarnation &&
              recipients.length > 0 &&
              recipients.length <=
                (context.mode.participants.maxRecipients ?? 1) &&
              [...members, ...recipients].every(
                (key) =>
                  key === session.viewer ||
                  context.mode.participants.eligible(key),
              )
            );
          } catch {
            return false;
          }
        };
        if (!active())
          throw new Error("A saved task participant is no longer eligible.");
        const targetKey = `draft:${recovery.channelId}`;
        const targetRevision = viewRevision(scope, targetKey);
        const target = mentionDraft(readView(scope, targetKey, ""));
        const retained = files.snapshot();
        const uploaded = retained.flatMap((item) =>
          item.uploaded ? [item.uploaded] : [],
        );
        let unchanged = false;
        if (uploaded.length === retained.length) {
          try {
            const forms = [
              composerMarkdown(draft),
              [
                composerMarkdown(draft, "legacy"),
                taskTokenFallback(
                  draft.tokens?.map((item) => item.token) ?? [],
                ),
              ]
                .filter(Boolean)
                .join("\n\n"),
            ];
            unchanged = forms.some((content) => {
              const outgoing = attachmentMessage(
                content,
                uploaded,
                uploaded[0]?.url,
              );
              return (
                outgoing.content === saved.event.content &&
                JSON.stringify(outgoing.tags) ===
                  JSON.stringify(
                    saved.event.tags.filter(([name]) => name === "imeta"),
                  )
              );
            });
          } catch {
            /* Changed/invalid files remain editable; never re-upload recovery. */
          }
        }
        const edited =
          !unchanged ||
          JSON.stringify(draft.tokens?.map((item) => item.token) ?? []) !==
            JSON.stringify(tokens) ||
          JSON.stringify([...(selection?.recipients ?? [])].sort()) !==
            JSON.stringify([...new Set(recipients)].sort());
        const targetFiles = attachmentDraft(
          session,
          `${scope}:${targetKey}`,
          recovery.channelId,
        );
        if (edited && hasDraftContent(target, targetFiles.snapshot().length))
          throw new Error(
            "This task already has a draft. Your changes remain here; open the task to review its existing draft first.",
          );
        if (create) {
          const labels = create.event.tags
            .filter(([key]) => key === "t")
            .map((tag) => tag[1] ?? "");
          if (
            !labels.includes(TASK_MODE_LABEL) ||
            JSON.stringify(regionLabels(labels)) !==
              JSON.stringify([context.label]) ||
            recipients.some((key) => !members.includes(key))
          )
            throw new Error(
              "The saved task creation does not match this message.",
            );
          const resumed = session.channelWrites.resumeStart(
            create.event.id,
            recovery.channelId,
            session.viewer,
            active,
          );
          void resumed.ready.catch((reason: unknown) => {
            if (reason instanceof ChatNotStarted)
              onFailed?.(recovery.channelId, reason.message);
          });
        }
        validateTaskPublication(session, saved.event);
        if (saved.delivery === "accepted" || saved.delivery === "seen") {
          if (!saved.signed)
            throw new Error(
              "Reload to inspect the saved task receipt before finishing.",
            );
          await recordTaskFirstEvent(
            session,
            saved.signed,
            saved.recovery,
            signal,
          );
        } else {
          session.outbox.retry(saved.event.id, active);
          await session.outbox.whenPrepared(saved.event.id);
        }
        signal.throwIfAborted();
        if (edited) {
          if (replaceView(scope, targetKey, targetRevision, draft) !== "saved")
            throw new Error(
              "The task draft changed. Your changes remain here; retry after reviewing the task.",
            );
          if (files.snapshot().length)
            transferAttachmentDraft(files, targetFiles);
          writeView(scope, `${key}:new-draft`, "");
        }
        if (!edited) {
          files.clear();
          writeView(scope, `${key}:new-draft`, "");
        }
        onStarted(recovery.channelId);
        return;
      }
      const recipients = selection?.recipients ?? [];
      const primary = selection?.primary;
      if (recipients.length > (context.mode.participants.maxRecipients ?? 1))
        throw new Error("Tag one agent per message");
      if (!selection || !primary || !recipients.includes(primary))
        throw new Error("Choose an eligible primary agent before sending.");
      changed(draft, primary);
      const input = {
        ...selection,
        primary,
        revision: current.current.revision,
      };
      const active = () =>
        !signal.aborted &&
        taskDraftContext(session, context.label)?.binding.incarnation ===
          context.binding.incarnation &&
        input.recipients.every(eligible);
      const checkActive = () => {
        signal.throwIfAborted();
        if (!active())
          throw new Error(
            "A selected task agent is no longer eligible. Choose an available agent.",
          );
      };
      checkActive();
      const uploaded = await files.prepareForSend(signal);
      checkActive();
      input.attachments = uploaded;
      taskTokenTags(input.tokens);
      if (
        input.tokens.some(
          (token) =>
            token.kind === "nexus.skill" && token.target !== input.primary,
        )
      )
        throw new Error("Select a skill for the primary agent.");
      const result = await context.mode.prepare(input, signal);
      checkActive();
      if (!result.ok)
        throw new Error(
          result.reason === "already_sent"
            ? "Finish creating this task after reloading. Your draft and files are kept here."
            : result.reason,
        );
      if (!Array.isArray(result.members))
        throw new Error("The prepared task has invalid participants.");
      const prepared = Object.freeze({
        ...result,
        members: Object.freeze([...result.members]),
      });
      if (
        !prepared.channelId ||
        !prepared.preparationId ||
        prepared.revision !== input.revision ||
        !prepared.members.includes(input.primary) ||
        input.recipients.some((key) => !prepared.members.includes(key)) ||
        prepared.members.some(
          (key) =>
            key !== session.viewer &&
            (!input.recipients.includes(key) ||
              !context.mode.participants.eligible(key)),
        )
      )
        throw new Error(
          "The prepared task has changed. Review its agents and retry.",
        );
      const claim = await context.mode.markChannelStarted(
        {
          draftId: input.draftId,
          revision: input.revision,
          preparationId: prepared.preparationId,
          channelId: prepared.channelId,
          binding: input.binding,
        },
        signal,
      );
      checkActive();
      if (claim !== "start")
        throw new Error(
          "Finish creating this task after reloading. Your draft and files are kept here.",
        );
      const title = prepared.title || startingChatTitle(draft);
      const start = session.channelWrites.start(
        prepared.channelId,
        title,
        prepared.members,
        undefined,
        false,
        undefined,
        {
          labels: [context.label, TASK_MODE_LABEL],
          active: () =>
            active() &&
            prepared.members.every(
              (key) =>
                key === session.viewer ||
                context.mode.participants.eligible(key),
            ),
        },
      );
      void start.ready.catch((reason: unknown) => {
        if (reason instanceof ChatNotStarted)
          onFailed?.(prepared.channelId, reason.message);
      });
      const firstEvent = session.messages.send(
        prepared.channelId,
        input.text,
        [input.primary],
        uploaded,
        taskFirstEventRecovery({
          draftId: input.draftId,
          revision: input.revision,
          preparationId: prepared.preparationId,
          channelId: prepared.channelId,
          regionLabel: context.label,
        }),
        [],
        {},
        input.tokens,
      );
      await session.outbox.whenPrepared(firstEvent);
      signal.throwIfAborted();
      files.clear();
      writeView(scope, `${key}:new-draft`, "");
      onStarted(prepared.channelId);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (attempt.current === controller) attempt.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const Header = context?.mode.header;
  const selected = snapshot(state.draft);
  const canSubmit = !!selected?.primary && selected.recipients.every(eligible);
  return (
    <SoloDraftView>
      <MessageComposer
        session={session}
        scope={scope}
        channelId={route.draftId}
        channelName="this task"
        extensions={extensions}
        chatPresentation
        ownSoloConversation
        inviteAgents
        label="Message your task agent"
        placeholder="What do you want to accomplish?"
        autoFocus={!!focusRequest}
        taskDraft={{
          region:
            context?.region ??
            route.region.slice(route.region.lastIndexOf(":") + 1),
          policy: context?.mode.participants,
          recipient: selected?.primary,
          selectPrimary: (pubkey, draft) => {
            if (
              attempt.current ||
              !context ||
              !eligible(pubkey) ||
              taskDraftContext(session, context.label)?.binding.incarnation !==
                context.binding.incarnation
            )
              return false;
            try {
              changed(draft, pubkey);
              setError(undefined);
              return true;
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
              return false;
            }
          },
        }}
        submission={{
          draftKey: `${key}:new-draft`,
          locked: busy,
          disabled:
            busy || !context || !canSubmit || !session.channelWrites.available,
          attachments: true,
          changed,
          header: (draft, controls) => {
            const input = snapshot(draft);
            return Header && input ? (
              <Header draft={input} {...controls} ui={taskHeaderUI} />
            ) : null;
          },
          submit: (draft, files) => {
            void start(draft, files);
          },
        }}
      />
      {!context && (
        <p className={composerStyles.composerColumn} role="status">
          {TASK_UNAVAILABLE}
        </p>
      )}
      {error && (
        <p className={composerStyles.composerColumn} role="alert">
          {error}
        </p>
      )}
    </SoloDraftView>
  );
}
