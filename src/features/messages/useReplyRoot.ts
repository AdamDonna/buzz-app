import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { ThreadSnapshot } from "../relay/threads";
import type { RelaySession } from "../relay/session";

const unsubscribe = () => {};

/** Resolve restored or broadcast reply targets beyond the loaded channel window. */
export function useReplyRoot(
  session: RelaySession | undefined,
  channelId: string,
  rootId: string | undefined,
): {
  message: ChannelMessage | undefined;
  status: ThreadSnapshot["status"];
  retry: (() => void) | undefined;
} {
  const window = useSyncExternalStore(
    useCallback(
      (notify) =>
        session && rootId
          ? session.channels.subscribeWindow(channelId, notify)
          : unsubscribe,
      [session, channelId, rootId],
    ),
    useCallback(
      () =>
        session && rootId ? session.channels.window(channelId) : undefined,
      [session, channelId, rootId],
    ),
  );
  const visible = window?.rows.find((row) => row.id === rootId);
  const [resolved, setResolved] = useState<{
    session: RelaySession;
    channelId: string;
    rootId: string;
    snapshot: ThreadSnapshot;
    retry(): void;
  }>();
  const needsRead = !!rootId && !visible;
  useEffect(() => {
    if (!session || !rootId || !needsRead) return;
    const view = session.thread(channelId, rootId, { exact: true });
    const retry = () => {
      void view.refresh();
    };
    const update = () =>
      setResolved({
        session,
        channelId,
        rootId,
        snapshot: view.snapshot(),
        retry,
      });
    const stop = view.subscribe(update);
    update();
    void view.refresh();
    return () => {
      stop();
      view.dispose();
    };
  }, [session, channelId, rootId, needsRead]);
  const current =
    resolved?.session === session &&
    resolved?.channelId === channelId &&
    resolved?.rootId === rootId
      ? resolved
      : undefined;
  return {
    message: visible ?? current?.snapshot.root,
    status: visible ? "ready" : (current?.snapshot.status ?? "loading"),
    retry: current?.retry,
  };
}
