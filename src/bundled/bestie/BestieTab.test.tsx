// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import type { RelayData } from "../../features/relay/service";
import { writeView } from "../../shared/view-state";
import { bestieTab } from "./BestieTab";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const member = (name: string, digit: string): Agent =>
  ({
    key: digit.repeat(64),
    pubkey: digit.repeat(64),
    name,
    type: "test/echo",
    owner: OWNER,
    relay: "wss://relay.example",
    place: "here",
  }) as Agent;
const ada = member("Ada", "a");
const bea = member("Bea", "b");

function community(saved: string | undefined, agents = [ada, bea]) {
  let record = saved;
  const choice = (agent: Agent) => ({
    pubkey: agent.pubkey,
    name: agent.name,
    managed: true,
  });
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: agents.map(choice),
    selectable: agents.map(choice),
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: vi.fn(async () => record),
    write: vi.fn(async (agent: string) => {
      record = agent;
    }),
  };
  const connection = {
    status: "ready",
    scope: SCOPE,
    session: {
      mainAgent,
      agentChoices: {
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
      },
    },
  };
  let current: unknown = connection;
  const relayListeners = new Set<() => void>();
  const relay = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => void relayListeners.delete(listener);
    },
  } as unknown as RelayData;
  /** Replaces the session, as a reconnection does. */
  const reconnect = (scope: string) => {
    current = {
      ...connection,
      scope,
      session: { ...connection.session, mainAgent: { ...mainAgent } },
    };
    for (const listener of relayListeners) listener();
  };
  return { relay, mainAgent, reconnect };
}

it("shows on the saved Bestie only, and moves when Change picks another", async () => {
  const user = userEvent.setup();
  const { relay, mainAgent } = community(ada.pubkey);
  const tab = bestieTab(relay);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  // Nothing shows before the account's choice is read.
  expect(tab.when?.(ada)).toBe(false);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  expect(tab.when?.(bea)).toBe(false);
  // The same agent in another community is not this one's Bestie.
  expect(tab.when?.({ ...ada, relay: "wss://other.example" })).toBe(false);

  const Tab = tab.component;
  render(<Tab agent={ada} />);
  expect(screen.getByText("This is your Bestie")).toBeVisible();
  expect(screen.getByText("Remembers you")).toBeVisible();
  // No switches yet.
  expect(screen.queryByRole("switch")).toBeNull();
  changed.mockClear();
  await user.click(screen.getByRole("button", { name: "Change" }));
  // Change offers every other agent you can make Bestie.
  expect(screen.queryByRole("menuitem", { name: "Ada" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Bea" }));
  const confirmation = await screen.findByRole("alertdialog", {
    name: "Make Bea your bestie?",
  });
  await user.click(
    within(confirmation).getByRole("button", { name: "Switch to Bea" }),
  );
  expect(mainAgent.write).toHaveBeenCalledWith(bea.pubkey);
  await vi.waitFor(() => expect(tab.when?.(bea)).toBe(true));
  expect(tab.when?.(ada)).toBe(false);
  // The host is told, so the tab moves without a reload.
  expect(changed).toHaveBeenCalled();
  stop?.();
});

it("keeps Change unavailable while there is no other agent to choose", async () => {
  const { relay } = community(ada.pubkey, [ada]);
  const Tab = bestieTab(relay).component;
  await act(async () => {
    render(<Tab agent={ada} />);
  });
  expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
});

it("tells the host only when the Bestie or its community changes", async () => {
  const { relay, reconnect } = community(ada.pubkey);
  const tab = bestieTab(relay);
  const changed = vi.fn();
  const stop = tab.subscribe?.(changed);
  await vi.waitFor(() => expect(tab.when?.(ada)).toBe(true));
  changed.mockClear();
  // Other view state in the community, such as a draft, isn't a change.
  writeView(SCOPE, "composer:draft", "hello");
  expect(changed).not.toHaveBeenCalled();
  // A new session in another community is.
  reconnect(`https://other.example:${OWNER}`);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(tab.when?.(ada)).toBe(false);
  stop?.();
});
