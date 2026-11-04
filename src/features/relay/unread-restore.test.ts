import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import type { InboxItem } from "./inbox";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { keypair, signed, type Key } from "./testing";
import { memoryThreadFollows } from "./thread-follows";
import { createUnread } from "./unread";
import { memoryUnreadStorage, type UnreadStorage } from "./unread-storage";

// Unit tests get a no-op recorder; this one records restore verification.
const cpu = vi.hoisted(() => vi.fn());
vi.mock("../developer/client-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../developer/client-metrics")>();
  return { ...actual, clientMetrics: { ...actual.clientMetrics, cpu } };
});

// What a relaunch restores of the saved evidence, and what a save keeps
// (design §3.2). Events are signed: restore verifies them again.
const viewerKey = keypair();
const peerKey = keypair();
const viewer = viewerKey.pubkey;
const T = 1_000_000;
const NOW = (T + 100_000) * 1000;
const post = (
  key: Key,
  channelId: string,
  created_at: number,
  tags: string[][] = [],
  content = `${channelId} ${created_at}`,
) =>
  signed(key, {
    kind: 9,
    content,
    created_at,
    tags: [["h", channelId], ...tags],
  });
const reply = (
  key: Key,
  channelId: string,
  root: RelayEvent,
  created_at: number,
  tags: string[][] = [],
) => post(key, channelId, created_at, [["e", root.id, "", "reply"], ...tags]);
const deletion = (key: Key, channelId: string, target: RelayEvent) =>
  signed(key, {
    kind: 5,
    content: "",
    created_at: target.created_at + 1,
    tags: [
      ["h", channelId],
      ["e", target.id],
    ],
  });
// Read traffic newer than everything else: the roster sample is these alone.
const busy = Array.from({ length: 500 }, (_, i) =>
  post(peerKey, "busy", T + 50_000 + i),
);
const BUSY_READ = { busy: T + 60_000 };

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});

/** One launch against a relay holding `store`: its query returns each
 * filter's newest matches, leaves deleted events out, and, as the relay
 * does, attaches edits and deletions only to top-level and depth-limited
 * reads, which the repair does not send. `down` fails every evidence read,
 * `fail` the ones it matches. */
