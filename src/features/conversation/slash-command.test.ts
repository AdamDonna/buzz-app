import { expect, it } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type { SlashCommand } from "./contracts";
import {
  isAvailable,
  recognizeSlashCommand,
  runSlashCommand,
} from "./slash-command";

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

it("keeps a canonical name against another plugin's alias, whatever the keys", () => {
  const found = recognizeSlashCommand("/shrug", [
    command("a.plugin/shout", "shout", ["shrug"]),
    command("z.plugin/shrug", "shrug"),
  ]);
  expect(found?.command.key).toBe("z.plugin/shrug");
});

it("gives a duplicated name to the lowest contribution key", () => {
  const found = recognizeSlashCommand("/shrug", [
    command("z.plugin/shrug", "shrug"),
    command("a.plugin/shrug", "shrug"),
  ]);
  expect(found?.command.key).toBe("a.plugin/shrug");
});

const place = {
  session: {} as never,
  scope: "scope",
  channelId: "channel",
  conversation: "channel" as const,
};
const base = {
  id: "x",
  name: "x",
  usage: "/x",
  description: "x",
  run: () => ({ send: "x" }),
};

it.each([
  ["omitted", undefined, true],
  ["true", () => true, true],
  ["false", () => false, false],
  [
    "throwing",
    () => {
      throw new Error("boom");
    },
    false,
  ],
  ["truthy but not true", (() => "yes") as never, false],
])(
  "treats an availability check that is %s as %s",
  (_label, available, expected) => {
    expect(
      isAvailable({ ...base, ...(available ? { available } : {}) }, place),
    ).toBe(expected);
  },
);

it("passes the composing place to the availability check", () => {
  const seen: unknown[] = [];
  isAvailable(
    {
      ...base,
      available: (context) => {
        seen.push(context);
        return true;
      },
    },
    { ...place, threadRootId: "root", conversation: "thread" },
  );
  expect(seen).toEqual([
    { ...place, threadRootId: "root", conversation: "thread" },
  ]);
});

it("keeps an after callback on a done result and rejects a bad one or one on a send", async () => {
  const after = () => {};
  const context = {
    ...place,
    args: "",
    recipients: [],
    signal: new AbortController().signal,
  };
  await expect(
    runSlashCommand({ ...base, run: () => ({ done: true, after }) }, context),
  ).resolves.toMatchObject({ done: true, after });
  await expect(
    runSlashCommand(
      { ...base, run: (() => ({ done: true, after: "go" })) as never },
      context,
    ),
  ).rejects.toThrow("/x returned an invalid result");
  await expect(
    runSlashCommand(
      { ...base, run: (() => ({ send: "hi", after })) as never },
      context,
    ),
  ).rejects.toThrow("/x returned an invalid result");
});

it("accepts a lone cancelled result and rejects it mixed with any other", async () => {
  const context = {
    ...place,
    args: "",
    recipients: [],
    signal: new AbortController().signal,
  };
  await expect(
    runSlashCommand({ ...base, run: () => ({ cancelled: true }) }, context),
  ).resolves.toEqual({ cancelled: true });
  for (const extra of [
    { send: "hi" },
    { done: true },
    { notice: "ok" },
    { after: () => {} },
  ])
    await expect(
      runSlashCommand(
        { ...base, run: (() => ({ cancelled: true, ...extra })) as never },
        context,
      ),
    ).rejects.toThrow("/x returned an invalid result");
  await expect(
    runSlashCommand(
      { ...base, run: (() => ({ cancelled: false })) as never },
      context,
    ),
  ).rejects.toThrow("/x returned an invalid result");
});
