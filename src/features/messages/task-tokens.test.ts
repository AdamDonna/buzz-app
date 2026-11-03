import { expect, it } from "vitest";
import type { ComposerToken } from "../conversation/contracts";
import {
  taskTokenTags,
  readTaskTokens,
  taskTokenFallback,
  TASK_TOKENS_TAG,
} from "./task-tokens";
import { scanMarkdown } from "../relay/message-content";

const token: ComposerToken = {
  kind: "nexus.repository",
  id: "github.com/block/buzz-app",
  label: "@block/buzz-app",
  verified: false,
};
it("round-trips exact identities and extra metadata without interpreting display verification", () => {
  expect(taskTokenTags([])).toEqual([]);
  expect(readTaskTokens(taskTokenTags([token]))).toEqual([token]);
  const skill: ComposerToken = {
    kind: "nexus.skill",
    id: JSON.stringify({ path: "/task/repo/SKILL.md", name: "Review" }),
    label: "/Review",
    target: "a".repeat(64),
    evidence: "reported",
  };
  expect(readTaskTokens(taskTokenTags([skill]))).toEqual([skill]);
});
it("rejects duplicate tags, duplicate identities, malformed shapes and oversized UTF-8 payloads", () => {
  const tag = taskTokenTags([token])[0];
  if (!tag) throw new Error("Missing tag");
  for (const tags of [
    [tag, tag],
    [[TASK_TOKENS_TAG, "{bad"]],
    [[TASK_TOKENS_TAG, "[]"]],
    [[TASK_TOKENS_TAG, JSON.stringify([{ ...token, verified: "yes" }])]],
  ])
    expect(() => readTaskTokens(tags)).toThrow();
  expect(() => taskTokenTags([token, token])).toThrow("duplicate");
  const large = Array.from({ length: 3 }, (_, i) => ({
    ...token,
    id: String(i),
    extra: "界".repeat(2300),
  }));
  expect(() => taskTokenTags(large)).toThrow("too large");
  expect(() =>
    readTaskTokens([[TASK_TOKENS_TAG, JSON.stringify(large)]]),
  ).toThrow();
  expect(() =>
    taskTokenTags(
      Array.from({ length: 33 }, (_, i) => ({ ...token, id: String(i) })),
    ),
  ).toThrow();
});
it("keeps unknown versions inert and fallback labels literal", () => {
  expect(readTaskTokens([["nexus.tokens.v2", "invalid future bytes"]])).toEqual(
    [],
  );
  const fallback = taskTokenFallback([
    { ...token, label: "@Other /run [link](https://example.com) `code`" },
  ]);
  expect(scanMarkdown(fallback).links).toEqual([]);
  expect(
    scanMarkdown(fallback).tree.children?.[0]?.children?.some(
      (node) => node.type === "inlineCode",
    ),
  ).toBe(true);
});
