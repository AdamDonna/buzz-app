import { getEventHash, verifiedSymbol } from "nostr-tools";
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
import {
  browserUnreadStorage,
  memoryUnreadStorage,
  UNREAD_RECORD_BYTES,
  UNREAD_RECORD_EVENTS,
  type UnreadStorage,
} from "./unread-storage";
import { memoryIndexedDB } from "./unread-storage-testing";

// Unit tests get a no-op recorder; this one records restore verification
// and each repair pass.
const cpu = vi.hoisted(() => vi.fn());
const unreadPass = vi.hoisted(() => vi.fn());
vi.mock("../developer/client-metrics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../developer/client-metrics")>();
  return {
    ...actual,
    clientMetrics: { ...actual.clientMetrics, cpu, unreadPass },
  };
});
// Restore yields between its batches; a test may hold it there.
const restoreHold = vi.hoisted(() => ({
  held: undefined as Promise<void> | undefined,
}));
vi.mock("./yield", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./yield")>();
  return {
    yieldToHost: async () => {
      await restoreHold.held;
      return actual.yieldToHost();
    },
  };
});
/** Holds restore at its next yield until `release`. */
function holdRestore() {
  let release = () => {};
  restoreHold.held = new Promise((resolve) => {
    release = () => {
      restoreHold.held = undefined;
      resolve();
    };
  });
  return release;
}

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
// The delta reads these kinds of each 128 channels, from the mark less
// 1,865 s; the read of deletions reads the last three.
const DELTA_KINDS = [9, 40002, 40008, 40003, 5, 9005];
const deltaRead = (filters: readonly ReadFilter[]) =>
  filters.some((filter) => filter.kinds?.join() === DELTA_KINDS.join());
