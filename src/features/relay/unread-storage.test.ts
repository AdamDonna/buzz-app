import { afterEach, expect, it, vi } from "vitest";
import type { ThreadParticipation } from "./thread-participation";
import {
  browserUnreadStorage,
  memoryUnreadStorage,
  purgeUnreadStorage,
} from "./unread-storage";

afterEach(() => vi.unstubAllGlobals());

// An in-memory IndexedDB shared by every connection. Transactions run one at
// a time in the order they were created, as overlapping readwrite
// transactions do, and complete once their last request has succeeded;
// values are structured clones. `blocked` opens are refused first.
function memoryIndexedDB(blocked = 0) {
  const stores = new Map<string, Map<string, unknown>>();
  let upgraded = false;
  let turn = Promise.resolve();
  const table = (name: string) => {
    const rows = stores.get(name) ?? new Map<string, unknown>();
    stores.set(name, rows);
    return rows;
  };
  function transaction() {
    const previous = turn;
    let release = () => {};
    turn = new Promise((resolve) => {
      release = resolve;
    });
    let pending = 0;
    let done = false;
    const tx = {
      error: null,
      oncomplete: () => {},
      onabort: () => {},
      onerror: () => {},
      objectStore: (name: string) => ({
        get: (key: unknown) =>
          request(() => structuredClone(table(name).get(JSON.stringify(key)))),
        put: (value: unknown, key: unknown) =>
          request(() => {
            table(name).set(JSON.stringify(key), structuredClone(value));
          }),
        delete: (key: unknown) =>
          request(() => {
            table(name).delete(JSON.stringify(key));
          }),
      }),
    };
    const finish = () => {
      if (pending || done) return;
      done = true;
      release();
      tx.oncomplete();
    };
    function request(run: () => unknown) {
      const issued = { result: undefined as unknown, onsuccess: () => {} };
      pending++;
      void previous.then(() => {
        issued.result = run();
        issued.onsuccess();
        pending--;
        finish();
      });
      return issued;
    }
    // A transaction that issues no request completes on its turn.
    void previous.then(finish);
    return tx;
  }
  const db = {
    onversionchange: () => {},
    close: vi.fn(),
    createObjectStore(name: string) {
      table(name);
      return { createIndex() {} };
    },
    transaction,
  };
  const opens: unknown[] = [];
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {
        result: db,
        error: null,
        onupgradeneeded: () => {},
        onsuccess: () => {},
        onerror: () => {},
        onblocked: () => {},
      };
      opens.push(request);
      queueMicrotask(() => {
        if (blocked-- > 0) return request.onblocked();
        if (!upgraded) request.onupgradeneeded();
        upgraded = true;
        request.onsuccess();
      });
      return request;
    },
  });
  return {
    opens,
    stores: () => [...stores.keys()],
    /** Writes a stored value as another build or a tampered disk would. */
    seed(name: string, key: unknown, value: unknown) {
      table(name).set(JSON.stringify(key), structuredClone(value));
    },
  };
}

const threads: ThreadParticipation = {
  roots: new Map([
    ["c0:root", { at: 1000 }],
    ["c0:other", { at: 1200, newestId: "a".repeat(64) }],
  ]),
  walk: { since: 1500 },
};
const scope = "https://relay.example:viewer";
const meta = (participation: unknown) => ({ version: 1, participation });

it("a record round-trips with its threads and walk mark", async () => {
  const idb = memoryIndexedDB();
  await browserUnreadStorage(scope).save({ participation: threads });
  // Both stores exist from the first open, so a later build adds no upgrade.
  expect(idb.stores()).toEqual(["meta", "events"]);
  // The next launch reads it through its own connection.
  await expect(browserUnreadStorage(scope).read()).resolves.toEqual({
    participation: threads,
  });
  await browserUnreadStorage(scope).save({
    participation: { roots: new Map() },
  });
  await expect(browserUnreadStorage(scope).read()).resolves.toEqual({
    participation: { roots: new Map() },
  });
});

it("malformed meta reads as no record", async () => {
  const idb = memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  const roots = [["c0:root", 1000]];
  for (const raw of [
    undefined,
    "record",
    { participation: { roots } },
    { version: 2, participation: { roots } },
    meta(undefined),
    meta({ roots: "c0:root" }),
    meta({ roots: [["c0:root", -1]] }),
    meta({ roots: [["c0:root", 1000, 7]] }),
    meta({ roots: [["c0:root", 1000, "a".repeat(65)]] }),
    meta({ roots: [[`c0:${"r".repeat(256)}`, 1000]] }),
    meta({ roots: [...roots, "junk"] }),
    meta({ roots: Array.from({ length: 1001 }, (_, i) => [`c0:${i}`, i]) }),
    meta({ roots, walk: null }),
    meta({ roots, walk: { since: 1.5 } }),
  ]) {
    idb.seed("meta", scope, raw);
    await expect(storage.read()).resolves.toBeUndefined();
  }
  idb.seed("meta", scope, meta({ roots, walk: { since: 1500 } }));
  await expect(storage.read()).resolves.toEqual({
    participation: {
      roots: new Map([["c0:root", { at: 1000 }]]),
      walk: { since: 1500 },
    },
  });
});

it("a record that would not read back is refused when saved, keeping the saved one", async () => {
  memoryIndexedDB();
  const storage = browserUnreadStorage(scope);
  await storage.save({ participation: threads });
  const beyond: ThreadParticipation = {
    roots: new Map([[`c0:${"r".repeat(256)}`, { at: 1000 }]]),
  };
  await expect(storage.save({ participation: beyond })).rejects.toThrow(
    RangeError,
  );
  await expect(
    memoryUnreadStorage().save({ participation: beyond }),
  ).rejects.toThrow(RangeError);
  await expect(storage.read()).resolves.toEqual({ participation: threads });
});

it("a blocked open is not held against the next read", async () => {
  const idb = memoryIndexedDB(1);
  const storage = browserUnreadStorage(scope);
  await expect(storage.read()).rejects.toThrow("Close other Buzz windows");
  await storage.save({ participation: threads });
  await expect(storage.read()).resolves.toEqual({ participation: threads });
  expect(idb.opens).toHaveLength(2);
});

it("a purge clears only that partition", async () => {
  memoryIndexedDB();
  // A scope that merely extends the purged one is a different partition.
  const others = [`${scope}0`, "https://other.example:viewer"];
  for (const other of others)
    await browserUnreadStorage(other).save({ participation: threads });
  await browserUnreadStorage(scope).save({ participation: threads });
  await purgeUnreadStorage(scope);
  await expect(browserUnreadStorage(scope).read()).resolves.toBeUndefined();
  for (const other of others)
    await expect(browserUnreadStorage(other).read()).resolves.toEqual({
      participation: threads,
    });
});
