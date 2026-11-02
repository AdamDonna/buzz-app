import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelQueries } from "../relay/contracts";

type Directory = NonNullable<
  ReturnType<NonNullable<ChannelQueries["openDirectory"]>>
>;
const none: Directory = [];
const noSubscribe = () => () => {};

type Read =
  | { status: "loading" }
  | { status: "ready"; partial: boolean }
  | { status: "error" };

/** The community's open channels, read while `active`, for browsing without
 * a query. Entries are display-only directory names: opening one reaches its
 * read-only preview, which resolves the channel. A first read's rows show
 * page by page while it loads; a finished read's stay whole while the next
 * one runs. */
export function useChannelDirectory(
  channels: Pick<
    ChannelQueries,
    "subscribeList" | "openDirectory" | "readDirectory" | "directoryComplete"
  >,
  active: boolean,
) {
  const directory = useSyncExternalStore(
    active ? channels.subscribeList : noSubscribe,
    () => (active ? (channels.openDirectory?.() ?? none) : none),
  );
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<Read>({ status: "loading" });
  const readDirectory = channels.readDirectory;
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reruns this finite read.
  useEffect(() => {
    if (!active) return;
    if (!readDirectory) {
      setRead({ status: "error" });
      return;
    }
    const controller = new AbortController();
    setRead({ status: "loading" });
    readDirectory({ signal: controller.signal }).then(
      ({ partial }) => {
        if (!controller.signal.aborted) setRead({ status: "ready", partial });
      },
      () => {
        if (!controller.signal.aborted) setRead({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [active, readDirectory, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    directory,
    // A refresh keeps the finished read's rows whole: nothing more to wait for.
    loading:
      active && read.status === "loading" && !channels.directoryComplete?.(),
    partial: read.status === "ready" && read.partial,
    error: read.status === "error",
    retry,
  };
}

const noCounts: ReadonlyMap<string, number> = new Map();

/** Member counts for the directory rows someone has seen: `show` takes the
 * ids in view, and each id is read once per mount. The first rows read at
 * once; later ones a moment after they show, so a fast scroll reads in one
 * batch. A failed read is tried again the next time its row shows. */
export function useMemberCounts(
  channels: Pick<ChannelQueries, "readMemberCounts">,
) {
  const [counts, setCounts] = useState(noCounts);
  const asked = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const controller = useRef<AbortController>(undefined);
  const first = useRef(true);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );
  const read = channels.readMemberCounts;
  const show = useCallback(
    (ids: readonly string[]) => {
      if (!read) return;
      for (const id of ids)
        if (!asked.current.has(id)) {
          asked.current.add(id);
          queue.current.add(id);
        }
      if (!queue.current.size || timer.current) return;
      const flush = () => {
        timer.current = undefined;
        const batch = [...queue.current];
        queue.current.clear();
        controller.current ??= new AbortController();
        const { signal } = controller.current;
        read(batch, { signal }).then(
          (found) => {
            if (!signal.aborted && found.size)
              setCounts((previous) => new Map([...previous, ...found]));
          },
          () => {
            for (const id of batch) asked.current.delete(id);
          },
        );
      };
      if (first.current) {
        first.current = false;
        flush();
      } else timer.current = setTimeout(flush, 100);
    },
    [read],
  );
  return { counts, show };
}
