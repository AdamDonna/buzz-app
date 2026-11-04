import { createArtifactStore } from "../../src/features/artifact-storage/store";
import type {
  ArtifactCollectionDefinition,
  HostArtifactCollection,
} from "../../src/features/artifact-storage/types";
const stores: ReturnType<typeof createArtifactStore>[] = [];
const definition: ArtifactCollectionDefinition = {
  name: "tasks",
  type: "test.task",
  version: 1,
  project({ record, preference }) {
    const data = record.current
      ? JSON.parse(record.current.content)
      : record.local;
    const prefs = preference as
      | { archived?: boolean; pinned?: boolean }
      | undefined;
    const value = prefs?.archived ?? data?.archived ?? false;
    return [
      { index: "archive", value: String(value), order: record.id },
      { index: "pin", value: String(prefs?.pinned ?? false), order: record.id },
    ];
  },
};
const api = {
  open(
    viewer = "viewer",
    relay = "relay",
    owner = "test",
    overrides: Partial<ArtifactCollectionDefinition> = {},
  ) {
    const store = createArtifactStore(viewer, relay);
    stores.push(store);
    return store.collection(owner, { ...definition, ...overrides });
  },
  close() {
    for (const store of stores) store.close();
  },
};
declare global {
  interface Window {
    artifactTest: typeof api;
    communityArtifacts: {
      snapshot(): import("../../src/features/communities/service").ClientSnapshot;
      select(): void;
      join(): void;
      leave(purge: boolean): Promise<unknown>;
      open(): import("../../src/features/artifact-storage/types").ArtifactCollection;
      aborted(): boolean | undefined;
      saved(): Promise<
        | import("../../src/features/artifact-storage/types").ArtifactEntry
        | undefined
      >;
    };
    collection: HostArtifactCollection;
    change: Promise<unknown>;
  }
}
window.artifactTest = api;

if (new URL(location.href).searchParams.has("communities")) {
  const [{ Context }, { createCommunities }, { ArtifactStorageService }] =
    await Promise.all([
      import("@deepseek-ai/cordis"),
      import("../../src/features/communities/service"),
      import("../../src/features/artifact-storage/service"),
    ]);
  const viewer = "a".repeat(64);
  const membership = { id: "https://fixture.example", name: "Fixture" };
  const root = new Context();
  const communities = createCommunities(
    root,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  root.provide("communityReader", communities);
  const storage = new ArtifactStorageService(root);
  const plugin = root.extend({
    pluginOwner: { id: "test.plugin", revision: "one" },
  });
  let signal: AbortSignal | undefined;
  storage.onOpen((entry) => {
    signal = entry.signal;
  });
  window.communityArtifacts = {
    snapshot: communities.snapshot,
    select: () => communities.select(membership.id),
    join: () =>
      communities.joined(membership, { name: "Fixture", picture: "" }),
    leave: (purge: boolean) => communities.leave(membership.id, { purge }),
    open: () => plugin.artifactStorage.open(definition),
    aborted: () => signal?.aborted,
    async saved() {
      const collection = api.open(viewer, membership.id, "test.plugin");
      try {
        return await collection.get("task");
      } finally {
        collection.close();
      }
    },
  };
}
