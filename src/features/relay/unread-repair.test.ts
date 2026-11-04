import { verifiedSymbol } from "nostr-tools";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelQueries } from "./contracts";
import type { ReadFilter, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import {
  NO_THREAD_PARTICIPATION,
  type ThreadMark,
  type ThreadParticipation,
} from "./thread-participation";
import { createUnread } from "./unread";
import { memoryUnreadStorage, type UnreadStorage } from "./unread-storage";

// Repair's evidence reads: per-channel windows since each channel's read mark
// and the participation pass that refetches the viewer's threads. Events are
// marked verified instead of signed, as in unread-lookups.test.ts.
let next = 0;
function event(
  channelId: string,
  pubkey: string,
  created_at: number,
  tags: string[][] = [],
  content = "",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind: 9,
    created_at,
    content,
    tags: [["h", channelId], ...tags],
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const reply = (
  channelId: string,
  pubkey: string,
  time: number,
  root: RelayEvent,
  tags: string[][] = [],
) => event(channelId, pubkey, time, [["e", root.id, "", "reply"], ...tags]);
const viewer = "a".repeat(64),
  peer = "b".repeat(64);
const flood = (channelId: string, count: number, from: number) =>
  Array.from({ length: count }, (_, i) => event(channelId, peer, from + i));
const NOW = 10_000_000;
// The threads storage holds for the next launch, and a record seeding them.
const remembered = async (storage: UnreadStorage) =>
  (await storage.read())?.participation ?? NO_THREAD_PARTICIPATION;
const remember = (storage: UnreadStorage, participation: ThreadParticipation) =>
  storage.save({ participation });

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

async function setup({
  channels: ids,
  frontiers,
  storage = memoryUnreadStorage(),
  authoredPage = true,
  sampled = true,
  localUnread = {},
}: {
  channels: readonly string[];
  frontiers: Readonly<Record<string, number>>;
  storage?: UnreadStorage;
  // Whether the viewer's newest authored page still reaches their old replies.
  authoredPage?: boolean;
  // Whether the roster sample still reaches this history; busier channels
  // move it past a quiet channel within hours, which windows and thread reads
  // do not depend on.
  sampled?: boolean;
  // Messages marked unread on this device, which a relaunch keeps.
  localUnread?: Readonly<Record<string, number>>;
}) {
  const store: RelayEvent[] = [];
  // Channels whose window requests fail: every time, or only the first.
  const failing = new Set<string>();
  const transient = new Set<string>();
  // Channels whose window requests wait for release.
  const held = new Map<string, Promise<void>>();
  const tagged = (item: RelayEvent, name: string, values: readonly string[]) =>
    item.tags.some(
      ([tag, value]) => tag === name && values.includes(value ?? ""),
    );
  // The roster sample: the newest across channels, with no start.
  const sample = (filter: ReadFilter) =>
    !!filter["#h"] && !filter["#e"] && filter.since === undefined;
  const reader = {
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      // The roster sample fails or waits as the "sample" channel would.
      const windows = filters.flatMap((filter) =>
        sample(filter) ? ["sample"] : (filter["#h"] ?? []),
      );
      // The walk's pages beyond the first fail as the "walk" channel would,
      // and single-root `since` thread reads as "cold".
      if (filters.some((filter) => filter.until !== undefined))
        windows.push("walk");
      if (
        filters.some(
          (filter) => filter.since !== undefined && filter["#e"]?.length === 1,
        )
      )
        windows.push("cold");
      await Promise.all(windows.map((id) => held.get(id)));
      if (windows.some((id) => failing.has(id)))
        throw new Error("Relay read timed out");
      if (windows.some((id) => transient.delete(id)))
        throw new DOMException("Relay read timed out", "TimeoutError");
      return filters.flatMap((filter) => {
        if (filter.authors && !filter["#e"] && !authoredPage) return [];
        if (sample(filter) && !sampled) return [];
        // `until` is exclusive at the keyset cursor, as the relay's is.
        const before = (item: RelayEvent) =>
          filter.until === undefined ||
          item.created_at < filter.until ||
          (item.created_at === filter.until &&
            (filter.before_id === undefined || item.id > filter.before_id));
        const matched = store
          .filter(
            (item) =>
              (!filter.kinds || filter.kinds.includes(item.kind)) &&
              (!filter.ids || filter.ids.includes(item.id)) &&
              (!filter.authors || filter.authors.includes(item.pubkey)) &&
              (filter.since === undefined || item.created_at >= filter.since) &&
              before(item) &&
              (!filter["#h"] || tagged(item, "h", filter["#h"])) &&
              (!filter["#e"] || tagged(item, "e", filter["#e"])),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        // `include_aux`: the relay adds the deletions of what matched.
        const ids = matched.map((item) => item.id);
        return filter.include_aux
          ? [
              ...matched,
              ...store.filter(
                (item) => item.kind === 5 && tagged(item, "e", ids),
              ),
            ]
          : matched;
      });
    }),
  };
  let journal: ReadJournal | undefined = {
    ...newReadJournal(),
    state: { frontiers, overrides: {} },
    localUnread: { ...localUnread },
    // A saved mark's revision is at most the journal's.
    revision: Math.max(0, ...Object.values(localUnread)),
  };
  const reads = createReadState({
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
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: ids.map((id) => ({ id, name: id, members: [viewer] })),
    }),
    subscribeList: () => () => {},
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
  const owner = createUnread({
    reads,
    channels,
    reader,
    viewer,
    storage,
    now: () => NOW * 1000,
  });
  owners.push(owner);
  const filters = () => reader.read.mock.calls.flatMap(([filters]) => filters);
  const hold = (channelId: string) => {
    let release = () => {};
    held.set(
      channelId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  return {
    owner,
    store,
    reader,
    filters,
    failing,
    transient,
    hold,
    storage,
  };
}

it("a thread the viewer replied in outlives its channel's later traffic and a busier channel", async () => {
  const h = await setup({
    channels: ["quiet", "busy"],
    // The viewer read the quiet channel through their own reply, and the
    // busy channel long ago.
    frontiers: { quiet: 1015, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answers = [1020, 1030, 1040].map((time) =>
    reply("quiet", peer, time, root),
  );
  // Later top-level traffic fills the quiet channel's one-page window, and
  // the busy channel holds far more than the roster sample.
  h.store.push(root, mine, ...answers, ...flood("quiet", 120, 1100));
  h.store.push(...flood("busy", 600, 2000));
  await h.owner.capability.ensure();
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  const thread = inbox.items.find((item) => item.rootId === root.id);
  assert(thread, "the thread row is missing");
  expect(thread).toMatchObject({ channelId: "quiet", unreadCount: 3 });
  expect(thread.messageIds).toEqual(
    expect.arrayContaining(answers.map((answer) => answer.id)),
  );
  // Windows are read per channel since its own mark; the thread came from
  // the viewer's authored page and one `#e` read of its root.
  const windows = h.filters().filter((filter) => filter.since !== undefined);
  expect(windows).toEqual([
    expect.objectContaining({ "#h": ["busy"], since: 1500, limit: 100 }),
    expect.objectContaining({ "#h": ["quiet"], since: 1015, limit: 100 }),
  ]);
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["quiet"], "#e": [root.id] }),
  );
});

it("an unread reply below a channel's catch-up mark, in a thread the viewer started, is in the Inbox and stays after the sample moves on", async () => {
  const storage = memoryUnreadStorage();
  // The channel was only scrolled to its end, so its one mark is the
  // catch-up mark, which reads no replies; the viewer has written much
  // since, so their authored page no longer reaches the root.
  const launch = (sampled: boolean) =>
    setup({
      channels: ["c0"],
      frontiers: { "activity:c0": 3000 },
      storage,
      authoredPage: false,
      sampled,
    });
  const root = event("c0", viewer, 1000);
  const answer = reply("c0", peer, 2000, root);
  const history = [root, answer, event("c0", peer, 3000)];
  const row = (h: Awaited<ReturnType<typeof launch>>) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const first = await launch(true);
  first.store.push(...history);
  await first.owner.capability.ensure();
  // The window starts at the mark, after the reply; the roster sample,
  // with no start, holds it.
  expect(first.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], since: 3000 }),
  );
  expect(row(first)).toMatchObject({ unreadCount: 1, messageIds: [answer.id] });
  expect(first.owner.capability.attention("c0", answer.id)).toMatchObject({
    status: "eligible",
    category: "thread",
    unread: true,
  });
  // The thread is remembered as of its root, so a launch after busier
  // channels have moved the sample on still reads the reply.
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1000,
    newestId: root.id,
  });
  first.owner.dispose();
  const second = await launch(false);
  second.store.push(...history);
  await second.owner.capability.ensure();
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 1,
      messageIds: [answer.id],
    }),
  );
});

