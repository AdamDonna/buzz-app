// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { AgentConfigHistoryRow } from "./AgentConfigHistoryRow";
import { ARTIFACT_KIND } from "./agent-config-artifacts";
import { HISTORY_PAGE } from "./agent-config-history";
import type { Agents, ConfigHistory } from "./service";

afterEach(cleanup);

function fixture(size = 2) {
  const revision = (side: "settings" | "instructions", n: number): RelayEvent =>
    ({
      id: `${side}-${n}`,
      pubkey: "a".repeat(64),
      sig: "b".repeat(128),
      kind: ARTIFACT_KIND,
      created_at: 1_700_000_000 + n,
      content: JSON.stringify(
        side === "instructions"
          ? { version: 1, text: `Instruction ${n}` }
          : { version: 1, agent_type: "test", settings: {} },
      ),
      tags: [
        ["ar", "1"],
        ["h", "c"],
        ["d", side],
        ["type", `buzz.agent.${side}`],
        ["op", n ? "update" : "create"],
        ...(n ? [["prev", `${side}-${n - 1}`]] : []),
      ],
    }) as RelayEvent;
  const revisions = {
    settings: [revision("settings", 0)],
    instructions: Array.from({ length: size }, (_, n) =>
      revision("instructions", n),
    ).reverse(),
  };
  const read = vi.fn<ConfigHistory["read"]>(async ([filter]) => {
    const side = filter?.["#d"]?.[0] as keyof typeof revisions;
    return revisions[side].slice(
      filter?.offset ?? 0,
      (filter?.offset ?? 0) + (filter?.limit ?? 0),
    );
  });
  const revise = vi.fn<ConfigHistory["revise"]>(async () => ({
    status: "refused",
    message: "Config changed. Reload and try again.",
  }));
  const history: ConfigHistory = {
    read,
    revise,
    sides: (["settings", "instructions"] as const).map((side) => ({
      side,
      expected: { channel: "c", d: side, type: `buzz.agent.${side}` },
      head: revisions[side][0],
      version: 0,
    })),
  };
  const snapshot = {} as ReturnType<Agents["snapshot"]>;
  const agents = {
    configHistory: () => history,
    snapshot: () => snapshot,
    subscribe: () => () => {},
  };
  return { agents, read, revise };
}

it("counts both tracks while collapsed and preserves changes and conflict feedback across collapse", async () => {
  const { agents, read, revise } = fixture();
  const user = userEvent.setup();
  render(<AgentConfigHistoryRow agents={agents} pubkey="a" />);
  const row = screen.getByRole("button", { name: "Config history" });
  expect(row).toHaveAttribute("aria-expanded", "false");
  expect(await screen.findByText("3 revisions")).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    screen.queryByRole("region", { name: "Instructions history" }),
  ).not.toBeInTheDocument();
  await user.click(row);
  expect(
    screen.getByRole("region", { name: "Settings history" }),
  ).toBeVisible();
  const instructions = within(
    screen.getByRole("region", { name: "Instructions history" }),
  );
  await user.click(
    instructions.getAllByRole("button", {
      name: "Show changes",
    })[0] as HTMLElement,
  );
  expect(
    instructions.getByRole("region", { name: "Changes" }),
  ).toHaveTextContent("+ Instruction 1");
  await user.click(
    instructions.getByRole("button", { name: "Revert to this" }),
  );
  expect(await instructions.findByRole("alert")).toHaveTextContent(
    "Not reverted: Config changed.",
  );
  expect(revise).toHaveBeenCalledWith(
    "instructions",
    expect.objectContaining({
      tags: expect.arrayContaining([["prev", "instructions-1"]]),
    }),
  );
  await user.click(row);
  await user.click(row);
  expect(instructions.getByRole("region", { name: "Changes" })).toBeVisible();
  expect(instructions.getByRole("alert")).toBeVisible();
  expect(read).toHaveBeenCalledTimes(2);
});

it("marks paginated counts as incomplete and updates the count after Load older", async () => {
  const { agents } = fixture(HISTORY_PAGE + 1);
  const user = userEvent.setup();
  render(<AgentConfigHistoryRow agents={agents} pubkey="a" />);
  expect(await screen.findByText("101+ revisions")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Config history" }));
  await user.click(screen.getByRole("button", { name: "Load older" }));
  expect(await screen.findByText("102 revisions")).toBeInTheDocument();
});
