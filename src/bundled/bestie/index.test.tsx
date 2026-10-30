// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { deferred } from "../builderlab/test-helpers";
import { bestieFixture, cleanups } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
composerDOMFixture();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const renderPage = (h: Awaited<ReturnType<typeof bestieFixture>>) => {
  const Page = h.pages.snapshot()[0]?.component;
  if (!Page) throw new Error("Missing Bestie page");
  return render(<Page />);
};

it("waits for the account choice before showing the chooser", async () => {
  const choice = deferred<string | undefined>();
  const h = await bestieFixture(native.invoke, {
    mainAgent: {
      read: () => choice.promise,
      write: async () => {},
    },
  });
  renderPage(h);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Loading your Bestie…",
  );
  expect(
    screen.queryByRole("button", { name: "Choose your bestie" }),
  ).not.toBeInTheDocument();
  await act(async () => choice.resolve(undefined));
  expect(
    await screen.findByRole("button", { name: "Choose your bestie" }),
  ).toBeVisible();
});

it("replaces hosted setup with the manual Bestie chooser", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  expect(
    await screen.findByRole("heading", { name: "Choose your bestie" }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Select or create an agent to be your bestie in Buzz. They’ll get special placement and extra capabilities throughout the app.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Set up Bestie" }),
  ).not.toBeInTheDocument();
});

it("opens the existing new-agent dialog from the chooser", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Choose your bestie" }),
  );
  await user.click(screen.getByRole("button", { name: "New agent" }));
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
});