it("a read mention whose root the windows dropped groups under its fetched root, and its thread is read in the same repair", async () => {
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const h = await setup({
    channels: ["c0", "own"],
    // The catch-up mark is older than the read mark, so the window reaches
    // the read mention; its root is older still.
    frontiers: { c0: 1100, "activity:c0": 1010 },
    storage,
  });
  const root = event("c0", peer, 1000);
  const mention = reply("c0", peer, 1020, root, [["p", viewer]]);
  h.store.push(root, mention, ...flood("c0", 80, 1100));
  // A full authored page keeps the walk, and so the repair, reading while
  // the mention's structure lookup lands.
  h.store.push(
    ...Array.from({ length: 100 }, (_, i) => event("own", viewer, 3000 + i)),
  );
  const release = h.hold("walk");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(h.owner.capability.inbox().items).toContainEqual(
        expect.objectContaining({
          rootId: root.id,
          messageIds: [mention.id],
          unreadCount: 0,
        }),
      ),
    );
  } finally {
    release();
  }
  await done;
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ ids: [root.id] }),
  );
  // The fetched root hands the mention's thread to the repair, which reads
  // it and remembers it before finishing: one save, the repair's own.
  expect(h.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  expect(save).toHaveBeenCalledTimes(1);
  expect((await remembered(storage)).roots.get(`c0:${root.id}`)).toEqual({
    at: 1020,
    newestId: mention.id,
  });
  // A single row names the thread; the mention is not its own row as well.
  expect(
    h.owner.capability.inbox().items.filter((item) => item.channelId === "c0"),
  ).toHaveLength(1);
});

