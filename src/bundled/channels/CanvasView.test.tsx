// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { MAX_MARKDOWN_DEPTH } from "../../features/relay/message-content";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { CanvasEditor } from "./CanvasEditor";
import { CANVAS_RENDER_CHARS, CanvasMarkdown } from "./CanvasView";

const profiles = {
  get: () => undefined,
  load: async () => undefined,
  subscribe: () => () => {},
} as never;
const channelId = "11111111-1111-4111-8111-111111111111";
const key = keypair();
const event = (content: string) =>
  signed(key, {
    kind: 40100,
    content,
    tags: [["h", channelId]],
    created_at: 1_700_000_000,
  });

function mount(read: ChannelCanvas["read"], readOnly = false) {
  const canvas = {
    available: true,
    read: vi.fn(read),
    save: vi.fn(async (_: string, content: string) => event(content)),
    history: vi.fn(async () => ({ revisions: [], next: undefined })),
  };
  render(
    <CanvasEditor
      canvas={canvas}
      profiles={profiles}
      scope="canvas-view-test"
      channelId={channelId}
      readOnly={readOnly}
    />,
  );
  return canvas;
}
const view = () => screen.getByRole("article", { name: "Saved Canvas" });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens on View with the saved Canvas rendered, beside Edit and History", async () => {
  mount(async () => event("# Plan\n\n- **one**\n- two"));
  const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["View", "Edit", "History"]);
  expect(screen.getByRole("tab", { name: "View" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await within(view()).findByRole("heading", { name: "Plan" }),
  ).toBeInTheDocument();
  expect(within(view()).getByText("one").tagName).toBe("STRONG");
});

it("shows the saved head, not an unsaved draft", async () => {
  mount(async () => event("Saved text"));
  await within(view()).findByText("Saved text");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas Markdown" }), {
    target: { value: "Draft text" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toHaveTextContent("Saved text");
  expect(view()).not.toHaveTextContent("Draft text");
});

it("shows loading, then a read failure with Retry, then the Canvas", async () => {
  let fail = true;
  const canvas = mount(async () => {
    if (fail) throw new Error("Relay unavailable");
    return event("Recovered");
  });
  expect(within(view()).getByRole("status")).toHaveTextContent(
    "Loading Canvas…",
  );
  expect(await within(view()).findByRole("alert")).toHaveTextContent(
    "Relay unavailable",
  );
  fail = false;
  fireEvent.click(
    within(view()).getByRole("button", { name: "Retry loading" }),
  );
  expect(await within(view()).findByText("Recovered")).toBeInTheDocument();
  expect(canvas.read).toHaveBeenCalledTimes(2);
});

it("says when the Canvas is empty", async () => {
  mount(async () => undefined);
  expect(
    await within(view()).findByText("This Canvas is empty."),
  ).toBeInTheDocument();
});

it("switches between View and Edit while the first read is pending", () => {
  mount(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  fireEvent.click(screen.getByRole("tab", { name: "View" }));
  expect(view()).toBeVisible();
});

it("keeps Edit for read-only viewers, with Save disabled", async () => {
  mount(async () => event("Saved"), true);
  await within(view()).findByText("Saved");
  fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
  expect(
    screen.getByRole("textbox", { name: "Canvas Markdown" }),
  ).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Save Canvas" })).toBeDisabled();
});

it("never runs raw HTML, inline images or unsafe links", () => {
  const openLink = vi.fn(() => true);
  const { container } = render(
    <CanvasMarkdown
      openLink={openLink}
      content={[
        '<script>alert(1)</script><b onclick="x()">bold</b>',
        "",
        "![tracker chart](https://example.test/chart.png)",
        "",
        "[unsafe](javascript:alert(1)) [creds](https://u:p@example.test/) [safe](https://example.test/doc)",
      ].join("\n")}
    />,
  );
  expect(container.querySelector("script, b, img")).toBeNull();
  expect(container).toHaveTextContent("<script>alert(1)</script>");
  expect(container).toHaveTextContent("tracker chart");
  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://example.test/doc",
  ]);
});

it("falls back to labelled source past the render budget or nesting limit", () => {
  const large = `# Big\n\n${"x".repeat(CANVAS_RENDER_CHARS)}`;
  const deep = `${">".repeat(MAX_MARKDOWN_DEPTH + 5)} deep`;
  for (const content of [large, deep]) {
    const { container, unmount } = render(
      <CanvasMarkdown content={content} openLink={() => false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "shown as Markdown source",
    );
    expect(container.querySelector("pre")?.textContent).toBe(content);
    expect(container.querySelector("h1")).toBeNull();
    unmount();
  }
});

it("renders a Canvas larger than the shared-notes cutoff", async () => {
  const body = Array.from({ length: 4_000 }, (_, i) => `- item ${i}`).join(
    "\n",
  );
  expect(body.length).toBeGreaterThan(40_000);
  const content = `# Tracker\n\n${body}\n\n${"word ".repeat(15_000)}`;
  expect(content.length).toBeGreaterThan(100_000);
  render(<CanvasMarkdown content={content} openLink={() => false} />);
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Tracker" }),
    ).toBeInTheDocument(),
  );
});
