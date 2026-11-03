import { archiveHides } from "../relay/identity-archives";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { LocalEvents, OutgoingEvent } from "../relay/outbox";

const keyPattern = /^[0-9a-f]{64}$/;

/** Channel types whose members may add people. A system channel's members
 * are its readers, for example the agents a plugin shares its records with. */
const expandable = new Set(["stream", "forum", "system"]);

/** The relay remains authoritative; never offer role changes or DM expansion. */
export function canAddMembers(
  session: {
    viewer?: string | undefined;
    outbox?: { supports(kind: number): boolean } | undefined;
  },
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    channel.viewerRole !== "guest" &&
    !channel.archived &&
    expandable.has(channel.channelType ?? "") &&
    (channel.members?.includes(session.viewer) ||
      (channel.readOnly && !channel.private && channel.joinRole !== "guest"))
  );
}

/** A session share adds only to this session. It never opens ordinary Members UI
 * or inherits parent-channel membership. */
export function canShareSoloChat(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel?.channelType === "solo" &&
    channel.private &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    channel.members?.includes(session.viewer)
  );
}

const channelOf = (session: RelaySession, channelId: string) =>
  session.channels.list().channels.find((item) => item.id === channelId) ??
  session.channels.get?.(channelId);

const knownAgent = (session: RelaySession, pubkey: string) =>
  session.agentChoices
    .snapshot()
    .identities.some((agent) => agent.pubkey === pubkey) ||
  !!session.profiles.snapshot().get(pubkey)?.isAgent;

/** Agents join as Bot. Private channel additions grant participation
 * explicitly, even if an older saved admission default is Guest. Solo and
 * system admission stay separate. */
function additionRole(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  soloParticipant: boolean,
) {
  const current = channelOf(session, channelId);
  return knownAgent(session, pubkey)
    ? "bot"
    : !soloParticipant &&
        current?.visibility === "private" &&
        (current.channelType === "stream" || current.channelType === "forum")
      ? "member"
      : undefined;
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Member addition interrupted. Reopen Members to check its status.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ?? "Addition is not confirmed. Retry to check again.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

const batchPrefix = "member-add:batch:";
/** A batch addition is settled by the roster read after it, never resumed. */
export const isBatchAddition = (item: OutgoingEvent) =>
  !!item.recovery?.key.startsWith(batchPrefix);

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
};

/** Explicit single-person intent. Membership truth and pending writes stay
 * session-owned. Whatever the outcome, settles the batches it may complete. */