// The device clock, in seconds.
const SECONDS = NOW / 1000;
let hashes = 0;
/** An event the relay returns and no restore verifies: hashed, not signed. */
const hashed = (
  channelId: string,
  created_at: number,
  kind = 9,
  tags: string[][] = [],
  pubkey = peerKey.pubkey,
): RelayEvent => {
  const template = {
    kind,
    pubkey,
    created_at,
    content: `${channelId} ${created_at} ${hashes++}`,
    tags: [["h", channelId], ...tags],
  };
  return {
    ...template,
    id: getEventHash(template),
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
};

const ROSTER = ["team", "quiet", "dm", "busy"];
/** The bytes of a request's filters, which the reader caps at 64 KiB. */
const requestBytes = (filters: readonly ReadFilter[]) =>
  new TextEncoder().encode(JSON.stringify(filters)).byteLength;
const summaries = (ids: readonly string[]) =>
  ids.map(
    (id): ChannelSummary => ({
      id,
      name: id,
      members: [viewer],
      ...(id === "dm" ? { channelType: "dm" as const } : {}),
    }),
  );

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  restoreHold.held = undefined;
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** One launch against a relay holding `store`: its query returns each
 * filter's newest matches, leaves deleted events out, matches an event with
 * no `h` tag to `#h` by its target's channel, and, as the relay does,
 * attaches edits and deletions only to top-level and depth-limited
 * reads, which the repair does not send. Like the reader, it refuses a
 * request over 64 KiB of filters. `down` fails every evidence read (the
 * repair's, the delta's and the read of deletions), `fail` the ones it
 * matches; `now` is the device clock, and `rosterSettled` says whether the
 * channel list is the relay's whole answer. */
async function launch({
  store,
  storage,
  frontiers = {},
  follows = memoryThreadFollows(),
  roster = summaries(ROSTER),
  down = false,
  fail = () => false,
  now = () => NOW,
  rosterSettled = () => true,
}: {
  store: readonly RelayEvent[];
  storage: UnreadStorage;
  frontiers?: Readonly<Record<string, number>>;
  follows?: ReturnType<typeof memoryThreadFollows>;
  roster?: readonly ChannelSummary[];
  down?: boolean;
  fail?: (filters: readonly ReadFilter[]) => boolean;
  now?: () => number;
  rosterSettled?: () => boolean;
}) {
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  const filedUnder = (item: RelayEvent): string[] => {
    const own = item.tags.flatMap(([tag, value]) =>
      tag === "h" && value ? [value] : [],
    );
    if (own.length) return own;
    const target = store.find((other) => tagged(item, "e", [other.id]));
    return target ? filedUnder(target) : [];
  };
  let held: Promise<void> | undefined;
  let waiting: (filters: readonly ReadFilter[]) => void = () => {};
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      if (requestBytes(filters) > 64 * 1024)
        throw new Error("Relay filters exceed the request budget");
      if (
        filters.some(
          (filter) => filter.kinds?.includes(9) || filter.kinds?.includes(5),
        )
      ) {
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
              (!filter["#h"] ||
                filedUnder(item).some((id) => filter["#h"]?.includes(id))) &&
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
      save(record, options) {
        const landed = storage.save(record, options);
        issued(landed);
        return landed;
      },
      close: () => storage.close(),
    },
    now,
    rosterSettled,
  });
  owners.push(owner);
  /** Evidence reads wait until `release`; `waiting` resolves with the first
   * that does. */
  function hold() {
    let release = () => {};
    held = new Promise((resolve) => {
      release = resolve;
    });
    const first = new Promise<readonly ReadFilter[]>((resolve) => {
      waiting = resolve;
    });
    return { release, waiting: first };
  }
  return {
    owner,
    reader,
    reads,
    /** How many restored events have been verified: restore admits them
     * once all have. */
    verified: () => verified,
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
    hold,
    /** A reconnect's pass, from its first evidence read to its end. */
    async reconnected() {
      const { release, waiting } = hold();
      try {
        owner.reconnect();
        await waiting;
        const pass = owner.capability.ensure();
        release();
        await pass;
      } finally {
        release();
      }
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
  expect((await storage.read())?.complete).toBe(true);
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
  expect(await saving.read()).toMatchObject({
    complete: true,
    mark: { checked: SECONDS },
  });
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
  // Its mark no longer vouches for what the session holds: the launch reads
  // the bootstrap, not the delta.
  expect(deltas(online)).toEqual([]);
  expect(online.reader.read.mock.calls.flat(2)).toContainEqual(
    expect.objectContaining({ "#h": ["team"], "#e": [root.id] }),
  );
  expect(online.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

it("a selection over the record's bounds, or one retention dropped, saves an incomplete record", async () => {
  // Unread messages larger together than the record's byte bound.
  const large = (key: Key, channelId: string, at: number) =>
    post(key, channelId, at, [], "x".repeat(UNREAD_RECORD_BYTES / 4));
  const over = memoryUnreadStorage();
  const many = Array.from({ length: 5 }, (_, i) =>
    large(peerKey, "quiet", T + i),
  );
  const first = await launch({ store: many, storage: over });
  await first.owner.capability.ensure();
  expect(first.count("quiet")).toBe(5);
  await first.saved;
  expect(await over.read()).toMatchObject({ events: [], complete: false });
  // The viewer's message, which the authored page returns, is refused room:
  // traffic that arrived during the repair filled the byte budget with newer
  // evidence of its channel. The page selects it, so the record is not
  // complete without it.
  const dropped = memoryUnreadStorage();
  const authored = large(viewerKey, "archive", T - 700_000);
  const later = Array.from({ length: 9 }, (_, i) =>
    large(peerKey, "archive", T - 690_000 + i),
  );
  const second = await launch({
    store: [authored, ...busy],
    storage: dropped,
    frontiers: {
      ...BUSY_READ,
      ...Object.fromEntries(
        later.map((event) => [`msg:${event.id}`, event.created_at]),
      ),
    },
    roster: ["archive", "busy"].map((id) => ({
      id,
      name: id,
      members: [viewer],
    })),
  });
  const { release, waiting } = second.hold();
  const repair = second.owner.capability.ensure();
  try {
    expect(await waiting).toContainEqual(
      expect.objectContaining({ authors: [viewer] }),
    );
    second.owner.accept(later);
  } finally {
    release();
  }
  await repair;
  expect(second.owner.event(authored.id)).toBeUndefined();
  await second.saved;
  expect((await dropped.read())?.events).toHaveLength(busy.length);
  expect((await dropped.read())?.complete).toBe(false);
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

it("a warm launch reads only the delta, shows the restored rows before the relay answers, and loads and observes channels once restore and the delta's first page are in", async () => {
  const storage = memoryUnreadStorage();
  // The lost thread: the viewer replied long ago, and only the thread reads
  // reach it. Beside it, more unread DMs than restore verifies at once.
  const lost = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", lost, T + 1);
  const answer = reply(peerKey, "team", lost, T + 2);
  const direct = Array.from({ length: 9 }, (_, i) =>
    post(peerKey, "dm", T + 10 + i),
  );
  // A read channel's unread message, older than the delta reaches.
  const unread = post(peerKey, "quiet", T - 5000);
  const frontiers = { quiet: T - 10_000 };
  const store = [lost, mine, answer, unread, ...direct];
  const first = await launch({ store, storage, frontiers });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const record = await storage.read();
  assert(record?.mark);
  expect(record.complete).toBe(true);
  const count = record.events.length;
  expect(count).toBeGreaterThan(8);
  const delta = {
    kinds: DELTA_KINDS,
    "#h": ROSTER,
    since: record.mark.at - 1865,
    limit: 500,
  };
  const rows = [
    expect.objectContaining({ rootId: lost.id, unreadCount: 1 }),
    expect.objectContaining({ channelId: "dm", unreadCount: 9 }),
  ];
  // The relay holds its answer: restore alone shows the rows.
  const held = await launch({ store, storage, frontiers });
  const network = held.hold();
  try {
    const launched = held.owner.capability.ensure();
    expect(await network.waiting).toEqual([delta]);
    await held.restored(count);
    expect(held.owner.capability.inbox()).toMatchObject({
      status: "loading",
      items: expect.arrayContaining(rows),
    });
    network.release();
    await launched;
  } finally {
    network.release();
  }
  held.owner.dispose();
  // Restore is held instead: the delta's page lands, with a reply sent
  // while this device was closed, and the Inbox still waits for restore.
  const later = reply(peerKey, "team", lost, T + 30);
  store.push(later);
  const release = holdRestore();
  const slow = await launch({ store, storage, frontiers });
  try {
    const launched = slow.owner.capability.ensure();
    await vi.waitFor(() => expect(slow.owner.event(later.id)).toBeDefined());
    expect(slow.verified()).toBeLessThan(count);
    expect(slow.owner.capability.inbox().status).toBe("loading");
    // A channel the delta read to its end counts the record too: it is not
    // observed, with nothing unread, while the record's unread is not in.
    expect(
      slow.owner.capability.snapshot({ kind: "channel", channelId: "quiet" }),
    ).toMatchObject({ coverage: "unknown" });
    release();
    await slow.restored(count);
    await launched;
  } finally {
    release();
  }
  expect(slow.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    items: expect.arrayContaining([
      expect.objectContaining({ rootId: lost.id, unreadCount: 2 }),
      rows[1],
    ]),
  });
  expect(slow.count("quiet")).toBe(1);
  expect(slow.reader.read.mock.calls).toEqual([[[delta], expect.anything()]]);
  await slow.saved;
  expect(await storage.read()).toMatchObject({
    complete: true,
    mark: { at: later.created_at, checked: SECONDS },
  });
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
    complete: false,
  });
});

/** A record that holds no evidence, complete, with `mark` covering
 * `roster`. */
async function marked(
  mark: { at: number; checked: number },
  roster: readonly string[] = ROSTER,
) {
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: { roots: new Map() },
    events: [],
    structure: new Set(),
    complete: true,
    mark,
    roster: new Set(roster),
  });
  return storage;
}
const members = (ids: readonly string[]) =>
  ids.map((id): ChannelSummary => ({ id, name: id, members: [viewer] }));
const sampleFilter = (filter: ReadFilter) =>
  !!filter["#h"] && filter.since === undefined && !filter["#e"];
// The roster sample fails where a test isolates the mark a delta confirms
// from the one the bootstrap's sample confirms.
const sampleRead = (filters: readonly ReadFilter[]) =>
  filters.some(sampleFilter);
type Launch = Awaited<ReturnType<typeof launch>>;
const deltas = (h: Launch) =>
  h.reader.read.mock.calls.flatMap(([filters]) =>
    deltaRead(filters) ? filters : [],
  );
