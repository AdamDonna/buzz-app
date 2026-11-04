import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { requestWork } from "../agents/request-work";
import { continuesMessageGroup } from "./message-grouping";
import { activityRuns } from "./activity-groups";

type Activity = RelaySession["agentActivity"];
type Snapshot = ReturnType<Activity["snapshot"]>;
type ActivityRun = {
  ids: string[];
  history: ChannelMessage[];
  latest: ChannelMessage;
  participants: string[];
  requestId: string | undefined;
  followingMessage: ChannelMessage | undefined;
};
export type ActivityPresentation = ActivityRun & {
  /** Display policy only; a public reply is not lifecycle completion. */
  hidden: boolean;
  retained?: boolean;
  working: boolean;
  standalone: boolean;
};
export type ActivityRowPresentation = {
  requestId: string | undefined;
  active: boolean;
  ownsLive: boolean;
  container: "history" | "bubble" | "standalone";
};
const noSubscribe = () => () => {};

const sameItems = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);
/** Whether two snapshots agree on everything a request projection in these
 * channels reads: their records, turns and local work, status and trimming. */
function sameChannelActivity(
  a: Snapshot | undefined,
  b: Snapshot | undefined,
  channels: ReadonlySet<string>,
) {
  if (a === b) return true;
  if (!a || !b || a.status !== b.status || a.trimmed !== b.trimmed)
    return false;
  const records = (snapshot: Snapshot) =>
    snapshot.records.filter((record) =>
      record.channelIds.some((id) => channels.has(id)),
    );
  const local = (snapshot: Snapshot) =>
    (snapshot.local ?? []).filter((work) => channels.has(work.channelId));
  const turns = (snapshot: Snapshot) =>
    JSON.stringify(
      snapshot.turns.filter(
        (turn) => !!turn.channelId && channels.has(turn.channelId),
      ),
    );
  return (
    sameItems(records(a), records(b)) &&
    sameItems(local(a), local(b)) &&
    turns(a) === turns(b)
  );
}
/** The activity snapshot, changing only when these channels' evidence does:
 * work elsewhere in the session does not re-render this conversation. */
export function useChannelActivitySnapshot(
  activity: Activity | undefined,
  channels: ReadonlySet<string>,
) {
  const held = useRef<Snapshot | undefined>(undefined);
  const read = () => {
    const live = activity?.snapshot();
    if (!sameChannelActivity(held.current, live, channels)) held.current = live;
    return held.current;
  };
  return useSyncExternalStore(activity?.subscribe ?? noSubscribe, read, read);
}

/** Status belongs to the triggering request, never to all work in its thread. */
function activityStatus(
  group: ActivityRun,
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  requests: ReadonlyMap<string, string>,
) {
  const { latest, participants, followingMessage: response, requestId } = group;
  const followedByReply =
    !!response &&
    response.audience !== "agents" &&
    !response.membership &&
    response.channelId === latest.channelId &&
    response.threadRootId === latest.threadRootId &&
    response.createdAt >= latest.createdAt &&
    requests.get(response.id) === requestId &&
    (participants.includes(response.authorId) ||
      // A helper can hand its result back to the replying coordinator without
      // the coordinator having authored a message in this activity run.
      ((response.agentEnvelope || agents?.has(response.authorId)) &&
        latest.mentions.includes(response.authorId)));
  // Only signed immediate reply links and activity IDs bind lifecycle evidence.
  // The preceding human message/thread root is useful for layout, not proof
  // that these updates came from that request's turn.
  const work = snapshot
    ? participants.flatMap((agent) => {
        const ids = group.history
          .filter((row) => row.authorId === agent)
          .flatMap((row) => [
            row.id,
            ...(row.replyParentId ? [row.replyParentId] : []),
          ]);
        return requestWork(snapshot, latest.channelId, ids).filter(
          (entry) => entry.agent === agent,
        );
      })
    : [];
  const settled = (entry: (typeof work)[number]) =>
    ["done", "ended", "superseded", "stopped"].includes(entry.state);
  // A layout-associated request may prove ongoing work, but cannot prove
  // completion for an unlinked update. Keep those two evidence paths separate.
  const pending =
    snapshot && requestId
      ? requestWork(snapshot, latest.channelId, requestId).filter(
          (entry) => participants.includes(entry.agent) && !settled(entry),
        )
      : [];
  const complete = participants.every((agent) =>
    work.some((entry) => entry.agent === agent && settled(entry)),
  );
  // Known pending, failed or uncertain work wins over the historical fallback.
  // Without lifecycle evidence, a related public reply only retires the display.
  const hidden =
    !pending.length && (complete || (!!followedByReply && work.every(settled)));
  const working = new Set(
    [...work, ...pending]
      .filter((entry) => entry.working)
      .map((entry) => entry.agent),
  );
  return {
    hidden,
    working,
    publicReply: followedByReply ? response : undefined,
  };
}

