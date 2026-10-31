import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { SlashCommand } from "../../features/conversation/contracts";
import { listSlashCommands, slashQuery } from "./slash-query";
import { shrug } from "./shrug";

const wire = "¯" + "\\".repeat(3) + "_(ツ)" + "\\" + "_/¯";

it("sends the CommonMark-escaped shrug, with the text first when there is some", () => {
  expect(shrug("")).toBe(wire);
  expect(shrug("well")).toBe(`well ${wire}`);
  const rendered = fromMarkdown(shrug("well")).children[0];
  expect(rendered).toMatchObject({
    type: "paragraph",
    children: [{ type: "text", value: "well ¯\\_(ツ)_/¯" }],
  });
});

it.each([
  ["/", 1, { start: 0, end: 1, query: "" }],
  ["/sh", 3, { start: 0, end: 3, query: "sh" }],
  ["  /Sh", 5, { start: 2, end: 5, query: "Sh" }],
  ["\n/sh", 4, { start: 1, end: 4, query: "sh" }],
  ["/sh hello", 3, { start: 0, end: 3, query: "sh" }],
  ["/sh", 2, null],
  ["/sh hello", 9, null],
  ["/sh hello", 4, null],
  ["//sh", 4, null],
  ["/usr/bin", 8, null],
  ["hello /sh", 9, null],
  ["@Eva /sh", 8, null],
  ["", 0, null],
])("finds the command query in %j at %i", (text, caret, expected) => {
  expect(slashQuery(text, caret)).toEqual(expected);
});

function command(name: string, aliases?: string[]): Contribution<SlashCommand> {
  return {
    id: name,
    key: `test/${name}`,
    pluginId: "test",
    revision: "1",
    name,
    ...(aliases ? { aliases } : {}),
    usage: `/${name}`,
    description: name,
    run: () => ({ send: name }),
  };
}

it("lists commands whose name starts with the query, by name, never by alias", () => {
  const commands = [
    command("topic"),
    command("status"),
    command("shrug"),
    command("remove", ["kick"]),
    command("rename"),
  ];
  const names = (query: string) =>
    listSlashCommands(commands, query).map(({ name }) => name);
  expect(names("")).toEqual(["remove", "rename", "shrug", "status", "topic"]);
  expect(names("RE")).toEqual(["remove", "rename"]);
  expect(names("s")).toEqual(["shrug", "status"]);
  expect(names("kick")).toEqual([]);
  expect(names("hrug")).toEqual([]);
});
