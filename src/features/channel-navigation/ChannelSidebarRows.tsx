import { useDndContext } from "@dnd-kit/core";
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
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import styles from "./ChannelSidebarRows.module.css";

/** Shrink and fade changing positions, retaining keyed rows and stationary anchors. */
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
  const desired = JSON.stringify(children.map((child) => String(child.key)));
  const [order, setOrder] = useState(desired);
  const [fading, setFading] = useState<ReadonlySet<string>>(() => new Set());
  const latest = useRef(desired);
  const ids: string[] = JSON.parse(order);
  const byId = new Map(children.map((child) => [String(child.key), child]));
  const sameMembers =
    ids.length === children.length && ids.every((id) => byId.has(id));
  useLayoutEffect(() => {
    latest.current = desired;
    if (instant || !sameMembers) {
      if (order !== desired) setOrder(desired);
      setFading((previous) => (previous.size ? new Set() : previous));
      return;
    }
    const target: string[] = JSON.parse(desired);
    const positions = new Map(target.map((id, index) => [id, index]));
    const displayed: string[] = JSON.parse(order);
    setFading((previous) => {
      const next = new Set(previous);
      displayed.forEach((id, index) => {
        if (positions.get(id) !== index) next.add(id);
      });
      return next.size === previous.size ? previous : next;
    });
  }, [desired, instant, order, sameMembers]);
  // The first completed fade applies the latest target. More activity can
  // add moving rows without restarting the rows already fading out.
  const applyOrder = useCallback(() => {
    setOrder(latest.current);
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
        {rows.map((child) => (
          <ChannelRow
            key={child.key}
            animated={!instant}
            hiding={!instant && sameMembers && fading.has(String(child.key))}
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
      hiding: boolean;
      onHidden: () => void;
    }
  >(function ChannelRow({ children, animated, hiding, onHidden }, ref) {
    const present = useIsPresent();
    // Full transform keyframes let Motion delegate scaling to browser animations.
    // Keep an explicit identity: Motion can normalize "none" to scale(0).
    return (
      <motion.div
        ref={ref}
        style={{ transformOrigin: "left center" }}
        initial={{
          opacity: animated ? 0 : 1,
          transform: animated ? "scale(0.85)" : "scale(1)",
        }}
        animate={{
          opacity: hiding ? 0 : 1,
          transform: hiding ? "scale(0.85)" : "scale(1)",
        }}
        exit={{ opacity: 0, transform: "scale(0.85)" }}
        transition={{ duration: animated ? (hiding ? 0.3 : 0.4) : 0 }}
        onAnimationComplete={() => {
          if (hiding && present) onHidden();
        }}
        inert={!present}
        aria-hidden={!present || undefined}
      >
        {children}
      </motion.div>
    );
  }),
);
