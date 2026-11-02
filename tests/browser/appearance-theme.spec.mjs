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

const FRAMED_THEMES = [
  {
    id: "relax",
    label: "Relax",
    description: "Deep plum frame around a bright, open workspace.",
    light: {
      sidebar: "rgb(76, 28, 72)",
      canvas: "rgb(59, 18, 56)",
      selected: "rgb(246, 231, 242)",
    },
    dark: {
      sidebar: "rgb(33, 22, 33)",
      canvas: "rgb(23, 15, 23)",
      selected: "rgb(107, 52, 102)",
    },
  },
  {
    id: "utmost",
    label: "Utmost",
    description:
      "A steady navy sidebar, a crisp white page and a confident blue.",
    light: {
      sidebar: "rgb(27, 49, 82)",
      canvas: "rgb(20, 36, 63)",
      selected: "rgb(59, 108, 216)",
    },
    dark: {
      sidebar: "rgb(22, 32, 55)",
      canvas: "rgb(14, 21, 37)",
      selected: "rgb(60, 107, 217)",
    },
  },
];

for (const [index, theme] of FRAMED_THEMES.entries()) {
  const { id, label, description, light, dark } = theme;
  const pick = new RegExp(`^${label}`);
  const others = FRAMED_THEMES.filter((other) => other.id !== id);
  test(`${label} is picked by keyboard and pointer, survives reload and frames the shell only in light mode`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "buzz");
    await expectFramed(page, false);
    const buzzSidebar = await background(page.locator("#shell-navigation"));

    await appearance(page);
    const group = page.getByRole("radiogroup", { name: "Theme", exact: true });
    await expect(radios(page)).toHaveCount(FRAMED_THEMES.length + 1);
    await expect(group.getByRole("radio", { name: /^Buzz/ })).toBeChecked();
    await expect(group.getByRole("radio", { name: pick })).not.toBeChecked();
    // The name and the description each have one owner; the thumbnail has none.
    await expect(
      group.getByRole("radio", { name: pick }),
    ).toHaveAccessibleDescription(description);
    await expect(group.locator("svg:not([aria-hidden='true'])")).toHaveCount(0);

    const cardSidebar = (themeId) =>
      group
        .locator(`svg[data-theme="${themeId}"]`)
        .evaluate((node) =>
          getComputedStyle(node).getPropertyValue("--surface-sidebar"),
        );
    const previews = async () =>
      Object.fromEntries(
        await Promise.all(
          ["buzz", ...FRAMED_THEMES.map((t) => t.id)].map(async (themeId) => [
            themeId,
            await cardSidebar(themeId),
          ]),
        ),
      );
    const cards = await previews();
    expect(
      new Set(Object.values(cards)).size,
      "every card previews a different sidebar",
    ).toBe(FRAMED_THEMES.length + 1);

    await group.getByRole("radio", { name: /^Buzz/ }).focus();
    for (let step = 0; step <= index; step += 1)
      await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: pick })).toBeChecked();
    await expect(group.getByRole("radio", { name: pick })).toBeFocused();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    expect(await page.evaluate((k) => localStorage.getItem(k), themeKey)).toBe(
      id,
    );
    expect(
      await page.evaluate((k) => localStorage.getItem(k), accentKey),
      "choosing a theme writes only the theme key",
    ).toBeNull();
    await expect(
      page.getByRole("button", { name: "Theme accent color" }),
    ).toHaveAttribute("aria-pressed", "true");

    expect(
      await previews(),
      "each card previews its own theme, not the page theme",
    ).toEqual(cards);

    await expectFramed(page, true);
    const frameSidebar = await resolved(
      page,
      "--surface-sidebar",
      "#shell-navigation",
    );
    expect(frameSidebar).toBe(light.sidebar);
    expect(
      await background(page.locator("#shell-navigation .panel[data-sidebar]")),
    ).toBe(frameSidebar);
    expect(frameSidebar).not.toBe(buzzSidebar);
    expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
      light.canvas,
    );
    expect(
      await resolved(page, "--surface-sidebar-selected", "#shell-navigation"),
    ).toBe(light.selected);
    for (const other of others)
      expect(frameSidebar).not.toBe(other.light.sidebar);

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
    expect(await background(page.locator("#shell-navigation"))).toBe(
      buzzSidebar,
    );
    await group.getByText(label, { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    await expectFramed(page, true);
    await expect(page.locator("html")).toHaveAttribute("data-accent", "theme");

    await expect(
      settingsDialog(page).getByRole("button", {
        name: "Close Settings",
        exact: true,
      }),
    ).toBeFocused();
    await selectSettingsSection(page, "Appearance");
    await expect(group.getByRole("radio", { name: pick })).toBeChecked();
    await chooseColorMode(page, "Dark");
    await expectFramed(page, false);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-mode",
      "dark",
    );
    expect(await resolved(page, "--surface-sidebar", "#shell-navigation")).toBe(
      dark.sidebar,
    );
    expect(await resolved(page, "--bg-app", "header.shell-header")).toBe(
      dark.canvas,
    );
    expect(
      await resolved(page, "--surface-sidebar-selected", "#shell-navigation"),
    ).toBe(dark.selected);
    await chooseColorMode(page, "Light");
    await expectFramed(page, true);
    await closeSettings(page);
    await expect(page.locator("#shell-navigation")).toHaveAttribute(
      "data-theme-frame",
      "",
    );
  });
}

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
