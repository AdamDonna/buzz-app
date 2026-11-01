import { useDndContext } from "@dnd-kit/core";
import {
  animate,
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactElement,
} from "react";
import styles from "./ChannelSidebarRows.module.css";

/** Slide keyed rows to their new positions while stationary anchors stay still. */
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
  const order = JSON.stringify(children.map((child) => String(child.key)));
  return (
    <div className={styles.rows}>
      <AnimatePresence
        initial={false}
        mode="popLayout"
        presenceAffectsLayout={false}
      >
        {children.map((child) => (
          <ChannelRow key={child.key} animated={animated} order={order}>
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
    { children: ReactElement; animated: boolean; order: string }
  >(function ChannelRow({ children, animated, order }, forwardedRef) {
    const ref = useRef<HTMLDivElement>(null);
    const position = useRef<{ order: string; top: number } | null>(null);
    const playback = useRef<ReturnType<typeof animate> | null>(null);
    const present = useIsPresent();
    useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement);
    useEffect(() => () => playback.current?.stop(), []);
    useLayoutEffect(() => {
      const node = ref.current;
      if (!node) return;
      const previous = position.current;
      const top = node.offsetTop;
      position.current = { order, top };
      if (!present) {
        playback.current?.stop();
        return;
      }
      if (!animated) {
        playback.current?.stop();
        node.style.transform = "none";
        node.style.opacity = "1";
        return;
      }
      if (previous === null || previous.order === order || previous.top === top)
        return;
      // Read only on an order change. Native transforms avoid per-frame layout
      // projection, and retarget from the displayed position during bursts.
      const style = getComputedStyle(node);
      const transform = new DOMMatrixReadOnly(style.transform);
      const delta = previous.top - top + transform.m42;
      const rect = node.getBoundingClientRect();
      const visible =
        Math.max(
          rect.bottom - transform.m42,
          rect.bottom + previous.top - top,
        ) > 0 &&
        Math.min(rect.top - transform.m42, rect.top + previous.top - top) <
          window.innerHeight;
      const scale = transform.a;
      const opacity = Number(style.opacity);
      playback.current?.stop();
      if (!visible || delta === 0) {
        node.style.transform = "none";
        node.style.opacity = "1";
        return;
      }
      // Hold the old screen position before paint while native playback starts.
      node.style.transform = `translateY(${delta}px) scale(${scale})`;
      playback.current = animate(
        node,
        {
          transform: [
            `translateY(${delta}px) scale(${scale})`,
            `translateY(${delta * 0.8}px) scale(0.9)`,
            `translateY(${delta * 0.2}px) scale(0.9)`,
            "translateY(0px) scale(1)",
          ],
          opacity: [opacity, 0.75, 0.75, 1],
        },
        { duration: 0.6, times: [0, 0.2, 0.8, 1], ease: "linear" },
      );
    }, [animated, order, present]);
    return (
      <motion.div
        ref={ref}
        style={{ transformOrigin: "left center" }}
        initial={{ opacity: animated ? 0 : 1 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: animated ? 0.15 : 0 }}
        inert={!present}
        aria-hidden={!present || undefined}
      >
        {children}
      </motion.div>
    );
  }),
);