it("a full budget evicts the busiest channel's oldest ordinary evidence, never a quiet channel's only message or the viewer's thread", async () => {
  const h = await setup({
    channels: ["quiet", "lone", "busy"],
    frontiers: { quiet: 1015, lone: 1500, busy: 1500 },
  });
  const root = event("quiet", peer, 1000);
  const mine = reply("quiet", viewer, 1010, root);
  const answer = reply("quiet", peer, 1020, root);
  const only = event("lone", peer, 1600);
  h.store.push(root, mine, answer, ...flood("quiet", 120, 1100), only);
  const windowed = flood("busy", 10, 2000);
  h.store.push(...windowed);
  await h.owner.capability.ensure();
  const inbox = () => h.owner.capability.inbox();
  const snapshot = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId });
  const unread = (channelId: string, id: string | undefined) =>
    h.owner.capability.attention(channelId, id ?? "").unread;
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id }),
  );
  expect(snapshot("lone").observedCount).toBe(1);
  // Its window holds the quiet channel's newest 100; the roster sample, all
  // 120 of its messages and the thread.
  expect(snapshot("quiet").observedCount).toBe(121);
  // Live traffic fills the event budget. Only what goes first is evicted: the
  // busy channel's own older traffic, since it holds the most — never the
  // lone channel's one unread message, whose count would otherwise become a
  // confident zero, nor the quiet channel's evidence or the viewer's thread.
  const live = flood("busy", 4096, 3000);
  h.owner.accept(live);
  expect(inbox().freshness).toBe("observed");
  expect(inbox().error).toBeUndefined();
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
  expect(snapshot("lone")).toMatchObject({
    observedCount: 1,
    coverage: "observed",
  });
  expect(snapshot("quiet").observedCount).toBe(121);
  expect(snapshot("busy").observedCount).toBe(4096 - 123 - 1);
  expect(unread("busy", live.at(-1)?.id)).toBe(true);
  expect(unread("busy", windowed[0]?.id)).toBe(false);
  expect(unread("lone", only.id)).toBe(true);
  // The byte budget evicts the same way: large live messages push out the
  // busy channel's oldest, not the other channels' evidence.
  const large = Array.from({ length: 20 }, (_, i) =>
    event("busy", peer, 9000 + i, [], "x".repeat(450_000)),
  );
  h.owner.accept(large);
  expect(snapshot("lone").observedCount).toBe(1);
  expect(snapshot("quiet").observedCount).toBe(121);
  expect(snapshot("busy").observedCount).toBeLessThan(30);
  expect(unread("busy", large.at(-1)?.id)).toBe(true);
  expect(unread("busy", live.at(-1)?.id)).toBe(false);
  // A refresh reads the windows again; what is retained stays known.
  await h.owner.capability.refresh();
  expect(snapshot("lone").observedCount).toBe(1);
  expect(inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 1 }),
  );
});

// A roster whose windows need a second request: the first carries the
// viewer's authored page and 127 windows, most recently read first.
const filler = Array.from({ length: 125 }, (_, i) => `f${i}`);
const fillerFrontiers = Object.fromEntries(filler.map((id) => [id, 1050]));

