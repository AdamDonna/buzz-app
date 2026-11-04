import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelMessage } from "../relay/contracts";
import { currentActivity } from "../agents/current-activity";
import { useActivityTypingReplacement } from "../conversation/typing-presentation";
const noSubscribe = () => () => {};
const noActivity = () => undefined;
const empty: ReturnType<RelaySession["typing"]["snapshot"]> = [];
const noTyping = () => empty;

/** A current, rendered activity row owns the live signal for its exact scope. */
export function useActivityIndicator(
  session: RelaySession | undefined,
  row: ChannelMessage,
  eligible: boolean,
  participants?: readonly string[],
  requestId?: string,
) {
  const typing = useSyncExternalStore(
    session?.typing?.subscribe ?? noSubscribe,
    session?.typing?.snapshot ?? noTyping,
  );
  const activity = useSyncExternalStore(
    session?.agentActivity?.subscribe ?? noSubscribe,
    session?.agentActivity?.snapshot ?? noActivity,
  );
  const represented = new Set(participants ?? [row.authorId]);
  const detail = eligible
    ? currentActivity(
        activity,
        typing,
        represented,
        row.channelId,
        row.threadRootId,
      )
    : undefined;
  // Top-level harness work uses its triggering request as the root, while its
  // published channel activity has no thread root. Match that known request,
  // never an arbitrary working thread in the same channel.
  const matches = (root: string | null | undefined) =>
    root === (row.threadRootId ?? null) ||
    (!row.threadRootId && !!requestId && root === requestId);
  const liveDetails = [...(detail ?? [])].filter(
    ([agent, value]) => represented.has(agent) && value.roots.some(matches),
  );
  const liveAgents = liveDetails
    .filter(([, value]) => value.roots.every(matches))
    .map(([agent]) => agent);
  const live = liveDetails.length > 0;
  useActivityTypingReplacement(
    session
      ? {
          session,
          channelId: row.channelId,
          threadRootId: row.threadRootId,
          pubkey: row.authorId,
        }
      : undefined,
    live,
    liveAgents,
  );
  return live;
}
