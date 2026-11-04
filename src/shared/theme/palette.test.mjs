import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import "./palette-runtime.js";
import {
  apcaContrast,
  wcagRatio,
} from "../../../scripts/design-system/apca.mjs";
const runtime = globalThis.BuzzPalette;
const colors = [
  "#000000",
  "#ffffff",
  "#ff0000",
  "#00ff00",
  "#0000ff",
  "#777777",
  "#888888",
  "#085d35",
  "#663399",
  "#ffff00",
];
const palette = (color) => ({
  version: 1,
  light: { window: color, sidebar: color, selection: color, accent: color },
  dark: { window: color, sidebar: color, selection: color, accent: color },
});
// Independent numeric composition: preserve fractions through both layers,
// then round each final channel toward the ink. WCAG/APCA are monotonic in
// that direction, so passing this conservative bound guarantees the CSS pair.
function stackedBound(fill, hoverInk, hover, ink, overlay) {
  const rgb = (color) =>
    [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  const first = rgb(fill).map(
    (value, i) => value + (rgb(hoverInk)[i] - value) * hover,
  );
  const final = first.map(
    (value, i) => value + (rgb(ink)[i] - value) * overlay,
  );
  return `#${final.map((value) => (ink === "#ffffff" ? Math.ceil(value) : Math.floor(value)).toString(16).padStart(2, "0")).join("")}`;
}
function readable(ink, fill, target = 60) {
  expect(wcagRatio(ink, fill), `${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
  expect(
    Math.abs(apcaContrast(ink, fill)),
    `${ink} on ${fill}`,
  ).toBeGreaterThanOrEqual(target);
}
it("accepts only bounded versioned opaque color data, normalizes and strips unknown keys", () => {
  const good = palette("#AABBCC");
  expect(runtime.parse(JSON.stringify({ ...good, css: "url(evil)" }))).toEqual(
    palette("#aabbcc"),
  );
  for (const value of [
    null,
    "",
    "null",
    "[]",
    "{}",
    JSON.stringify({ ...good, version: 2 }),
    JSON.stringify({ ...good, dark: null }),
    " ".repeat(2049),
  ])
    expect(runtime.parse(value)).toBeNull();
  for (const value of [
    "red",
    "#fff",
    "#000000ff",
    "var(--bg-app)",
    "url(https://example.com)",
    42,
  ]) {
    const bad = palette("#000000");
    bad.light.accent = value;
    expect(runtime.parse(JSON.stringify(bad))).toBeNull();
  }
});
it.each(colors)(
  "effective pairs meet independent WCAG and APCA measurements for %s in both modes",
  (color) => {
    for (const mode of ["light", "dark"]) {
      const { style, effective } = runtime.resolve(palette(color), mode);
      const ink = style[`--accent-ink-${mode}`];
      const accent = effective.accent;
      const link = style[`--accent-link-${mode}`];
      readable(ink, accent);
      readable(style["--text-sidebar-selected"], effective.selection);
      for (const hoverInk of ["#000000", "#ffffff"]) {
        for (const hover of [0, 0.05]) {
          for (const alpha of [0, 0.04, 0.08, 0.1, 0.16, 0.22]) {
            readable(ink, stackedBound(accent, hoverInk, hover, ink, alpha));
          }
        }
      }
      for (const bg of [
        mode === "light" ? "#ffffff" : "#232323",
        style[`--accent-4-${mode}`],
        style["--affordance-sidebar-hover"],
      ])
        readable(link, bg);
      const neutral = mode === "light" ? "#525252" : "#b3b3b3";
      for (const bg of [effective.window, effective.sidebar])
        readable(neutral, bg);
      for (const text of colors) {
        expect(runtime.contrast(text, color)).toBeCloseTo(
          apcaContrast(text, color),
          8,
        );
        expect(runtime.ratio(text, color)).toBeCloseTo(
          wcagRatio(text, color),
          8,
        );
      }
    }
  },
);
it("parser-blocking startup applies the same validated properties and mode before the app loads", () => {
  const stored = JSON.stringify(palette("#663399"));
  const properties = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: (key) => properties.delete(key),
    },
  };
  const context = {
    document: { documentElement: root },
    localStorage: {
      getItem: (key) =>
        key === runtime.key
          ? stored
          : key === "buzz-appearance.v1"
            ? "dark"
            : null,
    },
    matchMedia: () => ({ matches: false }),
  };
  runInNewContext(
    readFileSync(new URL("./palette-runtime.js", import.meta.url), "utf8"),
    context,
  );
  runInNewContext(
    readFileSync(
      new URL("../../../public/appearance-init.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  expect(root.dataset.colorMode).toBe("dark");
  expect(root.dataset.customPalette).toBe("");
  for (const [key, value] of Object.entries(
    runtime.properties(JSON.parse(stored)),
  ))
    expect(properties.get(key)).toBe(value);
  runtime.apply(root, null);
  expect(root.dataset.customPalette).toBeUndefined();
  expect([...properties.keys()]).toEqual(["--buzz-text-scale"]);
});
