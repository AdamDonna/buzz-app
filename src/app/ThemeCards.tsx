import { Field } from "../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import type { Accent } from "../shared/theme/accent";
import type { ColorMode } from "../shared/theme/service";
import {
  THEMES,
  THEME_DEFINITIONS,
  frameScope,
  parseTheme,
  type Theme,
} from "../shared/theme/themes";
import styles from "./ThemeCards.module.css";

const FRAME = {
  className: "dark",
  "data-color-mode": "dark",
  "data-theme-frame": "",
} as const;

/** The theme under its own palette, in the page's mode and the current accent. */
function ThemePreview({
  theme,
  mode,
  accent,
}: {
  theme: Theme;
  mode: ColorMode;
  accent: Accent;
}) {
  const framed = frameScope(theme, mode) === "dark";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 80 56"
      focusable="false"
      className={`buzz-theme-preview ${mode}`}
      data-theme={theme}
      data-accent={accent}
      data-color-mode={mode}
    >
      <rect width="80" height="56" rx="8" className={styles.canvas} />
      <g {...(framed ? FRAME : undefined)}>
        <rect
          x="5"
          y="5"
          width="20"
          height="46"
          rx="5"
          className={styles.sidebar}
        />
        <path d="M9 13h12" className={styles.selected} />
        <path d="M10 20h8M10 25h10" className={styles.sidebarLines} />
      </g>
      <rect
        x="28"
        y="5"
        width="47"
        height="46"
        rx="5"
        className={styles.panel}
      />
      <path d="M33 14h20M33 19h14" className={styles.lines} />
      <rect
        x="48"
        y="25"
        width="22"
        height="6"
        rx="3"
        className={styles.message}
      />
      <rect
        x="33"
        y="42"
        width="37"
        height="5"
        rx="2.5"
        className={styles.composer}
      />
    </svg>
  );
}

/** One radio card per theme, each previewed under its own palette. */
export function ThemeCards({
  value,
  mode,
  accent,
  onValueChange,
}: {
  value: Theme;
  mode: ColorMode;
  accent: Accent;
  onValueChange: (theme: Theme) => void;
}) {
  return (
    <div data-buzz-ui="" className={`buzz-theme-picker ${styles.cards}`}>
      <Field label="Theme" nativeLabel={false}>
        <RadioGroup
          value={value}
          onValueChange={(next) => onValueChange(parseTheme(next))}
        >
          {THEMES.map((theme) => (
            <Radio
              key={theme}
              value={theme}
              label={
                <span className="buzz-theme-choice">
                  <span
                    className={`buzz-theme-thumbnail ${styles.thumbnail}`}
                    aria-hidden="true"
                  >
                    <ThemePreview theme={theme} mode={mode} accent={accent} />
                  </span>
                  {THEME_DEFINITIONS[theme].label}
                </span>
              }
              description={THEME_DEFINITIONS[theme].description}
            />
          ))}
        </RadioGroup>
      </Field>
    </div>
  );
}
