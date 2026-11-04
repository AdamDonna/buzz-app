// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import type { Credential } from "../oauth/browser";
import { deferred } from "../test-helpers";
import { createCreationFields, EMPTY_CREATION } from "./Create";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
const catalog = [
  {
    id: "one",
    display_name: "Sol 6.1",
    supported_reasoning_efforts: ["low", "high", "xhigh"],
  },
  {
    id: "two",
    display_name: "Model Two",
    supported_reasoning_efforts: ["none"],
  },
];
async function fixture(signedIn = true, disabled = false) {
  const acquire = vi.fn(async () => ({
    value: "credential",
    account: {
      subject: "account",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const session = createOAuthSession(acquire, undefined, {
    request: (input) => request(input),
  });
  if (signedIn) await session.signIn();
  let fail = false;
  const pending = deferred<void>();
  const request = vi.fn<Host["request"]>(async () => {
    await pending.promise;
    if (fail) return { status: 400, headers: {}, body: "{}" };
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ models: catalog }),
    };
  });
  const client = createAgentClient(session, null);
  const { Create, CreateConfiguration } = createCreationFields(client, session);
  let draft = { ...EMPTY_CREATION };
  function Form() {
    const [config, setConfig] = useState(draft);
    draft = config;
    return (
      <form onSubmit={(event) => event.preventDefault()}>
        <CreateConfiguration
          config={config}
          onChange={setConfig}
          disabled={disabled}
          harnessControl={null}
        />
        <Create config={config} onChange={setConfig} disabled={disabled} />
      </form>
    );
  }
  render(<Form />, { wrapper: StrictMode });
  return {
    session,
    acquire,
    request,
    pending,
    draft: () => draft,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
async function choose(label: string, value: string) {
  const user = userEvent.setup();
  if (label === "Model") {
    await user.click(await screen.findByRole("button", { name: /^Model:/ }));
    (
      await screen.findByRole("menuitem", {
        name: value.startsWith("Sol") ? "OpenAI" : "Other",
      })
    ).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitemradio", { name: value }));
    return;
  }
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: value }));
}

it("loads the catalog and keeps instructions alongside explicit model and effort choices", async () => {
  const h = await fixture();
  expect(screen.getByRole("status")).toHaveTextContent("Loading models");
  await act(async () => h.pending.resolve());
  const model = await screen.findByRole("button", {
    name: "Model: Choose a model",
  });
  expect(model).toHaveTextContent("Choose a model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Be precise.",
    );
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "Extra high");
  expect(h.draft().reasoningEffort).toBe("xhigh");
  await choose("Model", "Model Two");
  expect(h.draft().reasoningEffort).toBe("");
  expect(
    screen.getByRole("textbox", { name: "Instructions Optional" }),
  ).toHaveValue("Be precise.");
  await choose("Thinking", "None");
  expect(h.draft()).toEqual({
    instructions: "Be precise.",
    modelId: "two",
    reasoningEffort: "none",
    subject: "account",
  });
  expect(
    h.request.mock.calls.every(([input]) =>
      input.url.endsWith("/get-model-catalog"),
    ),
  ).toBe(true);
});

it("retains instructions when catalog loading fails and is retried", async () => {
  const h = await fixture();
  h.fail(true);
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Keep this.",
    );
  await act(async () => h.pending.resolve());
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  h.fail(false);
  await userEvent.setup().click(retry);
  await screen.findByRole("button", { name: "Model: Choose a model" });
  expect(h.draft().instructions).toBe("Keep this.");
  expect(h.draft().modelId).toBe("");
});

it("offers catalog families without a default or custom model action", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await userEvent
    .setup()
    .click(
      await screen.findByRole("button", { name: "Model: Choose a model" }),
    );
  expect(await screen.findByRole("menuitem", { name: "OpenAI" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Other" })).toBeVisible();
  expect(screen.queryByText(/Default|Custom model/)).not.toBeInTheDocument();
  expect(h.draft()).toEqual(EMPTY_CREATION);
});

it("disables model, thinking and instructions while creation is pending", async () => {
  const h = await fixture(true, true);
  await act(async () => h.pending.resolve());
  expect(
    await screen.findByRole("button", { name: "Model: Choose a model" }),
  ).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Instructions Optional" }),
  ).toBeDisabled();
  expect(h.draft()).toEqual(EMPTY_CREATION);
});

it("requires new account choices while retaining the draft instructions", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "High");
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Keep this.",
    );
  act(() => h.session.signOut());
  h.acquire.mockResolvedValue({
    value: "other-credential",
    account: {
      subject: "other",
      email: "b@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "another Builderlab account",
  );
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await choose("Model", "Model Two");
  await choose("Thinking", "None");
  expect(h.draft()).toEqual({
    instructions: "Keep this.",
    modelId: "two",
    reasoningEffort: "none",
    subject: "other",
  });
});

it("waits for explicit sign-in before loading the creation catalog", async () => {
  const h = await fixture(false);
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => h.pending.resolve());
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  await screen.findByRole("button", { name: "Model: Choose a model" });
  expect(h.acquire).toHaveBeenCalledTimes(1);
});

it("can cancel a pending shared sign-in even while the creation form is disabled", async () => {
  const login = deferred<Credential>();
  let aborted = false;
  const session = createOAuthSession(
    (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return login.promise;
    },
    undefined,
    { request: (input) => request(input) },
  );
  const request = vi.fn<Host["request"]>();
  const client = createAgentClient(session, null);
  const { CreateConfiguration } = createCreationFields(client, session);
  render(
    <CreateConfiguration
      config={{ ...EMPTY_CREATION }}
      disabled
      onChange={() => {}}
      harnessControl={null}
    />,
    { wrapper: StrictMode },
  );
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    void session.signIn();
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
  expect(cancel).toBeEnabled();
  await userEvent.setup().click(cancel);
  expect(aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Sign in to choose a model",
  );
  expect(request).not.toHaveBeenCalled();
});
