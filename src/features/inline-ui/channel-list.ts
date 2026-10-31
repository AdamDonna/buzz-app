import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChannelQueries, ChannelReference } from "../relay/contracts";

/** Rows an Inline UI list shows before it pages. */
export const INLINE_LIST_PAGE = 5;

export type InlineChannelRow = Readonly<
  { id: string } & (
    | { state: "unknown" }
    /** The viewer can't see it, or it is a conversation, not a channel. */
    | { state: "withheld" }
    | {
        state: "found";
        name: string;
        joined: boolean;
        archived: boolean;
        /** Only when the lookup already read the roster; never read for this. */
        members?: number;
      }
  )
>;

export type InlineChannelPage = Readonly<{
  rows: readonly InlineChannelRow[];
  /** Every listed channel, across pages. */
  count: number;
  page: number;
  pages: number;
}>;

function row(id: string, reference: ChannelReference): InlineChannelRow {
  if (reference.state !== "found") return { id, state: reference.state };
  // A DM or Solo chat is never shown as a channel to join.
  if (
    reference.hidden ||
    reference.channelType === "dm" ||
    reference.channelType === "solo"
  )
    return { id, state: "withheld" };
  return {
    id,
    state: "found",
    name: reference.name,
    joined: reference.joined,
    archived: reference.archived,
    ...(reference.members === undefined ? {} : { members: reference.members }),
  };
}

/** One page of a list's channels as the viewer's lookup describes them now.
 * Out-of-range pages clamp to the nearest. */
export function inlineChannelPage(
  describe: (id: string) => ChannelReference,
  ids: readonly string[],
  page: number,
): InlineChannelPage {
  const pages = Math.max(1, Math.ceil(ids.length / INLINE_LIST_PAGE));
  const current = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  const start = current * INLINE_LIST_PAGE;
  return {
    rows: ids
      .slice(start, start + INLINE_LIST_PAGE)
      .map((id) => row(id, describe(id))),
    count: ids.length,
    page: current,
    pages,
  };
}

const unknown = (): ChannelReference => ({ state: "unknown" });
const noop = () => () => {};

/** A list's page, kept current from the channel store as the viewer. Reuses
 * channel links' lookup: the store reads, batches, expires and retries; this
 * only demands the shown page's unresolved channels while the list is
 * ready, because discovery owns access. */
export function useInlineChannelList(
  queries: ChannelQueries | undefined,
  ids: readonly string[],
  page: number,
): InlineChannelPage {
  const active = queries?.describe && queries.refer ? queries : undefined;
  // The list is replaced on every message preview; re-render only when this
  // page's answer changes.
  const snapshot = useSyncExternalStore(
    active?.subscribeList ?? noop,
    () => {
      const describe = (id: string) => active?.describe?.(id) ?? unknown();
      const ready = active?.list().status === "ready";
      return JSON.stringify([ready, inlineChannelPage(describe, ids, page)]);
    },
    () => JSON.stringify([false, inlineChannelPage(unknown, ids, page)]),
  );
  const [ready, current] = useMemo(
    () => JSON.parse(snapshot) as [boolean, InlineChannelPage],
    [snapshot],
  );
  const missing = current.rows
    .filter((row) => row.state !== "found")
    .map((row) => row.id)
    .join();
  useEffect(() => {
    if (!active || !ready || !missing) return;
    const releases = missing.split(",").map((id) => active.refer?.(id));
    return () => {
      for (const release of releases) release?.();
    };
  }, [active, ready, missing]);
  return current;
}
