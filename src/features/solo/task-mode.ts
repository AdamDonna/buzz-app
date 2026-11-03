import type {
  SoloRegionBinding,
  SoloTaskMode,
} from "../channel-navigation/solo-navigation-contract";
import { soloNavigationFor } from "../channel-navigation/solo-navigation";
import { regionLabels, TASK_MODE_LABEL } from "./region-labels";
export { TASK_MODE_LABEL } from "./region-labels";
import type { ChannelSummary } from "../relay/contracts";
import {
  hasEventProof,
  type EventData,
  type RelayEvent,
} from "../relay/events";
import type { OutboxRecovery } from "../relay/outbox";
import type { RelaySession } from "../relay/session";
import { readTaskTokens } from "../messages/task-tokens";

export const TASK_UNAVAILABLE =
  "Nexus is unavailable; this task chat is read-only until it reloads";
type TaskSession = Readonly<{
  viewer?: string | undefined;
  channels: { list(): Readonly<{ channels: readonly ChannelSummary[] }> };
}>;
export type TaskContext = Readonly<{
  mode: SoloTaskMode;
  region: string;
  label: string;
  binding: SoloRegionBinding;
  signal: AbortSignal;
}>;

export function taskDraftContext(
  session: object,
  label: string,
): TaskContext | undefined {
  const entry = soloNavigationFor(session)?.taskSource(label);
  const mode = entry?.source.task;
  if (!entry || !mode) return;
  return {
    mode,
    region: entry.source.id,
    label,
    binding: entry.binding,
    signal: entry.signal,
  };
}

export function isTaskChannel(session: TaskSession, channelId: string) {
  return !!session.channels
    .list()
    .channels.find((item) => item.id === channelId)
    ?.labels?.includes(TASK_MODE_LABEL);
}

/** The durable marker survives plugin disposal. A missing owner is an error,
 * never permission to use the ordinary Solo inventory. */
export function taskChannelContext(
  session: TaskSession,
  channelId: string,
): TaskContext | undefined {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  if (!channel?.labels?.includes(TASK_MODE_LABEL)) return;
  const labels = regionLabels(channel.labels);
  const context =
    labels.length === 1
      ? taskDraftContext(session, labels[0] ?? "")
      : undefined;
  if (!context) throw new Error(TASK_UNAVAILABLE);
  if (
    channel.channelType !== "solo" ||
    channel.creator !== session.viewer ||
    channel.archived ||
    channel.readOnly
  )
    throw new Error("This task chat is unavailable for sending.");
  return context;
}

export function validateTaskMembers(
  session: TaskSession,
  channelId: string,
  additions: readonly string[] = [],
) {
  const context = taskChannelContext(session, channelId);
  if (!context) return;
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === channelId);
  const policy = context.mode.participants;
  if (
    !channel?.members ||
    channel.members.some(
      (key) =>
        key !== session.viewer &&
        !policy.eligible(key) &&
        policy.isParticipant?.(channelId, key) !== true,
    ) ||
    additions.some((key) => !policy.eligible(key))
  )
    throw new Error(
      "A task participant is no longer eligible. Repair task membership before sending.",
    );
  return context;
}

export function validateTaskRecipients(
  session: TaskSession,
  channelId: string,
  recipients: readonly string[],
) {
  const context = validateTaskMembers(session, channelId);
  if (!context) return;
  const policy = context.mode.participants;
  if (!recipients.length || recipients.some((key) => !policy.eligible(key)))
    throw new Error(
      "A selected task agent is no longer eligible. Choose an available agent.",
    );
  if (recipients.length > (policy.maxRecipients ?? 1))
    throw new Error("Tag one agent per message");
  return context;
}

export function resolveTaskRecipients(
  session: TaskSession,
  channelId: string,
  explicit: readonly string[],
) {
  const context = taskChannelContext(session, channelId);
  if (!context) return [...explicit];
  const primary = explicit.length
    ? undefined
    : context.mode.participants.defaultRecipient(channelId);
  if (!explicit.length && !primary)
    throw new Error("Choose an eligible primary agent before sending.");
  const recipients = [
    ...new Set(explicit.length ? explicit : primary ? [primary] : []),
  ];
  validateTaskRecipients(session, channelId, recipients);
  if (
    primary &&
    !session.channels
      .list()
      .channels.find((item) => item.id === channelId)
      ?.members?.includes(primary)
  )
    throw new Error("Choose a primary agent who is a member of this task.");
  return recipients;
}