export async function addChannelMember(
  ...args: Parameters<typeof addOneMember>
) {
  const [session, channelId] = args;
  try {
    await addOneMember(...args);
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}

async function addOneMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
  soloParticipant = false,
  allowSoloAgents = false,
  /** Runs synchronously just before a new or retried addition is dispatched. */
  beforeDispatch?: () => void,
) {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const channel = () => channelOf(session, channelId);
  const checkAccess = () => {
    signal.throwIfAborted();
    if (
      !(soloParticipant
        ? canShareSoloChat(session, channel())
        : canAddMembers(session, channel()))
    )
      throw new Error(
        "This channel cannot add members right now. Refresh and try again.",
      );
    if (archiveHides(session.archives, pubkey, session.viewer))
      throw new Error(
        "Archived identities cannot be added. Choose someone else.",
      );
  };
  checkAccess();
  const outbox = session.outbox;
  if (!outbox) throw new Error("Member additions are unavailable.");
  await outbox.ready();
  checkAccess();
  // This existing session operation verifies the connected relay's signed roster.
  await session.channelWrites.refreshMembership(channelId);
  checkAccess();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const pending = fresh
    ? undefined
    : journal
        .snapshot()
        .find((item) =>
          intent.id
            ? item.event.id === intent.id
            : !item.acknowledged &&
              !isBatchAddition(item) &&
              item.event.kind === 9000 &&
              item.event.tags.some(
                ([tag, value]) => tag === "h" && value === channelId,
              ) &&
              item.event.tags.some(
                ([tag, value]) => tag === "p" && value === pubkey,
              ) &&
              !item.event.tags.some(
                ([tag, value]) =>
                  tag === "role" && value !== "bot" && value !== "member",
              ),
        );
  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  // A saved share may finish its exact Bot grant; it cannot authorize a new one.
  const recoveringSoloAgent =
    pending &&
    !pending.acknowledged &&
    !pending.guarded &&
    pending.recovery?.key === recovery.key &&
    pending.event.tags.some(
      ([tag, value]) => tag === "role" && value === "bot",
    );
  const check = () => {
    checkAccess();
    if (
      soloParticipant &&
      !allowSoloAgents &&
      !recoveringSoloAgent &&
      knownAgent(session, pubkey)
    )
      throw new Error(
        "Add agents by tagging them in the chat composer instead.",
      );
  };
  check();
  if (pending?.guarded && !channel()?.members?.includes(pubkey))
    throw new Error(
      "Retry this invitation from the agent’s profile so its eligibility can be checked.",
    );
  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  if (!fresh && intent.id && !pending)
    throw new Error(
      "The original addition receipt is unavailable. Refresh membership before trying again.",
    );
  if (
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= 15 * 60
  )
    throw new Error(
      "This addition expired. Remove its Not sent item in Outbox, then try again.",
    );
  const role = additionRole(session, channelId, pubkey, soloParticipant);
  beforeDispatch?.();
  const id =
    pending?.event.id ??
    outbox.send(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ["p", pubkey],
          ...(role ? [["role", role]] : []),
        ],
      },
      recovery,
    );
  if (pending?.delivery === "failed" || pending?.delivery === "unknown")
    outbox.retry(id);
  intent.id = id;
  intent.dismissed = false;
  intent.confirmed = false;
  await waitForAddition(journal, id, signal);
  check();
  await session.channelWrites.refreshMembership(channelId);
  check();
  if (!channel()?.members?.includes(pubkey))
    throw new Error(
      "Addition is not confirmed in the member list yet. Retry to check again.",
    );
  await outbox.acknowledge(id);
  check();
  intent.confirmed = true;
}

/** A batch is the only durable record of the people it names until each is
 * in the roster or has their own addition pending, so only then is it
 * acknowledged. Batches still sending are left to their own sender. */
export async function settleBatchAdditions(
  session: RelaySession,
  channelId: string,
) {
  const outbox = session.outbox;
  if (!outbox) return;
  const items = outbox
    .snapshot()
    .filter(
      (item) =>
        !item.acknowledged &&
        item.event.kind === 9000 &&
        item.event.tags.some(
          ([tag, value]) => tag === "h" && value === channelId,
        ),
    );
  const named = (item: OutgoingEvent) =>
    item.event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : []));
  const covered = new Set([
    ...(channelOf(session, channelId)?.members ?? []),
    ...items.filter((item) => !isBatchAddition(item)).flatMap(named),
  ]);
  for (const item of items)
    if (
      isBatchAddition(item) &&
      item.delivery !== "sending" &&
      named(item).every((key) => covered.has(key))
    )
      await outbox.acknowledge(item.event.id).catch(() => {});
}

/** Most people one kind:9000 may name; see the relay's put-user handler. */
const batchLimit = 100;

/**
 * Adds people missing from a channel with one kind:9000 per role and at most
 * 100 people, then reads the roster once. Returns everyone it shows, including
 * people already there. A relay without batch support adds only the first
 * person each event names. Best effort: only an abort or `beforeDispatch`
 * throws. Everyone not returned is left to `addChannelMember`, which also says
 * why they failed, as is anyone with an earlier single addition pending, so a
 * stale role is never resent. A batch is never resumed and never blocks one;
 * it stays in Outbox until everyone it names is settled.
 */
