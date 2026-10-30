import { expect, it } from "vitest";
import { hasFeature, memory, withFeature } from "./features";

const OPEN = "<!-- buzz:bestie/memory v1 -->";
const CLOSE = "<!-- /buzz:bestie/memory -->";

it("adds memory once, at the end, and removes only what it added", () => {
  const owner = "Be brief.\n\nAlways answer in French.\n";
  const on = withFeature(owner, memory, true);
  expect(on).toBe(
    `Be brief.\n\nAlways answer in French.\n\n${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(hasFeature(on, memory)).toBe(true);
  expect(withFeature(on, memory, true)).toBe(on);
  expect(withFeature(on, memory, false)).toBe(
    "Be brief.\n\nAlways answer in French.",
  );
  expect(withFeature(owner, memory, false)).toBe(owner);
  // Empty instructions get the section alone, and come back empty.
  expect(withFeature("", memory, true)).toBe(
    `${OPEN}\n${memory.text}\n${CLOSE}\n`,
  );
  expect(withFeature(withFeature("", memory, true), memory, false)).toBe("");
});

it("keeps the owner's text on both sides of a section moved by hand", () => {
  const text = `Before.\n\n${OPEN}\nold rules\n${CLOSE}\n\nAfter.`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Before.\n\nAfter.");
});

it("treats any version as on, and edited markers as absent", () => {
  const later =
    "<!-- buzz:bestie/memory v2 -->\nnew rules\n<!-- /buzz:bestie/memory -->";
  expect(hasFeature(later, memory)).toBe(true);
  expect(withFeature(`Mine.\n\n${later}`, memory, false)).toBe("Mine.");
  // Without its closing marker the section isn't found or touched; turning
  // memory on adds a whole one.
  const broken = `Mine.\n\n${OPEN}\nrules I edited`;
  expect(hasFeature(broken, memory)).toBe(false);
  expect(withFeature(broken, memory, false)).toBe(broken);
  expect(
    withFeature(broken, memory, true).startsWith(`${broken}\n\n${OPEN}`),
  ).toBe(true);
});

it("leaves markers quoted in the owner's text, and removes every section", () => {
  const quoted = `Never edit ${OPEN} by hand. Important rule.`;
  expect(hasFeature(quoted, memory)).toBe(false);
  const on = withFeature(quoted, memory, true);
  expect(withFeature(on, memory, false)).toBe(quoted);
  const twice = `${on}\n${OPEN}\ncopy\n${CLOSE}\n\n    indented code`;
  const off = withFeature(twice, memory, false);
  expect(off).toBe(`${quoted}\n\n    indented code`);
  expect(hasFeature(off, memory)).toBe(false);
});

it("finds a section in Windows line endings", () => {
  const text = `Mine.\r\n\r\n${OPEN}\r\nrules\r\n${CLOSE}\r\n`;
  expect(hasFeature(text, memory)).toBe(true);
  expect(withFeature(text, memory, false)).toBe("Mine.");
});
