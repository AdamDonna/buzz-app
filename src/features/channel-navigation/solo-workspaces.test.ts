import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import { createSoloRegionFixture } from "./solo-navigation-testing";
import { keypair, signed } from "../relay/testing";
import { SOLO_LABEL } from "../solo/labels";
import { createSoloWorkspaces } from "./solo-workspaces";

it("projects the existing Solo catalog and writer, preserving uncertainty and fencing ended bindings", async () => {
  const binding = { scope: "community", viewer: "owner", incarnation: "first" };
  let sections = [{ id: "existing", name: "Existing", order: 0 }];
  let connected = true;
  let uncertain = true;
  const connectionListeners = new Set<() => void>();
  const store = createSidebarPreferencesStore({
    available: true,
    groupsOnly: true,
    read: async () => ({
      sections,
      assignments: { privateChat: "existing" },
      starred: [],
      muted: [],
    }),
    write: async () => {
      throw new Error("No assignment writes");
    },
    createSection: async ({ id, name }) => {
      if (!sections.some((section) => section.id === id))
        sections = [...sections, { id, name, order: sections.length }];
      if (uncertain) {
        uncertain = false;
        throw new Error("Confirmation lost");
      }
      return { sections, assignments: {}, starred: [], muted: [] };
    },
  });
  const preferences = Object.assign(
    Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(store.queries),
    ) as typeof store.queries,
    { setWorkspaceLead: async () => true },
  );
  const api = createSoloWorkspaces(
    (current) => (connected && current === binding ? preferences : undefined),
    (listener) => {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },
  );
  let notifications = 0;
  const stop = api.subscribe(binding, () => notifications++);
  try {
    expect(api.snapshot(binding).status).toBe("loading");
    await api.refresh(binding);
    const snapshot = api.snapshot(binding);
    expect(api.snapshot(binding)).toBe(snapshot);
    expect(snapshot).toEqual({
      status: "ready",
      workspaces: [{ id: "existing", name: "Existing" }],
      canCreate: true,
    });
    const creation = { id: "stable", name: "Demo" };
    await expect(api.create(binding, creation)).rejects.toThrow(
      "Confirmation lost",
    );
    // Reconciliation can discover an accepted write; retry retains its identity.
    await api.refresh(binding);
    await api.create(binding, creation);
    expect(api.snapshot(binding).workspaces).toEqual([
      { id: "existing", name: "Existing" },
      { id: "stable", name: "Demo" },
    ]);
    expect(notifications).toBeGreaterThan(0);
    connected = false;
    for (const listener of connectionListeners) listener();
    expect(api.snapshot(binding)).toMatchObject({
      status: "unavailable",
      workspaces: [],
      canCreate: false,
    });
    await expect(api.create(binding, { id: "no", name: "No" })).rejects.toThrow(
      "ended",
    );
    await expect(api.refresh(binding)).rejects.toThrow("ended");
  } finally {
    stop();
    store.dispose();
  }
  expect(connectionListeners.size).toBe(0);
});

it("resolves archived lead history and replaces only an authoritatively absent lead, fencing source ownership and binding", async () => {
  const h = createSoloRegionFixture();
  const relay = keypair();
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const label = "buzz.region:example:work";
  let lead = { region: label, channelId: first };
  const snapshot = () => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "work", name: "Work", order: 0, lead }],
      assignments: {},
      starred: [],
      muted: [],
    },
  });
  const save = vi.fn(async (input: { lead: typeof lead }) => {
    lead = input.lead;
  });
  let archived = false;
  let absent = false;
  let creator = h.session.viewer;
  let fail = false;
  const read = vi.fn(
    async (filters: readonly { "#d"?: readonly string[] }[]) => {
      if (fail) throw new Error("Network unavailable");
      const id = filters[0]?.["#d"]?.[0];
      if (absent && id === first) return [];
      return [
        signed(relay, {
          kind: 39000,
          tags: [
            ["d", id ?? ""],
            ["t", "stream"],
            ["t", SOLO_LABEL],
            ["t", label],
            ["P", creator],
            ["private"],
            ...(archived ? [["archived", "true"]] : []),
          ],
          content: "",
        }),
      ];
    },
  );
  Object.assign(h.session, {
    relayAuthor: relay.pubkey,
    snapshotRead: read,
    soloPreferences: {
      ...h.session.soloPreferences,
      snapshot,
      refresh: async () => {},
      setWorkspaceLead: save,
    },
  });
  const source = await h.register({
    task: {
      prepare: async () => ({ ok: false, reason: "Unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: () => false,
        defaultRecipient: () => undefined,
        makePrimary: async () => {},
      },
    },
  });
  try {
    expect(await source.handle.workspaceLead(source.binding(), "work")).toBe(
      first,
    );
    archived = true;
    expect(await source.handle.workspaceLead(source.binding(), "work")).toBe(
      first,
    );
    archived = false;
    expect(
      await source.handle.setWorkspaceLead(source.binding(), "work", second),
    ).toBe(first);
    expect(save).not.toHaveBeenCalled();
    fail = true;
    await expect(
      source.handle.workspaceLead(source.binding(), "work"),
    ).rejects.toThrow("Network unavailable");
    expect(save).not.toHaveBeenCalled();
    fail = false;
    absent = true;
    expect(
      await source.handle.workspaceLead(source.binding(), "work"),
    ).toBeUndefined();
    await source.handle.setWorkspaceLead(source.binding(), "work", second);
    expect(save).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: "work",
        lead: { region: label, channelId: second },
        expected: first,
      },
      expect.any(AbortSignal),
    );
    creator = "b".repeat(64);
    await expect(
      source.handle.workspaceLead(source.binding(), "work"),
    ).rejects.toThrow("your own task");
    expect(read.mock.calls[0]?.[0]).toEqual([
      {
        kinds: [39000],
        authors: [relay.pubkey],
        "#d": [first],
        consistency: "strong",
        limit: 1,
      },
    ]);
    h.loseCoordinates();
    await expect(
      source.handle.workspaceLead(source.binding(), "work"),
    ).rejects.toThrow("ended");
  } finally {
    await h.dispose();
  }
});
