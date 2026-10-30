import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { keypair, signed } from "./testing";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("saves the main agent, or none, one change at a time", async () => {
  const order: (string | null)[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writeMainAgent = vi.fn(async (agent: string | null) => {
    if (agent !== null) await held;
    order.push(agent);
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: async () => [] as RelayEvent[],
    writer: {
      kinds: [30078],
      sign: async (event: Parameters<typeof signed>[1]) =>
        signed(viewer, event),
      publish: async () => undefined,
    },
    readMainAgent: async () => undefined,
    writeMainAgent,
  });
  owners.push(owner);
  const account = owner.session.mainAgent;
  if (!account) throw new Error("No main agent record");
  const choose = account.write("a".repeat(64));
  const clear = account.write(null);
  release();
  await Promise.all([choose, clear]);
  // None, saved after the choice, is the one left.
  expect(order).toEqual(["a".repeat(64), null]);
  expect(writeMainAgent).toHaveBeenLastCalledWith(
    null,
    expect.any(AbortSignal),
  );
});
