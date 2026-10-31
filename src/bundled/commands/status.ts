import { isUnicodeEmojiOnly } from "../../features/messages/emoji-size";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { StatusSheet } from "../../features/user-status/sheet";
import { standardEmojiFor } from "../emoji/emoji-search";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SHORTCODE = /^:([^:\s]+):$/;

export type StatusRequest =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "clear" }>
  | Readonly<{ kind: "set"; emoji: string; text: string }>;

/** The first argument is the emoji when it is a `:shortcode:` that `resolve`
 * names or a single emoji grapheme; otherwise every argument is the text. */
export async function parseStatus(
  args: string,
  resolve: (code: string) => Promise<string | undefined>,
): Promise<StatusRequest> {
  if (!args) return { kind: "open" };
  if (args.toLowerCase() === "clear") return { kind: "clear" };
  const first = /^\S+/.exec(args)?.[0] ?? "";
  const code = SHORTCODE.exec(first)?.[1];
  const emoji = code
    ? await resolve(code)
    : [...graphemes.segment(first)].length === 1 && isUnicodeEmojiOnly(first)
      ? first
      : undefined;
  return emoji
    ? { kind: "set", emoji, text: args.slice(first.length).trim() }
    : { kind: "set", emoji: "", text: args };
}

/** A community emoji stays `:code:`, which the status write path gives its
 * image URL; any other name must be a Unicode shortcode or alias. */
async function resolveShortcode(session: ComposerSession, code: string) {
  await session.emoji.ensure();
  const name = code.toLowerCase();
  const catalog = session.emoji.snapshot();
  if (catalog.entries.some(({ shortcode }) => shortcode === name))
    return `:${name}:`;
  const standard = await standardEmojiFor(code);
  if (!standard && catalog.status === "error")
    throw new Error("Could not load community emoji. Try again.");
  return standard;
}

/** Runs `/status`; returns the confirmation. Throws when nothing changed. */
export async function runStatus(
  args: string,
  session: ComposerSession,
  sheet: StatusSheet,
) {
  const request = await parseStatus(args, (code) =>
    resolveShortcode(session, code),
  );
  if (request.kind === "open") {
    if (!sheet.open())
      throw new Error("Status updates are unavailable in this community.");
    return undefined;
  }
  if (!session.statuses)
    throw new Error("Status updates are unavailable in this community.");
  if (request.kind === "clear") {
    await session.statuses.save({ text: "", emoji: "" });
    return "Status cleared";
  }
  await session.statuses.save({ text: request.text, emoji: request.emoji });
  return "Status set";
}
