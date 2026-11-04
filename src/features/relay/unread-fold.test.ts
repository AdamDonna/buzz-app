import { verifiedSymbol } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelQueries, ChannelSummary } from "./contracts";
import type { EventData, RelayEvent } from "./events";
import { createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "./read-state-storage";
import { createUnread } from "./unread";

// What the unread owner hands `foldMessages` for each channel.
const folds = vi.hoisted(() => ({
  calls: [] as { channelId: string; events: readonly EventData[] }[],
}));
vi.mock("./fold", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fold")>();
  return {
    ...actual,
    foldMessages: (
      ...[channelId, relayAuthor, events, options]: Parameters<
        typeof actual.foldMessages
      >
    ) => {
      folds.calls.push({ channelId, events });
      return actual.foldMessages(channelId, relayAuthor, events, options);
    },
  };
});

// Events are marked verified instead of signed, as in unread-repair.test.ts.
let next = 0;
function event(
  kind: number,
  pubkey: string,
  created_at: number,
  tags: string[][],
  content = "",
): RelayEvent {
  return {
    id: (next++).toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at,
    content,
    tags,
    sig: "0".repeat(128),
    [verifiedSymbol]: true,
  };
}
const viewer = "a".repeat(64),
  alice = "b".repeat(64);
const post = (
  channelId: string,
  pubkey: string,
  at: number,
  content: string,
  tags: string[][] = [],
) => event(9, pubkey, at, [["h", channelId], ...tags], content);
const mention = (channelId: string, at: number, content: string) =>
  post(channelId, alice, at, content, [["p", viewer]]);
const reply = (
  channelId: string,
  root: RelayEvent,
  at: number,
  content: string,
  tags: string[][] = [],
) =>
  post(channelId, alice, at, content, [["e", root.id, "", "reply"], ...tags]);
const edit = (channelId: string, target: RelayEvent, at: number) =>
  event(
    40003,
    alice,
    at,
    [
      ["h", channelId],
      ["e", target.id],
    ],
    "edited",
  );
// With no `h`, as a deletion may be sent; the relay files it under its target.
const deletion = (target: RelayEvent, at: number) =>
  event(5, alice, at, [["e", target.id]]);

const owners: ReturnType<typeof createUnread>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  folds.calls = [];
});

async function setup(
  list: readonly Pick<ChannelSummary, "id" | "channelType">[],
) {
  let journal: ReadJournal | undefined = newReadJournal();
  const reader = { read: vi.fn(async () => [] as RelayEvent[]) };
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
  const channels: ChannelQueries = {
    list: () => ({
      status: "ready" as const,
      channels: list.map((channel) => ({
        ...channel,
        name: channel.id,
        members: [viewer],
      })),
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
  const owner = createUnread({ reads, channels, reader, viewer });
  owners.push(owner);
  return owner;
}

it("with 2,000 retained events across 80 channels, the Inbox folds each channel's own events and the edits and deletions on them", async () => {
  const ids = Array.from({ length: 80 }, (_, index) => `c${index}`);
  const owner = await setup(ids.map((id) => ({ id })));
  const expected = new Map<string, Set<RelayEvent>>();
  const fixture = ids.flatMap((id) => {
    const root = post(id, viewer, 1000, "my thread");
    const replies = Array.from({ length: 18 }, (_, index) =>
      reply(
        id,
        root,
        1001 + index,
        `${index}`,
        index % 3 ? [] : [["p", viewer]],
      ),
    );
    const top = mention(id, 1100, "top");
    const [first, second, third, removed] = replies as [
      RelayEvent,
      RelayEvent,
      RelayEvent,
      RelayEvent,
    ];
    const edits = [first, second, third].map((target, index) =>
      edit(id, target, 1200 + index),
    );
    const overlays = [
      ...edits,
      deletion(removed, 1300),
      deletion(edits[0] as RelayEvent, 1301),
    ];
    const events = [root, ...replies, top, ...overlays];
    // The deleted reply and its deletion are no row and not folded.
    expect(events).toHaveLength(25);
    expected.set(
      id,
      new Set(
        events.filter((item) => item !== removed && item !== overlays[3]),
      ),
    );
    return events;
  });
  expect(fixture).toHaveLength(2000);
  owner.accept(fixture);
  expect(fixture.every((item) => owner.event(item.id))).toBe(true);
  expect(owner.capability.activity("c7").items).toHaveLength(1);
  expect(folds.calls).toHaveLength(1);
  expect(new Set(folds.calls[0]?.events)).toEqual(expected.get("c7"));
  folds.calls = [];
  const inbox = owner.capability.inbox();
  // A thread row and a mention row in each channel.
  expect(inbox.items).toHaveLength(160);
  // c7's rows are reused from its activity until the evidence changes.
  expect(folds.calls.map(({ channelId }) => channelId).sort()).toEqual(
    ids.filter((id) => id !== "c7").sort(),
  );
  for (const { channelId, events } of folds.calls) {
    expect(events.length).toBeLessThanOrEqual(25);
    expect(new Set(events)).toEqual(expected.get(channelId));
  }
});
