import type { Contribution } from "../../plugins/contributions";
import type {
  SlashCommand,
  SlashCommandScope,
} from "../../features/conversation/contracts";
import {
  runsInScope,
  slashNames,
} from "../../features/conversation/slash-command";

/** Syntax only: the caret ends a first token that is `/` plus name characters. */
export function slashQuery(text: string, caret: number) {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const match = /^(\s*)\/([\w-]*)$/u.exec(text.slice(0, caret));
  if (!match || (caret < text.length && !/\s/u.test(text[caret] ?? "")))
    return null;
  return { start: (match[1] ?? "").length, end: caret, query: match[2] ?? "" };
}

/** Commands usable in `scope` whose name starts with the typed text, by name.
 * Aliases never list. */
export function listSlashCommands(
  commands: readonly Contribution<SlashCommand>[],
  query: string,
  scope: SlashCommandScope | undefined,
) {
  const prefix = query.toLowerCase();
  return [...slashNames(commands)]
    .filter(
      ([name, command]) =>
        name === command.name &&
        name.startsWith(prefix) &&
        runsInScope(command, scope),
    )
    .map(([, command]) => command)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}
