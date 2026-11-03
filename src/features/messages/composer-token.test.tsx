// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { ComposerToken } from "../conversation/contracts";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerClipboard, buzzCopyDocument } from "./composer-clipboard";
import {
  composerTokenDraft,
  readComposerDocument,
  projectComposerDocument,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { composerToken } from "./composer-token";
import { mentionDraft, type MentionDraft } from "./mention-draft";

composerDOMFixture();
afterEach(cleanup);
it("bounds token JSON by UTF-8 bytes, including multibyte identities", () => {
  const template = { kind: "nexus.project", id: "", label: "Project" };
  const overhead = new TextEncoder().encode(JSON.stringify(template)).length;
  const count = Math.floor((8192 - overhead) / 3);
  const fitting = { ...template, id: "界".repeat(count) };
  expect(composerToken(fitting)).toEqual(fitting);
  expect(composerToken({ ...fitting, id: `${fitting.id}界` })).toBeUndefined();
});
const token: ComposerToken = {
  kind: "nexus.repository",
  id: "github.com/block/buzz-app",
  label: "@block/buzz-app",
  verified: false,
  extra: { preserve: true },
};

function mount(
  initial: MentionDraft | string = "Use @repo",
  maxLength = 16000,
) {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft(initial);
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={maxLength}
        decorationsFor={() => []}
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Editor />, { reactStrictMode: true });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return { input, view, draft: () => draft };
}

it("restores a seeded project as an editable removable token, never a recipient", () => {
  const project = {
    kind: "nexus.project" as const,
    id: "opaque-project",
    label: "Project",
  };
  const seeded = composerTokenDraft(project);
  expect(seeded).toBeDefined();
  const f = mount(mentionDraft(JSON.parse(JSON.stringify(seeded))));
  expect(f.draft().tokens?.[0]?.token).toEqual(project);
  expect(f.draft().recipients).toEqual([]);
  act(() => f.input.insertText("Do work"));
  expect(f.draft().tokens?.[0]?.token).toEqual(project);
  act(() => {
    const span = f.draft().tokens?.[0];
    if (!span) throw new Error("Missing seeded token");
    f.input.setSelectionRange(span.start, span.end);
    f.input.insertText("");
  });
  expect(f.draft().tokens).toBeUndefined();
  f.view.unmount();
  expect(
    mount(mentionDraft(JSON.parse(JSON.stringify(f.draft())))).draft().tokens,
  ).toBeUndefined();
});

it("keeps token identity through typing, persistence, deletion and undo without recipients", () => {
  const f = mount();
  act(() => {
    expect(f.input.insertToken(token, { start: 4, end: 9 })).toBe(true);
  });
  expect(
    f.input.querySelector('[aria-label="Repository @block/buzz-app"]'),
  ).toBeInTheDocument();
  expect(f.draft().recipients).toEqual([]);
  expect(f.draft().tokens?.[0]?.token).toEqual(token);
  act(() => {
    f.input.insertText("now");
  });
  expect(composerMarkdown(f.draft())).toBe("Use  now");
  const restored = mentionDraft(JSON.parse(JSON.stringify(f.draft())));
  f.view.unmount();
  const next = mount(restored);
  expect(next.draft().tokens?.[0]?.token).toEqual(token);
  act(() => {
    next.input.setSelectionRange(4, 4 + token.label.length);
    next.input.insertText("");
  });
  expect(next.draft().tokens).toBeUndefined();
  act(() => {
    next.input.undo(false);
  });
  expect(next.draft().tokens?.[0]?.token).toEqual(token);
});

it("copies only labels; pasting the label never creates semantic identity", () => {
  const f = mount();
  act(() => {
    f.input.insertToken(token, { start: 4, end: 9 });
  });
  const copied = composerClipboard(
    readComposerDocument(f.draft(), []),
    document,
  );
  expect(copied.text).toBe("Use @block/buzz-app ");
  expect(copied.html).not.toContain("github.com");
  const pastedDocument = buzzCopyDocument(copied.html);
  if (!pastedDocument) throw new Error("Missing copied document");
  const pasted = mount(projectComposerDocument(pastedDocument).draft);
  expect(pasted.draft().tokens).toBeUndefined();
  expect(pasted.draft().recipients).toEqual([]);
});

it("rejects token insertion inside code and leaves the editor unchanged", () => {
  const f = mount("`@repo`");
  act(() => {
    expect(f.input.insertToken(token, { start: 1, end: 6 })).toBe(false);
  });
  expect(f.draft().text).toBe("`@repo`");
  expect(f.draft().tokens).toBeUndefined();
});

it("rejects typing beyond the persisted source limit without losing tokens or undo", () => {
  // The persistence bound is independent of a caller's publication limit.
  const f = mount("Use @repo", 20000);
  act(() => {
    f.input.insertToken(token, { start: 4, end: 9 });
  });
  act(() => {
    f.input.insertText("x".repeat(16000 - f.draft().text.length));
  });
  expect(f.draft().text).toHaveLength(16000);
  const full = JSON.parse(JSON.stringify(f.draft()));
  act(() => {
    f.input.insertText("y");
  });
  expect(f.draft().text.length).toBe(16000);
  expect(f.draft()).toEqual(full);
  expect(
    mentionDraft(JSON.parse(JSON.stringify(f.draft()))).tokens?.[0]?.token,
  ).toEqual(token);
  act(() => {
    f.input.undo(false);
  });
  expect(f.draft().text).toBe(`Use ${token.label} `);
  expect(f.draft().tokens?.[0]?.token).toEqual(token);
});
