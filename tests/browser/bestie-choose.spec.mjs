import { test, expect } from "./source-fixture.mjs";

// With no saved Bestie, and in place of one that is no longer here, the Bestie
// page offers only agents on this device, and says why.
for (const [variant, query, title] of [
  ["empty", "", { role: "heading", name: "Choose your bestie" }],
  ["gone", "?gone", { text: "Zed is no longer here" }],
]) {
  test(`The ${variant} Bestie page offers only agents on this device`, async ({
    page,
  }) => {
    await page.goto(`/tests/fixtures/bestie-choose.html${query}`);
    await expect(
      title.role
        ? page.getByRole(title.role, { name: title.name })
        : page.getByText(title.text, { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Choose your bestie" }).click();
    await expect(
      page.getByText("Only agents on this device can be your Bestie for now."),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "Your agents" }).click();
    await expect(page.getByRole("option", { name: "Ada" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Cara" })).toHaveCount(0);
    if (process.env.BESTIE_SHOTS)
      await page.screenshot({
        path: `${process.env.BESTIE_SHOTS}/choose-${variant}.png`,
      });
  });
}
