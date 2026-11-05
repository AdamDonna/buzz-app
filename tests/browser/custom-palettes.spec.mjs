import { test, expect } from "./fixture.mjs";
import {
  openSettings,
  selectSettingsSection,
  chooseColorMode,
} from "./navigation.mjs";

// Real CSS cascading, native color controls and parser-blocking first paint
// cannot be proven by the resolver or React DOM tests.
test.use({ historyCounts: { alpha: 2, beta: 1 }, launchAnimation: true });
const palette = {
  version: 1,
  light: {
    window: "#ff0000",
    sidebar: "#0000ff",
    selection: "#663399",
    accent: "#888888",
  },
  dark: {
    window: "#ff0000",
    sidebar: "#0000ff",
    selection: "#663399",
    accent: "#888888",
  },
};
const button = (page, name) => page.getByRole("button", { name, exact: true });

test("custom palette editing, mode-scoped preview, reload and reset preserve actual host roles", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  await button(page, "Create theme").click();
  await page.getByLabel("Window color picker", { exact: true }).fill("#00ff00");
  await expect(
    page.getByRole("textbox", { name: "Window hex color", exact: true }),
  ).toHaveValue("#00ff00");
  const initialBackground = await page
    .locator("html")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await page
    .getByRole("textbox", { name: "Window hex color", exact: true })
    .fill("#ff0000");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    initialBackground,
  );
  const previews = page.getByRole("figure", { name: "Appearance preview" });
  await expect(previews).toHaveCount(2);
  await expect(previews.last()).toHaveCSS(
    "background-color",
    "rgb(255, 240, 240)",
  );
  await page
    .getByRole("textbox", { name: "Palette text" })
    .fill(JSON.stringify(palette));
  await button(page, "Import").click();
  // Inspect both modes in the same host: inherited root aliases must rebind.
  await button(page, "Dark").click();
  await expect(previews.last()).toHaveCSS("background-color", "rgb(15, 0, 0)");
  await button(page, "Light").click();
  await expect(previews.last()).toHaveCSS(
    "background-color",
    "rgb(255, 240, 240)",
  );
  for (let step = 0; step < 5; step++)
    await button(page, "Increase interface size").click();
  await expect(page.getByRole("status", { name: "Interface size" })).toHaveText(
    "150%",
  );
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    await page
      .getByRole("textbox", { name: "Accent hex color", exact: true })
      .focus();
    await expect(
      page.getByRole("textbox", { name: "Accent hex color", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("region", { name: "Appearance", exact: true })
      .screenshot({ path: testInfo.outputPath(`palette-editor-${width}.png`) });
    expect(
      await page
        .locator("html")
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
  await button(page, "Save theme").click();
  await expect(page.locator("html")).toHaveAttribute("data-custom-palette", "");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 240, 240)",
  );
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("buzz-palette.v1")),
    ),
  ).toEqual(palette);
  await expect(page.locator("[data-sidebar-surface]").first()).toHaveCSS(
    "background-color",
    "rgb(240, 240, 255)",
  );
  await chooseColorMode(page, "Dark");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(15, 0, 0)",
  );
  await expect(page.locator("[data-sidebar-surface]").first()).toHaveCSS(
    "background-color",
    "rgb(0, 0, 15)",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(15, 0, 0)",
  );
  await selectSettingsSection(page, "Appearance");
  await button(page, "Reset theme").click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-custom-palette",
    "",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(16, 16, 16)",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-palette.v1")),
  ).toBeNull();
  expect(
    await page
      .locator("html")
      .evaluate((node) => node.style.getPropertyValue("--accent-9-dark")),
  ).toBe("");
});

test("saved custom colors paint with the React module withheld", async ({
  page,
  app,
}) => {
  await page.addInitScript((data) => {
    localStorage.setItem("buzz-palette.v1", JSON.stringify(data));
    localStorage.setItem("buzz-appearance.v1", "light");
  }, palette);
  await page.route(/\/assets\/.*\.js$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "/* React withheld */",
    }),
  );
  await page.goto(app.origin, { waitUntil: "commit" });
  await expect(page.locator("#buzz-launch")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 240, 240)",
  );
  await expect(page.locator("html")).toHaveAttribute("data-custom-palette", "");
});

// Browser storage events cross actual windows; a DOM emulator cannot prove
// the integration between the browser event and a retained editor draft.
test("another window updates the saved palette while a dirty draft remains local", async ({
  page,
  context,
  app,
}) => {
  await page.goto(app.origin);
  await openSettings(page);
  await selectSettingsSection(page, "Appearance");
  await button(page, "Create theme").click();
  await page
    .getByRole("textbox", { name: "Accent hex color", exact: true })
    .fill("#ff0000");
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    const external = structuredClone(palette);
    external.light.window = "#00ff00";
    await other.evaluate(
      (data) => localStorage.setItem("buzz-palette.v1", JSON.stringify(data)),
      external,
    );
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      "rgb(240, 255, 240)",
    );
    await expect(page.getByText(/The saved theme changed/)).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Accent hex color", exact: true }),
    ).toHaveValue("#ff0000");
    await button(page, "Cancel").click();
    await button(page, "Edit theme").click();
    await expect(
      page.getByRole("textbox", { name: "Accent hex color", exact: true }),
    ).toHaveValue("#888888");
  } finally {
    await other.close();
  }
});
