import type { Contribution } from "../../plugins/contributions";
import type {
  SlashCommand,
  SlashCommandAvailabilityContext,
  SlashCommandContext,
  SlashCommandResult,
  SlashCommandScope,
} from "./contracts";

/** Every registered name and alias. A canonical name beats any alias; among
 * claimants of one name, the lowest key wins. */
export function slashNames(commands: readonly Contribution<SlashCommand>[]) {
  const names = new Map<string, Contribution<SlashCommand>>();
  const sorted = [...commands].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  for (const command of sorted)
    if (!names.has(command.name)) names.set(command.name, command);
  for (const command of sorted)
    for (const alias of command.aliases ?? [])
      if (!names.has(alias)) names.set(alias, command);
  return names;
}

/** A draft is a command when, after leading whitespace, its first token is `/`
 * plus a registered name or alias. Anything else, such as a mention first or
 * an unknown name, is not, so agents keep their own `/commands`. */
export function recognizeSlashCommand(
  draft: string,
  commands: readonly Contribution<SlashCommand>[],
) {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft);
  const command =
    match && slashNames(commands).get(match[1]?.toLowerCase() ?? "");
  return command ? { command, args: (match[2] ?? "").trim() } : undefined;
}

export const SLASH_SCOPES: readonly SlashCommandScope[] = [
  "channel",
  "dm",
  "thread",
];

/** A command without `scopes` runs everywhere; an unknown scope runs nothing scoped. */
export function runsInScope(
  command: SlashCommand,
  scope: SlashCommandScope | undefined,
) {
  return !command.scopes || (!!scope && command.scopes.includes(scope));
}

/** A command without `available` is available. A throwing check hides the
 * command rather than the whole list. */
export function isAvailable(
  command: SlashCommand,
  context: SlashCommandAvailabilityContext,
) {
  if (!command.available) return true;
  try {
    return command.available(context) === true;
  } catch {
    return false;
  }
}

export function unavailableRefusal(command: SlashCommand) {
  return `/${command.name} isn't available here. You may not have permission.`;
}

const SCOPE_NOUNS = {
  channel: "channels",
  dm: "direct messages",
  thread: "threads",
} as const;

export function scopeRefusal(command: SlashCommand) {
  const where = new Intl.ListFormat("en").format(
    (command.scopes ?? []).map((scope) => SCOPE_NOUNS[scope]),
  );
  return `/${command.name} only works in ${where}.`;
}

/** Runs a command and returns only a well-formed result. A failure the host can
 * show is an `Error` with a message; anything else becomes a generic one. */
export async function runSlashCommand(
  command: SlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  let result: unknown;
  try {
    result = await command.run(context);
  } catch (reason) {
    throw reason instanceof Error && reason.message.trim()
      ? reason
      : new Error(`/${command.name} failed`);
  }
  const value = (result ?? {}) as Record<string, unknown>;
  if (
    value.cancelled === true &&
    value.send === undefined &&
    value.done === undefined &&
    value.notice === undefined &&
    value.after === undefined
  )
    return { cancelled: true };
  if (
    typeof value.send === "string" &&
    value.send.trim() &&
    value.done === undefined &&
    value.notice === undefined &&
    value.after === undefined &&
    value.cancelled === undefined
  )
    return { send: value.send };
  if (
    value.done === true &&
    value.cancelled === undefined &&
    value.send === undefined &&
    (value.notice === undefined || typeof value.notice === "string") &&
    (value.after === undefined || typeof value.after === "function")
  )
    return {
      done: true,
      notice: value.notice?.trim() ? value.notice : undefined,
      after: value.after as (() => void) | undefined,
    };
  throw new Error(`/${command.name} returned an invalid result`);
}
