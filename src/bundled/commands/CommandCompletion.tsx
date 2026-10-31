import { useEffect, useSyncExternalStore } from "react";
import type {
  ComposerCompletionProps,
  ContributionReader,
  SlashCommand,
} from "../../features/conversation/contracts";
import { listSlashCommands } from "./slash-query";

export function CommandCompletion({
  commands,
  query,
  slashScope,
  publish,
}: ComposerCompletionProps & {
  commands: ContributionReader<SlashCommand>;
}) {
  const registered = useSyncExternalStore(
    commands.subscribe,
    commands.snapshot,
    commands.snapshot,
  );
  useEffect(() => {
    const withdraw = publish({
      items: listSlashCommands(registered, query.query, slashScope).map(
        (command) => ({
          id: command.key,
          label: command.usage,
          detail: command.description,
          edit: { text: `/${command.name}` },
        }),
      ),
    });
    return () => {
      if (withdraw) withdraw();
    };
  }, [registered, query.query, slashScope, publish]);
  return null;
}
