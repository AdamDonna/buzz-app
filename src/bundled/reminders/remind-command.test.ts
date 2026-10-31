import { expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../../features/conversation/contracts";
import type { Reminders } from "../../features/relay/reminders";
import type { RelayData } from "../../features/relay/service";
import { remindCommand } from "./remind-command";

const NOW = Date.UTC(2026, 9, 28, 15, 0);

function setup(connection: Record<string, unknown>) {
  const create = vi.fn<Reminders["create"]>(async () => {});
  const relay = {
    subscribe: () => () => {},
    snapshot: () => ({
      ...connection,
      session: { reminders: connection.reminders && { create } },
    }),
  } as unknown as RelayData;
  const command = remindCommand({
    relay,
    timeZone: "America/Chicago",
    now: () => NOW,
  });
  const run = (args: string, context: Partial<SlashCommandContext> = {}) =>
    command.run({
      session: {},
      scope: "origin:viewer",
      channelId: "channel",
      args,
      recipients: [],
      signal: new AbortController().signal,
      ...context,
    } as SlashCommandContext);
  return { create, run };
}

const ready = { status: "ready", scope: "origin:viewer", reminders: true };

it("creates a standalone reminder and reports the resolved local time", async () => {
  const { create, run } = setup(ready);
  await expect(run("me to submit the report in 20 minutes")).resolves.toEqual({
    done: true,
    notice: expect.stringMatching(/^Reminder set for Oct 28, 2026, 10:20.AM$/),
  });
  expect(create).toHaveBeenCalledExactlyOnceWith(
    undefined,
    (NOW + 20 * 60_000) / 1000,
    "submit the report",
  );
});

it.each([
  ["a connection that is not ready", { ...ready, status: "connecting" }],
  ["another community's connection", { ...ready, scope: "other:viewer" }],
  ["a session without reminders", { ...ready, reminders: false }],
])("fails visibly, creating nothing, with %s", async (_label, connection) => {
  const { create, run } = setup(connection);
  await expect(run("me to stretch in 1 hour")).rejects.toThrow(
    "Reminders are not available right now.",
  );
  expect(create).not.toHaveBeenCalled();
});

it("creates nothing once the send is abandoned", async () => {
  const { create, run } = setup(ready);
  const abandoned = new AbortController();
  abandoned.abort(new Error("abandoned"));
  await expect(
    run("me to stretch in 1 hour", { signal: abandoned.signal }),
  ).rejects.toThrow("abandoned");
  expect(create).not.toHaveBeenCalled();
});

it("lets a write failure through, so the draft is kept", async () => {
  const { create, run } = setup(ready);
  create.mockRejectedValueOnce(new Error("The relay refused the reminder"));
  await expect(run("me to stretch in 1 hour")).rejects.toThrow(
    "The relay refused the reminder",
  );
});

it("reports an unparseable <when> before it touches the session", async () => {
  const { create, run } = setup({ status: "connecting" });
  await expect(run("me to stretch")).rejects.toThrow(
    /^Say when, such as .* Usage: \/remind me <what> <when>$/,
  );
  await expect(run("@sam to stretch in 1 hour")).rejects.toThrow(
    "Reminders are personal. Use /remind me …",
  );
  expect(create).not.toHaveBeenCalled();
});
