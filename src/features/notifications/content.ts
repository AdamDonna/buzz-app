import { workflowLabel } from "../relay/workflow-attribution";
import type { ChannelSummary, Profile } from "../relay/contracts";
import type { IncomingMessage } from "../relay/incoming";
import { scanMarkdown, visibleHtmlSource } from "../relay/message-content";
import type { NotificationCategory } from "./preferences";
import { prepareMarkdown } from "../messages/markdown-preparation";
import { remarkSpoilers } from "../messages/remark-spoilers";

export type NotificationText = Readonly<{ title: string; body: string }>;

// An isolated surrogate is not valid Unicode; native JSON rejects it.
const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function shortText(value: string, limit: number) {
  const points = Array.from(
    value
      .replace(loneSurrogate, "\uFFFD")
      .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  );
  return points.length > limit
    ? `${points.slice(0, limit - 1).join("")}…`
    : points.join("");
}

type TextNode = { type: string; value?: string; children?: TextNode[] };
function prose(node: TextNode): string {
  if (node.type === "spoiler") return "[Spoiler]";
  if (node.type === "definition") return "";
  if (node.type === "html") return visibleHtmlSource(node.value ?? "");
  if (node.type === "image" || node.type === "imageReference") return "[Image]";
  if (node.type === "break" || node.type === "thematicBreak") return " ";
  if (node.value !== undefined) return node.value;
  const separator = [
    "paragraph",
    "heading",
    "emphasis",
    "strong",
    "link",
    "linkReference",
  ].includes(node.type)
    ? ""
    : " ";
  return (node.children ?? []).map(prose).join(separator);
}

type PreviewOptions = Readonly<{
  storedPreview?: boolean;
  truncated?: boolean;
}>;

/** Legacy previews lost code/escape provenance. Leave one Markdown conversion
 * to the final reader, hiding any ambiguous spoiler tail before that conversion. */
export function redactStoredPreview(content: string): string {
  const opener = content.indexOf("||");
  return opener < 0 ? content : `${content.slice(0, opener)}[Spoiler]`;
}

/** Generic plugin prose has CommonMark semantics, without Buzz spoilers. */
export function plainText(content: string) {
  const end = /[\uD800-\uDBFF]/.test(content.charAt(4095)) ? 4095 : 4096;
  const { tree, tooDeep } = scanMarkdown(content.slice(0, end));
  return tooDeep ? "" : shortText(prose(tree), 200);
}

/** Flattened, bounded prose; empty when nothing displayable remains.
 * Stored previews have lost code/escape provenance and may have been cut. */
function messageText(content: string, options: PreviewOptions) {
  if (options.storedPreview) return plainText(redactStoredPreview(content));
  // Cut the source on a whole code point, never between a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(content.charAt(4095)) ? 4095 : 4096;
  const bounded = content.slice(0, end);
  const original = scanMarkdown(bounded);
  if (original.tooDeep) return "";
  if (!bounded.includes("||")) return shortText(prose(original.tree), 200);
  const prepared = prepareMarkdown(bounded);
  if (prepared.kind === "plain") return "";
  // Protect only authored spoiler delimiters, using the renderer's source
  // rules. A collision-free text token survives Markdown decoding without
  // turning escaped pipes, code or table grammar into hidden content.
  // Preserve the renderer's punctuation flanking around emphasis delimiters.
  let delimiter = "<\uE000>";
  const decoded = JSON.stringify(original.tree);
  while (prepared.content.includes(delimiter) || decoded.includes(delimiter))
    delimiter = `<${delimiter}>`;
  let source = prepared.content;
  for (const offset of [...prepared.spoilerDelimiters].reverse())
    source = source.slice(0, offset) + delimiter + source.slice(offset + 2);
  const { tree, tooDeep } = scanMarkdown(source);
  if (!tooDeep)
    remarkSpoilers(delimiter, options.truncated || content.length > end)(tree);
  return tooDeep ? "" : shortText(prose(tree), 200);
}

/** Bounded CommonMark text, not rendered HTML or a fetch of linked/attached content. */
export function messagePreview(
  content: string,
  options: PreviewOptions = {},
): string {
  return messageText(content, options) || "New message";
}

/** Plugin text gets the same flattening and bounds; missing text keeps the category fallback. */
export function pluginNotificationText(
  input: Readonly<{ title?: string; body?: string }>,
  label: string,
): NotificationText {
  return Object.freeze({
    title: shortText(input.title ?? "", 128) || "Buzz",
    body: plainText(input.body ?? "") || `New ${label.toLowerCase()}`,
  });
}

/** Names are optional cached enrichment; notifications never wait for profile reads. */
export function messageNotificationText(
  message: IncomingMessage,
  category: NotificationCategory,
  channel: ChannelSummary | undefined,
  profile: Profile | undefined,
  resolvedName?: string | undefined,
): NotificationText {
  const name =
    shortText(resolvedName ?? profile?.name ?? "", 64) ||
    (message.workflowOwnerId ?? message.authorId).slice(0, 10);
  const sender = message.workflowOwnerId ? workflowLabel(name) : name;
  const destination =
    channel?.channelType === "dm"
      ? "a direct message"
      : `#${shortText(channel?.name ?? "", 64) || message.channelId.slice(0, 8)}`;
  const title =
    category === "mention"
      ? `${sender} mentioned you in ${destination}`
      : category === "direct"
        ? `${sender} sent you a direct message`
        : `${sender} replied in ${destination}`;
  return Object.freeze({
    title,
    body: messagePreview(message.previewContent, {
      truncated: message.previewTruncated === true,
    }),
  });
}
