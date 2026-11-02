// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import { ChannelMemberAvatars } from "./ChannelMemberAvatars";

afterEach(cleanup);

it("keeps the people preview and overflow current as profiles and membership arrive", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let members = ["alice", "bob", "carol", "dana", "agent", "remote-agent"];
  let list = { channels: [{ id: "channel", members }] };
  let profiles = new Map<
    string,
    { name: string; picture?: string; isAgent?: boolean }
  >([
    ["alice", { name: "Alice" }],
    ["bob", { name: "Bob" }],
    ["carol", { name: "Carol" }],
    ["dana", { name: "Dana" }],
    ["remote-agent", { name: "Remote agent", isAgent: true }],
  ]);
  const choices = { identities: [{ pubkey: "agent" }] };
  const session = {
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  render(<ChannelMemberAvatars session={session} channelId="channel" />);
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    members,
    "background",
  );
  expect(screen.getByTitle("Alice")).toBeInTheDocument();
  expect(screen.getByTitle("Bob")).toBeInTheDocument();
  expect(screen.getByTitle("Carol")).toBeInTheDocument();
  expect(screen.queryByTitle("Dana")).not.toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();

  act(() => {
    profiles = new Map(profiles).set("dana", {
      name: "Dana",
      picture: "https://example.test/dana.png",
    });
    for (const listener of listeners) listener();
  });
  expect(screen.getByTitle("Dana").querySelector("img")).toHaveAttribute(
    "src",
    "https://example.test/dana.png",
  );
  expect(screen.queryByTitle("Carol")).not.toBeInTheDocument();
  expect(screen.getByText("+1")).toBeInTheDocument();

  act(() => {
    members = ["bob"];
    list = { channels: [{ id: "channel", members }] };
    for (const listener of listeners) listener();
  });
  expect(session.profiles.ensure).toHaveBeenLastCalledWith(
    ["bob"],
    "background",
  );
  expect(screen.getByTitle("Bob")).toBeInTheDocument();
  expect(screen.queryByTitle("Dana")).not.toBeInTheDocument();
  expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
});

it("leads a Solo chat with its owner and keeps the people icon until it is shared", () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let list: {
    channels: {
      id: string;
      channelType: string;
      owner?: string;
      creator: string;
      members: string[];
    }[];
  } = {
    channels: [
      { id: "chat", channelType: "solo", creator: "me", members: ["me"] },
    ],
  };
  const profiles = new Map([
    ["me", { name: "Me" }],
    ["owner", { name: "Owner" }],
    ["alice", { name: "Alice", picture: "https://example.test/alice.png" }],
  ]);
  const choices = { identities: [] };
  const session = {
    viewer: "me",
    channels: { subscribeList: subscribe, list: () => list },
    profiles: {
      subscribe,
      snapshot: () => profiles,
      ensure: vi.fn().mockResolvedValue(undefined),
    },
    agentChoices: { subscribe, snapshot: () => choices },
    media: (url: string) => url,
  } as unknown as RelaySession;
  const { container } = render(
    <ChannelMemberAvatars session={session} channelId="chat" />,
  );
  expect(screen.queryByTitle("Me")).not.toBeInTheDocument();
  expect(container.querySelector("svg")).toBeInTheDocument();

  // Someone else's chat: the owner leads, ahead of people with photos.
  act(() => {
    list = {
      channels: [
        {
          id: "chat",
          channelType: "solo",
          creator: "owner",
          members: ["alice", "me", "owner"],
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getAllByTitle(/^(Owner|Alice|Me)$/).map((item) => item.title),
  ).toEqual(["Owner", "Alice", "Me"]);

  // The roster's owner outranks the creator, who may have handed it on.
  act(() => {
    list = {
      channels: [
        {
          id: "chat",
          channelType: "solo",
          owner: "alice",
          creator: "owner",
          members: ["alice", "me", "owner"],
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(
    screen.getAllByTitle(/^(Owner|Alice|Me)$/).map((item) => item.title)[0],
  ).toBe("Alice");
});
