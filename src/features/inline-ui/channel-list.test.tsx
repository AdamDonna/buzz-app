// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelList,
  ChannelQueries,
  ChannelReference,
} from "../relay/contracts";
import {
  INLINE_LIST_PAGE,
  inlineChannelPage,
  useInlineChannelList,
} from "./channel-list";

afterEach(cleanup);

const id = (index: number) =>
  `0000000${index.toString(16)}-0000-4000-8000-000000000000`;
const ids = Array.from({ length: 12 }, (_, index) => id(index));
const found = (name: string, extra: Partial<ChannelReference> = {}) =>
  ({
    state: "found",
    name,
    private: false,
    hidden: false,
    archived: false,
    joined: false,
    ...extra,
  }) as ChannelReference;

describe("Inline UI channel list", () => {
  it("pages the listed channels as the viewer's lookup describes them", () => {
    const answers = new Map<string, ChannelReference>([
      [id(0), found("general", { joined: true, members: 40 })],
      [id(1), { state: "withheld" }],
      [id(2), found("Alice", { channelType: "dm", hidden: true })],
      [id(3), found("old", { archived: true })],
    ]);
    const describe = (id: string) =>
      answers.get(id) ?? { state: "unknown" as const };
    const first = inlineChannelPage(describe, ids, 0);
    expect(first).toMatchObject({ count: 12, page: 0, pages: 3 });
    expect(first.rows).toHaveLength(INLINE_LIST_PAGE);
    expect(first.rows.slice(0, 5)).toEqual([
      {
        id: id(0),
        state: "found",
        name: "general",
        joined: true,
        archived: false,
        members: 40,
      },
      { id: id(1), state: "withheld" },
      // A conversation is never offered as a channel.
      { id: id(2), state: "withheld" },
      {
        id: id(3),
        state: "found",
        name: "old",
        joined: false,
        archived: true,
      },
      { id: id(4), state: "unknown" },
    ]);
    expect(
      inlineChannelPage(describe, ids, 2).rows.map((row) => row.id),
    ).toEqual(ids.slice(10));
    // Out-of-range pages clamp.
    expect(inlineChannelPage(describe, ids, 9).page).toBe(2);
    expect(inlineChannelPage(describe, ids, -1).page).toBe(0);
  });

  it("stays current and asks the store only for the shown page's unresolved channels", () => {
    let list: ChannelList = { status: "loading", channels: [] };
    const answers = new Map<string, ChannelReference>();
    const listeners = new Set<() => void>();
    const notify = () => {
      list = { ...list };
      for (const listener of listeners) listener();
    };
    const release = vi.fn();
    const refer = vi.fn((_id: string) => release);
    const queries = {
      list: () => list,
      describe: (id: string) => answers.get(id) ?? { state: "unknown" },
      refer,
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as ChannelQueries;
    const { result, rerender } = renderHook(
      ({ page }) => useInlineChannelList(queries, ids.slice(0, 7), page),
      { initialProps: { page: 0 } },
    );
    // Discovery owns access: nothing is demanded until the list is ready.
    expect(refer).not.toHaveBeenCalled();
    act(() => {
      list = { status: "ready", channels: [] };
      notify();
    });
    expect(refer.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 5));
    act(() => {
      answers.set(id(0), found("general"));
      notify();
    });
    expect(result.current.rows[0]).toMatchObject({
      state: "found",
      name: "general",
    });
    const before = result.current;
    act(notify);
    // An unrelated list change keeps the same page.
    expect(result.current).toBe(before);
    refer.mockClear();
    release.mockClear();
    rerender({ page: 1 });
    expect(release).toHaveBeenCalled();
    expect(refer.mock.calls.map(([id]) => id)).toEqual(ids.slice(5, 7));
    expect(result.current).toMatchObject({ page: 1, pages: 2, count: 7 });
  });
});