/** What each delta page returned, in the order they were asked for. */
const deltaPages = (h: Launch) =>
  Promise.all(
    h.reader.read.mock.calls.flatMap(([filters], index) =>
      deltaRead(filters) ? [h.reader.read.mock.results[index]?.value] : [],
    ),
  ) as Promise<RelayEvent[][]>;

it("the delta reads each 128 channels of the roster from the mark less 1,865 s, paging across a second's ties to a short page", async () => {
  const ids = Array.from({ length: 130 }, (_, i) => `c${i}`);
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 }, ids);
  // More events in one second than a page holds.
  const tied = Array.from({ length: 600 }, () => hashed("c0", at + 30));
  const h = await launch({ store: tied, storage, roster: members(ids) });
  await h.owner.capability.ensure();
  const page = (part: readonly string[]) => ({
    kinds: DELTA_KINDS,
    "#h": part,
    since: at - 1865,
    limit: 500,
  });
  const byId = [...tied].sort((a, b) => a.id.localeCompare(b.id));
  expect(deltas(h)).toEqual([
    page(ids.slice(0, 128)),
    page(ids.slice(128)),
    { ...page(ids.slice(0, 128)), until: at + 30, before_id: byId[499]?.id },
  ]);
  // Every event of the second, none twice.
  const read = (await deltaPages(h)).flat();
  expect(read).toHaveLength(600);
  expect(new Set(read.map(({ id }) => id))).toEqual(
    new Set(tied.map(({ id }) => id)),
  );
  await h.saved;
  expect((await storage.read())?.mark).toEqual({
    at: at + 30,
    checked: SECONDS,
  });
});

it("an event committed after a delta, dated 1,800 s before the mark it confirmed, is read by the next delta", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 });
  const store = [hashed("team", at + 100)];
  const h = await launch({ store, storage, fail: sampleRead });
  await h.owner.capability.ensure();
  expect(deltas(h)).toEqual([expect.objectContaining({ since: at - 1865 })]);
  const late = hashed("quiet", at + 100 - 1800);
  store.push(late);
  await h.reconnected();
  expect(deltas(h).at(-1)).toEqual(
    expect.objectContaining({ since: at + 100 - 1865 }),
  );
  expect((await deltaPages(h)).at(-1)).toContainEqual(late);
  expect(h.owner.event(late.id)).toBeDefined();
});

it("an event dated further ahead than the relay accepts raises the mark a fresh device's roster sample confirms only to 900 s past the device clock, saved so, and the next delta still reads a send the relay committed late before it", async () => {
  const storage = memoryUnreadStorage();
  // Dated past the relay's 900 s tolerance, which a relay that enforces it
  // never returns.
  const store = [hashed("team", SECONDS + 100_000)];
  const h = await launch({ store, storage });
  await h.owner.capability.ensure();
  await h.saved;
  expect((await storage.read())?.mark).toEqual({
    at: SECONDS + 900,
    checked: SECONDS,
  });
  const late = hashed("quiet", SECONDS - 965);
  store.push(late);
  await h.reconnected();
  expect(deltas(h).at(-1)).toEqual(
    expect.objectContaining({ since: SECONDS - 965 }),
  );
  expect(h.owner.event(late.id)).toBeDefined();
});

it("a delta that reads nothing newer keeps the mark's time and confirms it now", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 3600 });
  // Only older than the mark: the event it was raised to was deleted since.
  const h = await launch({
    store: [hashed("team", at - 100)],
    storage,
    fail: sampleRead,
  });
  await h.owner.capability.ensure();
  await h.saved;
  expect((await storage.read())?.mark).toEqual({ at, checked: SECONDS });
});

