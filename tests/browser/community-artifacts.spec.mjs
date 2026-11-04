import { test, expect } from "./source-fixture.mjs";

async function openWindows(page, context, legacy = false) {
  if (legacy)
    await page.addInitScript(() => {
      localStorage.setItem(
        `buzz-client.v1:${"a".repeat(64)}`,
        JSON.stringify({
          memberships: [{ id: "https://fixture.example", name: "Fixture" }],
          selected: "https://fixture.example",
        }),
      );
    });
  await page.goto("/tests/fixtures/artifact-storage.html?communities");
  await page.waitForFunction(
    () => window.communityArtifacts?.snapshot().status === "ready",
  );
  if (!legacy) await page.evaluate(() => window.communityArtifacts.join());
  const other = await context.newPage();
  await other.addInitScript(() =>
    window.addEventListener("storage", (event) => {
      if (window.pauseStorage) event.stopImmediatePropagation();
    }),
  );
  await other.goto(page.url());
  await other.waitForFunction(
    () => window.communityArtifacts?.snapshot().selected,
  );
  return other;
}

// Real storage events and IndexedDB ordering need separate browser windows.
for (const delayedEvent of [false, true]) {
  test(`leave fences artifact storage across windows with ${delayedEvent ? "delayed" : "normal"} storage events`, async ({
    page,
    context,
  }) => {
    const other = await openWindows(page, context);
    await other.evaluate((delay) => {
      window.handle = window.communityArtifacts.open();
      window.pauseStorage = delay;
      return window.handle.importBatch({
        records: [{ id: "task", local: { title: "saved" } }],
      });
    }, delayedEvent);
    await page.evaluate(() => window.communityArtifacts.leave(true));
    if (!delayedEvent)
      await other.waitForFunction(() => window.communityArtifacts.aborted());
    const result = await other.evaluate(async () => {
      let openError;
      try {
        window.communityArtifacts.open();
      } catch (error) {
        openError = error.message;
      }
      let writeError;
      try {
        await window.handle.importBatch({
          records: [{ id: "task", local: { title: "stale" } }],
        });
      } catch (error) {
        writeError = error.message;
      }
      return {
        snapshot: window.communityArtifacts.snapshot(),
        aborted: window.communityArtifacts.aborted(),
        openError,
        writeError,
        saved: await window.communityArtifacts.saved(),
      };
    });
    expect(result.snapshot.memberships).toEqual([]);
    expect(result.snapshot.selected).toBeNull();
    expect(result.aborted).toBe(true);
    expect(result.openError).toBe(
      "Artifact storage needs a plugin, identity and relay",
    );
    expect(result.writeError).toBe("Artifact storage scope changed");
    expect(result.saved).toBeUndefined();
    await other.evaluate(async () => {
      window.communityArtifacts.join();
      const fresh = window.communityArtifacts.open();
      await fresh.importBatch({
        records: [{ id: "rejoined", local: { title: "rejoined" } }],
      });
    });
    await page.waitForFunction(() =>
      window.communityArtifacts
        .snapshot()
        .memberships.some((entry) => entry.id === "https://fixture.example"),
    );
    expect(
      await page.evaluate(() => window.communityArtifacts.snapshot().selected),
    ).toBeNull();
    expect(
      await page.evaluate(async () => {
        window.communityArtifacts.select();
        return (await window.communityArtifacts.open().get("rejoined"))?.record
          .local;
      }),
    ).toEqual({ title: "rejoined" });
    await expect(
      other.evaluate(() => window.handle.get("task")),
    ).rejects.toThrow("scope changed");
  });
}

