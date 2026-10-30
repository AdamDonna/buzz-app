// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
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

function session(channels: ChannelSummary[], removal = "confirmed") {
  const roles: Record<string, string> = { [BESTIE]: "bot" };
  const add = vi.fn(async (id: string) => {
    if (id === "id-beta") throw new Error("Not confirmed. Try again.");
  });
  const run = vi.fn(async () => {});
  const list = { channels };
  const value = {
    viewer: YOU,
    outbox: { supports: () => true },
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => () => {},
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
  return { value, add, run };
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
  // Creating channels with Bestie is shown, not offered yet.
  expect(
    screen.getByRole("switch", {
      name: "Also add Bestie to private channels I create",
    }),
  ).toHaveAttribute("aria-disabled", "true");
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
