import { expect, it, vi } from "vitest";
import type { Agent, Agents } from "../../features/agents/service";
import { checkinHourly, memory, withFeature } from "./features";
import { saveFeature } from "./save";

it("refuses to turn on a section edited by hand, saving nothing", async () => {
  const save = vi.fn<Agents["save"]>(async () => {});
  const agents = { save, types: () => [] };
  const instructions = withFeature(
    withFeature("Be brief.", memory, true),
    checkinHourly,
    true,
  ).replace("<!-- /buzz:bestie/checkin.hourly -->", "");
  const agent = {
    key: "a".repeat(64),
    attention: {},
    config: { instructions },
  } as unknown as Agent;
  await expect(
    saveFeature(agents, agent, checkinHourly, true, { channel: "dm" }),
  ).rejects.toThrow("restore it first");
  // Its timer would otherwise be saved first, leaving half of it on.
  expect(save).not.toHaveBeenCalled();
});
