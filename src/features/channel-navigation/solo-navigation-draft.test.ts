// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSoloRegionFixture } from "./solo-navigation-testing";
import type { SoloTaskMode } from "./solo-navigation-contract";
import { soloDraft } from "./routes";
import { mentionDraft } from "../messages/mention-draft";
import { readView, subscribeView, writeView } from "../../shared/view-state";

const task: SoloTaskMode = {
  prepare: async () => ({ ok: false, reason: "fixture" }),
  markChannelStarted: async () => "start",
  recordFirstEvent: async () => {},
  participants: {
    eligible: () => true,
    defaultRecipient: () => undefined,
    makePrimary: async () => {},
  },
};
const project = { id: "opaque-project-id", label: "Selected project" };
const primary = "a".repeat(64);
const closes: (() => unknown)[] = [];
beforeEach(() => localStorage.clear());
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const h = createSoloRegionFixture();
  closes.push(h.dispose);
  const source = await h.register({ task });
  const open =
    vi.fn<(target: import("../navigation/targets").OpenTarget) => void>();
  let previous = h.navigator.snapshot().entry.target;
  closes.push(
    h.navigator.subscribe(() => {
      const target = h.navigator.snapshot().entry.target;
      if (target !== previous) open(target);
      previous = target;
    }),
  );
  return { ...h, source, open, stored: localStorage.length };
}

it("persists one copied semantic project on separate new draft identities before navigating", async () => {
  const h = await fixture();
  const selected = { ...project };
  h.source.handle.openDraft(h.source.binding(), {
    mode: "task",
    seed: { project: selected },
  });
  const target = h.open.mock.calls[0]?.[0];
  expect(target?.kind).toBe("page");
  if (target?.kind !== "page") throw new Error("Missing draft target");
  const route = soloDraft(target.route?.params);
  expect(route).toMatchObject({
    task: { region: h.source.handle.label },
  });
  expect(route?.agent).toBeUndefined();
  const key = `solo:task:${route?.task?.draftId}:new-draft`;
  selected.id = "mutated";
  const stored = mentionDraft(readView(h.scope, key, null));
  expect(stored.tokens?.map(({ token }) => token)).toEqual([
    { kind: "nexus.project", ...project },
  ]);
  expect(stored.recipients).toEqual([]);
  expect(readView("another-scope", key, null)).toBeNull();
  h.source.handle.openDraft(h.source.binding(), {
    mode: "task",
    seed: { project },
  });
  const next = h.open.mock.calls[1]?.[0];
  expect(next).not.toEqual(target);
  expect(mentionDraft(readView(h.scope, key, null))).toEqual(stored);
});

it("refuses combined project and primary seeds before allocating, writing or navigating", async () => {
  const h = await fixture();
  const uuid = vi.spyOn(crypto, "randomUUID");
  const save = vi.spyOn(Storage.prototype, "setItem");
  expect(() =>
    h.source.handle.openDraft(h.source.binding(), {
      mode: "task",
      // @ts-expect-error JavaScript callers must receive a runtime refusal too.
      seed: { primary, project },
    }),
  ).toThrow("cannot be combined");
  expect(uuid).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it.each([undefined, { primary }])(
  "preserves ordinary no-project seed %j",
  async (seed) => {
    const h = await fixture();
    h.source.handle.openDraft(h.source.binding(), {
      mode: "task",
      ...(seed ? { seed } : {}),
    });
    expect(h.open).toHaveBeenCalledOnce();
    const target = h.open.mock.calls[0]?.[0];
    if (target?.kind !== "page") throw new Error("Missing draft target");
    expect(soloDraft(target.route?.params)?.agent).toBe(seed?.primary);
    expect(localStorage.length).toBe(h.stored);
  },
);

it.each([
  null,
  {},
  { id: "", label: "Project" },
  { id: "p", label: "" },
  { id: "p\nq", label: "Project" },
  { id: "p", label: "x".repeat(257) },
])(
  "refuses malformed project %j without saving or navigating",
  async (invalid) => {
    const h = await fixture();
    expect(() =>
      h.source.handle.openDraft(h.source.binding(), {
        mode: "task",
        seed: { project: invalid as typeof project },
      }),
    ).toThrow("Invalid project");
    expect(h.open).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(h.stored);
  },
);

it("refuses an existing UUID draft rather than overwrite it", async () => {
  const h = await fixture();
  const id = "33333333-3333-4333-8333-333333333333";
  vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
  const key = `solo:task:${id}:new-draft`;
  writeView(h.scope, key, "Existing user draft");
  expect(() =>
    h.source.handle.openDraft(h.source.binding(), {
      mode: "task",
      seed: { project },
    }),
  ).toThrow("could not be saved");
  expect(readView(h.scope, key, null)).toBe("Existing user draft");
  expect(h.open).not.toHaveBeenCalled();
});

it.each(["throw", "readback"])(
  "refuses storage %s without navigation",
  async (failure) => {
    const h = await fixture();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      if (failure === "throw") throw new Error("Storage unavailable");
    });
    expect(() =>
      h.source.handle.openDraft(h.source.binding(), {
        mode: "task",
        seed: { project },
      }),
    ).toThrow("could not be saved");
    expect(h.open).not.toHaveBeenCalled();
  },
);

it("refuses an old binding before writing", async () => {
  const h = await fixture();
  const binding = h.source.binding();
  h.reconnect();
  expect(() =>
    h.source.handle.openDraft(binding, {
      mode: "task",
      seed: { project },
    }),
  ).toThrow("ended");
  expect(localStorage.length).toBe(h.stored);
  expect(h.open).not.toHaveBeenCalled();
});

it("rechecks binding when project validation re-enters the host", async () => {
  const h = await fixture();
  const binding = h.source.binding();
  const save = vi.spyOn(Storage.prototype, "setItem");
  const reentrant = {
    id: project.id,
    get label() {
      h.reconnect();
      return project.label;
    },
  };
  expect(() =>
    h.source.handle.openDraft(binding, {
      mode: "task",
      seed: { project: reentrant },
    }),
  ).toThrow("ended");
  expect(save).not.toHaveBeenCalled();
  expect(h.open).not.toHaveBeenCalled();
});

it("rechecks binding after synchronous draft-save subscribers invalidate it", async () => {
  const h = await fixture();
  const binding = h.source.binding();
  closes.push(subscribeView(h.scope, () => h.reconnect()));
  expect(() =>
    h.source.handle.openDraft(binding, {
      mode: "task",
      seed: { project },
    }),
  ).toThrow("ended");
  expect(localStorage.length).toBe(h.stored + 1);
  expect(h.open).not.toHaveBeenCalled();
});