// Six remembered threads the viewer replied in, of 300 unread replies each
// outside the channel's full window and the roster sample, and 44 remembered threads with nothing:
// the hot tier, whose whole reads offer 1,194 replies to the 1,024-reply
// budget. `cold` roots are remembered behind them with the time given, so
// their reads are the last request, held until the six whole reads have
// landed; the authored page is since the walk mark, so only the viewer's
// replies in the busy threads are retained.
async function spentBudget(
  cold: readonly (readonly [RelayEvent, number])[],
  events: readonly RelayEvent[],
) {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["c0"],
    frontiers: { c0: 5000 },
    storage,
    sampled: false,
  });
  const busy = Array.from({ length: 6 }, (_, i) => event("c0", peer, 1000 + i));
  const peerReplies = new Set<string>();
  for (const [i, root] of busy.entries()) {
    h.store.push(root, reply("c0", viewer, 8500 + i, root));
    for (let j = 0; j < 300; j++) {
      const answer = reply("c0", peer, 5100 + j, root);
      peerReplies.add(answer.id);
      h.store.push(answer);
    }
  }
  h.store.push(...flood("c0", 100, 9000), ...events);
  const quiet = Array.from({ length: 44 }, (_, i): [string, ThreadMark] => [
    `c0:${"f".repeat(60)}${i.toString(16).padStart(4, "0")}`,
    { at: 6000 + i },
  ]);
  await remember(storage, {
    roots: new Map<string, ThreadMark>([
      ...quiet,
      ...busy.map((root, i): [string, ThreadMark] => [
        `c0:${root.id}`,
        { at: 7000 + i },
      ]),
      ...cold.map(([root, at]): [string, ThreadMark] => [
        `c0:${root.id}`,
        { at },
      ]),
    ]),
    walk: { since: 8000 },
  });
  const release = h.hold("cold");
  const done = h.owner.capability.ensure();
  try {
    await vi.waitFor(() =>
      expect(
        busy.every((root) =>
          h
            .filters()
            .some(
              (filter) =>
                filter["#e"]?.[0] === root.id &&
                filter["#e"].length === 1 &&
                filter.since === undefined,
            ),
        ),
      ).toBe(true),
    );
  } finally {
    release();
  }
  await done;
  const items = () => h.owner.capability.inbox().items;
  const busyReplies = new Set(
    items()
      .filter((item) => busy.some((root) => root.id === item.rootId))
      .flatMap((item) => item.messageIds)
      .filter((id) => peerReplies.has(id)),
  ).size;
  return { h, items, busyReplies };
}

it("a thread whose read lands after busier threads spent the budget still gets its newest unread reply", async () => {
  const root = event("c0", peer, 1000);
  const answer = reply("c0", peer, 5050, root);
  // The thread's newest reply is the viewer's, read; the one before it is a
  // peer's, unread. Its slot was kept while the busier threads read.
  const { items, busyReplies } = await spentBudget(
    [[root, 1010]],
    [
      root,
      reply("c0", viewer, 1010, root),
      answer,
      reply("c0", viewer, 5060, root),
    ],
  );
  expect(busyReplies).toBe(1023);
  await vi.waitFor(() =>
    expect(items()).toContainEqual(
      expect.objectContaining({
        rootId: root.id,
        unreadCount: 1,
        messageIds: [answer.id],
      }),
    ),
  );
});

it("a large cold set keeps at most a quarter of the budget from the hot landing, and its landing threads still each admit one reply", async () => {
  // 950 remembered threads behind the hot ones, their reads held while the
  // six whole reads land: the landings still fill three quarters of the
  // budget, rather than the 74 slots the whole cold set would leave. Five of
  // the cold threads, in the first cold request to land (the most recently
  // written in), have an unread reply each: with 822 roots still pending
  // the reserve is at its cap, but a landing root's one slot is drawn on
  // the whole budget, not on the budget less the reserve, which is spent.
  // The viewer's own reply in each, at the thread's mark, is not admitted;
  // the membership lookup finds it and the row shows.
  const cold = Array.from(
    { length: 950 },
    (_, i) => [event("c0", peer, 100 + i), 500 + i] as const,
  );
  const answered = cold.slice(945).map(([root]) => root);
  const answers = answered.map((root, i) => reply("c0", peer, 5050 + i, root));
  const { items, busyReplies } = await spentBudget(cold, [
    ...answered,
    ...answered.map((root, i) => reply("c0", viewer, 1445 + i, root)),
    ...answers,
  ]);
  expect(busyReplies).toBe(768);
  await vi.waitFor(() => {
    for (const [i, root] of answered.entries())
      expect(items()).toContainEqual(
        expect.objectContaining({
          rootId: root.id,
          unreadCount: 1,
          messageIds: [answers[i]?.id],
        }),
      );
  });
});

