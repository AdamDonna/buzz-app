// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelList,
  ChannelSummary,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { PrivateChannels, privateChannels } from "./PrivateChannels";

afterEach(cleanup);

const YOU = "f".repeat(64);
const BESTIE = "b".repeat(64);
const OTHER = "c".repeat(64);
const channel = (
  name: string,
  members: readonly string[],
  extra: Partial<ChannelSummary> = {},
): ChannelSummary => ({
  id: `id-${name}`,
  name,
  channelType: "stream",
  private: true,
  members,
  ...extra,
});

it("keeps only your private channels, split by Bestie's membership, most recent first", () => {
  const { joined, others } = privateChannels(
    [
      channel("quiet", [YOU]),
      channel("busy", [YOU], { lastActivityAt: 20 }),
      channel("older", [YOU], { lastActivityAt: 10 }),
      channel("shared", [YOU, BESTIE]),
      channel("forum", [YOU], { channelType: "forum" }),
      {
        id: "id-public",
        name: "public",
        channelType: "stream",
        members: [YOU],
      },
      channel("not-yours", [OTHER, BESTIE]),
      channel("dm", [YOU, BESTIE], { channelType: "dm" }),
      channel("solo", [YOU, BESTIE], { channelType: "solo" }),
      channel("archived", [YOU], { archived: true }),
      channel("huddle", [YOU], { huddle: true }),
    ],
    YOU,
    BESTIE,
  );
  expect(joined.map(({ name }) => name)).toEqual(["shared"]);
  expect(others.map(({ name }) => name)).toEqual([
    "busy",
    "older",
    "forum",
    "quiet",
  ]);
});

function session(
  channels: ChannelSummary[],
  removal = "confirmed",
  read: Partial<ChannelList> = { status: "ready" },
) {
  const roles: Record<string, string> = { [BESTIE]: "bot" };
  const add = vi.fn(async (id: string) => {
    if (id === "id-beta") throw new Error("Not confirmed. Try again.");
  });
  const run = vi.fn(async () => {});
  const list = { channels, ...read };
  const refreshList = vi.fn();
  const value = {
    viewer: YOU,
    outbox: { supports: () => true },
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => () => {},
      refreshList,
    },
    memberAdditions: { add },
    memberAdministration: {
      refresh: vi.fn(async () => {}),
      run,
      snapshot: vi.fn(() =>
        run.mock.calls.length
          ? {
              status: "ready",
              authority: { roles: {} },
              operation: {
                change: { pubkey: BESTIE, role: "remove" },
                status: removal,
              },
              ...(removal !== "confirmed" && {
                error: "The change may have taken effect. Refresh to check.",
              }),
            }
          : { status: "ready", authority: { roles } },
      ),
    },
  } as unknown as RelaySession;
  return { value, add, run, refreshList };
}