it("a check that only moves the mark puts the mark entry and not the meta, and one that moves a remembered thread or covers a channel puts the meta", async () => {
  const idb = memoryIndexedDB();
  const scope = "https://relay.example:viewer";
  const at = SECONDS - 600;
  // A thread the viewer replied in, read whole and held, and walked to.
  const root = post(peerKey, "team", T);
  const mine = reply(viewerKey, "team", root, T + 1);
  const key = `team:${root.id}`;
  await browserUnreadStorage(scope).save({
    participation: {
      roots: new Map([[key, { at: mine.created_at }]]),
      walk: { since: mine.created_at },
    },
    events: [root, mine],
    structure: new Set(),
    complete: true,
    mark: { at, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
    whole: new Set([key]),
  });
  let clock = NOW;
  const storage = browserUnreadStorage(scope);
  const store: RelayEvent[] = [root, mine];
  const h = await launch({
    store,
    storage,
    frontiers: { team: SECONDS },
    now: () => clock,
  });
  await h.owner.capability.ensure();
  await h.saved;
  /** The meta store's keys `pass` put, a minute on, once its saves land. */
  async function put(pass: () => Promise<unknown>) {
    clock += 60_000;
    const save = vi.spyOn(storage, "save");
    idb.writes.splice(0);
    try {
      await pass();
      await Promise.all(save.mock.results.map(({ value }) => value));
    } finally {
      save.mockRestore();
    }
    return idb.writes.flatMap(([name, , key]) =>
      name === "meta" ? [key] : [],
    );
  }
  const next = () => browserUnreadStorage(scope).read();
  // A tick that reads nothing new confirms the mark now, and puts that alone.
  expect(await put(() => h.reconnected())).toEqual([[scope, "mark"]]);
  expect(idb.writes).toHaveLength(1);
  expect((await next())?.mark).toEqual({ at, checked: SECONDS + 60 });
  // A peer answers in the thread: only its remembered time moves on.
  const answer = reply(peerKey, "team", root, SECONDS - 300);
  store.push(answer);
  expect(await put(() => h.reconnected())).toEqual([scope, [scope, "mark"]]);
  expect((await next())?.participation.roots.get(key)).toEqual({
    at: answer.created_at,
    newestId: answer.id,
  });
  // Joining a channel adds it to what the mark covers.
  expect(
    await put(() => {
      h.roster(summaries([...ROSTER, "fresh"]));
      return h.owner.capability.ensure();
    }),
  ).toEqual([scope, [scope, "mark"]]);
  expect((await next())?.roster).toEqual(new Set([...ROSTER, "fresh"]));
  expect(await put(() => h.reconnected())).toEqual([[scope, "mark"]]);
  // A relaunch reads the mark from beside the meta, and catches up from it.
  expect((await next())?.mark).toEqual({
    at: answer.created_at,
    checked: SECONDS + 240,
  });
  h.owner.dispose();
  const warm = await launch({
    store,
    storage: browserUnreadStorage(scope),
    frontiers: { team: SECONDS },
    now: () => clock,
  });
  const launched = await sentDuring(warm, () => warm.owner.capability.ensure());
  expect(launched[0]).toMatchObject({
    kinds: DELTA_KINDS,
    since: answer.created_at - 1865,
  });
});

it("a chunk still full at six delta pages leaves the pass to the bootstrap, whose sample sets the mark the next delta reads to its end from", async () => {
  const at = SECONDS - 4000;
  const storage = await marked({ at, checked: SECONDS - 60 });
  // One event a second from the delta's start: more than six pages.
  const store = Array.from({ length: 3001 }, (_, i) =>
    hashed("team", at - 1865 + i),
  );
  const newest = at - 1865 + 3000;
  // Read, so the record holds only what the next repair's reads select.
  const h = await launch({ store, storage, frontiers: { team: SECONDS } });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  expect((await deltaPages(h)).map((page) => page.length)).toEqual([
    500, 500, 500, 500, 500, 500,
  ]);
  await h.saved;
  expect((await storage.read())?.mark).toEqual({
    at: newest,
    checked: SECONDS,
  });
  await h.reconnected();
  await save.mock.results.at(-1)?.value;
  expect(deltas(h)[6]).toEqual(
    expect.objectContaining({ since: newest - 1865 }),
  );
  expect((await deltaPages(h)).slice(6).map((page) => page.length)).toEqual([
    500, 500, 500, 366,
  ]);
});

it("a mark confirmed more than a day ago sends no delta, and one confirmed within it is read from however old it is", async () => {
  const stale = await marked({
    at: SECONDS - 600,
    checked: SECONDS - 86_401,
  });
  const store = [hashed("team", SECONDS - 600)];
  const h = await launch({ store, storage: stale });
  await h.owner.capability.ensure();
  expect(h.reader.read.mock.calls.length).toBeGreaterThan(0);
  expect(deltas(h)).toEqual([]);
  h.owner.dispose();
  // A quiet roster: its newest event is days old, but a read confirmed it
  // a minute ago.
  const days = SECONDS - 3 * 86_400;
  const quiet = await marked({ at: days, checked: SECONDS - 60 });
  const q = await launch({ store: [hashed("team", days)], storage: quiet });
  await q.owner.capability.ensure();
  expect(deltas(q)).toEqual([expect.objectContaining({ since: days - 1865 })]);
});

it("live events do not move the mark", async () => {
  const at = SECONDS - 600;
  const storage = await marked({ at, checked: SECONDS - 60 });
  const h = await launch({
    store: [hashed("team", at + 10)],
    storage,
    fail: sampleRead,
  });
  await h.owner.capability.ensure();
  h.owner.accept([hashed("team", at + 500)]);
  await h.reconnected();
  expect(deltas(h).map(({ since }) => since)).toEqual([
    at - 1865,
    at + 10 - 1865,
  ]);
});

it("a walk cut short by a dropped page saves an incomplete record, so the next launch reads the bootstrap, not the delta, and its walk", async () => {
  const storage = memoryUnreadStorage();
  // More of the viewer's messages than the authored page holds.
  const store = Array.from({ length: 101 }, (_, i) =>
    post(viewerKey, "quiet", T + i),
  );
  const later = (filters: readonly ReadFilter[]) =>
    filters.some((filter) => filter.authors && filter.until !== undefined);
  const first = await launch({ store, storage, fail: later });
  await first.owner.capability.ensure();
  await first.saved;
  first.owner.dispose();
  const record = await storage.read();
  expect(record?.mark).toEqual({ at: T + 100, checked: SECONDS });
  expect(record?.complete).toBe(false);
  // The walk's dropped page says nothing.
  expect(first.owner.capability.inbox().partial).toBeUndefined();
  const next = await launch({ store, storage });
  await next.owner.capability.ensure();
  await next.saved;
  expect(deltas(next)).toEqual([]);
  expect(next.reader.read.mock.calls.some(([filters]) => later(filters))).toBe(
    true,
  );
  expect((await storage.read())?.complete).toBe(true);
});

const overlayRead = (filters: readonly ReadFilter[]) =>
  filters.some((filter) => filter.kinds?.join() === "40003,5,9005");

const byIdRead = (filters: readonly ReadFilter[]) =>
  overlayRead(filters) && filters.some((filter) => !!filter["#e"]);

it("more edits and deletions since a stale mark than the bootstrap reads have those of the content its reads returned read by ID too, since those reads carry no edits: a reply in the viewer's thread shows the edit below the cut, and the mark moves", async () => {
  const at = T + 10_000;
  // Confirmed over a day ago: the launch reads the bootstrap.
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // The viewer's thread, which team's window and the thread read return
  // with no edits, and a peer's edit of its answer older than the 1,000
  // edits and deletions since the mark the read of them reaches.
  const root = hashed("team", at + 1, 9, [], viewer);
  const answer = hashed("team", at + 2, 9, [["e", root.id, "", "reply"]]);
  const edit = signed(peerKey, {
    kind: 40003,
    content: "answer, edited",
    created_at: at + 3,
    tags: [
      ["h", "team"],
      ["e", answer.id],
    ],
  });
  const noise = Array.from({ length: 1000 }, (_, i) =>
    hashed("team", at + 4 + i, 5, [["e", "f".repeat(64)]]),
  );
  const h = await launch({
    store: [root, answer, edit, ...noise, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at },
  });
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  const sent = h.reader.read.mock.calls.map(([filters]) => filters);
  expect(
    sent
      .filter(byIdRead)
      .flatMap((filters) => filters.flatMap((filter) => filter["#e"] ?? [])),
  ).toEqual(expect.arrayContaining([root.id, answer.id]));
  expect(h.rows()).toContainEqual(
    expect.objectContaining({
      messageIds: [answer.id],
      preview: "answer, edited",
    }),
  );
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
});

it("a held message edited more times than the evidence holds events has one edit held, so its edits evict nothing: every held message stays counted, and the mark moves", async () => {
  const at = T + 10_000;
  const since = at - 1865;
  const storage = await marked({ at, checked: SECONDS - 86_401 });
  // Unread past the window's cut and outside the roster sample, read by ID
  // together, the oldest of them edited by an agent 5,000 times.
  const held = Array.from({ length: 22 }, (_, i) =>
    hashed("team", at - 2000 + i),
  );
  const [status] = held;
  assert(status);
  const edits = Array.from({ length: 5000 }, (_, i) =>
    hashed("team", since + i, 40003, [["e", status.id]]),
  );
  const newer = Array.from({ length: 100 }, (_, i) =>
    hashed("team", at + 500 + i),
  );
  const h = await launch({
    store: [...held, ...edits, ...newer, ...busy],
    storage,
    frontiers: { ...BUSY_READ, team: at - 3000 },
  });
  h.owner.accept(held);
  const save = vi.spyOn(storage, "save");
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  expect(h.count("team")).toBe(122);
  expect(h.owner.event(status.id)).toBeDefined();
  expect(h.owner.event(edits.at(-1)?.id ?? "")).toBeDefined();
  expect(h.owner.event(edits.at(-2)?.id ?? "")).toBeUndefined();
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark).toEqual({
    at: T + 50_499,
    checked: SECONDS,
  });
});