export async function addChannelMembersAtOnce(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: ReadonlyMap<string, MemberAdditionIntent>,
  signal: AbortSignal,
  soloParticipant = false,
  beforeDispatch?: () => void,
): Promise<ReadonlySet<string>> {
  const confirmed = new Set<string>();
  const outbox = session.outbox;
  if (people.length < 2 || !outbox) return confirmed;
  const allowed = () =>
    soloParticipant
      ? canShareSoloChat(session, channelOf(session, channelId))
      : canAddMembers(session, channelOf(session, channelId));
  const attempt = async <T>(work: () => T | Promise<T>) => {
    try {
      return await work();
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  // Restored receipts count, so read them only once the outbox has loaded.
  const loaded = await attempt(async () => {
    await outbox.ready();
    return true;
  });
  if (!loaded) return confirmed;
  const pending = new Set(
    outbox
      .snapshot()
      .filter(
        (item) =>
          !item.acknowledged &&
          !isBatchAddition(item) &&
          item.event.kind === 9000 &&
          item.event.tags.some(
            ([tag, value]) => tag === "h" && value === channelId,
          ),
      )
      .flatMap(({ event }) =>
        event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : [])),
      ),
  );
  // Anyone with a single addition pending, or whom one would refuse, stays
  // with it: it alone may resume that write, and it reports why.
  const eligible = people.filter(
    (key) =>
      keyPattern.test(key) &&
      !intents.get(key)?.id &&
      !pending.has(key) &&
      !archiveHides(session.archives, key, session.viewer) &&
      // A Solo chat's agents keep their own receipts, so a recovering share
      // can finish its exact Bot grant.
      !(soloParticipant && knownAgent(session, key)),
  );
  if (eligible.length < 2) return confirmed;
  const before = allowed()
    ? await attempt(() => session.channelWrites.refreshMembership(channelId))
    : undefined;
  signal.throwIfAborted();
  if (!before || !allowed()) return confirmed;
  const groups = new Map<string | undefined, string[]>();
  for (const key of eligible)
    if (!before.members?.includes(key)) {
      const role = additionRole(session, channelId, key, soloParticipant);
      groups.set(role, [...(groups.get(role) ?? []), key]);
    }
  let sent = false;
  try {
    let roster: ChannelSummary | undefined = before;
    let dispatched = false;
    // One missing person gains nothing from a batch; the single addition sends it.
    if ([...groups.values()].flat().length > 1)
      for (const [role, keys] of groups)
        for (let start = 0; start < keys.length; start += batchLimit) {
          // Each later write reads the roster again, so it never names someone
          // admitted meanwhile, whose role an explicit one would overwrite.
          if (dispatched)
            roster = await attempt(() =>
              session.channelWrites.refreshMembership(channelId),
            );
          if (!roster || !allowed()) break;
          const recipients = keys.slice(start, start + batchLimit).filter(
            (key) =>
              !roster?.members?.includes(key) &&
              // Archives may refresh during any read, as the single addition rechecks.
              !archiveHides(session.archives, key, session.viewer),
          );
          if (!recipients.length) continue;
          dispatched = true;
          beforeDispatch?.();
          const id = await attempt(() =>
            outbox.send(
              {
                kind: 9000,
                content: "",
                tags: [
                  ["h", channelId],
                  ...recipients.map((key) => ["p", key]),
                  ...(role ? [["role", role]] : []),
                ],
              },
              { key: `${batchPrefix}${crypto.randomUUID()}`, value: "1" },
            ),
          );
          if (!id) continue;
          sent = true;
          // A refusal or unknown result still leaves the roster to decide.
          await attempt(() => waitForAddition(outbox, id, signal));
        }
    const after = sent
      ? await attempt(() => session.channelWrites.refreshMembership(channelId))
      : before;
    for (const key of eligible)
      if (after?.members?.includes(key)) confirmed.add(key);
    return confirmed;
  } finally {
    await settleBatchAdditions(session, channelId);
  }
}
