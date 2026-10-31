import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  SlashCommand,
  SlashCommandScope,
} from "../../features/conversation/contracts";
import { listSlashCommands, slashQuery } from "./slash-query";
import { shrug } from "./shrug";
import { choosePresence } from "./presence";
import { parseStatus } from "./status";
import type { PresenceControl } from "../../features/presence/activity";

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

function command(
  name: string,
  aliases?: string[],
  scopes?: SlashCommandScope[],
): Contribution<SlashCommand> {
  return {
    id: name,
    key: `test/${name}`,
    pluginId: "test",
    revision: "1",
    name,
    ...(aliases ? { aliases } : {}),
    ...(scopes ? { scopes } : {}),
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
    listSlashCommands(commands, query, "channel").map(({ name }) => name);
  expect(names("")).toEqual(["remove", "rename", "shrug", "status", "topic"]);
  expect(names("RE")).toEqual(["remove", "rename"]);
  expect(names("s")).toEqual(["shrug", "status"]);
  expect(names("kick")).toEqual([]);
  expect(names("hrug")).toEqual([]);
});

it("lists a scoped command only in its scopes", () => {
  const commands = [
    command("invite", undefined, ["channel"]),
    command("away", undefined, ["channel", "dm", "thread"]),
    command("shrug"),
  ];
  const names = (scope: SlashCommandScope | undefined) =>
    listSlashCommands(commands, "", scope).map(({ name }) => name);
  expect(names("channel")).toEqual(["away", "invite", "shrug"]);
  expect(names("dm")).toEqual(["away", "shrug"]);
  expect(names("thread")).toEqual(["away", "shrug"]);
  expect(names(undefined)).toEqual(["shrug"]);
});

const shortcodes: Record<string, string> = {
  tada: "🎉",
  party: ":party:",
};
const resolve = vi.fn(async (code: string) => shortcodes[code]);

it.each([
  ["", { kind: "open" }],
  ["clear", { kind: "clear" }],
  ["CLEAR", { kind: "clear" }],
  ["clear it", { kind: "set", emoji: "", text: "clear it" }],
  [":tada: shipped", { kind: "set", emoji: "🎉", text: "shipped" }],
  [":tada:", { kind: "set", emoji: "🎉", text: "" }],
  [
    ":party:   all  hands",
    { kind: "set", emoji: ":party:", text: "all  hands" },
  ],
  [":nope: shipped", { kind: "set", emoji: "", text: ":nope: shipped" }],
  [":nope:", { kind: "set", emoji: "", text: ":nope:" }],
  ["tada shipped", { kind: "set", emoji: "", text: "tada shipped" }],
  ["🎉 shipped", { kind: "set", emoji: "🎉", text: "shipped" }],
  ["🎉", { kind: "set", emoji: "🎉", text: "" }],
  ["👍🏽 ok", { kind: "set", emoji: "👍🏽", text: "ok" }],
  ["❤️ love", { kind: "set", emoji: "❤️", text: "love" }],
  ["1️⃣ first", { kind: "set", emoji: "1️⃣", text: "first" }],
  ["👨‍👩‍👧 family", { kind: "set", emoji: "👨‍👩‍👧", text: "family" }],
  ["🇺🇸 home", { kind: "set", emoji: "🇺🇸", text: "home" }],
  ["🎉🎉 shipped", { kind: "set", emoji: "", text: "🎉🎉 shipped" }],
  ["🎉shipped", { kind: "set", emoji: "", text: "🎉shipped" }],
  ["in a meeting", { kind: "set", emoji: "", text: "in a meeting" }],
  ["a", { kind: "set", emoji: "", text: "a" }],
  ["1", { kind: "set", emoji: "", text: "1" }],
])("reads the /status arguments %j", async (args, expected) => {
  expect(await parseStatus(args, resolve)).toEqual(expected);
});

it("asks the resolver only about a lone :shortcode: first argument", async () => {
  resolve.mockClear();
  await parseStatus(":tada: :party: x", resolve);
  await parseStatus("see :tada:", resolve);
  await parseStatus("🎉 :tada:", resolve);
  await parseStatus(":a:b: x", resolve);
  expect(resolve.mock.calls).toEqual([["tada"]]);
});

const control = (
  accepted: boolean,
  error?: string,
): [PresenceControl, ReturnType<typeof vi.fn>] => {
  const setPreference = vi.fn(() => accepted);
  return [
    {
      setPreference,
      snapshot: () => ({ status: "online", preference: "auto", error }),
    },
    setPreference,
  ];
};

it.each([
  ["away", true, undefined, undefined],
  ["auto", true, undefined, undefined],
  ["away", false, undefined, "Could not change your availability."],
  ["auto", false, undefined, "Could not change your availability."],
  ["away", true, "Could not save your status.", "Could not save your status."],
] as const)(
  "sets %s and reports a missing viewer or an unsaved presence change (accepted %s, error %s)",
  (target, accepted, error, failure) => {
    const [presence, setPreference] = control(accepted, error);
    if (failure)
      expect(() => choosePresence(presence, target)).toThrow(failure);
    else expect(() => choosePresence(presence, target)).not.toThrow();
    expect(setPreference).toHaveBeenCalledExactlyOnceWith(target);
  },
);
