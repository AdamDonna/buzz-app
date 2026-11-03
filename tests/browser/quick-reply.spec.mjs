import { openPage } from "./navigation.mjs";
import { fixtureRelayUrl } from "../relay-config.ts";
import { test, expect } from "./fixture.mjs";
import { open, settle, end } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 30, beta: 1 } });

// Browser boundary: real editor focus/draft restoration and signed reply wiring
// through the main workspace, without a thread-tab navigation.
test("main conversation replies inline and keeps the existing thread summary", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "Inline reply target");
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const channel = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await channel.fill("Keep my channel draft");
  const chooseReply = async () => {
    await hoverMessage(row);
    await row
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
  };
  // Hover can scroll the virtualized row into view and replace estimated row
  // heights. Establish bottom geometry after that preparation, before Reply.
  await end(page);
  await hoverMessage(row);
  await settle(page);
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: "Channel message history" })
        .evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
    )
    .toBeLessThanOrEqual(1);
  await page.evaluate(() => {
    window.replyFrames = [];
    window.replySampling = true;
    const sample = () => {
      const history = document.querySelector("[data-message-scroller]");
      const composer = document.querySelector("form");
      if (history && composer)
        window.replyFrames.push({
          top: history.scrollTop,
          height: history.clientHeight,
          total: history.scrollHeight,
          composer: composer.getBoundingClientRect().top,
        });
      if (window.replySampling) requestAnimationFrame(sample);
    };
    sample();
  });
  let frames;
  try {
    await row
      .getByRole("button", { name: "Reply in thread", exact: true })
      .click();
    const form = page.locator("form").filter({
      has: page.getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      }),
    });
    await expect(
      form.getByText("Reply in thread", { exact: true }),
    ).toBeVisible();
    // Stable polling can fall between WebKit animation frames. Wait for the
    // actual transition, then let ResizeObserver and the next paint finish.
    await form.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    await settle(page);
  } finally {
    frames = await page.evaluate(() => {
      window.replySampling = false;
      return window.replyFrames;
    });
  }
  // Growing the preview may move messages upward with the composer, never
  // clamp them downward behind it while replacing the editor.
  expect(Math.min(...frames.map((frame) => frame.top))).toBeGreaterThanOrEqual(
    frames[0].top,
  );
  const last = frames.at(-1);
  expect(last.total - last.height - last.top).toBeLessThanOrEqual(1);
  const reply = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(
    page
      .locator("form")
      .filter({ has: reply })
      .getByText("Reply in thread", { exact: true }),
  ).toBeVisible();
  await expect(reply).toBeFocused();
  await expect(reply).toHaveText("Keep my channel draft");
  const preview = page.locator("form").filter({ has: reply });
  await expect(
    preview.getByText("Inline reply target", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[role="tab"][data-tab-value^="thread:"]'),
  ).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      await expect(
        preview.getByText("Inline reply target", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Cancel reply target", exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`quick-reply-${mode}-${width}.png`),
      });
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize({ width: 1440, height: 950 });
  await reply.fill("Saved inline reply");
  await page.locator('button[data-channel-id="beta"]').click();
  await page.locator('button[data-channel-id="alpha"]').click();
  await expect(reply).toHaveText("Saved inline reply");
  await expect(
    preview.getByText("Inline reply target", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(reply).toHaveText("Saved inline reply");
  await expect(
    preview.getByText("Inline reply target", { exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Cancel reply target", exact: true })
    .click();
  await expect(channel).toHaveText("Saved inline reply");
  await chooseReply();
  await expect(reply).toHaveText("Saved inline reply");
  await expect(reply).toBeFocused();
  await row.click();
  await chooseReply();
  await expect(reply).toBeFocused();
  await reply.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.find(
        ({ event }) =>
          event.kind === 9 && event.content === "Saved inline reply",
      ),
    )
    .toBeTruthy();
  const sent = app.report.publications.find(
    ({ event }) => event.kind === 9 && event.content === "Saved inline reply",
  ).event;
  expect(sent.tags).toContainEqual(["e", event.id, "", "reply"]);
  await expect(channel).toHaveText("");
  await expect(
    page.locator('[role="tab"][data-tab-value^="thread:"]'),
  ).toHaveCount(0);
  const summary = row.getByRole("button", { name: /^View thread:/ });
  await expect(summary).toBeVisible();
  // Up selects the newest message from the now-empty composer; T replies.
  await channel.press("ArrowUp");
  await page.keyboard.press("t");
  await expect(
    preview.getByText("Reply in thread", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel reply target", exact: true })
    .click();
  await summary.click();
  await expect(
    page
      .getByRole("region", { name: "Thread messages", exact: true })
      .getByText("Saved inline reply", { exact: true }),
  ).toBeVisible();
});

// Integration boundary: a saved destination can fall outside the bounded channel
// window; resolving it must use the relay thread reader before publishing.
test("restores an off-window reply through loading, failure and retry", async ({
  page,
  app,
}) => {
  const root = app.histories.get("primary/alpha")[0];
  // Exceed the loaded head deliberately; this case proves bounded-history recovery.
  for (let i = 0; i < 80; i++)
    app.append("primary", "alpha", `Newer message ${i}`, false);
  await page.addInitScript(
    ({ viewer, relay, rootId }) => {
      localStorage.setItem(
        `buzz-view.v1:${JSON.stringify([`${relay}:${viewer}`, "draft:alpha"])}`,
        JSON.stringify({
          text: "Reply to the older message",
          recipients: [],
          replyRootId: rootId,
        }),
      );
    },
    { viewer: app.viewer, relay: fixtureRelayUrl, rootId: root.id },
  );
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let recover = false;
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters?.some((filter) => filter.ids?.includes(root.id)))
      return route.continue();
    await held;
    if (recover) return route.continue();
    // A malformed response fails this read without relying on retry timers.
    await route.fulfill({
      contentType: "application/json",
      body: "invalid JSON",
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.locator(`[data-channel-timeline] [data-message-id="${root.id}"]`),
  ).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(composer).toHaveText("Reply to the older message");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  try {
    await expect(
      page.getByText("Loading reply target…", { exact: true }),
    ).toBeVisible();
    await expect(composer).toBeEnabled();
    await composer.fill("Edited while loading");
    await expect(send).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    page.getByText("Couldn’t load reply target.", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveText("Edited while loading");
  await expect(send).toBeDisabled();
  recover = true;
  await page
    .getByRole("button", { name: "Retry reply target", exact: true })
    .click();
  await expect(
    page.locator("form").getByText(root.content, { exact: true }),
  ).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.find(
        ({ event }) =>
          event.kind === 9 && event.content === "Edited while loading",
      ),
    )
    .toBeTruthy();
  const sent = app.report.publications.find(
    ({ event }) => event.kind === 9 && event.content === "Edited while loading",
  ).event;
  expect(sent.tags).toContainEqual(["e", root.id, "", "reply"]);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toHaveText("");
  await expect(
    page.locator('[role="tab"][data-tab-value^="thread:"]'),
  ).toHaveCount(0);
});
