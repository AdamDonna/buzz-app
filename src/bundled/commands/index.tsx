import type { PluginModule } from "../../plugins/api";
import { CommandCompletion } from "./CommandCompletion";
import { slashQuery } from "./slash-query";
import { shrug } from "./shrug";
import { choosePresence } from "./presence";
import { runStatus } from "./status";

export const inject = ["conversation", "presence", "statusSheet"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { conversation, presence, statusSheet } = ctx;
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
  conversation.registerCommand({
    id: "away",
    name: "away",
    usage: "/away",
    description: "Set your availability to away",
    run: () => {
      choosePresence(presence, "away");
      return { done: true, notice: "You are set to away" };
    },
  });
  conversation.registerCommand({
    id: "active",
    name: "active",
    usage: "/active",
    description: "Clear your away setting",
    run: () => {
      choosePresence(presence, "auto");
      return { done: true, notice: "You are set to active" };
    },
  });
  conversation.registerCommand({
    id: "status",
    name: "status",
    usage: "/status [emoji] <text> | clear",
    description: "Set or clear your status",
    run: async ({ args, session }) => {
      const notice = await runStatus(args, session, statusSheet);
      return notice ? { done: true, notice } : { done: true };
    },
  });
};