// What the mark does not cover is read once beside the delta (design §3.6);
// a pass that catches up reads nothing else of the bootstrap.
/** The filters of the reads sent while `pass` ran. */
async function sentDuring(h: Launch, pass: () => Promise<unknown>) {
  const from = h.reader.read.mock.calls.length;
  await pass();
  return h.reader.read.mock.calls.slice(from).flatMap(([filters]) => filters);
}
const windowOf = (id: string) => (filter: ReadFilter) =>
  filter.include_aux === true &&
  filter.since !== undefined &&
  !filter["#e"] &&
  filter["#h"]?.join() === id;
const deltaFilter = (filter: ReadFilter) => deltaRead([filter]);
/** A launch from a complete record whose mark covers the default roster. */
async function caughtUp(
  store: RelayEvent[],
  roster = summaries(ROSTER),
  frontiers: Readonly<Record<string, number>> = {},
) {
  const storage = await marked({
    at: SECONDS - 600,
    checked: SECONDS - 60,
  });
  const h = await launch({ store, storage, roster, frontiers });
  await h.owner.capability.ensure();
  return { h, storage };
}

it("joining a channel holding an old unread message, and a DM, reads each once beside the delta, and not again on the next tick", async () => {
  // Older than the delta reaches.
  const old = post(peerKey, "fresh", T + 10);
  const direct = post(peerKey, "dm2", T + 20);
  const { h, storage } = await caughtUp([old, direct]);
  const joined = [
    ...summaries([...ROSTER, "fresh"]),
    {
      id: "dm2",
      name: "dm2",
      members: [viewer, peerKey.pubkey],
      channelType: "dm" as const,
    },
  ];
  const joining = await sentDuring(h, () => {
    h.roster(joined);
    return h.owner.capability.ensure();
  });
  expect(joining.filter(deltaFilter)).not.toEqual([]);
  for (const id of ["fresh", "dm2"])
    expect(joining.filter(windowOf(id))).toHaveLength(1);
  expect(joining.filter(windowOf("team"))).toEqual([]);
  expect(joining.filter(sampleFilter)).toHaveLength(1);
  expect(h.count("fresh")).toBe(1);
  expect(h.count("dm2")).toBe(1);
  expect((await storage.read())?.roster).toEqual(
    new Set([...ROSTER, "fresh", "dm2"]),
  );
  const ticking = await sentDuring(h, () => h.reconnected());
  for (const id of ["fresh", "dm2"])
    expect(ticking.filter(windowOf(id))).toEqual([]);
  expect(ticking.filter(sampleFilter)).toEqual([]);
});

it("Refresh pressed while a pass catches up has the bootstrap read after it, and each press settles once that has", async () => {
  const storage = await marked({ at: SECONDS - 600, checked: SECONDS - 60 });
  // Only the bootstrap after the reconnect's pass reads the channel's
  // window, which fails, so only its end leaves the Inbox partial.
  const h = await launch({
    store: [hashed("team", SECONDS - 300)],
    storage,
    fail: (filters) => filters.some(windowOf("team")),
  });
  await h.owner.capability.ensure();
  const from = h.reader.read.mock.calls.length;
  const { release, waiting } = h.hold();
  let pressed: Promise<void>[] = [];
  try {
    h.owner.reconnect();
    await waiting;
    const syncing = vi.spyOn(h.reads, "refresh");
    pressed = [h.owner.capability.refresh(), h.owner.capability.refresh()];
    // Each asks for its repair as soon as the read state settles, before
    // anything awaiting that settles.
    await Promise.all(syncing.mock.results.map(({ value }) => value));
  } finally {
    release();
  }
  for (const press of [pressed[1], pressed[0]]) {
    await press;
    expect(h.owner.capability.inbox().partial).toBe(true);
  }
  const sent = h.reader.read.mock.calls
    .slice(from)
    .flatMap(([filters]) => filters);
  expect(sent.filter(deltaFilter)).toHaveLength(1);
  // Read and retried once.
  expect(sent.filter(windowOf("team"))).toHaveLength(2);
});

// A full repair from a mark (design §3.7): the threads read through to it
// are asked for replies since the mark less 1,865 s in one read of their
// roots, not each on its own.
const CONTENT = [9, 40002, 40008];
const threadReads = (filters: readonly ReadFilter[]) =>
  filters.filter(
    (filter) => !!filter["#e"] && filter.kinds?.join() === CONTENT.join(),
  );
const ownReads = (filters: readonly ReadFilter[]) =>
  threadReads(filters).filter(
    (filter) => filter.since === undefined || filter.limit === 50,
  );
/** A record not complete, so the launch reads the bootstrap from its mark,
 * confirmed a minute ago, holding no evidence: `hot` threads read whole and
 * through. */
async function readThrough(hot: readonly [string, RelayEvent][]) {
  const key = ([channelId, root]: [string, RelayEvent]) =>
    `${channelId}:${root.id}`;
  const storage = memoryUnreadStorage();
  const mark = { at: SECONDS - 600, checked: SECONDS - 60 };
  await storage.save({
    participation: {
      roots: new Map(
        hot.map((entry) => [key(entry), { at: entry[1].created_at }]),
      ),
    },
    events: [],
    structure: new Set(),
    complete: false,
    mark,
    roster: new Set(ROSTER),
    whole: new Set(hot.map(key)),
    through: new Set(hot.map(key)),
  });
  return { storage, mark, since: mark.at - 1865 };
}

