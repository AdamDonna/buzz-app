import {
  chooseColorMode,
  closeSettings,
  openSettings,
  selectSettingsSection,
  settingsDialog,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1 }, launchAnimation: true });

const themeKey = "buzz-theme.v1";
const accentKey = "buzz-accent.v1";

const frameParts = (page) => [
  page.locator("header.shell-header"),
  page.locator("#shell-navigation"),
];

const background = (locator) =>
  locator.evaluate((node) => getComputedStyle(node).backgroundColor);

const resolved = (page, variable, scope = "html") =>
  page.evaluate(
    ([name, selector]) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${name})`;
      document.querySelector(selector).append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    },
    [variable, scope],
  );

async function appearance(page) {
  await openSettings(page);
  await expect(
    settingsDialog(page).getByRole("button", {
      name: "Close Settings",
      exact: true,
    }),
  ).toBeFocused();
  await selectSettingsSection(page, "Appearance");
}

const radios = (page) =>
  page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio");

async function expectFramed(page, framed) {
  for (const part of frameParts(page)) {
    if (framed) {
      await expect(part).toHaveAttribute("data-theme-frame", "");
      await expect(part).toHaveClass(/\bdark\b/);
      await expect(part).toHaveAttribute("data-color-mode", "dark");
    } else {
      await expect(part).not.toHaveAttribute("data-theme-frame", "");
      await expect(part).not.toHaveAttribute("data-color-mode", /.*/);
    }
  }
}

test("a theme is picked by keyboard and pointer, survives reload and frames the shell only in light mode", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "buzz");
  await expectFramed(page, false);
  const buzzSidebar = await background(page.locator("#shell-navigation"));

  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await expect(radios(page)).toHaveCount(4);
  await expect(group.getByRole("radio", { name: /^Buzz/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: /^Relax/ })).not.toBeChecked();
  // The name and the description each have one owner; the thumbnail has none.
  await expect(
    group.getByRole("radio", { name: /^Relax/ }),
  ).toHaveAccessibleDescription(
    "Deep plum frame around a bright, open workspace.",
  );
  await expect(group.locator("svg:not([aria-hidden='true'])")).toHaveCount(0);

  const cardSidebar = (theme) =>
    group
      .locator(`svg[data-theme="${theme}"]`)
      .evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--surface-sidebar"),
      );
  const cards = {
    buzz: await cardSidebar("buzz"),
    relax: await cardSidebar("relax"),
  };
  expect(cards.buzz).not.toBe(cards.relax);

  await group.getByRole("radio", { name: /^Buzz/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: /^Relax/ })).toBeChecked();
  await expect(group.getByRole("radio", { name: /^Relax/ })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "relax");
  expect(await page.evaluate((k) => localStorage.getItem(k), themeKey)).toBe(
    "relax",
  );
  expect(
    await page.evaluate((k) => localStorage.getItem(k), accentKey),
    "choosing a theme writes only the theme key",
  ).toBeNull();
  await expect(
    page.getByRole("button", { name: "Theme accent color" }),
  ).toHaveAttribute("aria-pressed", "true");

  expect(
    { buzz: await cardSidebar("buzz"), relax: await cardSidebar("relax") },
    "each card previews its own theme, not the page theme",
  ).toEqual(cards);

  await expectFramed(page, true);
  const frameSidebar = await resolved(
    page,
    "--surface-sidebar",
    "#shell-navigation",
  );
  expect(frameSidebar).toBe("rgb(76, 28, 72)");
  expect(
    await background(page.locator("#shell-navigation .panel[data-sidebar]")),
  ).toBe(frameSidebar);
  expect(frameSidebar).not.toBe(buzzSidebar);
  const headerCanvas = await resolved(page, "--bg-app", "header.shell-header");
  expect(headerCanvas).toBe("rgb(59, 18, 56)");

  // The main pane and portaled UI keep the page mode.
  const mainPane = page.locator("main, [data-shell-main]").first();
  await expect(mainPane).not.toHaveAttribute("data-theme-frame", "");
  expect(await resolved(page, "--surface-panel", "body")).toBe(
    "rgb(255, 255, 255)",
  );
  await page.getByRole("combobox", { name: "Mode", exact: true }).click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(listbox).not.toHaveAttribute("data-theme-frame", "");
  expect(
    await listbox.evaluate((node) => ({
      inFrame: node.closest("[data-theme-frame]") !== null,
      popover: getComputedStyle(node).getPropertyValue("--surface-popover"),
    })),
  ).toEqual({
    inFrame: false,
    popover: await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--surface-popover",
      ),
    ),
  });
  await page.keyboard.press("Escape");

  await group.getByText("Buzz", { exact: true }).click();
  await expect(group.getByRole("radio", { name: /^Buzz/ })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "buzz");
  await expectFramed(page, false);
  expect(await background(page.locator("#shell-navigation"))).toBe(buzzSidebar);
  await group.getByText("Relax", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "relax");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "relax");
  await expectFramed(page, true);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");

  await expect(
    settingsDialog(page).getByRole("button", {
      name: "Close Settings",
      exact: true,
    }),
  ).toBeFocused();
  await selectSettingsSection(page, "Appearance");
  await expect(group.getByRole("radio", { name: /^Relax/ })).toBeChecked();
  await chooseColorMode(page, "Dark");
  await expectFramed(page, false);
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
    "rgb(33, 22, 33)",
  );
  expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
    "rgb(23, 15, 23)",
  );
  await chooseColorMode(page, "Light");
  await expectFramed(page, true);
  await closeSettings(page);
  await expect(page.locator("#shell-navigation")).toHaveAttribute(
    "data-theme-frame",
    "",
  );
});

test("a saved manual accent stays when the theme changes", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("buzz-accent.v1") === null)
      localStorage.setItem("buzz-accent.v1", "cobalt");
  });
  await page.goto(app.origin);
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  await appearance(page);
  await page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByText("Relax", { exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "relax");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  await expect(
    page.getByRole("button", { name: "Cobalt accent color" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Cable fills own bubbles with green under the Theme accent and yields to a manual accent", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await expect(group.getByRole("radio", { name: /^Cable/ })).not.toBeChecked();
  await expect(
    group.getByRole("radio", { name: /^Cable/ }),
  ).toHaveAccessibleDescription("Airy sky blue with fresh green replies.");
  await group.getByText("Cable", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "cable");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  await expectFramed(page, false);

  const ownBubble = async () => ({
    fill: await resolved(page, "--surface-message-own"),
    text: await resolved(page, "--text-message-own"),
  });
  expect(await ownBubble()).toEqual({
    fill: "rgb(232, 247, 219)",
    text: "rgb(31, 51, 19)",
  });
  expect(await resolved(page, "--accent-9")).toBe("rgb(16, 123, 187)");

  await chooseColorMode(page, "Dark");
  expect(await ownBubble()).toEqual({
    fill: "rgb(42, 78, 114)",
    text: "rgb(238, 245, 252)",
  });
  await chooseColorMode(page, "Light");

  await page.getByRole("button", { name: "Cobalt accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  const accentBubble = await ownBubble();
  expect(accentBubble.fill).toBe(await resolved(page, "--accent-4"));
  expect(accentBubble.fill).not.toBe("rgb(232, 247, 219)");

  await page.getByRole("button", { name: "Theme accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  expect((await ownBubble()).fill).toBe("rgb(232, 247, 219)");
});

test("Howdy gives own bubbles the mint fill only with the Theme accent", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await appearance(page);
  const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
  await group.getByText("Howdy", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "howdy");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-level",
    "touch",
  );
  expect(await resolved(page, "--surface-message-own")).toBe(
    "rgb(218, 246, 208)",
  );
  expect(await resolved(page, "--surface-panel", "body")).toBe(
    "rgb(247, 243, 234)",
  );
  await expectFramed(page, false);
  const cardBubble = (theme) =>
    group
      .locator(`svg[data-theme="${theme}"]`)
      .evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--surface-message-own"),
      );
  expect(
    await cardBubble("howdy"),
    "the Howdy card previews the mint fill",
  ).not.toBe(await cardBubble("buzz"));
  expect(
    await cardBubble("relax"),
    "another theme's card does not inherit the page theme's bubble",
  ).not.toBe(await cardBubble("howdy"));
  await chooseColorMode(page, "Dark");
  expect(await resolved(page, "--surface-message-own")).toBe("rgb(4, 89, 74)");
  expect(await resolved(page, "--affordance-mention-own-hover")).toBe(
    "rgb(5, 118, 98)",
  );
  await chooseColorMode(page, "Light");

  await page.getByRole("button", { name: "Cobalt accent color" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
  expect(await resolved(page, "--surface-message-own")).toBe(
    await resolved(page, "--accent-4"),
  );
  expect(await resolved(page, "--surface-message-own")).not.toBe(
    "rgb(218, 246, 208)",
  );
  expect(await resolved(page, "--text-metadata-own")).toBe(
    await resolved(page, "--text-metadata"),
  );
});
