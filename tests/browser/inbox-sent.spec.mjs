import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: actual tab focus/panel visibility and exact-message navigation
// through the bundled Inbox and Messages hosts, with the production broker.
test("Sent switches with the keyboard and opens an authored message", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Inbox");
  const mailbox = page.getByRole("tablist", { name: "Mailbox" });
  const inbox = mailbox.getByRole("tab", { name: "Inbox", exact: true });
  const sent = mailbox.getByRole("tab", { name: "Sent", exact: true });
  await inbox.focus();
  await page.keyboard.press("ArrowRight");
  await expect(sent).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sent).toHaveAttribute("aria-selected", "true");
  const list = page.getByRole("list", { name: "Sent messages" });
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  const row = list.getByRole("button").filter({ hasText: "Thread root 0" });
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Inbox conversations" }),
  ).toBeHidden();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(row).toBeVisible();
  await page.setViewportSize({ width: 480, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(sent).toBeInViewport();
  await expect(row).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await inbox.click();
  await expect(list).toBeHidden();
  await page.getByRole("button", { name: "Inbox filters" }).click();
  await page
    .getByRole("menuitemradio", { name: "Drafts", exact: true })
    .click();
  await sent.click();
  await inbox.click();
  await expect(page.getByRole("list", { name: "Drafts" })).toBeVisible();
  await sent.click();
  await row.click();
  await expect(
    page.locator(`[data-message-id="${root.id}"]`).first(),
  ).toBeVisible();
});
