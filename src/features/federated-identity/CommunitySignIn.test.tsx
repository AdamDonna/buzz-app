// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { CommunitySignIn } from "./CommunitySignIn";
import { federatedFixture } from "./testing";
afterEach(cleanup);
it.each(["storage-unavailable", "storage-denied"])(
  "gives secure-storage recovery instead of exposing %s",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "unavailable", failure });
    render(
      <CommunitySignIn
        identity={h.service}
        error="Federated sign-in is required"
        retry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Check your system’s credential permissions and try again.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(failure);
    expect(h.service.signIn).not.toHaveBeenCalled();
  },
);
it("requires explicit sign-in before retrying protected community admission", async () => {
  const h = federatedFixture();
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={h.service}
      error="Federated sign-in is required"
      retry={retry}
    />,
  );
  expect(h.service.signIn).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in" }));
  expect(retry).toHaveBeenCalledOnce();
});
it.each(["binding-mismatch", "authorization-denied"])(
  "retains a valid login and gives %s recovery without another login",
  (failure) => {
    const h = federatedFixture();
    h.publish({ status: "signed-in", failure });
    render(
      <CommunitySignIn identity={h.service} error={failure} retry={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      failure === "binding-mismatch"
        ? "Settings → Builderlab hosting"
        : "administrator",
    );
    if (failure === "binding-mismatch")
      expect(
        screen.getByRole("button", { name: "Sign in again" }),
      ).toBeEnabled();
    else expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(h.service.signIn).not.toHaveBeenCalled();
    expect(h.service.signOut).not.toHaveBeenCalled();
  },
);

it("renews explicitly without global sign-out, then resumes the refused connection", async () => {
  const h = federatedFixture();
  h.publish({ status: "signed-in" });
  const retry = vi.fn();
  render(
    <CommunitySignIn
      identity={h.service}
      error="binding-mismatch"
      retry={retry}
    />,
  );
  expect(h.service.signOut).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in again" }));
  expect(h.service.signOut).not.toHaveBeenCalled();
  expect(h.service.signIn).toHaveBeenCalledOnce();
  expect(retry).toHaveBeenCalledOnce();
});

it.each([
  ["Federated identity is not configured for this community", "exact host"],
  [
    "Unsupported federated community discovery",
    "Check your connection and retry",
  ],
])("explains %s without opening a browser", (error, message) => {
  const h = federatedFixture();
  render(
    <CommunitySignIn identity={h.service} error={error} retry={vi.fn()} />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(message);
  expect(h.service.signIn).not.toHaveBeenCalled();
});

it("keeps sign-in cancellable while the browser handoff is pending", async () => {
  const h = federatedFixture();
  let finish!: () => void;
  vi.mocked(h.service.signIn).mockImplementation(async () => {
    h.publish({ status: "signing-in" });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return h.service.snapshot();
  });
  render(
    <CommunitySignIn
      identity={h.service}
      error="Federated sign-in is required"
      retry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  try {
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  } finally {
    finish();
  }
});

it.each(["cancel", "failure"])(
  "binding recovery retains the existing shared session on browser %s",
  async (outcome) => {
    const h = federatedFixture();
    h.publish({ status: "signed-in" });
    const before = h.service.snapshot();
    let finish!: () => void;
    vi.mocked(h.service.signIn).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (outcome === "failure") throw new Error("storage-unavailable");
      return h.service.snapshot();
    });
    vi.mocked(h.service.cancelSignIn).mockResolvedValue();
    const retry = vi.fn();
    render(
      <CommunitySignIn
        identity={h.service}
        error="binding-mismatch"
        retry={retry}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    try {
      expect(
        screen.getByText(/existing valid Buzz sign-in stays active/),
      ).toBeVisible();
      expect(h.service.snapshot()).toBe(before);
      if (outcome === "cancel")
        await user.click(
          screen.getByRole("button", { name: "Cancel sign-in" }),
        );
    } finally {
      await act(async () => finish());
    }
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign in again" }),
      ).toBeEnabled(),
    );
    expect(h.service.snapshot()).toBe(before);
    expect(h.service.signOut).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  },
);