it("a dropped first request still lets the Inbox leave loading", async () => {
  const h = await setup({
    channels: ["c1", "c0", ...filler, "quiet"],
    frontiers: { c1: 1000, c0: 1000, ...fillerFrontiers, quiet: 900 },
  });
  h.store.push(event("quiet", peer, 1100, [["p", viewer]]));
  // The request carrying the authored page and c1 fails both reads; the
  // second request, quiet's window, lands, and so does the roster sample,
  // which names c1 first but, having no start, claims nothing of it.
  h.failing.add("c1");
  await h.owner.capability.ensure();
  expect(h.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
    partial: true,
    items: [expect.objectContaining({ channelId: "quiet", unreadCount: 1 })],
  });
  expect(
    h
      .filters()
      .filter(
        (filter) => filter["#h"]?.[0] === "c1" && filter.since !== undefined,
      ),
  ).toHaveLength(2);
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "c1" }),
  ).toMatchObject({ coverage: "unknown", observedCount: null });
});

it("replies of a thread never show as rows of their own while the repair fetches its root", async () => {
  const h = await setup({
    channels: ["other", "second"],
    frontiers: { other: 1005, second: 1000 },
  });
  // The root predates other's read mark, so the window returns the replies
  // alone; the viewer's reply in the authored page makes them the viewer's
  // conversation, and the thread read it teaches fetches the root.
  const root = event("other", peer, 1000);
  h.store.push(
    root,
    reply("other", viewer, 1010, root),
    ...Array.from({ length: 3 }, (_, i) =>
      reply("other", peer, 1020 + i, root),
    ),
    event("second", peer, 1100, [["p", viewer]]),
  );
  const counts: number[] = [];
  const inbox = () => h.owner.capability.inbox();
  h.owner.capability.subscribeInbox(() => counts.push(inbox().items.length));
  const read = h.reader.read.getMockImplementation();
  assert(read);
  h.reader.read.mockImplementation(async (filters: readonly ReadFilter[]) => {
    counts.push(inbox().items.length);
    return read(filters);
  });
  await h.owner.capability.ensure();
  expect(inbox().items).toEqual([
    expect.objectContaining({ channelId: "second", unreadCount: 1 }),
    expect.objectContaining({ rootId: root.id, unreadCount: 3 }),
  ]);
  expect(Math.max(...counts)).toBeLessThanOrEqual(2);
  expect(
    h.filters().filter((filter) => filter["#e"]?.[0] === root.id),
  ).toHaveLength(1);
});

it("a first run with a large roster sizes each window so the pass fits the budget, and a quiet channel's mention survives", async () => {
  const ids = Array.from({ length: 41 }, (_, i) => `c${i}`);
  const h = await setup({ channels: ids, frontiers: {} });
  const floor = NOW - 7 * 24 * 60 * 60;
  const mention = event("c0", peer, floor + 10, [["p", viewer]]);
  h.store.push(mention);
  for (let i = 1; i < ids.length; i++)
    h.store.push(...flood(`c${i}`, 100, floor + 1000 * i));
  await h.owner.capability.ensure();
  const windows = h.filters().filter((filter) => filter.since !== undefined);
  expect(windows).toHaveLength(41);
  // floor(3072 / 41): forty pages of 74 and the mention all fit in 4,096.
  for (const window of windows)
    expect(window).toMatchObject({ since: floor, limit: 74 });
  const inbox = h.owner.capability.inbox();
  expect(inbox).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox.items).toContainEqual(
    expect.objectContaining({
      channelId: "c0",
      messageIds: [mention.id],
      unreadCount: 1,
    }),
  );
  // A window holds its page; the roster sample adds the newest 500, the
  // five newest channels' 100 each.
  const observed = (channelId: string) =>
    h.owner.capability.snapshot({ kind: "channel", channelId }).observedCount;
  expect(observed("c35")).toBe(74);
  expect(observed("c36")).toBe(100);
  expect(observed("c40")).toBe(100);
});

