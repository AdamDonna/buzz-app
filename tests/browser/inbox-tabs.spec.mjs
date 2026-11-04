import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: the bundled page hosts the shared tab workspace. Its list stays
// the main tab while one side tab follows the rows the reader opens.
test("Inbox rows open their conversation in one side tab beside the list", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const main = inbox.getByRole("tablist", { name: "Inbox tabs" });
  const side = inbox.getByRole("tablist", { name: "Panel tabs" });
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  const rows = list.getByRole("listitem");
  const expectList = async () => {
    await expect(main.getByRole("tab")).toHaveText(["Inbox"]);
    await expect(
      main.getByRole("tab", { name: "Inbox", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(list).toBeVisible();
    await expect(rows).toHaveCount(3);
  };
  await expectList();
  await expect(side).toHaveCount(0);
  const alpha = inbox.getByRole("region", {
    name: "Conversation in Alpha",
    exact: true,
  });
  const thread = alpha.getByRole("region", {
    name: "Thread messages",
    exact: true,
  });
  const reply = alpha.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const roots = app.histories.get("primary/alpha");
  const root = (content) => roots.find((event) => event.content === content);

  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(
    side.getByRole("tab", { name: "Thread root 1", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 1").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: "Unread reply 1" }),
  ).toBeInViewport();
  await expect(reply).toBeVisible();
  await expectList();
  // A tab does not visit the channel; the Inbox page stays in view.
  await expect(page.getByRole("region", { name: "Channels" })).toHaveCount(0);

  await reply.fill("Thread root 1 draft");
  // Thread root 0's row shows whichever of its replies loaded as newest.
  const other = rows
    .filter({ hasText: "#Alpha" })
    .filter({ hasNotText: "Unread reply 1" });
  const shown = (await other.textContent()).includes("Broadcast reply")
    ? "Broadcast reply"
    : "Unread reply 0";
  await other.getByRole("button", { name: /^Open / }).click();
  // A plain open replaces the previous tab, so one tab follows the clicks.
  await expect(side.getByRole("tab")).toHaveText(["Thread root 0"]);
  await expect(
    thread.locator(`[data-message-id="${root("Thread root 0").id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator("[data-message-id]").filter({ hasText: shown }),
  ).toBeInViewport();
  await expect(thread.getByText("Unread reply 1", { exact: true })).toHaveCount(
    0,
  );
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveText("Thread root 1 draft");
  await expectList();

  await rows
    .filter({ hasText: "Inbox DM fixture reply" })
    .getByRole("button", { name: /^Open / })
    .click();
  // A DM opens its whole conversation, not a thread.
  await expect(side.getByRole("tab")).toHaveText(["Alice Fixture"]);
  const dm = inbox.getByRole("region", {
    name: "Conversation in Alice Fixture",
    exact: true,
  });
  await expect(alpha).toHaveCount(0);
  await expect(
    dm
      .getByRole("region", { name: "Channel message history" })
      .getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await expect(dm.getByRole("complementary", { name: "Thread" })).toHaveCount(
    0,
  );
  await expect(dm.getByRole("textbox", { name: /^Message / })).toBeVisible();
  await expectList();

  // Reopening the first thread restores its retained draft in a fresh tab.
  await rows
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  await expect(side.getByRole("tab")).toHaveText(["Thread root 1"]);
  await expect(reply).toHaveText("Thread root 1 draft");
});

// Browser-only: the tab's menu takes its conversation to Channels, as the
// former Inbox detail pane's Open in channel did. Real layout decides that
// the channel's root row is in view and painted beside the focused thread.
test.describe("with the thread's root beyond the channel's newest page", () => {
  test.use({ threadUnreadNewerRows: 30 });
  test("an Inbox tab's menu opens its thread in its channel beside its root", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, app);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    const root = app.histories
      .get("primary/alpha")
      .find((event) => event.content === "Thread root 1");
    await inbox
      .getByRole("list", { name: "Inbox conversations" })
      .getByRole("listitem")
      .filter({ hasText: "Unread reply 1" })
      .getByRole("button", { name: /^Open / })
      .click();
    // The arrival cue is transient: observe it before the channel opens.
    await page.evaluate((id) => {
      window.rootMarked = false;
      new MutationObserver(() => {
        const row = document.querySelector(
          `[data-channel-timeline="alpha"] [data-message-id="${id}"]`,
        );
        if (
          row &&
          [row, ...row.querySelectorAll("[data-highlight-surface]")].some(
            (surface) => /messageHighlight/.test(surface.className),
          )
        )
          window.rootMarked = true;
      }).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }, root.id);
    // Off the channel's newest page, the tab cannot name its thread by root.
    await inbox
      .getByRole("tablist", { name: "Panel tabs" })
      .getByRole("tab", { name: /^Thread/ })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in channel" }).click();
    await expect(inbox).toHaveCount(0);
    const target = await page.evaluate(
      () => history.state.buzzNavigationV1.entry.target,
    );
    expect(target.threadRootId).toBe(root.id);
    expect(target.messageId).toMatch(/^[a-f0-9]{64}$/);
    // The thread still opens at the same message, which keeps focus.
    const reply = page
      .getByRole("region", { name: "Thread messages", exact: true })
      .locator(`[data-message-id="${target.messageId}"]`);
    await expect(reply).toContainText("Unread reply 1");
    await expect(reply).toBeFocused();
    // Beside it, the channel waits to show its list at the thread's root,
    // reading the older page the fixture holds.
    await expect.poll(() => app.pending.length).toBe(1);
    expect(app.pending[0].channel).toBe("alpha");
    await expect(
      page
        .getByRole("region", { name: "Channel history", exact: true })
        .getByRole("status"),
    ).toHaveText("Loading messages…");
    await expect(reply).toBeFocused();
    app.pending.shift().release();
    const head = app.report.queries.find(
      ({ community, filter }) =>
        community === "primary" &&
        filter.top_level &&
        filter.until === undefined &&
        filter["#h"].includes("alpha"),
    );
    expect(
      app.histories.get("primary/alpha").at(-head.filter.limit).created_at,
      "the root predates the channel's newest page",
    ).toBeGreaterThan(root.created_at);
    await expect(
      page
        .locator('[data-channel-timeline="alpha"]')
        .locator(`[data-message-id="${root.id}"]`),
    ).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.rootMarked)).toBe(true);
    await expect(reply).toBeFocused();
  });
});
