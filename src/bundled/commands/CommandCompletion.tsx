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
  session,
  scope,
  channelId,
  threadRootId,
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
    let withdraw: (() => void) | false | undefined;
    const update = () => {
      if (withdraw) withdraw();
      withdraw = publish({
        items: listSlashCommands(registered, query.query, slashScope, {
          session,
          scope,
          channelId,
          threadRootId,
        }).map((command) => ({
          id: command.key,
          label: command.usage,
          detail: command.description,
          edit: { text: `/${command.name}` },
        })),
      });
    };
    update();
    const stop = session.channels.subscribeList(update);
    return () => {
      stop();
      if (withdraw) withdraw();
    };
  }, [
    registered,
    query.query,
    session,
    scope,
    channelId,
    threadRootId,
    slashScope,
    publish,
  ]);
  return null;
}
