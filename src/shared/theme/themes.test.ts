import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEMES,
  THEME_DEFINITIONS,
  frameScope,
  parseTheme,
} from "./themes";

it("registers a definition for every theme id", () => {
  for (const id of THEMES) {
    const definition = THEME_DEFINITIONS[id];
    expect(definition.id).toBe(id);
    expect(definition.label).not.toBe("");
    expect(definition.description).not.toBe("");
  }
  expect(DEFAULT_THEME).toBe("buzz");
});

it.each([
  [null, "buzz"],
  [undefined, "buzz"],
  ["", "buzz"],
  ["Relax", "buzz"],
  ["unknown", "buzz"],
  [42, "buzz"],
  ["buzz", "buzz"],
  ["relax", "relax"],
  ["utmost", "utmost"],
  ["Utmost", "buzz"],
])("parses %j as %s", (value, expected) => {
  expect(parseTheme(value)).toBe(expected);
});

it("opens a dark frame scope only on a light page for a dark-frame theme", () => {
  expect(frameScope("buzz", "light")).toBeUndefined();
  expect(frameScope("buzz", "dark")).toBeUndefined();
  expect(frameScope("relax", "light")).toBe("dark");
  expect(frameScope("relax", "dark")).toBeUndefined();
  expect(frameScope("utmost", "light")).toBe("dark");
  expect(frameScope("utmost", "dark")).toBeUndefined();
});

const tokens = readFileSync(
  new URL("../design-system/styles/tokens.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const themeBlock = (id: string) =>
  new RegExp(`\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(tokens)?.[1];

it("keeps every theme in step with its stylesheet block", () => {
  for (const id of THEMES.filter((theme) => theme !== DEFAULT_THEME)) {
    const body = themeBlock(id);
    expect(body, `${id} needs a [data-theme] block`).toBeDefined();
    const darkFrame = THEME_DEFINITIONS[id].frame.light === "dark";
    expect(/--theme-frame-canvas-light:/.test(body ?? "")).toBe(darkFrame);
    expect(/--theme-frame-sidebar-light:/.test(body ?? "")).toBe(darkFrame);
    for (const mode of ["light", "dark"]) {
      expect(body).toContain(`--theme-canvas-${mode}:`);
      expect(body).toContain(`--theme-sidebar-${mode}:`);
      expect(body).toContain(`--theme-accent-9-${mode}:`);
    }
  }
  expect(themeBlock(DEFAULT_THEME)).toBeUndefined();
});

it.each(
  THEMES.filter((theme) => theme !== DEFAULT_THEME).map(
    (id) => [id, THEME_DEFINITIONS[id].accentFamily] as const,
  ),
)("points the %s Theme accent at its %s family", (id, family) => {
  const body = themeBlock(id) ?? "";
  for (const mode of ["light", "dark"]) {
    for (const step of ["1", "9", "12", "contrast", "ink", "link"]) {
      expect(body).toContain(
        `--theme-accent-${step}-${mode}: var(--${family}-${step}-${mode});`,
      );
    }
  }
});

it("resets every slot a role reads for a scope that previews the baseline", () => {
  const reads = new Set(
    [...tokens.matchAll(/var\(\s*(--theme-[a-z0-9-]+)/g)].map((m) => m[1]),
  );
  const reset = new Set(
    [
      ...(
        /\[data-theme-reset\]\s*\{([^}]*)\}/.exec(tokens)?.[1] ?? ""
      ).matchAll(/(--theme-[a-z0-9-]+):\s*initial;/g),
    ].map((m) => m[1]),
  );
  expect(reads.size).toBeGreaterThan(0);
  expect([...reads].filter((slot) => !reset.has(slot))).toEqual([]);
});
