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
