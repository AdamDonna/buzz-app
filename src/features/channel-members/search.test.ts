import { expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { createRelaySession } from "../relay/session";
import { keypair, profile } from "../relay/testing";
import type { ReadFilter } from "../relay/events";
import { searchMembers, MEMBER_SEARCH_PAGE_SIZE } from "./search";

it("uses the server prefix-search page, distinguishes namesakes, ranks exact names, and reports another page", async () => {
  const viewer = keypair(),
    relay = keypair();
  const rows = Array.from({ length: MEMBER_SEARCH_PAGE_SIZE }, (_, i) =>
    profile(keypair(), { name: i === 2 ? "Morgan" : "Morgan Martin" }),
  );
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => rows);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
  });
  try {
    const result = await searchMembers(
      owner.session,
      "Morgan",
      2,
      new AbortController().signal,
    );
    expect(query.mock.calls[0]?.[0]).toEqual([
      {
        kinds: [0],
        search: "Morgan",
        search_mode: "prefix",
        page: 2,
        limit: MEMBER_SEARCH_PAGE_SIZE,
      },
    ]);
    expect(result.people).toHaveLength(MEMBER_SEARCH_PAGE_SIZE);
    expect(result.people[0]?.name).toBe("Morgan");
    expect(result.more).toBe(true);
  } finally {
    owner.dispose();
  }
});
it.each([
  ["an npub", (pubkey: string) => nip19.npubEncode(pubkey)],
  ["a nostr: npub", (pubkey: string) => `nostr:${nip19.npubEncode(pubkey)}`],
  ["uppercase hex", (pubkey: string) => pubkey.toUpperCase()],
])(
  "resolves an exact key from %s without searching its display text",
  async (_case, typed) => {
    const viewer = keypair(),
      relay = keypair(),
      person = keypair();
    const query = vi.fn(async (_filters: readonly ReadFilter[]) => [
      profile(person, { name: "Morgan" }),
    ]);
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
    });
    try {
      const result = await searchMembers(
        owner.session,
        typed(person.pubkey),
        1,
        new AbortController().signal,
      );
      expect(query.mock.calls[0]?.[0]).toEqual([
        {
          kinds: [0],
          authors: [person.pubkey],
          limit: MEMBER_SEARCH_PAGE_SIZE,
        },
      ]);
      expect(result.people[0]?.pubkey).toBe(person.pubkey);
      expect(result.more).toBe(false);
    } finally {
      owner.dispose();
    }
  },
);
it("propagates a failed search instead of displaying no matches", async () => {
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => {
      throw new Error("Offline");
    },
  });
  try {
    await expect(
      searchMembers(owner.session, "Morgan", 1, new AbortController().signal),
    ).rejects.toThrow("Offline");
  } finally {
    owner.dispose();
  }
});
