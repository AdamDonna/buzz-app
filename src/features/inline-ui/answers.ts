import type { ChannelMessage } from "../relay/contracts";
import { channelLink, type InlineUi } from "./spec";

/** The signed tag on an answer: the answered message's id and the value
 * picked. The answer's text is the answer itself, so a reader without Inline
 * UI, person or agent, reads it as an ordinary reply. */
export const ANSWER_TAG = "inline-ui-answer";

/** Values: an option's, action's or manual step's index; `own` for a written
 * choice; a listed channel's id for joining it; `saved` for a form. */
export const OWN = "own";
export const SAVED = "saved";
const OWN_MAX = 500;
const HEX64 = /^[0-9a-f]{64}$/;

const at = <T>(list: readonly T[], value: string) =>
  /^\d$/.test(value) ? list[Number(value)] : undefined;

/** The text of an answer with `value`, or undefined when it doesn't answer
 * `ui`. A written choice supplies its own one-line text. */
export function answerContent(
  ui: InlineUi,
  value: string,
  own?: string,
): string | undefined {
  switch (ui.type) {
    case "choice": {
      if (value !== OWN) return at(ui.options, value);
      const text = own?.trim();
      return ui.own && text && text.length <= OWN_MAX && !/[\r\n]/.test(text)
        ? text
        : undefined;
    }
    case "action": {
      // Opening a channel is navigation, not an answer.
      const action = at(ui.actions, value);
      return action?.do === "join_channel" ? action.label : undefined;
    }
    case "list":
      return ui.channels.includes(value)
        ? `Joined ${channelLink(value)}`
        : undefined;
    case "form":
      return value === SAVED ? "Saved your name and avatar." : undefined;
    case "checklist": {
      // A step the app checks from real state takes no answer.
      const step = at(ui.steps, value);
      return step && !step.joined ? `Done: ${step.label}` : undefined;
    }
  }
}

/** The message's signed answer claim, if well formed. */
export function readAnswerTag(tags: readonly (readonly string[])[]) {
  const tag = tags.find(([name]) => name === ANSWER_TAG);
  return tag?.[1] && HEX64.test(tag[1]) && tag[2]
    ? Object.freeze({ messageId: tag[1], value: tag[2] })
    : undefined;
}

/** Whether `person` may answer `message`'s Inline UI. `owner` is the
 * verified owner of an agent, from its signed profile. */
export function canAnswer(
  message: Pick<ChannelMessage, "authorId" | "mentions" | "inlineUi">,
  person: string,
  owner: (agent: string) => string | undefined,
) {
  const ui = message.inlineUi?.ui;
  if (!ui || person === message.authorId) return false;
  if (ui.type === "form") return owner(message.authorId) === person;
  return ui.for !== "mentioned" || message.mentions.includes(person);
}

export type InlineUiAnswer = Readonly<{
  /** The answer message. */
  id: string;
  authorId: string;
  value: string;
  content: string;
}>;

/** Each Inline UI message's counted answers, oldest first: messages in the
 * same channel and thread whose signed claim names it, from someone allowed to
 * answer, whose text is exactly that answer's. An edited, failed or
 * unconfirmed answer doesn't count, and neither does a person's repeat of a
 * value they already answered. Single-answer types (choice, action, form)
 * keep only each person's first. An answer is the person's signed claim:
 * "Joined" says the app joined first, but check membership itself when an
 * agent relies on it. */
export function inlineUiAnswers(
  rows: readonly ChannelMessage[],
  owner: (agent: string) => string | undefined,
): ReadonlyMap<string, readonly InlineUiAnswer[]> {
  const asked = new Map(
    rows.flatMap((row) => (row.inlineUi ? [[row.id, row] as const] : [])),
  );
  const answers = new Map<string, InlineUiAnswer[]>();
  const counted = new Set<string>();
  for (const row of rows) {
    const claim = row.inlineUiAnswer;
    const message = claim && asked.get(claim.messageId);
    if (
      !claim ||
      !message?.inlineUi ||
      row.edited ||
      (row.delivery &&
        row.delivery !== "accepted" &&
        row.delivery !== "seen") ||
      row.channelId !== message.channelId ||
      row.threadRootId !== message.threadRootId ||
      row.createdAt < message.createdAt ||
      !canAnswer(message, row.authorId, owner)
    )
      continue;
    const { ui } = message.inlineUi;
    // The signed text, before attachment links are shown as attachments.
    const content = row.sourceContent ?? row.content;
    if (content !== answerContent(ui, claim.value, content)) continue;
    const single =
      ui.type === "choice" || ui.type === "action" || ui.type === "form";
    const key = `${message.id}:${row.authorId}:${single ? "" : claim.value}`;
    if (counted.has(key)) continue;
    counted.add(key);
    const list = answers.get(message.id) ?? [];
    list.push(
      Object.freeze({
        id: row.id,
        authorId: row.authorId,
        value: claim.value,
        content,
      }),
    );
    answers.set(message.id, list);
  }
  return answers;
}