it("a selection over the record's bound on events is saved as no events and incomplete, while the session keeps what it selected: the next tick reads one delta and no window, a Refresh reads the threads read through past the mark in one read, and only a launch from that record reads the full repair", async () => {
  unreadPass.mockClear();
  const roots = Array.from({ length: 60 }, (_, i) =>
    post(peerKey, "team", T + i),
  );
  // Unread, so their windows return them all: 80 in each of 20 channels.
  const filled = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const filler = filled.flatMap((id) =>
    Array.from({ length: 80 }, (_, i) => hashed(id, T + 1000 + i)),
  );
  // 499 of the busy traffic, so a catch-up's one page is short.
  const store = [
    ...roots,
    ...roots.map((root, i) => reply(viewerKey, "team", root, T + 100 + i)),
    ...filler,
    ...busy.slice(1),
  ];
  const roster = summaries(["team", ...filled, "busy"]);
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const h = await launch({ store, storage, roster, frontiers: BUSY_READ });
  await h.owner.capability.ensure();
  await save.mock.results.at(-1)?.value;
  const record = await storage.read();
  expect(record).toMatchObject({ events: [], complete: false });
  expect(record?.whole).toBeUndefined();
  expect(record?.through).toBeUndefined();
  const mark = record?.mark?.at ?? 0;
  expect(await sentDuring(h, () => h.reconnected())).toEqual([
    expect.objectContaining({ kinds: DELTA_KINDS }),
  ]);
  const refreshed = await sentDuring(h, () => h.owner.capability.refresh());
  expect(threadReads(refreshed)).toEqual([
    {
      kinds: CONTENT,
      "#h": ["team"],
      "#e": expect.arrayContaining(roots.map((root) => root.id)),
      since: mark - 1865,
      include_aux: true,
      limit: 500,
    },
  ]);
  expect(threadReads(refreshed)[0]?.["#e"]).toHaveLength(60);
  expect(refreshed.filter(windowOf("team"))).toHaveLength(1);
  // Each pass reports its reads and a selection over the bound.
  expect(
    unreadPass.mock.calls.map(([{ route, fits, events }]) => [
      route,
      fits,
      events > UNREAD_RECORD_EVENTS,
    ]),
  ).toEqual([
    ["bootstrap", false, true],
    ["delta", false, true],
    ["bootstrap", false, true],
  ]);
  await save.mock.results.at(-1)?.value;
  expect(await storage.read()).toMatchObject({ events: [], complete: false });
  h.owner.dispose();
  const relaunched = await launch({
    store,
    storage,
    roster,
    frontiers: BUSY_READ,
  });
  const next = await sentDuring(relaunched, () =>
    relaunched.owner.capability.ensure(),
  );
  expect(next.filter(deltaFilter)).toEqual([]);
  expect(next.filter(windowOf("team"))).toHaveLength(1);
});

