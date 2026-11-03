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

it("keeps the latest of overlapping reads visible after an external New", async () => {
  const files = sharedFiles();
  const writer = new PiSessionStore(files.open());
  const initial = await writer.current("agent", "channel/root");
  await writer.save("agent", { ...initial, conversation: 1 });
  const storage = { ...files.open() };
  const reader = new PiSessionStore(storage);
  await reader.current("agent", "channel/root");
  const read = storage.read;
  const oldReading = deferred();
  const newReading = deferred();
  const releaseOld = deferred();
  const releaseNew = deferred();
  vi.spyOn(storage, "read").mockImplementation(async (key) => {
    const text = await read(key);
    if (key.includes(":session:")) {
      if (key.endsWith(initial.key)) {
        oldReading.resolve();
        await releaseOld.promise;
      } else {
        newReading.resolve();
        await releaseNew.promise;
      }
    }
    return text;
  });
  const old = reader.current("agent", "channel/root");
  let next: ReturnType<PiSessionStore["current"]> | undefined;
  try {
    await oldReading.promise;
    await writer.replace("agent", "channel/root");
    const replacement = {
      ...(await writer.current("agent", "channel/root")),
      conversation: 2,
    };
    await writer.save("agent", replacement);
    next = reader.current("agent", "channel/root");
    await newReading.promise;
    releaseOld.resolve();
    expect((await old).key).toBe(initial.key);
    releaseNew.resolve();
    expect(await next).toEqual(replacement);
    expect(reader.list("agent")).toEqual([replacement]);
    const saved = { ...replacement, at: 200 };
    await reader.save("agent", saved);
    expect(reader.list("agent")).toEqual([saved]);
  } finally {
    releaseOld.resolve();
    releaseNew.resolve();
    await Promise.all([old, next]);
  }
});

it("refreshes current and historical sessions from an already-loaded window", async () => {
  const files = sharedFiles();
  const reader = new PiSessionStore(files.open());
  const writer = new PiSessionStore(files.open());
  const initial = await writer.current("agent", "channel/root");
  await writer.save("agent", { ...initial, conversation: 1 });
  await writer.replace("agent", "channel/root");
  const current = {
    ...(await writer.current("agent", "channel/root")),
    conversation: 2,
  };
  await writer.save("agent", current);
  await reader.refresh("agent");
  expect(reader.list("agent")).toEqual([current]);
  expect(
    reader
      .history("agent")
      .map((session) => session.key)
      .sort(),
  ).toEqual([initial.key, current.key].sort());
  const updated = { ...current, at: 200 };
  await reader.save("agent", updated);
  expect(reader.list("agent")).toEqual([updated]);
});

it("keeps local New visible when an earlier inventory scan finishes late", async () => {
  const files = sharedFiles();
  const storage = { ...files.open() };
  const store = new PiSessionStore(storage);
  const initial = await store.current("agent", "channel/root");
  await store.save("agent", { ...initial, conversation: 1 });
  const scan = storage.scan;
  const entered = deferred();
  const release = deferred();
  vi.spyOn(storage, "scan").mockImplementation(async (prefix) => {
    const entries = await scan(prefix);
    entered.resolve();
    await release.promise;
    return entries;
  });
  const refreshing = store.refresh("agent");
  try {
    await entered.promise;
    await store.replace("agent", "channel/root");
    const current = await store.current("agent", "channel/root");
    release.resolve();
    await refreshing;
    expect(store.list("agent")).toEqual([current]);
  } finally {
    release.resolve();
    await refreshing;
  }
});

it("keeps refreshed inventory visible when an older keyed read finishes late", async () => {
  const files = sharedFiles();
  const writer = new PiSessionStore(files.open());
  const initial = await writer.current("agent", "channel/root");
  await writer.save("agent", { ...initial, conversation: 1 });
  const storage = { ...files.open() };
  const reader = new PiSessionStore(storage);
  const read = storage.read;
  const entered = deferred();
  const release = deferred();
  vi.spyOn(storage, "read").mockImplementation(async (key) => {
    const text = await read(key);
    if (key.endsWith(initial.key)) {
      entered.resolve();
      await release.promise;
    }
    return text;
  });
  const old = reader.current("agent", "channel/root");
  try {
    await entered.promise;
    await writer.replace("agent", "channel/root");
    const current = await writer.current("agent", "channel/root");
    await reader.refresh("agent");
    release.resolve();
    await old;
    expect(reader.list("agent")).toEqual([current]);
  } finally {
    release.resolve();
    await old;
  }
});
