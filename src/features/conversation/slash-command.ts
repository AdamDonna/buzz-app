import type { Contribution } from "../../plugins/contributions";
import type { SlashCommand } from "./contracts";

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

/** Rejects with the signal's reason as soon as it aborts, even when `work`
 * ignores the signal, so a caller never waits on an abandoned command. */
export function untilAborted<T>(
  work: T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
