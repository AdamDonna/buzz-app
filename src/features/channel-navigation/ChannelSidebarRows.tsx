import { useDndContext } from "@dnd-kit/core";
import {
  AnimatePresence,
  motion,
  useAnimate,
  useIsPresent,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { flushSync } from "react-dom";
import styles from "./ChannelSidebarRows.module.css";

/** Fade a changing order without projecting/measuring every channel's layout. */
export function ChannelSidebarRows({
  children,
  open,
}: {
  children: ReactElement[];
  open: boolean;
}) {
  const { active } = useDndContext();
  const reducedMotion = useReducedMotion();
  const instant = !open || !!active || !!reducedMotion;
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const desired = JSON.stringify(children.map((child) => String(child.key)));
  const [order, setOrder] = useState(desired);
  const latest = useRef(desired);
  const fading = useRef<ReturnType<typeof animate> | undefined>(undefined);
  const ids: string[] = JSON.parse(order);
  const byId = new Map(children.map((child) => [String(child.key), child]));
  const sameMembers =
    ids.length === children.length && ids.every((id) => byId.has(id));
  useLayoutEffect(() => {
    latest.current = desired;
  }, [desired]);
  useLayoutEffect(() => {
    if (!scope.current) return;
    if (instant || !sameMembers) {
      fading.current?.stop();
      fading.current = undefined;
      void animate(scope.current, { opacity: 1 }, { duration: 0 });
      if (order !== desired) setOrder(desired);
      return;
    }
    if (order === desired || fading.current) return;
    const playback = animate(scope.current, { opacity: 0 }, { duration: 0.06 });
    fading.current = playback;
    void playback.then(() => {
      if (fading.current !== playback || !scope.current) return;
      fading.current = undefined;
      // Swap while hidden. Read the latest target so a busy nav cannot keep
      // restarting the fade or apply a stale intermediate order.
      flushSync(() => setOrder(latest.current));
      void animate(scope.current, { opacity: 1 }, { duration: 0.09 });
    });
  }, [animate, desired, instant, order, sameMembers, scope]);
  useLayoutEffect(
    () => () => {
      fading.current?.stop();
      fading.current = undefined;
    },
    [],
  );
  const rows = sameMembers
    ? ids.flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
      })
    : children;
  return (
    <div ref={scope} className={styles.rows}>
      <AnimatePresence
        initial={false}
        mode="popLayout"
        presenceAffectsLayout={false}
      >
        {rows.map((child) => (
          <ChannelRow key={child.key} animate={!instant}>
            {child}
          </ChannelRow>
        ))}
      </AnimatePresence>
    </div>
  );
}

const ChannelRow = memo(
  forwardRef<HTMLDivElement, { children: ReactElement; animate: boolean }>(
    function ChannelRow({ children, animate }, ref) {
      const present = useIsPresent();
      return (
        <motion.div
          ref={ref}
          initial={{ opacity: animate ? 0 : 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: animate ? 0.15 : 0 }}
          inert={!present}
          aria-hidden={!present || undefined}
        >
          {children}
        </motion.div>
      );
    },
  ),
);
