import { expect, it, vi } from "vitest";
import { sharedFiles } from "../../features/agents/test-fakes";
import { deferred } from "./pi-testing";
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

it("keeps a replacement visible when an old state read finishes late", async () => {
  const files = sharedFiles();
  const storage = { ...files.open() };
  const store = new PiSessionStore(storage);
  const initial = await store.current("agent", "channel/root");
  await store.save("agent", { ...initial, conversation: 1 });
  const read = storage.read;
  const reading = deferred();
  const release = deferred();
  vi.spyOn(storage, "read").mockImplementation(async (key) => {
    const text = await read(key);
    if (key.endsWith(initial.key)) {
      reading.resolve();
      await release.promise;
    }
    return text;
  });
  const old = store.current("agent", "channel/root");
  try {
    await reading.promise;
    await store.replace("agent", "channel/root");
    const replacement = await store.current("agent", "channel/root");
    expect(replacement.key).not.toBe(initial.key);
    release.resolve();
    expect((await old).key).toBe(initial.key);
    expect(store.list("agent")).toEqual([replacement]);
  } finally {
    release.resolve();
    await old;
  }
});
