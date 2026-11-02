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
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "../../features/agents/service";
import { approve, approved, type Config, DEFAULT_CONFIG } from "./config";
import { READY } from "./harness";
import { launchKey, modelCache } from "./models";
import { AcpRuntime } from "./runtime";
import {
  type Conversation,
  createTabs,
  type SignIn,
  type TabsRuntime,
} from "./tabs";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function fakeRuntime(over: Partial<TabsRuntime> = {}): TabsRuntime {
  return {
    subscribe: () => () => {},
    signIn: () => undefined,
    recheck: async () => undefined,
    conversations: () => [],
    replays: () => undefined,
    transcript: async () => undefined,
    ...over,
  };
}

const start: Config = {
  ...DEFAULT_CONFIG,
  command: "cursor-agent",
  args: ["acp"],
  env: { CURSOR_API_KEY: "hunter2", PATH: "/opt/bin" },
};

function mount(
  check = vi.fn(async (_: Config) => READY),
  initial = start,
  failing = 0,
  /** Saves wait for it, when given. */
  gate?: Promise<void>,
) {
  const { SettingsTab } = createTabs({
    check,
    cache: modelCache(localStorage),
    runtime: fakeRuntime(),
  });
  const saves: Config[] = [];
  let failures = failing;
  function Host() {
    const [config, setConfig] = useState(initial);
    return (
      <SettingsTab
        agent={{ config } as Agent<Config>}
        save={async (next) => {
          await gate;
          if (failures-- > 0) throw new Error("disk full");
          saves.push(next);
          setConfig(next);
        }}
      />
    );
  }
  render(<Host />);
  return { saves, check };
}

it("confirms the exact launch without showing env values other than PATH", async () => {
  const { saves, check } = mount();
  expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent('["cursor-agent","acp"]');
  expect(dialog).toHaveTextContent("CURSOR_API_KEY");
  expect(dialog).toHaveTextContent("PATH=/opt/bin");
  expect(dialog).not.toHaveTextContent("hunter2");
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(await approved(saves[0] as Config)).toBe(true);
  const checkButton = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(checkButton).toBeEnabled());
  await userEvent.click(checkButton);
  expect(check).toHaveBeenCalledWith(saves[0]);
  expect(await screen.findByRole("status")).toHaveTextContent(READY);
});

it("drops the approval when a launch setting is saved changed", async () => {
  const { saves } = mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  const args = screen.getByRole("textbox", { name: "Arguments" });
  await userEvent.type(args, "\n--force");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(saves[1]).toMatchObject({ args: ["acp", "--force"], approval: "" });
  expect(screen.getByRole("button", { name: "Check" })).toBeDisabled();
});

it("won't save a reserved env name, and says so once the field is left", async () => {
  const { saves } = mount();
  await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
  const name = screen.getByRole("textbox", { name: "Name of variable 3" });
  expect(name).toHaveFocus();
  await userEvent.type(name, "BUZZ_PRIVATE_KEY");
  // Not while typing.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  // Moving within the Environment group doesn't leave it.
  await userEvent.tab();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("textbox", { name: "Workspace" }));
  expect(screen.getByRole("alert")).toHaveTextContent("reserved for Buzz");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(saves).toHaveLength(0);
});

it("shows an edit's problem on Save without waiting for the field to be left", async () => {
  const { saves } = mount();
  const args = screen.getByRole("textbox", { name: "Arguments" });
  await userEvent.type(args, "\n");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.submit(args.closest("form") as HTMLFormElement);
  expect(screen.getByRole("alert")).toHaveTextContent("can't be empty");
  expect(saves).toHaveLength(0);
});

it("names each env row by its variable and keeps focus on hand after Remove", async () => {
  mount();
  const removeKey = screen.getByRole("button", {
    name: "Remove variable 1 (CURSOR_API_KEY)",
  });
  expect(
    screen.getByLabelText("Value of variable 1 (CURSOR_API_KEY)"),
  ).toBeInTheDocument();
  await userEvent.click(removeKey);
  // The row that moved up into its place.
  const path = screen.getByRole("button", { name: "Remove variable 1 (PATH)" });
  expect(path).toHaveFocus();
  await userEvent.click(path);
  expect(screen.getByRole("button", { name: "Add variable" })).toHaveFocus();
});

