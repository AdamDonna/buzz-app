import { test, expect } from "./fixture.mjs";

test.use({
  productionBroker: true,
  relayPolicy: JSON.stringify({
    pinned: "primary.example",
    allowlist: ["secondary.example"],
  }),
  historyCounts: { alpha: 2, beta: 1 },
});

// One app journey proves the compiled policy, real browser persistence, UI
// and production broker compose. URL/configuration permutations stay in Vitest/Rust.
test("restores the pin before connecting and rejects a forbidden join and pinned leave", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const switcher = page.getByRole("button", {
    name: /^Community switcher:/,
  });
  await expect(switcher).toBeVisible();
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith("buzz-client.v1:"),
    );
    if (!key) throw new Error("Client identity did not finish restoring");
    const record = JSON.parse(localStorage.getItem(key));
    record.memberships = [
      { id: "https://blocked.example", name: "Blocked" },
      { id: "secondary", name: "Secondary" },
    ];
    record.selected = "https://blocked.example";
    localStorage.setItem(key, JSON.stringify(record));
  });
  await page.reload();
  await switcher.click();
  const picker = page.getByRole("dialog", {
    name: "Switch community",
    exact: true,
  });
  await expect(
    picker.getByRole("button", {
      name: "Switch to primary.example",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "true");
  await expect(
    picker.getByRole("button", { name: "Switch to Blocked", exact: true }),
  ).toHaveCount(0);
  await picker
    .getByRole("button", { name: "Join a community", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Community URL", exact: true })
    .fill("wss://blocked.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "not allowed by this build's relay policy",
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await switcher.click();
  await picker
    .getByRole("button", { name: "Switch to primary.example", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Leave community", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Leave community", exact: true })
    .click();
  await expect(
    page.getByText("The pinned relay cannot be removed from this build.", {
      exact: false,
    }),
  ).toBeVisible();
  await switcher.click();
  await picker
    .getByRole("button", { name: "Switch to Secondary", exact: true })
    .click();
  await expect.poll(() => app.relay.hasRoute("secondary", "alpha")).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith("buzz-client.v1:"),
        );
        const saved = JSON.parse(localStorage.getItem(key));
        return {
          selected: saved.selected,
          ids: saved.memberships.map((m) => m.id),
        };
      }),
    )
    .toEqual({ selected: "secondary", ids: ["primary", "secondary"] });
});