it("a dropped read past the mark holds the mark and says some activity could not be checked, and the next pass reads it again", async () => {
  const root = post(peerKey, "team", T);
  const { storage, mark, since } = await readThrough([["team", root]]);
  let failing = true;
  const past = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(root.id) && filter.since === since;
  const h = await launch({
    store: [root, reply(peerKey, "team", root, since + 5), ...busy],
    storage,
    frontiers: BUSY_READ,
    fail: (filters) => failing && filters.some(past),
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  // Retried once, then dropped.
  expect(launched.filter(past)).toHaveLength(2);
  expect(ownReads(launched)).toEqual([]);
  expect(h.owner.capability.inbox().partial).toBe(true);
  await h.saved;
  expect((await storage.read())?.mark).toEqual(mark);
  failing = false;
  const refreshed = await sentDuring(h, () => h.owner.capability.refresh());
  expect(refreshed.filter(past)).toHaveLength(1);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect((await storage.read())?.mark?.checked).toBeGreaterThan(mark.checked);
});

// A catch-up reads no cold thread of a channel the mark covers, so one whose
// own read dropped takes its channel out, and the next catch-up reads that
// channel's threads once.
it("a cold thread's own read dropped in a Refresh over a channel the mark covers takes the channel out of the roster set: the next tick catches up, reads the thread on its own and shows the reply it missed before the notice clears, and the tick after it reads the delta alone", async () => {
  // Ranked above the thread, so it is cold; read whole and through.
  const hotter = Array.from({ length: 50 }, (_, i) =>
    post(peerKey, "quiet", T + 10 + i),
  );
  const hotKeys = hotter.map((event) => `quiet:${event.id}`);
  const root = post(viewerKey, "team", T);
  const answer = reply(peerKey, "team", root, T + 2);
  const at = SECONDS - 600;
  const storage = memoryUnreadStorage();
  // Complete, caught up a minute ago and covering every channel; the
  // thread is not read through, as one learned beside a catch-up.
  await storage.save({
    participation: {
      roots: new Map([
        [`team:${root.id}`, { at: T }],
        ...hotter.map(
          (event) => [`quiet:${event.id}`, { at: event.created_at }] as const,
        ),
      ]),
    },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
    whole: new Set(hotKeys),
    through: new Set(hotKeys),
  });
  // Newer posts fill team's window above the answer and, with busy's
  // traffic, the roster sample: only the thread's own read returns it.
  const newer = Array.from({ length: 101 }, (_, i) =>
    post(peerKey, "team", at + 1 + i),
  );
  const store = [...hotter, root, answer, ...newer, ...busy];
  const own = (filter: ReadFilter) =>
    !!filter["#e"]?.includes(root.id) && filter.since === T;
  let failing = true;
  const h = await launch({
    store,
    storage,
    frontiers: BUSY_READ,
    fail: (filters) => failing && filters.some(own),
  });
  const save = vi.spyOn(storage, "save");
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  expect(launched.filter(deltaFilter)).toHaveLength(1);
  expect(launched.filter(own)).toEqual([]);
  const refreshed = await sentDuring(h, () => h.owner.capability.refresh());
  // Retried once, then dropped.
  expect(refreshed.filter(own)).toHaveLength(2);
  expect(h.owner.capability.inbox().partial).toBe(true);
  expect(h.owner.owed()).toBe(true);
  await save.mock.results.at(-1)?.value;
  expect((await storage.read())?.complete).toBe(true);
  failing = false;
  const shown = (items: readonly InboxItem[]) =>
    items.some((item) => item.rootId === root.id && item.unreadCount === 1);
  // Whether the reply shows when the tick first publishes the notice clear.
  let clear: boolean | undefined;
  const stop = h.owner.capability.subscribeInbox(() => {
    const inbox = h.owner.capability.inbox();
    if (clear === undefined && !inbox.partial) clear = shown(inbox.items);
  });
  const next = await sentDuring(h, () => h.reconnected());
  stop();
  expect(next.filter(deltaFilter)).toHaveLength(1);
  expect(next.filter(windowOf("team"))).toHaveLength(1);
  expect(next.filter(own)).toEqual([
    {
      kinds: CONTENT,
      "#h": ["team"],
      "#e": [root.id],
      since: T,
      include_aux: true,
      limit: 50,
    },
  ]);
  expect(clear).toBe(true);
  expect(shown(h.owner.capability.inbox().items)).toBe(true);
  expect(h.owner.capability.inbox().partial).toBeUndefined();
  expect(h.owner.owed()).toBe(false);
  const after = await sentDuring(h, () => h.reconnected());
  expect(after).toEqual([expect.objectContaining({ kinds: DELTA_KINDS })]);
  expect(shown(h.owner.capability.inbox().items)).toBe(true);
});

// A catch-up reads no cold thread, so the forget leaves the record owing a
// full repair, which reads it on its own; once it has, a tick catches up.
it("restored evidence of a cold thread forgotten by a full repair whose roster sample drops and whose edits since the mark are more than its read of deletions takes leaves the record incomplete: the next tick reads the bootstrap, reads the thread on its own and the unread reply counts, and the tick after it catches up", async () => {
  // Ranked above the thread, so it is cold.
  const hotter = Array.from({ length: 50 }, (_, i) =>
    post(peerKey, "quiet", T + 10 + i),
  );
  const root = post(viewerKey, "team", T);
  const answer = reply(peerKey, "team", root, T + 2);
  const key = `team:${root.id}`;
  const at = SECONDS - 600;
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map([
        [key, { at: T }],
        ...hotter.map(
          (event) => [`quiet:${event.id}`, { at: event.created_at }] as const,
        ),
      ]),
    },
    events: [root, answer],
    structure: new Set(),
    complete: false,
    mark: { at, checked: SECONDS - 60 },
    roster: new Set(ROSTER),
    through: new Set([key]),
  });
  // Newer posts fill team's window above the answer; they are saved, so
  // signed. The edits are of a message no longer held.
  const newer = Array.from({ length: 101 }, (_, i) =>
    post(peerKey, "team", at + 1 + i),
  );
  const edits = Array.from({ length: 1001 }, (_, i) =>
    hashed("team", at + 200 + i, 40003, [["e", "f".repeat(64)]]),
  );
  const store = [...hotter, root, answer, ...newer, ...edits];
  let failing = true;
  const h = await launch({
    store,
    storage,
    fail: (filters) => failing && sampleRead(filters),
  });
  await h.owner.capability.ensure();
  await h.saved;
  failing = false;
  const next = await sentDuring(h, () => h.reconnected());
  expect(next.filter(windowOf("team"))).toHaveLength(1);
  expect(ownReads(next)).toContainEqual({
    kinds: CONTENT,
    "#h": ["team"],
    "#e": [root.id],
    since: T,
    include_aux: true,
    limit: 50,
  });
  expect(h.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  const after = await sentDuring(h, () => h.reconnected());
  expect(after.filter(deltaFilter)).not.toEqual([]);
  expect(after.filter(windowOf("team"))).toEqual([]);
});

/** A device's first launch as the live relay showed it (#note:8341a9c0):
 * the viewer's 100 newest messages are their replies in 50 threads across
 * channels a–k, read whole. Older, their replies in l–o rank cold, under
 * roots of their own in l and m and of a peer's in n and o: each channel's
 * window holds the reply and not the root (the walk's second page returns
 * the viewer's, and is not evidence), the cold read returns the reply alone,
 * passed over, and busier traffic keeps both out of the roster's newest
 * events: 499 of it, so a catch-up's one page is short. */
function ownColdThreads() {
  const hotChannels = [..."abcdefghijk"];
  const hot = Array.from({ length: 50 }, (_, i) => {
    const channelId = hotChannels[i % hotChannels.length] ?? "a";
    const root = post(peerKey, channelId, T + 1000 + 10 * i);
    return [
      root,
      reply(viewerKey, channelId, root, root.created_at + 1),
      reply(viewerKey, channelId, root, root.created_at + 2),
    ];
  }).flat();
  const cold = (
    [
      ["l", viewerKey],
      ["m", viewerKey],
      ["n", peerKey],
      ["o", peerKey],
    ] as const
  ).map(([channelId, key]) => {
    const root = post(key, channelId, T + 100);
    return {
      channelId,
      key,
      root,
      mine: reply(viewerKey, channelId, root, T + 200),
    };
  });
  return {
    roster: summaries([...hotChannels, "l", "m", "n", "o", "busy"]),
    frontiers: {
      ...BUSY_READ,
      ...Object.fromEntries(hotChannels.map((id) => [id, T + 2000])),
      ...Object.fromEntries(cold.map(({ channelId }) => [channelId, T + 150])),
    },
    cold,
    rootIds: cold.map(({ root }) => root.id),
    store: [
      ...hot,
      ...cold.flatMap(({ root, mine }) => [root, mine]),
      ...busy.slice(1),
    ],
  };
}
/** The reads by ID of any of `ids`. */
const fetchesOf = (filters: readonly ReadFilter[], ids: readonly string[]) =>
  filters.filter((filter) => filter.ids?.some((id) => ids.includes(id)));