it("removes Bestie from a channel it is in, as the Members dialog does", async () => {
  const user = userEvent.setup();
  const { value, run } = session([channel("shared", [YOU, BESTIE])]);
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  await user.click(
    screen.getByRole("button", { name: "Remove Bestie from #shared" }),
  );
  expect(run).toHaveBeenCalledWith("id-shared", {
    pubkey: BESTIE,
    expectedRole: "bot",
    role: "remove",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  // Adding Bestie to channels you create isn't offered yet.
  expect(screen.queryByRole("switch")).toBeNull();
});

it("adds Bestie to one channel, or to all after asking, and reports what didn't confirm", async () => {
  const user = userEvent.setup();
  const { value, add } = session([
    channel("alpha", [YOU], { lastActivityAt: 5 }),
    channel("beta", [YOU], { lastActivityAt: 9 }),
  ]);
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  expect(screen.getByText(/Not in any of your private channels/)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Choose…" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual(["#beta", "#alpha"]);
  await user.click(screen.getByRole("menuitem", { name: "#alpha" }));
  expect(add).toHaveBeenCalledWith("id-alpha", BESTIE);

  add.mockClear();
  expect(screen.getByText(/2 channels without Bestie/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Add to all" }),
  ).toHaveAccessibleDescription("Add to all my private channels");
  await user.click(screen.getByRole("button", { name: "Add to all" }));
  const ask = await screen.findByRole("alertdialog", {
    name: "Add Bestie to 2 private channels?",
  });
  expect(add).not.toHaveBeenCalled();
  await user.click(within(ask).getByRole("button", { name: "Add to all" }));
  expect(add.mock.calls).toEqual([
    ["id-beta", BESTIE],
    ["id-alpha", BESTIE],
  ]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "#beta: Not confirmed. Try again.",
  );
});

it("stops adding a Bestie that changed partway through Add to all", async () => {
  const user = userEvent.setup();
  const { value, add } = session([
    channel("alpha", [YOU]),
    channel("gamma", [YOU]),
  ]);
  let done = () => {};
  add.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const { rerender } = render(
    <PrivateChannels session={value} bestie={BESTIE} />,
  );
  await user.click(screen.getByRole("button", { name: "Add to all" }));
  const ask = await screen.findByRole("alertdialog");
  await user.click(within(ask).getByRole("button", { name: "Add to all" }));
  expect(add).toHaveBeenCalledTimes(1);
  // Change makes another agent Bestie while the first add is pending.
  rerender(<PrivateChannels session={value} bestie={OTHER} />);
  await act(async () => done());
  expect(add.mock.calls).toEqual([[expect.any(String), BESTIE]]);
});

it("says when a removal isn't confirmed, and offers none from a cached roster", async () => {
  const user = userEvent.setup();
  const { value } = session(
    [
      channel("shared", [YOU, BESTIE]),
      channel("offline", [YOU, BESTIE], { cached: true }),
    ],
    "uncertain",
  );
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  expect(
    screen.getByRole("button", { name: "Remove Bestie from #offline" }),
  ).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Remove Bestie from #shared" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "#shared: The change may have taken effect. Refresh to check.",
  );
});

it("removes Bestie on the first click after mounting under StrictMode", async () => {
  const user = userEvent.setup();
  const { value, run } = session([channel("shared", [YOU, BESTIE])]);
  render(<PrivateChannels session={value} bestie={BESTIE} />, {
    reactStrictMode: true,
  });
  await user.click(
    screen.getByRole("button", { name: "Remove Bestie from #shared" }),
  );
  expect(run).toHaveBeenCalledOnce();
});

it("doesn't call a roster it couldn't read empty, and retries it", async () => {
  const user = userEvent.setup();
  const { value, refreshList } = session([], "confirmed", {
    status: "error",
    error: "The relay didn't answer.",
  });
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  expect(screen.queryByText(/Not in any of your private channels/)).toBeNull();
  expect(screen.getByText("Couldn't load your private channels")).toBeVisible();
  expect(screen.getByText("The relay didn't answer.")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(refreshList).toHaveBeenCalledOnce();
});

it("says it is still loading rather than that Bestie is in none", () => {
  const { value } = session([], "confirmed", { status: "loading" });
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  expect(screen.getByText("Loading your private channels…")).toBeVisible();
  expect(screen.queryByText(/Not in any of your private channels/)).toBeNull();
});

it("keeps the channels it knows from a partial roster, and holds Add to all", async () => {
  const user = userEvent.setup();
  const { value, add } = session(
    [channel("shared", [YOU, BESTIE]), channel("alpha", [YOU])],
    "confirmed",
    { status: "ready", coverage: "partial" },
  );
  render(<PrivateChannels session={value} bestie={BESTIE} />);
  expect(
    screen.getByRole("button", { name: "Remove Bestie from #shared" }),
  ).toBeEnabled();
  expect(
    screen.getByText("Only some of your private channels are loaded"),
  ).toBeVisible();
  expect(screen.queryByText(/Not in any of your private channels/)).toBeNull();
  expect(screen.getByRole("button", { name: "Add to all" })).toBeDisabled();
  expect(
    screen.getByText("Available once all your private channels have loaded."),
  ).toBeVisible();
  // A channel that is known can still be added on its own.
  await user.click(screen.getByRole("button", { name: "Choose…" }));
  await user.click(await screen.findByRole("menuitem", { name: "#alpha" }));
  expect(add).toHaveBeenCalledWith("id-alpha", BESTIE);
});
