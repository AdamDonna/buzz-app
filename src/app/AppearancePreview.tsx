import styles from "./AppearancePreview.module.css";

const FRAME = {
  "data-color-mode": "dark",
  "data-theme-frame": "",
} as const;

/** Decorative app sketch using the same semantic colors as the live interface. */
export function AppearancePreview({ framed = false }: { framed?: boolean }) {
  return (
    <figure className={styles.preview} aria-label="Appearance preview">
      <div className={styles.scene} inert aria-hidden="true">
        <div
          {...(framed ? FRAME : undefined)}
          className={`${styles.sidebar} ${framed ? "dark" : ""}`}
        >
          <div className={styles.workspace}>
            <i />
            <span />
          </div>
          <div className={styles.nav}>
            <span />
          </div>
          <div className={styles.nav} data-selected>
            <span />
          </div>
          <div className={styles.nav}>
            <span />
          </div>
        </div>
        <div className={styles.conversation}>
          <div className={styles.heading}>
            <span />
          </div>
          <div className={styles.messages}>
            <div className={styles.received}>
              <i className={styles.avatar} />
              <div className={styles.bubble}>
                <span />
                <span />
                <span className={styles.link} />
              </div>
            </div>
            <div className={styles.bubble} data-own>
              <span />
              <span />
            </div>
          </div>
          <div className={styles.composer}>
            <span />
            <i />
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        Illustrated preview of your current theme, mode, accent, and contrast.
      </figcaption>
    </figure>
  );
}