it("remembered participation is saved and refetches the thread after the authored page moves on", async () => {
  const storage = memoryUnreadStorage();
  const save = vi.spyOn(storage, "save");
  const first = await setup({
    channels: ["c0"],
    frontiers: { c0: 1015 },
    storage,
  });
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  // A thread page of later replies: the thread read reaches none older.
  const answers = Array.from({ length: 200 }, (_, i) =>
    reply("c0", peer, 1020 + i, root),
  );
  first.store.push(root, mine, ...answers);
  await first.owner.capability.ensure();
  expect(first.owner.capability.inbox().items).toContainEqual(
    expect.objectContaining({ rootId: root.id, unreadCount: 200 }),
  );
  // Remembered as of the viewer's reply: the unread answers advance nothing.
  expect(save).toHaveBeenCalledWith({
    participation: {
      roots: new Map([[`c0:${root.id}`, { at: 1010, newestId: mine.id }]]),
      walk: { since: 1010 },
    },
  });
  first.owner.dispose();
  // A later session: the viewer has since written a page of newer messages
  // elsewhere, so their authored page no longer reaches the old reply, which
  // the thread page ends before as well; the replies have been read since.
  const second = await setup({
    channels: ["c0"],
    frontiers: { c0: 1300 },
    storage,
    authoredPage: false,
    sampled: false,
  });
  second.store.push(...first.store);
  await second.owner.capability.ensure();
  expect(second.filters()).toContainEqual(
    expect.objectContaining({ "#h": ["c0"], "#e": [root.id] }),
  );
  // The viewer's membership is looked up and verified, so the read thread
  // stays in the Inbox.
  await vi.waitFor(() =>
    expect(second.owner.capability.inbox().items).toContainEqual(
      expect.objectContaining({ rootId: root.id, unreadCount: 0 }),
    ),
  );
  expect(second.filters()).toContainEqual(
    expect.objectContaining({
      authors: [viewer],
      "#h": ["c0"],
      "#e": expect.arrayContaining([root.id]),
    }),
  );
});

// A viewer with 140 threads behind 480 later one-liners: the newest page is
// one-liners only, so only the walk reaches the threads.
function history(h: Awaited<ReturnType<typeof setup>>) {
  const roots = Array.from({ length: 140 }, (_, i) =>
    event(i % 2 ? "b" : "a", peer, 1000 + i),
  );
  const mine = roots.map((root, i) =>
    reply(root.tags[0]?.[1] ?? "", viewer, 2000 + i, root),
  );
  const notes = Array.from({ length: 480 }, (_, i) =>
    event("a", viewer, 3000 + i),
  );
  h.store.push(...roots, ...mine, ...notes);
  return { roots, mine, notes };
}

