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
])("parses %j as %s", (value, expected) => {
  expect(parseTheme(value)).toBe(expected);
});

it("opens a dark frame scope only on a light page for a dark-frame theme", () => {
  expect(frameScope("buzz", "light")).toBeUndefined();
  expect(frameScope("buzz", "dark")).toBeUndefined();
  expect(frameScope("relax", "light")).toBe("dark");
  expect(frameScope("relax", "dark")).toBeUndefined();
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
