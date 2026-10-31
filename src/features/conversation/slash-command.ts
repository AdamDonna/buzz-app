import type { Contribution } from "../../plugins/contributions";
import type { SlashCommand } from "./contracts";

/** Every registered name and alias; a duplicate belongs to the lowest key. */
export function slashNames(commands: readonly Contribution<SlashCommand>[]) {
  const names = new Map<string, Contribution<SlashCommand>>();
  for (const command of [...commands].sort((a, b) =>
    a.key.localeCompare(b.key),
  ))
    for (const name of [command.name, ...(command.aliases ?? [])])
      if (!names.has(name)) names.set(name, command);
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