/** Shared projection for timeline and thread; hosts own scrolling and disclosure state. */
export function activityPresentation(
  rows: readonly ChannelMessage[],
  snapshot: Snapshot | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
  pinnedIds?: ReadonlyMap<string, number>,
) {
  const following = new Map(
    rows.map((row, index) => [row.id, rows[index + 1]]),
  );
  const preceding = new Map(
    rows.map((row, index) => [row.id, rows[index - 1]]),
  );
  const requests = new Map<string, string>();
  if (rootId) requests.set(rootId, rootId);
  const representedAgents = new Map<string, string[]>();
  // Each request's latest public reply row per agent.
  const publicReplies = new Map<string, Map<string, string>>();
  const activityAuthors = new Set(
    rows
      .filter((row) => row.audience === "agents" || row.agentEnvelope)
      .map((row) => row.authorId),
  );
  let request = rootId;
  for (const row of rows) {
    const isAgent =
      activityAuthors.has(row.authorId) || agents?.has(row.authorId);
    if (
      row.audience !== "agents" &&
      !isAgent &&
      !row.membership &&
      agents &&
      !agents.has(row.authorId)
    )
      request = row.id;
    // A thread root is a scope, not necessarily the latest triggering request.
    // Preserve explicit reply links; otherwise follow the preceding request.
    const parentRequest = row.replyParentId
      ? (requests.get(row.replyParentId) ?? row.replyParentId)
      : undefined;
    const rowRequest = isAgent ? (parentRequest ?? request) : request;
    if (rowRequest) requests.set(row.id, rowRequest);
    if (rowRequest && !row.membership && isAgent) {
      const represented = representedAgents.get(rowRequest) ?? [];
      if (!represented.includes(row.authorId)) represented.push(row.authorId);
      representedAgents.set(rowRequest, represented);
      if (row.audience !== "agents") {
        const replies = publicReplies.get(rowRequest) ?? new Map();
        replies.set(row.authorId, row.id);
        publicReplies.set(rowRequest, replies);
      }
    }
  }
  const repliedAgents = new Map<string, string[]>();
  const replyRequests = new Map<string, string>();
  for (const [requestId, replies] of publicReplies) {
    repliedAgents.set(requestId, [...replies.keys()]);
    for (const id of replies.values()) replyRequests.set(id, requestId);
  }
  const groups: ActivityPresentation[] = [];
  const bubbleAnchors = new Set<string>();
  const byRow = new Map<string, ActivityRowPresentation>();
  for (const history of activityRuns(rows, requests)) {
    const first = history[0];
    const latest = history.at(-1);
    if (!first || !latest) continue;
    const participants = [...new Set(history.map((row) => row.authorId))];
    const group: ActivityRun = {
      ids: history.map((row) => row.id),
      history,
      latest,
      participants,
      requestId: requests.get(first.id) ?? first.threadRootId,
      followingMessage: following.get(latest.id),
    };
    const { hidden, working, publicReply } = activityStatus(
      group,
      snapshot,
      agents,
      requests,
    );
    const retained = hidden && group.ids.some((id) => pinnedIds?.has(id));
    const before = preceding.get(first.id);
    const anchor =
      hidden && !retained && publicReply?.authorId === first.authorId
        ? publicReply
        : before;
    const standalone =
      !anchor ||
      !!anchor.membership ||
      anchor.audience === "agents" ||
      anchor.authorId !== first.authorId ||
      anchor.threadRootId !== first.threadRootId ||
      (anchor === before && !continuesMessageGroup(anchor, first));
    if (!standalone && !hidden && before) bubbleAnchors.add(before.id);
    const lastByAgent = new Map(history.map((row) => [row.authorId, row.id]));
    for (const row of history) {
      const last = lastByAgent.get(row.authorId) === row.id;
      byRow.set(row.id, {
        requestId: group.requestId,
        active: last && working.has(row.authorId),
        ownsLive:
          last &&
          !hidden &&
          (working.has(row.authorId) || !group.followingMessage),
        container:
          row.id === first.id && standalone
            ? "standalone"
            : !hidden || standalone
              ? "bubble"
              : "history",
      });
    }
    groups.push({
      ...group,
      hidden,
      retained,
      working: working.size > 0,
      standalone,
    });
  }
  return {
    groups,
    byRow,
    representedAgents,
    repliedAgents,
    replyRequests,
    bubbleAnchors,
  };
}
export function useActivityPresentation(
  rows: readonly ChannelMessage[],
  activity: Activity | undefined,
  agents: ReadonlySet<string> | undefined,
  rootId?: string,
  pinnedIds?: ReadonlyMap<string, number>,
) {
  const channels = useMemo(
    () => new Set(rows.map((row) => row.channelId)),
    [rows],
  );
  const snapshot = useChannelActivitySnapshot(activity, channels);
  const projection = useMemo(
    () => activityPresentation(rows, snapshot, agents, rootId),
    [rows, snapshot, agents, rootId],
  );
  const prior = useRef(new Map<string, ActivityPresentation>());
  const groups = useMemo(() => {
    const groups = projection.groups.map((group) => {
      const key = group.ids[0] ?? "";
      const previous = prior.current.get(key);
      // Retain the same contained tree, not merely its individual message IDs:
      // report dialogs and their pending submissions belong to that tree.
      return previous &&
        group.hidden &&
        group.ids.some((id) => pinnedIds?.has(id))
        ? {
            ...previous,
            hidden: true,
            working: group.working,
            retained: true,
            followingMessage: group.followingMessage,
          }
        : group;
    });
    prior.current = new Map(groups.map((group) => [group.ids[0] ?? "", group]));
    return groups;
  }, [projection, pinnedIds]);
  return { ...projection, groups };
}