it("a device's first repair walks the viewer's history behind the windows, remembering every thread they replied in, and reads new replies in the older ones", async () => {
  const storage = memoryUnreadStorage();
  const h = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
    sampled: false,
  });
  const { roots, notes } = history(h);
  // A peer answered the oldest thread since; the others are quiet.
  const [oldest, quiet] = roots as [RelayEvent, RelayEvent];
  const answer = reply("a", peer, 9500, oldest);
  h.store.push(answer);
  await h.owner.capability.ensure();
  const requests = h.reader.read.mock.calls.map(([filters]) => filters);
  // Today's page first, then two keyset pages of 500 behind the windows:
  // the third is short, so the walk ends.
  expect(requests[0]?.[0]).toEqual({
    kinds: [9, 40002, 40008],
    authors: [viewer],
    include_aux: true,
    limit: 100,
  });
  const pages = requests.filter((request) =>
    request.some((filter) => filter.until !== undefined),
  );
  expect(pages).toEqual([
    [
      expect.objectContaining({
        authors: [viewer],
        until: 3380,
        before_id: notes[380]?.id,
        limit: 500,
      }),
    ],
    [
      expect.objectContaining({
        authors: [viewer],
        until: 2020,
        before_id: h.store.find((item) => item.created_at === 2020)?.id,
        limit: 500,
      }),
    ],
  ]);
  const windows = requests.findIndex((request) =>
    request.some((filter) => filter["#h"] && !filter["#e"]),
  );
  expect(requests.indexOf(pages[0] as ReadFilter[])).toBeGreaterThan(windows);
  // The 50 newest threads are read whole with their roots; the other 90 are
  // each asked for replies since their newest time, and only the answered
  // thread's root is then fetched.
  const hot = h
    .filters()
    .filter(
      (filter) => filter["#e"] && !filter.authors && filter.since === undefined,
    );
  expect(hot.map((filter) => filter["#e"]?.length)).toEqual([25, 25]);
  expect(hot.every((filter) => filter.limit === 200)).toBe(true);
  const cold = h
    .filters()
    .filter((filter) => filter["#e"] && filter.since !== undefined);
  expect(cold).toHaveLength(90);
  expect(cold.at(-1)).toEqual(
    expect.objectContaining({
      "#h": ["a"],
      "#e": [oldest.id],
      since: 2000,
      limit: 50,
    }),
  );
  expect(cold).toContainEqual(
    expect.objectContaining({ "#h": ["b"], "#e": [quiet.id], since: 2001 }),
  );
  // Each cold read is inclusive of the thread's newest time, which the walk
  // taught from the viewer's reply, so that reply returns and is passed over
  // by ID: the hot roots and the answered thread's are the ones fetched.
  const fetched = h.filters().flatMap((filter) => filter.ids ?? []);
  expect(fetched).toHaveLength(51);
  expect(fetched).toContain(oldest.id);
  expect(fetched).not.toContain(quiet.id);
  const inbox = () => h.owner.capability.inbox();
  expect(inbox()).toMatchObject({ status: "ready", freshness: "observed" });
  expect(inbox().partial).toBeUndefined();
  // The viewer's reply is older than the read reaches, so their membership
  // is looked up; the read answer then shows under its fetched root.
  await vi.waitFor(() =>
    expect(inbox().items).toContainEqual(
      expect.objectContaining({
        rootId: oldest.id,
        messageIds: [answer.id],
        unreadCount: 0,
      }),
    ),
  );
  // A cold thread the viewer has read is not a row until it gets a reply
  // they have not read; see docs/inbox.md.
  expect(
    inbox().items.find((item) => item.rootId === quiet.id),
  ).toBeUndefined();
  // The walk's pages are not evidence: the one-liners outside the window are
  // not retained, so channel a's count stays that of its window.
  expect(
    h.owner.capability.snapshot({ kind: "channel", channelId: "a" })
      .observedCount,
  ).toBe(0);
  const saved = await remembered(storage);
  expect(saved.roots.size).toBe(140);
  expect(saved.roots.get(`a:${oldest.id}`)).toEqual({
    at: 9500,
    newestId: answer.id,
  });
  expect(saved.roots.get(`b:${quiet.id}`)).toEqual({
    at: 2001,
    newestId: h.store.find((item) => item.created_at === 2001)?.id,
  });
  expect(saved.walk).toEqual({ since: 3479 });
  h.owner.dispose();
  // The next repair reads only what was authored since the walk — the mark
  // itself repeats, as `since` is inclusive — and walks no further.
  const second = await setup({
    channels: ["a", "b"],
    frontiers: { a: 9600, b: 9600 },
    storage,
  });
  second.store.push(...h.store);
  const late = event("b", peer, 9000);
  second.store.push(late, reply("b", viewer, 9700, late));
  await second.owner.capability.ensure();
  const again = second.reader.read.mock.calls.map(([filters]) => filters);
  expect(again[0]?.[0]).toMatchObject({
    authors: [viewer],
    since: 3479,
    limit: 100,
  });
  expect(
    second.filters().filter((filter) => filter.until !== undefined),
  ).toEqual([]);
  // The 50 newest remembered threads by channel, then the thread the page
  // just taught; the other 90 are asked one by one.
  expect(
    second
      .filters()
      .filter((filter) => filter["#e"] && !filter.authors && !filter.since),
  ).toHaveLength(3);
  expect(
    second.filters().filter((filter) => filter["#e"] && filter.since),
  ).toHaveLength(90);
  expect(await remembered(second.storage)).toMatchObject({
    walk: { since: 9700 },
  });
  expect((await remembered(storage)).roots.size).toBe(141);
});

// A remembered thread outside the 50 most recently active, so the repair asks
// it for replies since its newest time rather than reading it whole: 50 newer
// threads are remembered beside it, and the walk mark is past everything.
async function coldThread(
  storage: UnreadStorage,
  channelId: string,
  root: RelayEvent,
  at: number,
  newestId?: string,
) {
  const newer = Array.from({ length: 50 }, (_, i): [string, ThreadMark] => [
    `${channelId}:${"f".repeat(60)}${i.toString(16).padStart(4, "0")}`,
    { at: 5000 + i },
  ]);
  await remember(storage, {
    roots: new Map([
      ...newer,
      [`${channelId}:${root.id}`, newestId ? { at, newestId } : { at }],
    ]),
    walk: { since: 6000 },
  });
}
const coldReads = (h: Awaited<ReturnType<typeof setup>>, root: RelayEvent) =>
  h
    .filters()
    .filter(
      (filter) =>
        filter["#e"]?.length === 1 &&
        filter["#e"][0] === root.id &&
        filter.since !== undefined,
    );

