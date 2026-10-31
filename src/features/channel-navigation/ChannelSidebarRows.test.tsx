// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChannelSidebarRows } from "./ChannelSidebarRows";

afterEach(cleanup);

function rows(ids: string[]) {
  return (
    <ChannelSidebarRows open>
      {ids.map((id) => (
        <button type="button" key={id}>
          {id}
        </button>
      ))}
    </ChannelSidebarRows>
  );
}

it("shows initial rows immediately and preserves their nodes and focus on reorder", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  expect(alpha.parentElement).toHaveStyle({ opacity: "1" });
  alpha.focus();
  view.rerender(rows(["beta", "alpha"]));
  await waitFor(() =>
    expect(screen.getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "beta" }),
      alpha,
    ]),
  );
  expect(alpha).toHaveFocus();
});

it("applies the latest order when more activity arrives during a fade", async () => {
  const view = render(rows(["alpha", "beta", "gamma"]));
  view.rerender(rows(["beta", "alpha", "gamma"]));
  view.rerender(rows(["gamma", "beta", "alpha"]));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button").map((node) => node.textContent),
    ).toEqual(["gamma", "beta", "alpha"]),
  );
  await waitFor(() =>
    expect(view.container.firstElementChild).toHaveStyle({ opacity: "1" }),
  );
  expect(screen.getAllByRole("button").map((node) => node.textContent)).toEqual(
    ["gamma", "beta", "alpha"],
  );
});

it("leaves a stationary middle row fully opaque while its neighbors swap", async () => {
  const view = render(rows(["alpha", "beta", "gamma"]));
  const beta = screen.getByRole("button", { name: "beta" });
  const anchor = beta.parentElement;
  const container = view.container.firstElementChild;
  const opacities: number[] = [];
  const observer = new MutationObserver(() => {
    opacities.push(
      Number(getComputedStyle(anchor as Element).opacity) *
        Number(getComputedStyle(container as Element).opacity || "1"),
    );
  });
  observer.observe(view.container, {
    subtree: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  try {
    view.rerender(rows(["gamma", "beta", "alpha"]));
    await waitFor(() =>
      expect(
        screen.getAllByRole("button").map((node) => node.textContent),
      ).toEqual(["gamma", "beta", "alpha"]),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "alpha" }).parentElement,
      ).toHaveStyle({ opacity: "1" }),
    );
    expect(screen.getByRole("button", { name: "beta" })).toBe(beta);
    expect(opacities.length).toBeGreaterThan(0);
    expect(opacities.every((opacity) => opacity === 1)).toBe(true);
  } finally {
    observer.disconnect();
  }
});

it("retires an exiting row from interaction and accessibility before its fade ends", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  view.rerender(rows(["beta"]));
  expect(alpha.parentElement).toHaveAttribute("inert");
  expect(alpha.parentElement).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("button", { name: "alpha" }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(alpha).not.toBeInTheDocument());
});

it("restores a row that reappears during its exit without replacing its node", async () => {
  const view = render(rows(["alpha", "beta"]));
  const alpha = screen.getByRole("button", { name: "alpha" });
  view.rerender(rows(["beta"]));
  expect(alpha.parentElement).toHaveAttribute("inert");
  view.rerender(rows(["beta", "alpha"]));
  expect(screen.getByRole("button", { name: "alpha" })).toBe(alpha);
  expect(alpha.parentElement).not.toHaveAttribute("inert");
  await waitFor(() =>
    expect(alpha.parentElement).toHaveStyle({ opacity: "1" }),
  );
});
