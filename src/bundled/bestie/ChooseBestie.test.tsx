// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import type { RelaySession } from "../../features/relay/session";
import { onBestieMade } from "../agents/BestieChoice";
import { BestieChooser } from "./ChooseBestie";

// The New agent dialog creates hosted Cara at once.
vi.mock("../agents/AgentCreateDialog", () => ({
  AgentCreateDialog: ({ onCreated }: { onCreated(agent: unknown): void }) => (
    <button
      type="button"
      onClick={() =>
        onCreated({ pubkey: "c".repeat(64), name: "Cara", place: "hosted" })
      }
    >
      Create Cara
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const OWNER = "f".repeat(64);
const SCOPE = `https://relay.example:${OWNER}`;
const member = (name: string, digit: string, place = "here") =>
  ({ pubkey: digit.repeat(64), name, place }) as unknown as Agent;
const ada = member("Ada", "a");
const cara = member("Cara", "c", "hosted");

/** A community where Ada runs on this device and Cara is hosted. */
function community() {
  const choice = (agent: Agent) => ({
    pubkey: agent.pubkey,
    name: agent.name,
    managed: true,
  });
  const choices = {
    status: "ready",
    complete: true,
    pending: false,
    identities: [ada, cara].map(choice),
    selectable: [ada, cara].map(choice),
    archives: { status: "unavailable", archived: [] },
  };
  const mainAgent = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async (_agent: string | null) => {}),
  };
  const session = {
    mainAgent,
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  const snapshot = { agents: [ada, cara], running: [] };
  const types: never[] = [];
  const agents = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    types: () => types,
  } as unknown as Agents;
  return { session, agents, mainAgent };
}

it("offers only agents on this device, and says why", async () => {
  const user = userEvent.setup();
  const { session, agents } = community();
  render(<BestieChooser session={session} scope={SCOPE} agents={agents} />);
  await user.click(screen.getByRole("button", { name: "Choose your bestie" }));
  expect(
    screen.getByText("Only agents on this device can be your Bestie for now."),
  ).toBeVisible();
  await user.click(screen.getByRole("combobox", { name: "Your agents" }));
  expect(await screen.findByRole("option", { name: "Ada" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "Cara" })).toBeNull();
});

it("saves the agent chosen here as Bestie, and tells the plugin", async () => {
  const user = userEvent.setup();
  const { session, agents, mainAgent } = community();
  const made = vi.fn();
  const stop = onBestieMade(made);
  render(<BestieChooser session={session} scope={SCOPE} agents={agents} />);
  await user.click(screen.getByRole("button", { name: "Choose your bestie" }));
  await user.click(screen.getByRole("combobox", { name: "Your agents" }));
  await user.click(await screen.findByRole("option", { name: "Ada" }));
  await vi.waitFor(() =>
    expect(mainAgent.write).toHaveBeenCalledWith(ada.pubkey),
  );
  await vi.waitFor(() => expect(made).toHaveBeenCalledWith(ada.pubkey));
  stop();
});

it("says a hosted agent created here can't be Bestie yet", async () => {
  const user = userEvent.setup();
  const { session, agents, mainAgent } = community();
  render(<BestieChooser session={session} scope={SCOPE} agents={agents} />);
  await user.click(screen.getByRole("button", { name: "Choose your bestie" }));
  await user.click(screen.getByRole("button", { name: "New agent" }));
  await user.click(screen.getByRole("button", { name: "Create Cara" }));
  expect(
    await screen.findByText(
      "Cara was created. Only agents on this device can be your Bestie for now.",
    ),
  ).toBeVisible();
  expect(mainAgent.write).not.toHaveBeenCalled();
});