it("a cold thread's unread replies return on every launch until read; read, the newest is passed over on the next", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  await coldThread(storage, "c0", root, 1010, mine.id);
  const answers = Array.from({ length: 3 }, (_, i) =>
    reply("c0", peer, 2000 + i, root),
  );
  const newest = answers[2];
  assert(newest);
  const history = [root, mine, ...answers, ...flood("c0", 100, 3000)];
  const launch = async (frontiers: Readonly<Record<string, number>>) => {
    const h = await setup({
      channels: ["c0"],
      frontiers,
      storage,
      sampled: false,
    });
    h.store.push(...history);
    await h.owner.capability.ensure();
    return h;
  };
  type Launch = Awaited<ReturnType<typeof launch>>;
  const row = (h: Launch) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const fetched = (h: Launch) =>
    h.filters().flatMap((filter) => filter.ids ?? []);
  const mark = async () =>
    (await remembered(storage)).roots.get(`c0:${root.id}`);
  // A session admits the three unread replies; they advance nothing.
  const first = await launch({ c0: 1500 });
  await vi.waitFor(() => expect(row(first)).toMatchObject({ unreadCount: 3 }));
  expect(await mark()).toEqual({ at: 1010, newestId: mine.id });
  first.owner.dispose();
  // Relaunched with nothing retained, the cold read returns all three again.
  const second = await launch({ c0: 1500 });
  expect(coldReads(second, root)).toEqual([
    expect.objectContaining({ since: 1010 }),
  ]);
  expect(fetched(second)).toContain(root.id);
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 3,
      messageIds: expect.arrayContaining(answers.map((answer) => answer.id)),
    }),
  );
  second.owner.dispose();
  // Read through the newest on another device, the replies return once more,
  // read, and the repair learns the newest as the boundary.
  const read = { c0: 1500, [`thread:${root.id}`]: 2002 };
  const third = await launch(read);
  expect(coldReads(third, root)).toEqual([
    expect.objectContaining({ since: 1010 }),
  ]);
  await vi.waitFor(() => expect(row(third)).toMatchObject({ unreadCount: 0 }));
  expect(await mark()).toEqual({ at: 2002, newestId: newest.id });
  third.owner.dispose();
  // On the next launch the boundary alone returns and is passed over: no
  // root fetched, no row.
  const fourth = await launch(read);
  expect(coldReads(fourth, root)).toEqual([
    expect.objectContaining({ since: 2002 }),
  ]);
  expect(fourth.owner.capability.inbox()).toMatchObject({
    status: "ready",
    freshness: "observed",
  });
  expect(fetched(fourth)).not.toContain(root.id);
  expect(row(fourth)).toBeUndefined();
  expect(await mark()).toEqual({ at: 2002, newestId: newest.id });
});

it("a cold thread's boundary reply marked unread on this device is admitted on the next launch, not passed over", async () => {
  const storage = memoryUnreadStorage();
  const root = event("c0", peer, 1000);
  const mine = reply("c0", viewer, 1010, root);
  const answer = reply("c0", peer, 2000, root);
  await coldThread(storage, "c0", root, 1010, mine.id);
  const history = [root, mine, answer, ...flood("c0", 100, 3000)];
  // The thread was read through the answer on another device.
  const frontiers = { c0: 1500, [`thread:${root.id}`]: 2000 };
  const launch = async (localUnread: Readonly<Record<string, number>> = {}) => {
    const h = await setup({
      channels: ["c0"],
      frontiers,
      storage,
      localUnread,
    });
    h.store.push(...history);
    await h.owner.capability.ensure();
    return h;
  };
  type Launch = Awaited<ReturnType<typeof launch>>;
  const row = (h: Launch) =>
    h.owner.capability.inbox().items.find((item) => item.rootId === root.id);
  const mark = async () =>
    (await remembered(storage)).roots.get(`c0:${root.id}`);
  // The read answer is the thread's newest reply: the repair learns it as
  // the boundary. Marked unread here, it counts at once.
  const first = await launch();
  await vi.waitFor(() => expect(row(first)).toMatchObject({ unreadCount: 0 }));
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
  await first.owner.capability.markUnreadLocal({
    kind: "message",
    channelId: "c0",
    messageId: answer.id,
  });
  expect(row(first)).toMatchObject({ unreadCount: 1, manual: true });
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
  first.owner.dispose();
  // Relaunched, the cold read returns the boundary alone; still marked
  // unread on this device, it is admitted under its fetched root and its
  // mark does not pass it.
  const second = await launch({ [`msg:${answer.id}`]: 1 });
  expect(coldReads(second, root)).toEqual([
    expect.objectContaining({ since: 2000 }),
  ]);
  await vi.waitFor(() =>
    expect(row(second)).toMatchObject({
      unreadCount: 1,
      manual: true,
      messageIds: [answer.id],
    }),
  );
  expect(await mark()).toEqual({ at: 2000, newestId: answer.id });
});
