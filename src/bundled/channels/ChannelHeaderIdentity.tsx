import type { ComponentProps, ReactNode } from "react";
import { CaretRightIcon } from "../../shared/design-system/icons";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import styles from "./ChannelHeaderIdentity.module.css";

/** One artwork/name target opens the conversation's existing member manager. */
export function ChannelHeaderIdentity({
  name,
  avatars,
  ...props
}: Omit<ComponentProps<typeof SurfaceButton>, "children" | "className"> & {
  name: string;
  avatars: ReactNode;
}) {
  return (
    <SurfaceButton {...props} className={styles.identity}>
      <span className={styles.avatars} aria-hidden="true">
        {avatars}
      </span>
      <span className={styles.label}>
        <span className={`${styles.name} text-body-sm`}>{name}</span>
        <CaretRightIcon size="1rem" aria-hidden="true" />
      </span>
    </SurfaceButton>
  );
}
