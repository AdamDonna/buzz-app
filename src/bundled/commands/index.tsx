import type { PluginModule } from "../../plugins/api";
import { channelAdminCommands } from "./channel-admin";
import { CommandCompletion } from "./CommandCompletion";
import { membershipCommands } from "./membership";
import { slashQuery } from "./slash-query";
import { shrug } from "./shrug";

export const inject = ["conversation", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { conversation } = ctx;
  conversation.registerCompletion({
    id: "typeahead",
    title: "Command",
    match: ({ text, start }, { slashScope }) =>
      slashScope ? slashQuery(text, start) : null,
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
  for (const command of membershipCommands(ctx.navigation))
    conversation.registerCommand(command);
  for (const command of channelAdminCommands(ctx.navigation))
    conversation.registerCommand(command);
};
