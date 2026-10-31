import { useCallback, useEffect, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { UserStatus } from "../relay/user-status";

export function useStatusEditor(
  session: RelaySession | undefined,
  viewer: string | undefined,
) {
  const [editor, setEditor] = useState<{
    session: RelaySession;
    viewer: string;
    current: UserStatus | undefined;
  }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes discard the editor, even when its snapshot is unchanged.
  useEffect(() => {
    setEditor(undefined);
  }, [session, viewer]);
  const close = () => setEditor(undefined);
  const open = useCallback(() => {
    if (!session || !viewer) return false;
    setEditor({
      session,
      viewer,
      current: session.statuses.snapshot().get(viewer),
    });
    return true;
  }, [session, viewer]);
  return {
    editor:
      editor?.session === session && editor?.viewer === viewer
        ? editor
        : undefined,
    open,
    close,
  };
}
