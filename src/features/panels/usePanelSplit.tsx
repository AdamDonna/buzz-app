import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  clearView,
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { ResizeHandle } from "./ResizeHandle";
import styles from "./Panels.module.css";

function readSplit(scope: string | undefined, key: string) {
  if (!scope) return undefined;
  const saved = readView<unknown>(scope, key, undefined);
  return typeof saved === "number" && Number.isFinite(saved) && saved > 0
    ? saved
    : undefined;
}

/**
 * Each page owns its split. The preferred width is saved per community and
 * viewer workspace (`scope`) under the page's `name`, so it survives the dock
 * closing, page switches and restarts; without a scope it stays in memory.
 */
export function usePanelSplit(
  scope: string | undefined,
  name: string,
  defaultWidth?: number,
  min = 316,
  primary?: { defaultWidth: number; maxRatio: number },
) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `panel-split:${name}`;
  const [view, setView] = useState(() => ({
    scope,
    key,
    preferred: readSplit(scope, key),
  }));
  // A workspace change reads that workspace's width without remounting the page.
  if (view.scope !== scope || view.key !== key)
    setView({ scope, key, preferred: readSplit(scope, key) });
  const { preferred } = view;
  // Follow saves from another frame or window sharing this page's width.
  useLayoutEffect(() => {
    if (!scope) return;
    return subscribeView(scope, () => {
      if (viewRevision(scope, key) === undefined) return;
      const saved = readSplit(scope, key);
      setView((current) =>
        current.scope === scope &&
        current.key === key &&
        current.preferred === saved
          ? current
          : { scope, key, preferred: saved },
      );
    });
  }, [scope, key]);
  const setPreferred = (width: number | undefined) => {
    setView({ scope, key, preferred: width });
    if (!scope) return;
    if (width !== undefined) writeView(scope, key, width);
    else
      try {
        clearView(scope, key);
      } catch {
        // The default still applies until the page next mounts.
      }
  };
  return {
    ref,
    style: undefined,
    handle: (
      <PanelSplitHandle
        target={ref}
        preferred={preferred}
        setPreferred={setPreferred}
        defaultWidth={defaultWidth}
        min={min}
        primary={primary}
      />
    ),
  };
}

// Container reflow updates the grip and CSS width, not the page and its messages.
function PanelSplitHandle({
  target: ref,
  preferred,
  setPreferred,
  defaultWidth,
  min,
  primary,
}: {
  target: RefObject<HTMLDivElement | null>;
  preferred: number | undefined;
  setPreferred(width: number | undefined): void;
  defaultWidth: number | undefined;
  min: number;
  primary: { defaultWidth: number; maxRatio: number } | undefined;
}) {
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  const minimum = Math.max(min, available * (1 - (primary?.maxRatio ?? 1)));
  const max = Math.max(minimum, available - 320);
  const clamp = (width: number) => Math.min(max, Math.max(minimum, width));
  const width = clamp(
    preferred ??
      defaultWidth ??
      (primary ? available - primary.defaultWidth : available / 2.1),
  );
  const automatic = preferred === undefined && primary === undefined;
  useLayoutEffect(() => {
    if (!available) return;
    const style = ref.current?.style;
    if (automatic) style?.removeProperty("--secondary-panel-width");
    else style?.setProperty("--secondary-panel-width", `${width}px`);
  }, [ref, available, width, automatic]);
  return (
    <ResizeHandle
      label="Resize main and secondary panels"
      direction={-1}
      target={ref}
      property="--secondary-panel-width"
      width={width}
      min={minimum}
      max={max}
      setWidth={(next) => setPreferred(clamp(next))}
      reset={() => setPreferred(undefined)}
      className={styles.resize}
    />
  );
}