it("a full repair ends by fetching by ID the roots of remembered threads whose replies it holds without them, kept as structure or as the viewer's own, so the record saves complete and the next launch reads one delta", async () => {
  const { roster, frontiers, cold, rootIds, store } = ownColdThreads();
  const storage = memoryUnreadStorage();
  const fresh = await launch({ store, storage, roster, frontiers });
  const launched = await sentDuring(fresh, () =>
    fresh.owner.capability.ensure(),
  );
  const fetched = fetchesOf(launched, rootIds);
  expect(fetched).toEqual([
    { kinds: CONTENT, ids: expect.any(Array), include_aux: true, limit: 4 },
  ]);
  expect(new Set(fetched[0]?.ids)).toEqual(new Set(rootIds));
  await fresh.saved;
  const record = await storage.read();
  expect(record?.complete).toBe(true);
  // A peer's root is structure; the viewer's is their own message, which
  // never counts either.
  for (const { root, key } of cold)
    expect(record?.structure.has(root.id)).toBe(key === peerKey);
  expect(await saved(storage)).toEqual(
    expect.arrayContaining([...rootIds, ...cold.map(({ mine }) => mine.id)]),
  );
  fresh.owner.dispose();
  const warm = await launch({ store, storage, roster, frontiers });
  expect(await sentDuring(warm, () => warm.owner.capability.ensure())).toEqual([
    expect.objectContaining({ kinds: DELTA_KINDS }),
  ]);
});

it("a root that full repair's fetch finds deleted is saved as absent, so the record saves complete, a peer's unread reply under it still counts on its own, and the next launch reads one delta", async () => {
  const { roster, frontiers, cold, rootIds, store } = ownColdThreads();
  const [first] = cold;
  assert(first);
  // Relevant through the viewer's reply beside it, and unread.
  const answer = reply(peerKey, first.channelId, first.root, T + 300);
  const deleted = [
    ...store,
    answer,
    ...cold.map(({ key, channelId, root }) => deletion(key, channelId, root)),
  ];
  const storage = memoryUnreadStorage();
  const fresh = await launch({ store: deleted, storage, roster, frontiers });
  const launched = await sentDuring(fresh, () =>
    fresh.owner.capability.ensure(),
  );
  expect(
    new Set(fetchesOf(launched, rootIds).flatMap((filter) => filter.ids)),
  ).toEqual(new Set(rootIds));
  await fresh.saved;
  expect(await storage.read()).toMatchObject({
    complete: true,
    absent: new Set(rootIds),
  });
  expect(await saved(storage)).toContain(answer.id);
  // Thread activity without its root, a row of its own (docs/inbox.md).
  const row = expect.objectContaining({
    messageIds: [answer.id],
    unreadCount: 1,
  });
  expect(fresh.count(first.channelId)).toBe(1);
  expect(fresh.owner.capability.inbox().items).toContainEqual(row);
  fresh.owner.dispose();
  const warm = await launch({ store: deleted, storage, roster, frontiers });
  expect(await sentDuring(warm, () => warm.owner.capability.ensure())).toEqual([
    expect.objectContaining({ kinds: DELTA_KINDS }),
  ]);
  expect(warm.count(first.channelId)).toBe(1);
  expect(warm.owner.capability.inbox().items).toContainEqual(row);
});

it("a full repair whose fetch of those roots drops saves the record incomplete and says some activity could not be checked; the next tick reads the bootstrap, fetches them and saves it complete, and the tick after it reads one delta", async () => {
  const { roster, frontiers, rootIds, store } = ownColdThreads();
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  let failing = true;
  const h = await launch({
    store,
    storage,
    roster,
    frontiers,
    fail: (filters) => failing && fetchesOf(filters, rootIds).length > 0,
  });
  const launched = await sentDuring(h, () => h.owner.capability.ensure());
  // Read once more in its slot, then dropped.
  expect(fetchesOf(launched, rootIds)).toHaveLength(2);
  expect(h.owner.capability.inbox().partial).toBe(true);
  await h.saved;
  expect((await storage.read())?.complete).toBe(false);
  failing = false;
  const next = await sentDuring(h, () => h.reconnected());
  expect(next.filter(deltaFilter)).toEqual([]);
  expect(fetchesOf(next, rootIds)).toHaveLength(1);
  expect(h.owner.capability.inbox().partial).toBeFalsy();
  await save.mock.results.at(-1)?.value;
  expect((await storage.read())?.complete).toBe(true);
  expect(await sentDuring(h, () => h.reconnected())).toEqual([
    expect.objectContaining({ kinds: DELTA_KINDS }),
  ]);
});

it("the roots of 1,000 remembered threads a catch-up brought replies to are fetched at most 16 filters of 50 IDs a request, each within the reader's 64 KiB, so the record saves complete", async () => {
  // The viewer's replies, 100 to each channel's window, under roots older
  // than the delta: only the fetch at the end of the pass brings them.
  const channelIds = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const threads = Array.from({ length: 1000 }, (_, i) => {
    const channelId = channelIds[i % channelIds.length] ?? "c0";
    const root = hashed(channelId, T + i);
    const mine = hashed(
      channelId,
      SECONDS - 1000 + i,
      9,
      [["e", root.id, "", "reply"]],
      viewer,
    );
    return { key: `${channelId}:${root.id}`, root, mine };
  });
  const keys = threads.map(({ key }) => key);
  const storage = memoryUnreadStorage();
  await storage.save({
    participation: {
      roots: new Map(
        threads.map(({ key, root }) => [key, { at: root.created_at }]),
      ),
    },
    events: [],
    structure: new Set(),
    complete: true,
    mark: { at: SECONDS - 600, checked: SECONDS - 60 },
    roster: new Set(channelIds),
    // Read whole, so the catch-up promotes none of them.
    whole: new Set(keys),
  });
  const save = vi.spyOn(storage, "save");
  const h = await launch({
    store: threads.flatMap(({ root, mine }) => [root, mine]),
    storage,
    roster: summaries(channelIds),
  });
  await h.owner.capability.ensure();
  const fetches = h.reader.read.mock.calls
    .map(([filters]) => filters)
    .filter((filters) => filters.some((filter) => filter.ids));
  expect(fetches.map((filters) => filters.length)).toEqual([16, 4]);
  for (const filters of fetches)
    expect(requestBytes(filters)).toBeLessThanOrEqual(64 * 1024);
  expect(new Set(fetches.flat().flatMap((filter) => filter.ids ?? []))).toEqual(
    new Set(threads.map(({ root }) => root.id)),
  );
  expect(h.owner.capability.inbox().partial).toBeFalsy();
  await save.mock.results.at(-1)?.value;
  expect((await storage.read())?.complete).toBe(true);
});
