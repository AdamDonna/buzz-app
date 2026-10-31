import type { InlineUi } from "./spec";

export type InlineActionHost = Readonly<{
  /** Joins as the viewer; resolves only once the relay confirms the join. */
  join(channelId: string): Promise<unknown>;
  open(channelId: string): void;
  /** Sends the viewer's answer, as `messages.answer` does. */
  answer(value: string): Promise<unknown> | unknown;
}>;

/** Runs what the viewer picked, with their own account, when they pick it.
 * `value` is an action's index, or a listed channel's id to join. A join is
 * answered only after the relay confirms it, so a failed join never claims
 * success; its error reaches the caller and nothing is posted. */
export async function runInlineAction(
  ui: InlineUi,
  value: string,
  host: InlineActionHost,
) {
  const action =
    ui.type === "action"
      ? /^\d$/.test(value)
        ? ui.actions[Number(value)]
        : undefined
      : ui.type === "list" && ui.channels.includes(value)
        ? ({ do: "join_channel", channel: value } as const)
        : undefined;
  if (!action) throw new Error("That isn’t one of its actions");
  if (action.do === "open_channel") return host.open(action.channel);
  await host.join(action.channel);
  await host.answer(value);
}
