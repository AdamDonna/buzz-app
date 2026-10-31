import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import {
  ANSWER_TAG,
  OWN,
  SAVED,
  answerContent,
  canAnswer,
  inlineUiAnswers,
  readAnswerTag,
} from "./answers";
import { readInlineUi, type InlineUi } from "./spec";

const agent = "a".repeat(64);
const owner = "b".repeat(64);
const carol = "c".repeat(64);
const dave = "d".repeat(64);
const general = "11111111-1111-4111-8111-111111111111";
const ownerOf = (pubkey: string) => (pubkey === agent ? owner : undefined);

const ui = (value: unknown) => {
  const read = readInlineUi(value);
  if (!("ui" in read)) throw new Error(read.error);
  return read.ui;
};
const choice = ui({ type: "choice", options: ["Warm", "Direct"], own: true });

let next = 0;
const id = () => (++next).toString(16).padStart(64, "0");
const asked = (inline: InlineUi, extra: Partial<ChannelMessage> = {}) =>
  ({
    id: id(),
    channelId: "chan",
    authorId: agent,
    createdAt: 10,
    content: "Pick.",
    mentions: [],
    attachments: [],
    reactions: [],
    inlineUi: { ui: inline, text: "Pick." },
    ...extra,
  }) as unknown as ChannelMessage;
const answer = (
  message: ChannelMessage,
  authorId: string,
  value: string,
  content: string,
  extra: Partial<ChannelMessage> = {},
) =>
  ({
    id: id(),
    channelId: "chan",
    authorId,
    createdAt: 11,
    content,
    mentions: [agent],
    attachments: [],
    reactions: [],
    inlineUiAnswer: { messageId: message.id, value },
    ...extra,
  }) as unknown as ChannelMessage;

describe("Inline UI answers", () => {
  it("words each answer from the value it picks", () => {
    expect(answerContent(choice, "1")).toBe("Direct");
    expect(answerContent(choice, OWN, "  Playful ")).toBe("Playful");
    expect(answerContent(choice, OWN, "two\nlines")).toBeUndefined();
    expect(answerContent(choice, "7")).toBeUndefined();
    expect(
      answerContent(ui({ type: "choice", options: ["a", "b"] }), OWN, "c"),
    ).toBeUndefined();
    const action = ui({
      type: "action",
      actions: [
        { label: "Join #general", do: "join_channel", channel: general },
        { label: "Open #general", do: "open_channel", channel: general },
      ],
    });
    expect(answerContent(action, "0")).toBe("Join #general");
    // Opening a channel is navigation, not an answer.
    expect(answerContent(action, "1")).toBeUndefined();
    const list = ui({ type: "list", channels: [general] });
    expect(answerContent(list, general)).toBe(
      `Joined buzz://channel/${general}`,
    );
    expect(answerContent(list, "0")).toBeUndefined();
    expect(
      answerContent(ui({ type: "form", form: "agent_profile" }), SAVED),
    ).toBe("Saved your name and avatar.");
    const checklist = ui({
      type: "checklist",
      steps: [{ label: "Say hi" }, { label: "Join", joined: general }],
    });
    expect(answerContent(checklist, "0")).toBe("Done: Say hi");
    // The app checks a joined step from real state.
    expect(answerContent(checklist, "1")).toBeUndefined();
  });

  it("reads only well-formed answer claims", () => {
    const target = "e".repeat(64);
    expect(readAnswerTag([[ANSWER_TAG, target, "0"]])).toEqual({
      messageId: target,
      value: "0",
    });
    expect(readAnswerTag([[ANSWER_TAG, "short", "0"]])).toBeUndefined();
    expect(readAnswerTag([[ANSWER_TAG, target]])).toBeUndefined();
    expect(readAnswerTag([])).toBeUndefined();
  });

  it("lets anyone but the author answer, only those tagged when it says so, and only the owner fill a form", () => {
    const open = asked(choice);
    expect(canAnswer(open, carol, ownerOf)).toBe(true);
    expect(canAnswer(open, agent, ownerOf)).toBe(false);
    const tagged = asked(
      ui({ type: "choice", options: ["a", "b"], for: "mentioned" }),
      { mentions: [carol] },
    );
    expect(canAnswer(tagged, carol, ownerOf)).toBe(true);
    expect(canAnswer(tagged, dave, ownerOf)).toBe(false);
    const form = asked(ui({ type: "form", form: "agent_profile" }), {
      mentions: [carol],
    });
    expect(canAnswer(form, owner, ownerOf)).toBe(true);
    expect(canAnswer(form, carol, ownerOf)).toBe(false);
  });

  it("counts each person's first valid answer, the same on any device", () => {
    const message = asked(choice);
    const first = answer(message, carol, "0", "Warm");
    const rows = [
      message,
      // Text that disagrees with the value it claims.
      answer(message, dave, "0", "Direct"),
      first,
      answer(message, carol, "1", "Direct"),
      answer(message, dave, OWN, "Playful"),
      // The author can't answer itself.
      answer(message, agent, "1", "Direct"),
    ];
    const counted = inlineUiAnswers(rows, ownerOf).get(message.id);
    expect(
      counted?.map(({ authorId, value, content }) => [
        authorId,
        value,
        content,
      ]),
    ).toEqual([
      [carol, "0", "Warm"],
      [dave, OWN, "Playful"],
    ]);
    expect(counted?.[0]?.id).toBe(first.id);
  });

  it("ignores edited, failed or misplaced answers and earlier messages", () => {
    const message = asked(choice);
    const rows = [
      message,
      answer(message, carol, "0", "Warm", { edited: true }),
      answer(message, carol, "0", "Warm", { delivery: "failed" }),
      answer(message, carol, "0", "Warm", { delivery: "unknown" }),
      answer(message, carol, "0", "Warm", { channelId: "other" }),
      answer(message, carol, "0", "Warm", { threadRootId: "f".repeat(64) }),
      answer(message, carol, "0", "Warm", { createdAt: 9 }),
    ];
    expect(inlineUiAnswers(rows, ownerOf).size).toBe(0);
    // A message without valid Inline UI has no answers.
    const { inlineUi: _ui, ...plain } = message;
    expect(
      inlineUiAnswers([plain, answer(plain, carol, "0", "Warm")], ownerOf).size,
    ).toBe(0);
  });

  it("keeps one answer per value for lists and checklists", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const message = asked(ui({ type: "list", channels: [general, other] }));
    const rows = [
      message,
      answer(message, carol, general, `Joined buzz://channel/${general}`),
      answer(message, carol, general, `Joined buzz://channel/${general}`),
      answer(message, carol, other, `Joined buzz://channel/${other}`),
    ];
    expect(
      inlineUiAnswers(rows, ownerOf)
        .get(message.id)
        ?.map(({ value }) => value),
    ).toEqual([general, other]);
  });
});