test("rejects an old handle after leave and rejoin before event delivery", async ({
  page,
  context,
}) => {
  const other = await openWindows(page, context, true);
  await other.evaluate(async () => {
    window.handle = window.communityArtifacts.open();
    await window.handle.get("task");
    window.pauseStorage = true;
  });
  await page.evaluate(async () => {
    await window.communityArtifacts.leave(true);
    window.communityArtifacts.join();
    await window.communityArtifacts
      .open()
      .importBatch({ records: [{ id: "task", local: { title: "fresh" } }] });
  });
  await expect(
    other.evaluate(() =>
      window.handle.importBatch({ records: [{ id: "stale", local: {} }] }),
    ),
  ).rejects.toThrow("scope changed");
  expect(await other.evaluate(() => window.communityArtifacts.aborted())).toBe(
    true,
  );
  expect(
    await other.evaluate(
      async () =>
        (await window.communityArtifacts.open().get("task"))?.record.local,
    ),
  ).toEqual({ title: "fresh" });
});
test("rejoin waits for a pending purge before it imports fresh artifacts", async ({
  page,
  context,
}) => {
  const other = await openWindows(page, context);
  await page.evaluate(async () => {
    const open = IDBFactory.prototype.open;
    const held = new Promise((resolve) => {
      IDBFactory.prototype.open = function (...args) {
        const request = open.apply(this, args);
        if (args[0] === "buzz-channel-heads-v1") {
          Object.defineProperty(request, "onsuccess", {
            set(listener) {
              request.addEventListener(
                "success",
                (event) => {
                  IDBFactory.prototype.open = open;
                  window.releasePurge = () => listener.call(request, event);
                  resolve();
                },
                { once: true },
              );
            },
          });
        }
        return request;
      };
    });
    window.pendingLeave = window.communityArtifacts.leave(true);
    await held;
  });
  try {
    await other.evaluate(() => {
      window.communityArtifacts.join();
      window.freshImport = window.communityArtifacts
        .open()
        .importBatch({ records: [{ id: "task", local: { title: "fresh" } }] });
    });
    const pending = await other.evaluate(
      async () => (await navigator.locks.query()).pending,
    );
    expect(
      pending.some(
        (lock) =>
          lock.name.startsWith("buzz-artifacts-v1:") && lock.mode === "shared",
      ),
    ).toBe(true);
  } finally {
    await page.evaluate(() => window.releasePurge());
  }
  await page.evaluate(() => window.pendingLeave);
  await other.evaluate(() => window.freshImport);
  expect(
    await other.evaluate(
      async () =>
        (await window.communityArtifacts.open().get("task"))?.record.local,
    ),
  ).toEqual({ title: "fresh" });
});

test("cancels an import whose collection initialization waits behind leave", async ({
  page,
  context,
}) => {
  const other = await openWindows(page, context);
  await page.evaluate(async () => {
    const held = new Promise((resolve) => {
      window.partitionGate = navigator.locks.request(
        `buzz-artifacts-v1:https://fixture.example:${"a".repeat(64)}`,
        async () => {
          resolve();
          await new Promise((release) => {
            window.releaseGate = release;
          });
        },
      );
    });
    await held;
    window.pendingLeave = window.communityArtifacts.leave(true);
  });
  try {
    await other.evaluate(() => {
      window.pauseStorage = true;
      window.pendingImport = window.communityArtifacts
        .open()
        .importBatch({ records: [{ id: "task", local: { title: "stale" } }] })
        .then(
          () => null,
          (error) => error.message,
        );
    });
    const pending = await page.evaluate(
      async () => (await navigator.locks.query()).pending,
    );
    expect(pending.map((lock) => lock.mode)).toEqual(["exclusive", "shared"]);
  } finally {
    await page.evaluate(() => window.releaseGate());
  }
  await page.evaluate(() => window.pendingLeave);
  expect(await other.evaluate(() => window.pendingImport)).toMatch(
    /scope changed|closed/,
  );
  expect(await other.evaluate(() => window.communityArtifacts.aborted())).toBe(
    true,
  );
  expect(
    await other.evaluate(() => window.communityArtifacts.saved()),
  ).toBeUndefined();
});
