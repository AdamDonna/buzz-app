import { expect, it } from "vitest";
import type { ComposerToken } from "../conversation/contracts";
import {
  taskTokenTags,
  readTaskTokens,
  taskTokenFallback,
  TASK_TOKENS_TAG,
} from "./task-tokens";
import { scanMarkdown } from "../relay/message-content";
import {
  composerTokenDraft,
  composerSchema,
  projectComposerDocument,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";

const token: ComposerToken = {
  kind: "nexus.repository",
  id: "github.com/block/buzz-app",
  label: "@block/buzz-app",
  verified: false,
};
it("keeps repository and folder references in authored order without project prose or a footer", () => {
  const folder: ComposerToken = {
    kind: "nexus.folder",
    id: "/notes",
    label: "@notes",
  };
  const project: ComposerToken = {
    kind: "nexus.project",
    id: "private",
    label: "Private project",
  };
  const atom = (semantic: ComposerToken) =>
    composerSchema.nodes.token.create({ source: semantic.label, semantic });
  const doc = composerSchema.nodes.doc.create(
    { projects: [project] },
    composerSchema.nodes.paragraph.create(null, [
      atom(token),
      composerSchema.text(" - use "),
      atom(folder),
      composerSchema.text(" now"),
    ]),
  );
  const draft = projectComposerDocument(doc).draft;
  expect(composerMarkdown(draft)).toBe(
    "&#64;block/buzz-app - use &#64;notes now",
  );
  expect(draft.tokens?.map(({ token }) => token)).toEqual([
    project,
    token,
    folder,
  ]);
});

it("serializes syntax-like token labels literally in place, including under rich formatting", () => {
  const label = "@Other /run [link](https://example.com) `code` **bold**";
  const selected = { ...token, label };
  const draft = composerTokenDraft(selected);
  if (!draft) throw new Error("Missing selected reference");
  const wire = composerMarkdown(draft);
  expect(scanMarkdown(wire).links).toEqual([]);
  expect(
    scanMarkdown(wire).tree.children?.[0]?.children?.every(
      (node) => node.type === "text",
    ),
  ).toBe(true);
  const atom = composerSchema.nodes.token.create(
    { source: label, semantic: selected },
    null,
    [composerSchema.marks.bold.create()],
  );
  const rich = composerSchema.nodes.doc.create(
    null,
    composerSchema.nodes.paragraph.create(null, [
      composerSchema.text("Before "),
      atom,
      composerSchema.text(" after"),
    ]),
  );
  const output = composerMarkdown(projectComposerDocument(rich).draft);
  expect(scanMarkdown(output).links).toEqual([]);
  expect(output).toMatch(/^Before \*\*/);
  expect(output).toMatch(/\*\* after$/);
});
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
  const folder: ComposerToken = {
    kind: "nexus.folder",
    id: "/Development/notes",
    label: "@notes",
    executionHost: "82e43596-21a8-43c2-afb3-a9d8f2b4bf85",
  };
  expect(readTaskTokens(taskTokenTags([folder]))).toEqual([folder]);
  expect(taskTokenTags([folder]).map(([name]) => name)).toEqual([
    TASK_TOKENS_TAG,
  ]);
  expect(() => taskTokenTags([folder, folder])).toThrow("duplicate");
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
  const project: ComposerToken = {
    kind: "nexus.project",
    id: "opaque",
    label: "#Do not send this project tag",
  };
  expect(taskTokenFallback([project, token])).toBe(taskTokenFallback([token]));
  expect(readTaskTokens(taskTokenTags([project]))).toEqual([project]);
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
