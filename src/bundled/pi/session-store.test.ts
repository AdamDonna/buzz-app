import { expect, it } from "vitest";
import { sharedFiles } from "../../features/agents/test-fakes";
import { PiSessionStore } from "./session-store";

it("reads a saved replacement from a store loaded before New", async () => {
  const files = sharedFiles();
  const first = new PiSessionStore(files.open());
  const initial = await first.current("agent", "channel/root");
  await first.save("agent", { ...initial, conversation: 1 });
  const second = new PiSessionStore(files.open());
  await first.replace("agent", "channel/root");
  const replacement = await first.current("agent", "channel/root");
  await first.save("agent", { ...replacement, conversation: 2 });
  expect(replacement.key).not.toBe(initial.key);
  expect((await second.current("agent", "channel/root")).key).toBe(
    replacement.key,
  );
  expect(second.list("agent")).toEqual([{ ...replacement, conversation: 2 }]);
});
