// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { checkinHourly, memory, withFeature } from "./features";
import {
  formerWithSettings,
  rememberNewBestie,
  stopFormerCheckIns,
} from "./former";

afterEach(() => localStorage.clear());

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const DM = "0f0f0f0f-0000-4000-8000-000000000001";
const TIMER = {
  "interest/bestie-hourly-check-in": { type: "interest" },
  "watch/bestie-hourly-check-in": { type: "timer", channel: DM },
};
const checkingIn = withFeature(
  withFeature("Be brief.\n", memory, true),
  checkinHourly,
  true,
);
const agent = (digit: string, instructions = "", attention = {}): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name: digit,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
    attention,
    config: { instructions },
  }) as unknown as Agent;
const ada = agent("a", checkingIn, TIMER);
const bea = agent("b");

/** A community whose account read of the saved Bestie waits until `settle`. */
function community(channels: readonly ChannelSummary[] = [], account = true) {
  let settle: (pubkey: string | undefined) => void = () => {};
  const read = new Promise<string | undefined>((resolve) => {
    settle = resolve;
  });
  const session = {
    viewer: OWNER,
    ...(account && {
      mainAgent: { read: () => read, write: vi.fn(async () => {}) },
    }),
    channels: {
      list: () => ({ channels }),
      subscribeList: () => () => {},
      ensureList: () => {},
    },
  };
  const snapshot = { status: "ready", scope: SCOPE, session };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  return {
    relay,
    snapshot: snapshot as unknown as RelaySnapshot,
    settle: async (pubkey: string | undefined) => {
      settle(pubkey);
      await read;
      await Promise.resolve();
    },
  };
}

function host(list: Agent[], running: Agent[] = []) {
  let agents = list;
  const listeners = new Set<() => void>();
  const save = vi.fn<Agents["save"]>(async (key, change) => {
    agents = agents.map((each) =>
      each.key !== key
        ? each
        : ({
            ...each,
            ...(change.config !== undefined && { config: change.config }),
            ...(change.attention && {
              attention: Object.fromEntries(
                Object.entries({
                  ...each.attention,
                  ...change.attention,
                }).filter(([, value]) => value),
              ),
            }),
          } as Agent),
    );
    for (const listener of listeners) listener();
  });
  return {
    save,
    /** The agents' listeners are told, with nothing changed. */
    notify: () => {
      for (const listener of listeners) listener();
    },
    agents: {
      save,
      types: () => [{ key: "test/echo", adopt: () => ({}) }],
      snapshot: () => ({ agents, running: [...agents, ...running] }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } as unknown as Pick<Agents, "save" | "types" | "snapshot" | "subscribe">,
  };
}

it("stops a former Bestie's check-ins once the Bestie is known, and leaves its memory", async () => {
  const { relay, settle } = community();
  const { agents, save, notify } = host([ada, bea]);
  const stop = stopFormerCheckIns(relay, agents);
  // While the saved Bestie is being read, nobody is former.
  await Promise.resolve();
  expect(save).not.toHaveBeenCalled();
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-hourly-check-in": null,
          "watch/bestie-hourly-check-in": null,
        },
      },
    ],
    [
      ada.key,
      { config: { instructions: withFeature("Be brief.\n", memory, true) } },
    ],
  ]);
  // Once stopped there is nothing more to do.
  save.mockClear();
  notify();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("does nothing while the saved Bestie is unknown, or to the Bestie itself", async () => {
  const unknown = community();
  const first = host([ada]);
  const stopUnknown = stopFormerCheckIns(unknown.relay, first.agents);
  // An account with no saved Bestie, or a read that failed, isn't "none".
  await unknown.settle(undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(first.save).not.toHaveBeenCalled();
  stopUnknown();

  const known = community();
  const second = host([ada]);
  const stopKnown = stopFormerCheckIns(known.relay, second.agents);
  await known.settle(ada.pubkey);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(second.save).not.toHaveBeenCalled();
  stopKnown();
});

it("stops a timer left without its section, and doesn't retry a failed save until something changes", async () => {
  const { relay, settle } = community();
  const half = agent("c", "Be brief.", TIMER);
  const { agents, save, notify } = host([half]);
  save.mockRejectedValueOnce(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1);
  // The same state seen again isn't saved again.
  notify();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(1);
  stop();
  warn.mockRestore();
});

it("turns memory on for a local agent made Bestie here, unless it has it", async () => {
  const { relay } = community();
  const { agents, save } = host([ada, bea]);
  await rememberNewBestie(relay, agents, ada.pubkey);
  expect(save).not.toHaveBeenCalled();
  await rememberNewBestie(relay, agents, bea.pubkey);
  expect(save).toHaveBeenCalledWith(bea.key, {
    config: { instructions: withFeature("", memory, true) },
  });
  // A remote agent, or one in another community, is left alone.
  save.mockClear();
  await rememberNewBestie(relay, agents, "9".repeat(64));
  expect(save).not.toHaveBeenCalled();
  // Nor is one whose section was edited by hand: no second section.
  const edited = host([
    {
      ...bea,
      config: {
        instructions: withFeature("", memory, true).replace(
          "<!-- /buzz:bestie/memory -->",
          "",
        ),
      },
    } as Agent,
  ]);
  await rememberNewBestie(relay, edited.agents, bea.pubkey);
  expect(edited.save).not.toHaveBeenCalled();
});

it("counts a former Bestie as on while it has a section, or a private channel once seen as Bestie", async () => {
  const channel = {
    id: "c1",
    name: "plans",
    channelType: "stream",
    private: true,
    members: [OWNER, bea.pubkey],
  } as unknown as ChannelSummary;
  const { relay, snapshot, settle } = community([channel]);
  const { agents } = host([ada, bea]);
  expect(formerWithSettings(ada, snapshot)).toBe(true);
  // Any agent in a private channel isn't a former Bestie...
  expect(formerWithSettings(bea, snapshot)).toBe(false);
  // ...but one this device saw as Bestie is, once another one is.
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  expect(formerWithSettings(bea, snapshot)).toBe(true);
  expect(
    formerWithSettings({ ...bea, pubkey: "d".repeat(64) } as Agent, snapshot),
  ).toBe(false);
  stop();
});

it("leaves a Bestie kept only on this device alone, as an automatic pick looks the same", async () => {
  const { relay } = community([], false);
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([SCOPE, "solo:default-agent"])}`,
    JSON.stringify(bea.pubkey),
  );
  const { agents, save } = host([ada, bea]);
  const stop = stopFormerCheckIns(relay, agents);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).not.toHaveBeenCalled();
  stop();
});

it("stops only the timer of an agent also in another community, whose instructions it shares", async () => {
  const { relay, settle } = community();
  const elsewhere = { ...ada, relay: "wss://other.example" } as Agent;
  const { agents, save } = host([ada, bea], [elsewhere]);
  const stop = stopFormerCheckIns(relay, agents);
  await settle(bea.pubkey);
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save.mock.calls).toEqual([
    [
      ada.key,
      {
        attention: {
          "interest/bestie-hourly-check-in": null,
          "watch/bestie-hourly-check-in": null,
        },
      },
    ],
  ]);
  stop();
});
