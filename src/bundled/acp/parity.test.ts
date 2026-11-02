// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { launchKey, modelCache, picks } from "./models";
import { pickFor, threadIn } from "./runtime";
import { localSessions } from "./sessions";
import { syncedSettings, withSyncedSettings } from "./settings";

afterEach(() => localStorage.clear());

const launched = { ...DEFAULT_CONFIG, approval: "digest" };

describe("saved conversations", () => {
  it("writes a pointer only on advance, and drop keeps the listing", () => {
    const store = localSessions(localStorage, "agent");
    store.touch("c/r", 5);
    expect(store.load("c/r")).toEqual({ at: 5 });
    store.advance("c/r", {
      id: "s1",
      covered: { at: 10, ids: ["e1"] },
      context: "x",
      overridden: { model: false, effort: true },
    });
    expect(store.load("c/r")).toMatchObject({
      id: "s1",
      covered: { at: 10, ids: ["e1"] },
      context: "x",
    });
    store.advance("c/r", {
      id: "s1",
      covered: { at: 20, ids: ["e1", "e2"] },
      context: "ignored",
      overridden: { model: true, effort: false },
    });
    expect(store.load("c/r")).toMatchObject({
      covered: { at: 20, ids: ["e1", "e2"] },
      context: "x",
      overridden: { model: true, effort: true },
    });
    store.drop("c/r");
    expect(store.load("c/r")).toEqual({ at: 5 });
    expect(localSessions(localStorage, "other").list()).toEqual([]);
  });
});

describe("model cache", () => {
  const state = (current: string, efforts?: string[]) =>
    ({
      model: {
        id: "model",
        currentValue: current,
        options: [
          { value: "a", name: "A" },
          { value: "b", name: "B" },
        ],
      },
      ...(efforts && {
        effort: {
          id: "effort",
          currentValue: efforts[0],
          options: efforts.map((value) => ({ value, name: value })),
        },
      }),
    }) as never;

  it("keeps efforts per selected model and never borrows another's", () => {
    const cache = modelCache(localStorage);
    const key = launchKey(launched) as string;
    cache.record(key, state("a", ["low", "high"]));
    const shown = picks(cache, { ...launched, model: "b" }).models;
    expect(shown.map((m) => m.id)).toEqual(["a", "b"]);
    expect(shown[0]?.efforts.map((e) => e.id)).toEqual(["low", "high"]);
    expect(shown[1]?.efforts).toEqual([]);
  });

  it("shows nothing for an unconfirmed launch, and a models-only harness has no efforts", () => {
    const cache = modelCache(localStorage);
    expect(launchKey(DEFAULT_CONFIG)).toBeUndefined();
    expect(picks(cache, DEFAULT_CONFIG).models).toEqual([]);
    cache.record(launchKey(launched) as string, state("a"));
    expect(picks(cache, launched).models[0]?.efforts).toEqual([]);
  });
});

describe("turn picks", () => {
  it("lets a message's pick win and falls back to the pinned settings", () => {
    const pinned = { ...launched, model: "a", effort: "low" };
    expect(pickFor(pinned, { effort: "high" })).toEqual({
      pick: { model: "a", effort: "high" },
      source: { model: "device", effort: "message" },
    });
    expect(pickFor(launched, undefined)).toEqual({ pick: {}, source: {} });
  });
});

describe("synced settings", () => {
  it("round-trips preset, model, effort and scope and never the launch", () => {
    const value = {
      ...launched,
      preset: "cursor",
      model: "m",
      effort: "e",
      scope: "channel" as const,
      command: "/bin/evil",
    };
    const synced = syncedSettings(value);
    expect(Object.keys(synced).sort()).toEqual([
      "effort",
      "model",
      "preset",
      "scope",
    ]);
    const local = { ...launched, command: "cursor-agent", model: "old" };
    const merged = withSyncedSettings(local, synced);
    expect(merged).toMatchObject({
      model: "m",
      scope: "channel",
      command: "cursor-agent",
    });
  });

  it("resets a synced setting the accepted copy leaves out to the default", () => {
    const local = { ...launched, model: "mine", scope: "channel" as const };
    expect(withSyncedSettings(local, {})).toMatchObject({
      model: DEFAULT_CONFIG.model,
      scope: DEFAULT_CONFIG.scope,
    });
  });
});

it("reads the thread a channel-scoped prompt replied in", () => {
  const id = "a".repeat(64);
  expect(threadIn(`… pass \`reply: "${id}"\` …`)).toBe(id);
  expect(threadIn("no reply")).toBeUndefined();
});
