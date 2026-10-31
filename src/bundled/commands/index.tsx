import type { PluginModule } from "../../plugins/api";
import { CommandCompletion } from "./CommandCompletion";
import { slashQuery } from "./slash-query";
import { shrug } from "./shrug";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { conversation } = ctx;
  conversation.registerCompletion({
    id: "typeahead",
    title: "Command",
    match: ({ text, start }, { slashCommands }) =>
      slashCommands ? slashQuery(text, start) : null,
    component: (props) => (
      <CommandCompletion {...props} commands={conversation.commands} />
    ),
  });
  conversation.registerCommand({
    id: "shrug",
    name: "shrug",
    usage: "/shrug [text]",
    description: "Send a message with ¯\\_(ツ)_/¯ appended",
    run: ({ args }) => ({ send: shrug(args) }),
  });
};
