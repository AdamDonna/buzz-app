import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

let server;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    envDir: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "persistence-page",
        configureServer(server) {
          server.middlewares.use(
            "/persistence-fixture",
            (_request, response) => {
              response.setHeader("Content-Type", "text/html");
              response.end("<!doctype html><title>Persistence fixture</title>");
            },
          );
        },
      },
    ],
  });
  await server.listen();
});
test.afterAll(async () => server?.close());

// Real IDB upgrades, transaction ordering and restart cannot be proved by mocked stores.
test("upgrades the cache, evicts by metadata and preserves revoke/clear across restart", async ({
  page,
}) => {
  await page.goto(`${server.resolvedUrls.local[0]}persistence-fixture`);
  const result = await page.evaluate(async () => {
    const name = "buzz-channel-heads-v1";
    const open = (version) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          for (const store of ["heads", "startup"])
            request.result.createObjectStore(store, { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const committed = (tx) =>
      new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
    const db = await open(2);
    const now = Date.now();
    const tx = db.transaction(["heads", "startup"], "readwrite");
    for (let i = 0; i < 64; i++)
      tx.objectStore("heads").put({
        key: `viewer:relay:legacy-${i}`,
        scope: "viewer:relay",
        channelId: `legacy-${i}`,
        savedAt: i === 63 ? now - 86_400_001 : now - 1000 + i,
        bytes: 100,
        events: [{ content: "legacy" }],
        profiles: [],
      });
    for (const [key, savedAt] of [
      ["other:relay", now - 2000],
      ["viewer:relay", now - 1000],
    ])
      tx.objectStore("startup").put({
        key,
        savedAt,
        bytes: 3 * 1024 * 1024,
        data: { discovery: { events: [] } },
      });
    await committed(tx);
    db.close();
    const { createHeadPersistence } = await import(
      "/src/features/relay/persistence.ts"
    );
    let cache = createHeadPersistence("viewer", "relay");
    const restored = await cache.read();
    let savedAt = now - 100;
    const head = (channelId, content = "new") => ({
      channelId,
      savedAt: ++savedAt,
      events: [{ content }],
      profiles: [],
    });
    await cache.write(head("new"));
    await cache.write(head("newer"));
    const afterCount = (await cache.read()).map((row) => row.channelId);
    // The global byte budget must also remove records belonging to other viewers.
    const other = createHeadPersistence("third", "relay");
    await other.write(head("large", "x".repeat(5 * 1024 * 1024)));
    await cache.write(head("large", "x".repeat(5 * 1024 * 1024)));
    const otherEvicted = (await other.read()).length === 0;
    await other.writeStartup({
      discovery: {
        savedAt: now,
        relayAuthor: "relay",
        events: ["x".repeat(3 * 1024 * 1024)],
      },
    });
    const olderStartup = createHeadPersistence("other", "relay");
    const startupEvicted = (await olderStartup.readStartup()) === undefined;
    // Concurrent invocation order must survive a fresh handle, without delayed saves resurrecting data.
    await Promise.all([cache.write(head("revoked")), cache.remove("revoked")]);
    await Promise.all([
      cache.write(head("retained")),
      cache.retain(["retained"]),
    ]);
    cache.close();
    cache = createHeadPersistence("viewer", "relay");
    const retained = (await cache.read()).map((row) => row.channelId);
    await Promise.all([cache.write(head("cleared")), cache.clear()]);
    cache.close();
    cache = createHeadPersistence("viewer", "relay");
    const cleared = await cache.read();
    const clearedStartup = await cache.readStartup();
    cache.close();
    other.close();
    olderStartup.close();
    const inspect = await open();
    const scan = inspect.transaction([
      "heads",
      "heads-budget",
      "startup",
      "startup-budget",
    ]);
    const requests = ["heads", "heads-budget", "startup", "startup-budget"].map(
      (store) => scan.objectStore(store).getAll(),
    );
    await committed(scan);
    inspect.close();
    return {
      restored: restored.length,
      afterCount,
      otherEvicted,
      startupEvicted,
      retained,
      cleared,
      clearedStartup,
      keys: requests.map((request) =>
        request.result.map((row) => row.key).sort(),
      ),
    };
  });
  expect(result.restored).toBe(63);
  expect(result.afterCount).toHaveLength(64);
  expect(result.afterCount).not.toContain("legacy-0");
  expect(result.afterCount).not.toContain("legacy-63");
  expect(result.otherEvicted).toBe(true);
  expect(result.startupEvicted).toBe(true);
  expect(result.retained).toEqual(["retained"]);
  expect(result.cleared).toEqual([]);
  expect(result.clearedStartup).toBeUndefined();
  expect(result.keys[0]).toEqual(result.keys[1]);
  expect(result.keys[2]).toEqual(result.keys[3]);
});