it("moves focus to the row before when the last row is removed", async () => {
  mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Remove variable 2 (PATH)" }),
  );
  expect(
    screen.getByRole("button", { name: "Remove variable 1 (CURSOR_API_KEY)" }),
  ).toHaveFocus();
});

it("says that a changed command needs confirming again after Save", async () => {
  mount();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Arguments" }),
    "\n--force",
  );
  expect(
    screen.getByText(/After you save, confirm it again/),
  ).toBeInTheDocument();
});

it("keeps a failed confirmation in the dialog, where it can be retried", async () => {
  const { saves } = mount(undefined, start, 1);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm" }),
  );
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "disk full",
  );
  expect(saves).toHaveLength(0);
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm" }),
  );
  await waitFor(() => expect(saves).toHaveLength(1));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(await approved(saves[0] as Config)).toBe(true);
});

it("shows Check pending on Check, and its failure apart from readiness", async () => {
  let finish!: (text: string) => void;
  const check = vi.fn(
    (_: Config) => new Promise<string>((resolve) => (finish = resolve)),
  );
  mount(check, await approve(start));
  const button = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  finish("cursor-agent wasn't found");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Check failed: cursor-agent wasn't found",
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("needs a new confirmation after switching preset away and back", async () => {
  const { saves } = mount();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  const check = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(check).toBeEnabled());
  for (const name of [/OpenCode/, /Cursor/]) {
    await userEvent.click(screen.getByRole("combobox", { name: "Harness" }));
    await userEvent.click(await screen.findByRole("option", { name }));
  }
  expect(check).toBeDisabled();
  expect(
    screen.getByText(
      "This command needs your confirmation before the agent can run.",
    ),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(saves[1]).toMatchObject({ preset: "cursor", approval: "" });
});

it.each([[["a\nb"]], [[""]]])(
  "won't silently rewrite stored args %j the box can't show",
  async (stored) => {
    const { saves } = mount(undefined, { ...start, args: stored });
    const save = screen.getByRole("button", { name: "Save" });
    expect(screen.getByRole("alert")).toHaveTextContent("can't be empty");
    expect(save).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(save);
    expect(saves).toHaveLength(0);
    const args = screen.getByRole("textbox", { name: "Arguments" });
    await userEvent.clear(args);
    await userEvent.type(args, "acp");
    await userEvent.tab();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ args: ["acp"] });
  },
);

it("waits for Arguments to be left even after another field was", async () => {
  mount();
  await userEvent.click(screen.getByRole("textbox", { name: "Command" }));
  await userEvent.tab();
  const args = screen.getByRole("textbox", { name: "Arguments" });
  expect(args).toHaveFocus();
  await userEvent.type(args, "{End}\n");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await userEvent.tab();
  expect(screen.getByRole("alert")).toHaveTextContent("can't be empty");
});

