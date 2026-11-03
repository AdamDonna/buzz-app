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
  composerSchema,
  readComposerDocument,
  projectComposerDocument,
} from "./composer-document";
import { composerMarkdown } from "./composer-markdown";
import { composerToken, composerTokenName } from "./composer-token";
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
const folder: ComposerToken = {
  kind: "nexus.folder",
  id: "/Development/notes",
  label: "@notes",
  executionHost: "82e43596-21a8-43c2-afb3-a9d8f2b4bf85",
};

it("keeps folder references bounded and separate from recipients", () => {
  expect(composerToken(folder)).toEqual(folder);
  expect(composerTokenName(folder)).toBe("Folder @notes");
  for (const invalid of [
    { ...folder, id: "" },
    { ...folder, id: "x".repeat(4097) },
    { ...folder, id: "/path\u0000" },
    { ...folder, label: " " },
    { ...folder, label: "x".repeat(257) },
    { ...folder, label: "@\u202enotes" },
    { ...folder, extra: "界".repeat(3000) },
    { ...folder, kind: "nexus.unknown" },
  ])
    expect(composerToken(invalid)).toBeUndefined();
  expect(composerTokenDraft(folder)?.recipients).toEqual([]);
});

function mount(
  initial: MentionDraft | string = "Use @repo",
  maxLength = 16000,
) {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft(initial);
  let update!: (next: MentionDraft) => void;
  function Editor() {
    const [value, setValue] = useState(draft);
    update = setValue;
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
  return {
    input,
    view,
    draft: () => draft,
    sync(next: MentionDraft) {
      act(() => {
        draft = next;
        update(next);
      });
    },
  };
}

it("restores selected project metadata without editor text or a chip, and removes it through existing controls", () => {
  const project = {
    kind: "nexus.project" as const,
    id: "opaque-project",
    label: "Project",
  };
  const seeded = composerTokenDraft(project);
  expect(seeded).toBeDefined();
  const f = mount(mentionDraft(JSON.parse(JSON.stringify(seeded))));
  expect(f.input).toHaveValue("");
  expect(f.input.querySelector('[aria-label="Project Project"]')).toBeNull();
  expect(f.draft().tokens?.[0]?.token).toEqual(project);
  expect(f.draft().recipients).toEqual([]);
  act(() => f.input.insertText("Do work"));
  expect(f.draft().tokens?.[0]?.token).toEqual(project);
  act(() => {
    const span = f.draft().tokens?.[0];
    if (!span) throw new Error("Missing seeded token");
    expect(span.start).toBe(span.end);
    f.input.insertText("", undefined, span);
  });
  expect(f.draft().tokens).toBeUndefined();
  f.view.unmount();
  expect(
    mount(mentionDraft(JSON.parse(JSON.stringify(f.draft())))).draft().tokens,
  ).toBeUndefined();
});

it("consumes a project query atomically while preserving prose, other identities, caret, undo and recovery", () => {
  const project: ComposerToken = {
    kind: "nexus.project",
    id: "project-id",
    label: "#Project",
  };
  const f = mount("Before #query after ");
  act(() => {
    f.input.insertToken(token, {
      start: f.input.value.length,
      end: f.input.value.length,
    });
    f.input.insertText(
      "",
      { pubkey: "a".repeat(64), name: "Ada" },
      { start: 0, end: 0 },
    );
  });
  const before = f.input.value;
  const start = before.indexOf("#query");
  act(() => {
    expect(f.input.insertToken(project, { start, end: start + 6 })).toBe(true);
  });
  expect(f.input).toHaveValue(before.replace("#query", ""));
  expect(f.input).toHaveFocus();
  expect(f.input.selectionStart).toBe(start);
  expect(f.draft().tokens?.map((span) => span.token)).toEqual([project, token]);
  expect(f.draft().recipients.map((person) => person.pubkey)).toEqual([
    "a".repeat(64),
  ]);
  expect(composerMarkdown(f.draft())).not.toContain(project.label);
  act(() => f.input.undo(false));
  expect(f.input).toHaveValue(before);
  expect(
    f.draft().tokens?.some((span) => span.token.kind === "nexus.project"),
  ).toBe(false);
  act(() => f.input.undo(true));
  expect(f.input).toHaveValue(before.replace("#query", ""));
  const saved = mentionDraft(JSON.parse(JSON.stringify(f.draft())));
  f.view.unmount();
  const restored = mount(saved);
  expect(restored.input).toHaveValue(before.replace("#query", ""));
  expect(restored.draft().tokens?.map((span) => span.token)).toEqual([
    project,
    token,
  ]);
  const projectSpan = restored.draft().tokens?.[0];
  if (!projectSpan) throw new Error("Missing selected project");
  act(() => {
    restored.input.setSelectionRange(2, 4);
    expect(restored.input.insertText("#", undefined, projectSpan)).toBe(true);
  });
  expect(restored.input.value).toBe(
    `${before.slice(0, 2)}#${before.replace("#query", "").slice(2)}`,
  );
  expect(restored.draft().tokens?.map((span) => span.token)).toEqual([token]);
  expect(restored.input.insertText("", undefined, projectSpan)).toBe(false);
});

it("lifts historical project chips on reopen without changing prose or repository identity", () => {
  const project: ComposerToken = {
    kind: "nexus.project",
    id: "old-project",
    label: "#Old",
  };
  const doc = composerSchema.nodes.doc.create(
    null,
    composerSchema.nodes.paragraph.create(null, [
      composerSchema.text("Before "),
      composerSchema.nodes.token.create({
        source: project.label,
        semantic: project,
      }),
      composerSchema.text(" after "),
      composerSchema.nodes.token.create({
        source: token.label,
        semantic: token,
      }),
    ]),
  );
  const draft = mentionDraft({
    text: `Before #Old after ${token.label}`,
    recipients: [],
    document: { version: 1, content: doc.toJSON() },
  });
  const f = mount(draft);
  expect(f.input).toHaveValue(`Before  after ${token.label}`);
  expect(f.input.querySelector('[aria-label="Project #Old"]')).toBeNull();
  expect(f.draft().tokens?.map((span) => span.token)).toEqual([project, token]);
  expect(
    mentionDraft(JSON.parse(JSON.stringify(f.draft()))).tokens?.map(
      (span) => span.token,
    ),
  ).toEqual([project, token]);
});

it("retains project metadata through external sync and reset without putting it in the editor", () => {
  const first: ComposerToken = {
    kind: "nexus.project",
    id: "first",
    label: "First",
  };
  const second: ComposerToken = {
    kind: "nexus.project",
    id: "second",
    label: "Second",
  };
  const seeded = composerTokenDraft(first),
    next = composerTokenDraft(second);
  if (!seeded || !next) throw new Error("Missing project seed");
  const f = mount(seeded);
  f.sync(next);
  act(() => f.input.insertText("After sync"));
  expect(f.draft().tokens?.map((span) => span.token)).toEqual([second]);
  act(() => {
    f.input.reset(seeded);
    f.input.insertText("After reset");
  });
  expect(f.input).toHaveValue("After reset");
  expect(
    mentionDraft(JSON.parse(JSON.stringify(f.draft()))).tokens?.map(
      (span) => span.token,
    ),
  ).toEqual([first]);
});

it.each([token, folder])(
  "keeps $kind identity through typing, persistence, deletion and undo without recipients",
  (token) => {
    const f = mount();
    act(() => {
      expect(f.input.insertToken(token, { start: 4, end: 9 })).toBe(true);
    });
    expect(
      f.input.querySelector(`[aria-label="${composerTokenName(token)}"]`),
    ).toBeInTheDocument();
    expect(f.draft().recipients).toEqual([]);
    expect(f.draft().tokens?.[0]?.token).toEqual(token);
    act(() => {
      f.input.insertText("now");
    });
    expect(composerMarkdown(f.draft())).toBe(
      `Use ${token.label.replace("@", "&#64;")} now`,
    );
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
  },
);

it.each([token, folder])(
  "copies only $kind labels; pasting the label never creates semantic identity",
  (token) => {
    const f = mount();
    act(() => {
      f.input.insertToken(token, { start: 4, end: 9 });
    });
    const copied = composerClipboard(
      readComposerDocument(f.draft(), []),
      document,
    );
    expect(copied.text).toBe(`Use ${token.label} `);
    expect(copied.html).not.toContain("github.com");
    expect(copied.html).not.toContain(token.id);
    const pastedDocument = buzzCopyDocument(copied.html);
    if (!pastedDocument) throw new Error("Missing copied document");
    const pasted = mount(projectComposerDocument(pastedDocument).draft);
    expect(pasted.draft().tokens).toBeUndefined();
    expect(pasted.draft().recipients).toEqual([]);
  },
);

it.each([token, folder])(
  "rejects $kind insertion inside code and leaves the editor unchanged",
  (token) => {
    const f = mount("`@repo`");
    act(() => {
      expect(f.input.insertToken(token, { start: 1, end: 6 })).toBe(false);
    });
    expect(f.draft().text).toBe("`@repo`");
    expect(f.draft().tokens).toBeUndefined();
  },
);

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
