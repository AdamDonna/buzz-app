import { useDndContext } from "@dnd-kit/core";
import { animate } from "motion/mini";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import styles from "./ChannelSidebarRows.module.css";

// Fast Refresh preserves refs; a replaced module must restart the prepared batch.
const animationGeneration = {};

/** Keep local movement short; fade distant jumps between their endpoints. */
export function ChannelSidebarRows({
  children,
  open,
}: {
  children: ReactElement[];
  open: boolean;
}) {
  const { active } = useDndContext();
  const reducedMotion = useReducedMotion();
  const animated = open && !active && !reducedMotion;
  const desired = JSON.stringify(children.map((child) => String(child.key)));
  const [order, setOrder] = useState(desired);
  const [fading, setFading] = useState<ReadonlySet<string>>(() => new Set());
  const target = useRef(desired);
  const pending = useRef(new Set<string>());
  const batchStart = useRef<number | null>(null);
  const generation = useRef(animationGeneration);
  const ids: string[] = JSON.parse(order);
  const byId = new Map(children.map((child) => [String(child.key), child]));
  const sameMembers =
    ids.length === children.length && ids.every((id) => byId.has(id));
  useLayoutEffect(() => {
    if (
      !animated ||
      !sameMembers ||
      generation.current !== animationGeneration
    ) {
      generation.current = animationGeneration;
      target.current = desired;
      pending.current.clear();
      batchStart.current = null;
      if (order !== desired) setOrder(desired);
      setFading((previous) => (previous.size ? new Set() : previous));
      return;
    }
    if (order === desired) batchStart.current = null;
    if (order === desired || fading.size) return;
    const now = performance.now();
    batchStart.current ??= now;
    const timer = setTimeout(
      () => {
        batchStart.current = null;
        target.current = desired;
        const next: string[] = JSON.parse(desired);
        const positions = new Map(next.map((id, index) => [id, index]));
        const displayed: string[] = JSON.parse(order);
        const distant = new Set(
          displayed.filter(
            (id, index) => Math.abs((positions.get(id) ?? index) - index) > 2,
          ),
        );
        pending.current = new Set(distant);
        if (distant.size) setFading(distant);
        else setOrder(desired);
      },
      Math.min(200, Math.max(0, 600 - (now - batchStart.current))),
    );
    return () => clearTimeout(timer);
  }, [animated, desired, fading.size, order, sameMembers]);
  // Finish the prepared batch; subsequent activity gets its own quiet period.
  const applyOrder = useCallback((id: string) => {
    if (!pending.current.delete(id) || pending.current.size) return;
    setOrder(target.current);
    setFading((previous) => (previous.size ? new Set() : previous));
  }, []);
  const rows = sameMembers
    ? ids.flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
      })
    : children;
  return (
    <div className={styles.rows}>
      <AnimatePresence
        initial={false}
        mode="popLayout"
        presenceAffectsLayout={false}
      >
        {rows.map((child, index) => (
          <ChannelRow
            key={child.key}
            animated={animated}
            index={index}
            hiding={animated && sameMembers && fading.has(String(child.key))}
            onHidden={applyOrder}
          >
            {child}
          </ChannelRow>
        ))}
      </AnimatePresence>
    </div>
  );
}

const ChannelRow = memo(
  forwardRef<
    HTMLDivElement,
    {
      children: ReactElement;
      animated: boolean;
      index: number;
      hiding: boolean;
      onHidden: (id: string) => void;
    }
  >(function ChannelRow(
    { children, animated, index, hiding, onHidden },
    forwardedRef,
  ) {
    const ref = useRef<HTMLDivElement>(null);
    const position = useRef<{ index: number; top: number } | null>(null);
    const playback = useRef<ReturnType<typeof animate> | null>(null);
    const present = useIsPresent();
    useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement);
    useEffect(() => {
      const node = ref.current;
      return () => {
        playback.current?.stop();
        position.current = null;
        if (node) {
          node.style.transform = "none";
          delete node.dataset.moving;
          node.style.zIndex = "";
        }
      };
    }, []);
    useLayoutEffect(() => {
      const node = ref.current;
      if (!node) return;
      const previous = position.current;
      const top = node.offsetTop;
      position.current = { index, top };
      if (!present || !animated) {
        playback.current?.stop();
        node.style.transform = "none";
        delete node.dataset.moving;
        node.style.zIndex = "";
        return;
      }
      if (!previous || previous.index === index || previous.top === top) return;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      const delta = previous.top - top + matrix.m42;
      const rect = node.getBoundingClientRect();
      const visible =
        Math.max(rect.bottom - matrix.m42, rect.bottom + previous.top - top) >
          0 &&
        Math.min(rect.top - matrix.m42, rect.top + previous.top - top) <
          window.innerHeight;
      playback.current?.stop();
      if (!visible || Math.abs(previous.index - index) > 2 || delta === 0) {
        node.style.transform = "none";
        delete node.dataset.moving;
        node.style.zIndex = "";
        return;
      }
      // Nearby crossings retain an opaque backing. Distant rows never sweep
      // through their neighbors; their opacity transition owns the hidden swap.
      node.dataset.moving = "";
      node.style.zIndex = delta > 0 ? "2" : "1";
      node.style.transform = `translateY(${delta}px)`;
      const animation = animate(
        node,
        { transform: [`translateY(${delta}px)`, "translateY(0px)"] },
        { duration: 0.14, ease: "easeOut" },
      );
      playback.current = animation;
      void animation.then(() => {
        if (playback.current !== animation) return;
        delete node.dataset.moving;
        node.style.zIndex = "";
      });
    }, [animated, index, present]);
    return (
      <motion.div
        ref={ref}
        className={styles.row}
        initial={{ opacity: animated ? 0 : 1 }}
        animate={{ opacity: hiding ? 0 : 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: animated ? 0.1 : 0 }}
        onAnimationComplete={() => {
          if (hiding && present) onHidden(String(children.key));
        }}
        inert={!present}
        aria-hidden={!present || undefined}
      >
        {children}
      </motion.div>
    );
  }),
);