export function validateTaskPublication(
  session: TaskSession,
  event: EventData,
  allowInformational = true,
) {
  if (event.kind !== 9 && event.kind !== 9000) return;
  const channelId = event.tags.find(([key]) => key === "h")?.[1];
  if (!channelId) return;
  if (event.kind === 9000)
    return validateTaskMembers(
      session,
      channelId,
      event.tags.filter(([key]) => key === "p").map((tag) => tag[1] ?? ""),
    );
  const tokens = readTaskTokens(event.tags);
  const recipients = event.tags
    .filter(([key]) => key === "p")
    .map((tag) => tag[1] ?? "");
  const context = validateTaskMembers(session, channelId);
  const destinations = event.tags.filter(([name]) => name === "h");
  if (
    hasEventProof(event) &&
    event.pubkey === session.viewer &&
    destinations.length === 1 &&
    destinations[0]?.length === 2 &&
    context?.mode.isInformational?.(channelId, event) === true
  ) {
    if (!allowInformational || recipients.length || tokens.length)
      throw new Error(
        "Informational task notices cannot address agents, carry task tokens or start a task.",
      );
    return context;
  }
  validateTaskRecipients(session, channelId, recipients);
  if (tokens.length && !context)
    throw new Error("Task tokens require a task chat.");
  if (
    tokens.some(
      (token) =>
        token.kind === "nexus.skill" && !recipients.includes(token.target),
    )
  )
    throw new Error(
      "The selected skill belongs to another agent. Select it again for this recipient.",
    );
  return context;
}

export type TaskFirstEventRecovery = Readonly<{
  draftId: string;
  revision: number;
  preparationId: string;
  channelId: string;
  regionLabel: string;
}>;
export function taskFirstEventRecovery(
  input: TaskFirstEventRecovery,
): OutboxRecovery {
  return { key: `solo-task:${input.draftId}`, value: JSON.stringify(input) };
}

export function readTaskFirstEventRecovery(
  event: Pick<RelayEvent, "kind" | "tags">,
  recovery: OutboxRecovery,
) {
  const input: TaskFirstEventRecovery = JSON.parse(recovery.value);
  const destinations = event.tags.filter(([key]) => key === "h");
  if (
    event.kind !== 9 ||
    !input ||
    typeof input.draftId !== "string" ||
    recovery.key !== `solo-task:${input.draftId}` ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    typeof input.preparationId !== "string" ||
    !input.preparationId ||
    input.preparationId.length > 4096 ||
    typeof input.regionLabel !== "string" ||
    typeof input.channelId !== "string" ||
    !input.channelId ||
    destinations.length !== 1 ||
    destinations[0]?.length !== 2 ||
    input.channelId !== destinations[0]?.[1]
  )
    throw new Error("The prepared task does not match this saved message.");
  return input;
}

export async function recordTaskFirstEvent(
  session: TaskSession & Pick<RelaySession, "channelWrites">,
  event: RelayEvent,
  recovery: OutboxRecovery | undefined,
  signal: AbortSignal,
) {
  const allowInformational = !recovery?.key.startsWith("solo-task:");
  const context = validateTaskPublication(session, event, allowInformational);
  const revalidate = () => {
    validateTaskPublication(session, event, allowInformational);
  };
  if (!recovery?.key.startsWith("solo-task:")) return revalidate;
  const input = readTaskFirstEventRecovery(event, recovery);
  if (!context || input.regionLabel !== context.label)
    throw new Error("The prepared task does not match this saved message.");
  const bound = AbortSignal.any([signal, context.signal]);
  bound.throwIfAborted();
  const starting = session.channelWrites.starting(input.channelId);
  if (starting) {
    let abort = () => {};
    try {
      await Promise.race([
        starting,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(bound.reason);
          bound.addEventListener("abort", abort, { once: true });
          if (bound.aborted) abort();
        }),
      ]);
    } finally {
      bound.removeEventListener("abort", abort);
    }
  }
  bound.throwIfAborted();
  validateTaskPublication(session, event, allowInformational);
  await context.mode.recordFirstEvent(
    {
      draftId: input.draftId,
      revision: input.revision,
      preparationId: input.preparationId,
      channelId: input.channelId,
      eventId: event.id,
      binding: context.binding,
    },
    bound,
  );
  bound.throwIfAborted();
  validateTaskPublication(session, event, allowInformational);
  return revalidate;
}