it("gives draft rows that share a name distinct accessible names", async () => {
  mount();
  await userEvent.click(screen.getByRole("button", { name: "Add variable" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Name of variable 3" }),
    "PATH",
  );
  expect(
    screen.getByRole("button", { name: "Remove variable 2 (PATH)" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Remove variable 3 (PATH)" }),
  ).toBeInTheDocument();
});

it("won't save a new launch while Check runs, so its result stays current", async () => {
  let finish!: (text: string) => void;
  const check = vi.fn(
    (_: Config) => new Promise<string>((resolve) => (finish = resolve)),
  );
  const { saves } = mount(check, await approve(start));
  const button = screen.getByRole("button", { name: "Check" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Arguments" }),
    "{End}\n--force",
  );
  const save = screen.getByRole("button", { name: "Save" });
  await userEvent.click(save);
  fireEvent.submit(save.closest("form") as HTMLFormElement);
  expect(saves).toHaveLength(0);
  finish(READY);
  expect(await screen.findByRole("status")).toHaveTextContent(READY);
  await userEvent.click(save);
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("keeps the dialog open while its save is pending, so a late failure shows", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { saves } = mount(undefined, start, 1, gate);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm command" }),
  );
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm" }),
  );
  await userEvent.keyboard("{Escape}");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("dialog")).toBe(dialog);
  release();
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "disk full",
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Confirm" }),
  );
  await waitFor(() => expect(saves).toHaveLength(1));
});

it("offers the models a launch has shown, with efforts only once selected", async () => {
  const value = await approve(start);
  const cache = modelCache(localStorage);
  cache.record(
    launchKey(value) as string,
    {
      model: {
        id: "model",
        currentValue: "a",
        options: [
          { value: "a", name: "Model A" },
          { value: "b", name: "Model B" },
        ],
      },
      effort: {
        id: "effort",
        currentValue: "low",
        options: [{ value: "low", name: "Low" }],
      },
    } as never,
  );
  const { SettingsTab } = createTabs({
    check: vi.fn(),
    cache,
    runtime: fakeRuntime(),
  });
  function Host() {
    const [config, setConfig] = useState<Config>({ ...value, model: "b" });
    return (
      <SettingsTab
        agent={{ config } as Agent<Config>}
        save={async (next) => setConfig(next)}
      />
    );
  }
  render(<Host />);
  expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
  // Model B was never selected, so no efforts are borrowed from A.
  expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
});

it("shows the harness's sign-in methods as its text and rechecks on demand", async () => {
  const signIn: SignIn = {
    methods: [{ name: "Browser", description: "Run its login" }],
  };
  const recheck = vi.fn(async () => "still signed out");
  const { SettingsTab } = createTabs({
    check: vi.fn(),
    cache: modelCache(localStorage),
    runtime: fakeRuntime({ signIn: () => signIn, recheck }),
  });
  render(
    <SettingsTab
      agent={{ pubkey: "p1", config: start } as Agent<Config>}
      save={async () => {}}
    />,
  );
  expect(screen.getByText(/instructions from it/)).toBeInTheDocument();
  expect(screen.getByText("Browser: Run its login")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Recheck" }));
  expect(recheck).toHaveBeenCalledWith("p1");
  expect(
    await screen.findByText("Recheck failed: still signed out"),
  ).toBeInTheDocument();
});

it("lists conversations and says when the harness can't replay them", async () => {
  const rows: Conversation[] = [
    {
      key: "c1/r1",
      channelId: "c1",
      root: "r1",
      at: 1,
      status: "Idle",
      replayable: true,
    },
  ];
  const { HistoryTab } = createTabs({
    check: vi.fn(),
    cache: modelCache(localStorage),
    runtime: fakeRuntime({ conversations: () => rows, replays: () => false }),
  });
  render(
    <HistoryTab
      agent={{ pubkey: "p1", config: start } as Agent<Config>}
      save={async () => {}}
    />,
  );
  expect(screen.getByText(/thread r1/)).toBeInTheDocument();
  expect(
    screen.getByText("This harness can't replay its transcripts."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Transcript" })).toBeNull();
});

it("mounts Settings and History on the real runtime, which React calls unbound", () => {
  const runtime = new AcpRuntime(
    {} as never,
    () => undefined,
    {} as never,
    undefined,
    undefined,
    localStorage,
  );
  const { SettingsTab, HistoryTab } = createTabs({
    check: vi.fn(),
    cache: modelCache(localStorage),
    runtime,
  });
  const agent = { pubkey: "p1", config: start } as Agent<Config>;
  render(<SettingsTab agent={agent} save={async () => {}} />);
  render(<HistoryTab agent={agent} save={async () => {}} />);
  expect(screen.getByRole("button", { name: "Confirm command" })).toBeVisible();
});