async function launch({
  store,
  storage,
  frontiers = {},
  follows = memoryThreadFollows(),
  roster = ["team", "quiet", "dm", "busy"].map(
    (id): ChannelSummary => ({
      id,
      name: id,
      members: [viewer],
      ...(id === "dm" ? { channelType: "dm" as const } : {}),
    }),
  ),
  down = false,
  fail = () => false,
}: {
  store: readonly RelayEvent[];
  storage: UnreadStorage;
  frontiers?: Readonly<Record<string, number>>;
  follows?: ReturnType<typeof memoryThreadFollows>;
  roster?: readonly ChannelSummary[];
  down?: boolean;
  fail?: (filters: readonly ReadFilter[]) => boolean;
}) {
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  let held: Promise<void> | undefined;
  let waiting: (filters: readonly ReadFilter[]) => void = () => {};
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        if (held) waiting(filters);
        await held;
        if (down || fail(filters)) throw new Error("Relay read timed out");
      }
      const removed = new Set(
        store.flatMap((other) =>
          other.kind === 5
            ? other.tags.flatMap(([tag, id]) =>
                tag === "e" ? [`${other.pubkey}:${id}`] : [],
              )
            : [],
        ),
      );
      const deleted = (item: RelayEvent) =>
        removed.has(`${item.pubkey}:${item.id}`);
      return filters.flatMap((filter) => {
        const matched = store
          .filter(
            (item) =>
              !deleted(item) &&
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.since === undefined || item.created_at >= filter.since) &&
              (filter.until === undefined ||
                item.created_at < filter.until ||
                (item.created_at === filter.until &&
                  item.id > (filter.before_id ?? ""))) &&
              (!filter["#h"] || tagged(item, "h", filter["#h"])) &&
              (!filter["#e"] || tagged(item, "e", filter["#e"])),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        const ids = matched.map((item) => item.id);
        return filter.include_aux &&
          (filter.top_level || filter.depth_limit !== undefined)
          ? [
              ...matched,
              ...store.filter(
                (item) =>
                  (item.kind === 5 || item.kind === 40003) &&
                  tagged(item, "e", ids),
              ),
            ]
          : matched;
      });
    }),
  };
  let journal: ReadJournal | undefined = {
    ...newReadJournal(),
    state: { frontiers, overrides: {} },
  };
  const reads = createReadState({
    floor: () => 0,
    viewer,
    reader,
    host: undefined,
    storage: {
      async update(change) {
        journal = readJournal(change(journal), viewer);
        return journal;
      },
      close() {},
    },
  });
  await reads.ready;
  let list = roster;
  const listeners = new Set<() => void>();
  const channels: ChannelQueries = {
    list: () => ({ status: "ready" as const, channels: list }),
    subscribeList(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    window() {
      throw new Error("Unread must not inspect windows");
    },
    subscribeWindow() {
      throw new Error("Unread must not subscribe to windows");
    },
    ensureList() {},
    ensure() {},
    loadOlder() {},
  };
  // Barriers. Restore reports each verified batch and admits the evidence
  // right after the last, so the reported count reaching the record's is the
  // moment it is in. A save waits for restore and the reconciles behind it,
  // so the session's first save, landed, is past both when online.
  let verified = 0;
  const verifying: [number, () => void][] = [];
  cpu.mockImplementation((stage: string, _ms: number, count: number) => {
    if (stage !== "verify.restore") return;
    verified += count;
    for (const waiter of [...verifying])
      if (verified >= waiter[0]) {
        verifying.splice(verifying.indexOf(waiter), 1);
        waiter[1]();
      }
  });
  let issued: (landed: Promise<void>) => void = () => {};
  const firstSave = new Promise<void>((resolve) => {
    issued = resolve;
  });
  // A test of a refused save may never await it.
  firstSave.catch(() => {});
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer,
    follows,
    // Spies a test puts on `storage` later still see each call.
    storage: {
      read: () => storage.read(),
      save(record) {
        const landed = storage.save(record);
        issued(landed);
        return landed;
      },
      close: () => storage.close(),
    },
    now: () => NOW,
  });
  owners.push(owner);
  return {
    owner,
    reader,
    /** Resolves once restore has admitted a record of `count` events. */
    restored(count: number) {
      return new Promise<void>((resolve) => {
        if (verified >= count) resolve();
        else verifying.push([count, resolve]);
      });
    },
    /** The session's first save, landed. */
    saved: firstSave,
    /** Resolves once the Inbox publishes a row that `matches`. */
    inboxed(matches: (item: InboxItem) => boolean) {
      return new Promise<void>((resolve) => {
        const check = () => {
          if (!owner.capability.inbox().items.some(matches)) return;
          stop();
          resolve();
        };
        const stop = owner.capability.subscribeInbox(check);
        check();
      });
    },
    rows: () =>
      owner.capability
        .inbox()
        .items.map(({ id, messageIds, unreadCount, preview }) => ({
          id,
          messageIds,
          unreadCount,
          preview,
        })),
    count: (channelId: string) =>
      owner.capability.snapshot({ kind: "channel", channelId }).observedCount,
    /** Evidence reads wait until `release`; `waiting` resolves with the
     * first that does. */
    hold() {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      const first = new Promise<readonly ReadFilter[]>((resolve) => {
        waiting = resolve;
      });
      return { release, waiting: first };
    },
    roster(next: readonly ChannelSummary[]) {
      list = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const saved = async (storage: UnreadStorage) =>
  ((await storage.read())?.events ?? []).map(
    (event) => (event as RelayEvent).id,
  );

it("a relaunch that reads only storage shows every row and count the warm repair shows", async () => {
  const storage = memoryUnreadStorage();
  const follows = memoryThreadFollows();
  // A lost thread, as in #buzz-team: the viewer replied long ago, and only
  // the thread reads reach it; its unread answer was edited.
  const lost = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", lost, T + 1);
  const answer = reply(peerKey, "team", lost, T + 2);
  const edit = signed(peerKey, {
    kind: 40003,
    content: "edited",
    created_at: T + 3,
    tags: [
      ["h", "team"],
      ["e", answer.id],
    ],
  });
  // A read mention in a thread the viewer is not part of, which the
  // mention feed delivered.
  const asked = post(peerKey, "team", T + 10);
  const mention = reply(peerKey, "team", asked, T + 11, [["p", viewer]]);
  // A thread the viewer follows.
  const followed = post(peerKey, "team", T + 20);
  const followedReply = reply(peerKey, "team", followed, T + 21);
  follows.write(new Map([[`team:${followed.id}`, true]]));
  // A quiet channel's unread top-level message, and a DM.
  const quiet = post(peerKey, "quiet", T + 30);
  const direct = post(peerKey, "dm", T + 40);
  // A thread the viewer started long ago, whose answer arrived live: later,
  // only the thread reads reach the viewer's root, which makes it theirs.
  const begun = post(viewerKey, "team", T + 50);
  const answered = reply(peerKey, "team", begun, T + 51);
  // R1: an unread reply below the channel's catch-up mark, in a thread the
  // viewer started, which only the roster sample reads.
  const started = post(viewerKey, "team", T + 90_000);
  const r1 = reply(peerKey, "team", started, T + 90_001);
  const store = [
    lost,
    mine,
    answer,
    edit,
    asked,
    mention,
    followed,
    followedReply,
    quiet,
    direct,
    begun,
    answered,
    ...busy,
    started,
    r1,
  ];
  const frontiers = {
    ...BUSY_READ,
    quiet: T + 25,
    "activity:team": T + 95_000,
    [`msg:${mention.id}`]: T + 11,
  };
  // A fresh launch, then a warm one, against the relay. The repair's reads
  // carry no edits: this one arrived live, once its target was read.
  const fresh = await launch({ store, storage, frontiers, follows });
  fresh.owner.accept([asked, mention, answered]);
  await fresh.owner.capability.ensure();
  fresh.owner.accept([edit]);
  await fresh.owner.capability.refresh();
  fresh.owner.dispose();
  const warm = await launch({ store, storage, frontiers, follows });
  await warm.owner.capability.ensure();
  await warm.saved;
  const expected = [
    { rootId: lost.id, unreadCount: 1, preview: "edited" },
    { rootId: asked.id, unreadCount: 0 },
    { rootId: followed.id, unreadCount: 1 },
    { rootId: begun.id, unreadCount: 1 },
    { rootId: started.id, unreadCount: 1 },
    { channelId: "dm", unreadCount: 1 },
  ];
  expect(warm.owner.capability.inbox().items).toEqual(
    expect.arrayContaining(expected.map((row) => expect.objectContaining(row))),
  );
  expect(warm.count("quiet")).toBe(1);
  expect(warm.count("team")).toBe(4);
  const rows = warm.rows();
  const shown = rows.flatMap((row) => row.messageIds);
  expect(await saved(storage)).toEqual(expect.arrayContaining(shown));
  warm.owner.dispose();
  // The relay cannot be read: the rows and counts come from storage alone,
  // verified as the channel heads' restore is.
  const count = (await saved(storage)).length;
  const offline = await launch({
    store,
    storage,
    frontiers,
    follows,
    down: true,
  });
  await offline.owner.capability.ensure();
  await offline.restored(count);
  expect(offline.rows()).toEqual(expect.arrayContaining(rows));
  expect(offline.count("quiet")).toBe(1);
  expect(offline.count("team")).toBe(4);
});

it("a tampered event discards the restored evidence, keeping the threads the repair reads again", async () => {
  const saving = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const store = [root, mine, answer, post(peerKey, "quiet", T + 3)];
  const first = await launch({ store, storage: saving });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(saving)).toContain(answer.id);
  // Storage changed one event's content after it was signed.
  const storage: UnreadStorage = {
    ...saving,
    async read() {
      const record = await saving.read();
      return (
        record && {
          ...record,
          events: record.events.map((event) =>
            (event as RelayEvent).id === answer.id
              ? { ...(event as RelayEvent), content: "tampered" }
              : event,
          ),
        }
      );
    },
  };
  const offline = await launch({ store, storage, down: true });
  await offline.owner.capability.ensure();
  // Nothing is restored, not even the events that verify. A record of at
  // most eight events is verified in one batch, within the launch's storage
  // read, so the repair that just ended is past it.
  expect(offline.rows()).toEqual([]);
  expect(offline.count("quiet")).toBeNull();
  offline.owner.dispose();
  const online = await launch({ store, storage });
  await online.owner.capability.ensure();
  expect(online.reader.read.mock.calls.flat(2)).toContainEqual(
    expect.objectContaining({ "#h": ["team"], "#e": [root.id] }),
  );
  expect(online.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

it("restored evidence the relay no longer returns, deleted while this device was closed, is dropped", async () => {
  const storage = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answers = Array.from({ length: 10 }, (_, i) =>
    reply(peerKey, "team", root, T + 2 + i),
  );
  const [gone, alsoGone] = answers as [RelayEvent, RelayEvent];
  const store = [root, mine, ...answers];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([gone.id, alsoGone.id]),
  );
  const thread = (owner: Awaited<ReturnType<typeof launch>>) =>
    owner.owner.capability.inbox().items.find((item) => item.rootId === root.id)
      ?.messageIds;
  // Reads that land while the evidence is still being verified.
  store.push(deletion(peerKey, "team", gone));
  const early = await launch({ store, storage });
  await early.owner.capability.ensure();
  await early.saved;
  expect(thread(early)).toContain(answers.at(-1)?.id);
  expect(thread(early)).not.toContain(gone.id);
  expect(await saved(storage)).not.toContain(gone.id);
  early.owner.dispose();
  // Reads that land once it is in.
  store.push(deletion(peerKey, "team", alsoGone));
  const count = (await saved(storage)).length;
  const late = await launch({ store, storage });
  const { release } = late.hold();
  const repair = late.owner.capability.ensure();
  try {
    await late.restored(count);
    expect(thread(late)).toContain(alsoGone.id);
  } finally {
    release();
  }
  await repair;
  expect(thread(late)).not.toContain(alsoGone.id);
  expect(thread(late)).toContain(answers.at(-1)?.id);
});

it("restored evidence of a channel whose membership is not confirmed yet waits for it, and is saved meanwhile", async () => {
  const storage = memoryUnreadStorage();
  const direct = post(peerKey, "dm", T);
  const store = [direct, post(peerKey, "team", T + 1)];
  const channels = (cached: boolean) => [
    { id: "team", name: "team", members: [viewer] },
    {
      id: "dm",
      name: "dm",
      members: [viewer],
      channelType: "dm" as const,
      ...(cached ? { cached: true as const } : {}),
    },
  ];
  const first = await launch({ store, storage, roster: channels(false) });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toContain(direct.id);
  // The roster starts from the downloaded membership; the repair reads, and
  // saves, the confirmed channel alone.
  const next = await launch({
    store: store.slice(1),
    storage,
    roster: channels(true),
  });
  await next.owner.capability.ensure();
  await next.saved;
  expect(await saved(storage)).toContain(direct.id);
  next.roster(channels(false));
  expect(next.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ channelId: "dm", messageIds: [direct.id] }),
  );
});

it("a root a lookup fetched stays structure on every relaunch: it groups the mention and never counts", async () => {
  const storage = memoryUnreadStorage();
  // Older than the window's week, in a channel the viewer never opened:
  // only the structure lookup of a read mention that arrived live fetches it.
  const old = post(peerKey, "team", T - 600_000);
  const mention = reply(peerKey, "team", old, T + 10, [["p", viewer]]);
  const store = [old, ...busy];
  const frontiers = { ...BUSY_READ, [`msg:${mention.id}`]: T + 10 };
  const row = expect.objectContaining({ rootId: old.id, unreadCount: 0 });
  const first = await launch({ store, storage, frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  store.push(mention);
  first.owner.accept([mention]);
  await first.inboxed((item) => item.rootId === old.id);
  const save = vi.spyOn(storage, "save");
  await first.owner.capability.refresh();
  expect(save).toHaveBeenCalled();
  await save.mock.results.at(-1)?.value;
  expect(first.owner.capability.inbox().items).toContainEqual(row);
  expect(first.count("team")).toBe(0);
  expect(first.owner.event(old.id)).toBeUndefined();
  const record = await storage.read();
  assert(record);
  expect(record.structure).toEqual(new Set([old.id]));
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([old.id, mention.id]),
  );
  first.owner.dispose();
  // Online, the mention taught the pass its thread, whose read fetches the
  // root by ID.
  const online = await launch({ store, storage, frontiers });
  await online.owner.capability.ensure();
  await online.saved;
  expect(online.owner.capability.inbox().items).toContainEqual(row);
  expect(online.count("team")).toBe(0);
  expect(online.owner.event(old.id)).toBeUndefined();
  online.owner.dispose();
  // Offline, restore puts the root back before it admits the mention, so no
  // published Inbox shows the mention outside its thread.
  const offline = await launch({ store, storage, frontiers, down: true });
  const ungrouped: unknown[] = [];
  offline.owner.capability.subscribeInbox(() => {
    const items = offline.owner.capability.inbox().items;
    if (
      offline.owner.event(mention.id) &&
      !items.some((item) => item.rootId === old.id)
    )
      ungrouped.push(items);
  });
  await offline.owner.capability.ensure();
  await offline.restored(record.events.length);
  expect(ungrouped).toEqual([]);
  expect(offline.owner.capability.inbox().items).toContainEqual(row);
  expect(offline.count("team")).toBe(0);
  expect(offline.owner.event(old.id)).toBeUndefined();
});

it("a cache clear wipes the saved record, including what the launch was still reading", async () => {
  const storage = memoryUnreadStorage();
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const answer = reply(peerKey, "team", root, T + 2);
  const store = [root, mine, answer];
  const first = await launch({ store, storage });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  expect(await saved(storage)).toContain(answer.id);
  // The clear lands while the launch's storage read is in flight.
  let release = () => {};
  const reading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await launch({
    store,
    storage: {
      ...storage,
      async read() {
        const record = await storage.read();
        await reading;
        return record;
      },
    },
    down: true,
  });
  const repair = h.owner.capability.ensure();
  const wiped = h.owner.clear();
  release();
  await repair.catch(() => {});
  await wiped;
  expect(h.owner.capability.inbox().items).toEqual([]);
  expect(await storage.read()).toEqual({
    participation: { roots: new Map() },
    events: [],
    structure: new Set(),
  });
});