/** Retired updates stay in Activity; hiding is not a claim of successful completion. */
export function activityDisplayRows<T extends ChannelMessage>(
  rows: readonly T[],
  groups: readonly ActivityPresentation[],
  revealedId?: string,
): readonly T[] {
  const hiddenIds = new Set(
    groups
      .filter((group) => group.hidden && !group.retained)
      .flatMap((group) => group.ids),
  );
  return hiddenIds.size
    ? rows.filter((row) => row.id === revealedId || !hiddenIds.has(row.id))
    : rows;
}

/** Each activity projection allocates fresh row values. Reuse the previous ones
 * while they are equal, so memoized rows skip unrelated activity updates. */
export function useStableRowActivity() {
  const [stable] = useState(() => {
    const activities = new Map<string, ActivityRowPresentation>();
    const agents = new Map<string, readonly string[]>();
    return {
      activity(
        id: string,
        next: ActivityRowPresentation | undefined,
        container = next?.container,
      ) {
        if (!next || !container) {
          activities.delete(id);
          return undefined;
        }
        const prior = activities.get(id);
        if (
          prior &&
          prior.requestId === next.requestId &&
          prior.active === next.active &&
          prior.ownsLive === next.ownsLive &&
          prior.container === container
        )
          return prior;
        const value = { ...next, container };
        activities.set(id, value);
        return value;
      },
      agents(id: string, next: readonly string[] | undefined) {
        if (!next) {
          agents.delete(id);
          return undefined;
        }
        const prior = agents.get(id);
        if (
          prior &&
          prior.length === next.length &&
          prior.every((agent, index) => agent === next[index])
        )
          return prior;
        agents.set(id, next);
        return next;
      },
    };
  });
  return stable;
}
