import { expect, it } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { SlashCommand } from "./contracts";
import { recognizeSlashCommand } from "./slash-command";

function command(
  key: string,
  name: string,
  aliases?: string[],
): Contribution<SlashCommand> {
  return {
    id: name,
    key,
    pluginId: key.split("/")[0] ?? "",
    revision: "1",
    name,
    ...(aliases ? { aliases } : {}),
    usage: `/${name}`,
    description: name,
    run: () => ({ send: name }),
  };
}
const commands = [
  command("buzz.commands/shrug", "shrug"),
  command("buzz.commands/remove", "remove", ["kick"]),
];

it.each([
  ["/shrug", "shrug", ""],
  ["/SHRUG", "shrug", ""],
  ["  /shrug  spaced   out  ", "shrug", "spaced   out"],
  ["\n/shrug\nmulti\nline", "shrug", "multi\nline"],
  ["/kick @sam", "remove", "@sam"],
])("runs %j as /%s", (draft, name, args) => {
  const found = recognizeSlashCommand(draft, commands);
  expect(found?.command.name).toBe(name);
  expect(found?.args).toBe(args);
});

it.each([
  "@Eva /shrug",
  "[@Eva](nostr:npub1abc) /shrug",
  "/review hello",
  "/usr/bin/foo",
  "//shrug",
  "/shrug-now",
  "/shru",
  "/",
  "/ shrug",
  "hello /shrug",
  "",
])("sends %j unchanged", (draft) => {
  expect(recognizeSlashCommand(draft, commands)).toBeUndefined();
});

it("gives a duplicated name to the lowest contribution key", () => {
  const found = recognizeSlashCommand("/shrug", [
    command("z.plugin/shrug", "shrug"),
    command("a.plugin/shrug", "shrug"),
  ]);
  expect(found?.command.key).toBe("a.plugin/shrug");
});
