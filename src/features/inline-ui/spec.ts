// Inline UI: interactive pieces an agent attaches to a chat message. The
// agent names a type and supplies only its words and references; the app owns
// how each type looks, what it shows and what it does. The format is
// runtime-neutral: any agent host can emit the signed `inline-ui` tag below
// with the message text followed by `fallbackText` of the same value.

/** The signed tag holding a message's Inline UI as JSON. */
export const INLINE_UI_TAG = "inline-ui";
export const INLINE_UI_VERSION = 1;

export const TYPES = ["choice", "action", "list", "form", "checklist"] as const;
export const ACTIONS = ["join_channel", "open_channel"] as const;
export const FORMS = ["agent_profile"] as const;

const LABEL_MAX = 80;
const MAX_TAG = 8192;
const LIMITS = {
  options: [2, 6],
  actions: [1, 2],
  channels: [1, 50],
  steps: [1, 8],
} as const;
const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `mentioned`: only the people the message tags may answer. Absent: anyone
 * in the chat but its author. A form is always its agent's owner's alone. */
type Audience = Readonly<{ for?: "mentioned" }>;
type Base<T extends (typeof TYPES)[number]> = Readonly<{
  v: typeof INLINE_UI_VERSION;
  type: T;
}>;

export type InlineUiAction = Readonly<{
  label: string;
  do: (typeof ACTIONS)[number];
  channel: string;
}>;
export type InlineUiStep = Readonly<{
  label: string;
  /** The app checks the step off once the viewer has joined this channel. */
  joined?: string;
}>;

export type InlineUi =
  | (Base<"choice"> &
      Audience &
      Readonly<{ options: readonly string[]; own?: true }>)
  | (Base<"action"> &
      Audience &
      Readonly<{ actions: readonly InlineUiAction[] }>)
  /** Channels named by id; the app resolves them live, as the viewer. */
  | (Base<"list"> & Audience & Readonly<{ channels: readonly string[] }>)
  | (Base<"form"> & Readonly<{ form: (typeof FORMS)[number] }>)
  | (Base<"checklist"> &
      Audience &
      Readonly<{ steps: readonly InlineUiStep[] }>);

type Read = Readonly<{ ui: InlineUi }> | Readonly<{ error: string }>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Breaks a line, or reorders how text displays. Emoji joiners and variation
 * selectors stay allowed. */
const NOT_ONE_LINE =
  /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function label(value: unknown, what: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > LABEL_MAX || NOT_ONE_LINE.test(text))
    throw new Error(`${what} must be one line of 1–${LABEL_MAX} characters.`);
  // The plain-text version writes links after labels; a label holding one
  // could make two different Inline UIs read the same.
  if (text.includes("buzz://"))
    throw new Error(`${what} can't contain a buzz:// link.`);
  return text;
}

function channel(value: unknown, what: string) {
  if (typeof value !== "string" || !CHANNEL_ID.test(value))
    throw new Error(`${what} must be a channel id.`);
  return value;
}

function items<T>(
  value: unknown,
  name: keyof typeof LIMITS,
  read: (item: unknown, index: number) => T,
): readonly T[] {
  const [min, max] = LIMITS[name];
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new Error(`ui.${name} must list ${min}–${max} items.`);
  return Object.freeze(value.map(read));
}

function unique(values: readonly string[], what: string) {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) throw new Error(`${what} repeat “${value}”.`);
    seen.add(key);
  }
}

function fields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where = "ui",
) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Error(`${where} has unknown fields: ${extra.join(", ")}.`);
}

function audience(value: Record<string, unknown>): Audience {
  if (value.for === undefined) return {};
  if (value.for !== "mentioned") throw new Error("ui.for must be mentioned.");
  return { for: "mentioned" };
}

/** Inline UI from untrusted input, or the reason it is not, worded for the
 * agent that sent it. `v` defaults to the current version. */
export function readInlineUi(value: unknown): Read {
  try {
    if (!isObject(value)) throw new Error("ui must be an object.");
    const v = value.v ?? INLINE_UI_VERSION;
    if (v !== INLINE_UI_VERSION)
      throw new Error(`ui.v must be ${INLINE_UI_VERSION}.`);
    const base = { v: INLINE_UI_VERSION } as const;
    switch (value.type) {
      case "choice": {
        fields(value, ["v", "type", "for", "options", "own"]);
        const options = items(value.options, "options", (option) =>
          label(option, "Each option"),
        );
        unique(options, "ui.options");
        if (value.own !== undefined && typeof value.own !== "boolean")
          throw new Error("ui.own must be true or false.");
        return done({
          ...base,
          type: "choice",
          ...audience(value),
          options,
          ...(value.own ? { own: true as const } : {}),
        });
      }
      case "action": {
        fields(value, ["v", "type", "for", "actions"]);
        const actions = items(value.actions, "actions", (action) => {
          if (!isObject(action))
            throw new Error("Each action must be an object.");
          fields(action, ["label", "do", "channel"], "An action");
          if (!ACTIONS.includes(action.do as InlineUiAction["do"]))
            throw new Error(`An action's do must be ${ACTIONS.join(" or ")}.`);
          return Object.freeze({
            label: label(action.label, "Each action label"),
            do: action.do as InlineUiAction["do"],
            channel: channel(action.channel, "An action's channel"),
          });
        });
        unique(
          actions.map(({ label }) => label),
          "ui.actions",
        );
        return done({ ...base, type: "action", ...audience(value), actions });
      }
      case "list": {
        fields(value, ["v", "type", "for", "channels"]);
        const channels = items(value.channels, "channels", (id) =>
          channel(id, "Each ui.channels item"),
        );
        unique(channels, "ui.channels");
        return done({ ...base, type: "list", ...audience(value), channels });
      }
      case "form": {
        fields(value, ["v", "type", "form"]);
        if (!FORMS.includes(value.form as (typeof FORMS)[number]))
          throw new Error(`ui.form must be ${FORMS.join(" or ")}.`);
        return done({
          ...base,
          type: "form",
          form: value.form as (typeof FORMS)[number],
        });
      }
      case "checklist": {
        fields(value, ["v", "type", "for", "steps"]);
        const steps = items(value.steps, "steps", (step) => {
          if (!isObject(step)) throw new Error("Each step must be an object.");
          fields(step, ["label", "joined"], "A step");
          return Object.freeze({
            label: label(step.label, "Each step label"),
            ...(step.joined === undefined
              ? {}
              : { joined: channel(step.joined, "A step's joined") }),
          });
        });
        unique(
          steps.map(({ label }) => label),
          "ui.steps",
        );
        return done({ ...base, type: "checklist", ...audience(value), steps });
      }
      default:
        throw new Error(`ui.type must be one of ${TYPES.join(", ")}.`);
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const done = (ui: InlineUi): Read => ({ ui: Object.freeze(ui) });

/** A channel's link, which Buzz shows as its live name, or as a private
 * channel to someone who can't see it. */
export const channelLink = (id: string) => `buzz://channel/${id}`;

/** What a client without Inline UI shows after the message text. Every part
 * comes from the value itself, so the app can check that the text says what
 * the Inline UI does. */
export function fallbackText(ui: InlineUi): string {
  switch (ui.type) {
    case "choice":
      return [
        ui.options.map((option, index) => `${index + 1}. ${option}`).join("\n"),
        ...(ui.own ? ["Or reply with your own answer."] : []),
      ].join("\n\n");
    case "action":
      return ui.actions
        .map(
          (action) =>
            `- ${action.label}: ${action.do === "join_channel" ? "join" : "open"} ${channelLink(action.channel)}`,
        )
        .join("\n");
    case "list":
      return ui.channels.map((id) => `- ${channelLink(id)}`).join("\n");
    case "form":
      return "Open the Buzz app to choose my name and avatar.";
    case "checklist":
      return ui.steps
        .map(
          (step) =>
            `- [ ] ${step.label}${step.joined ? `: join ${channelLink(step.joined)}` : ""}`,
        )
        .join("\n");
  }
}

/** The message content for `text` with `ui` attached. */
export const inlineUiContent = (text: string, ui: InlineUi) =>
  `${text.trimEnd()}\n\n${fallbackText(ui)}`;

/** A received message's Inline UI and the text shown above it. Absent unless
 * the tag is valid at a version this app knows and the content still ends
 * with that value's plain-text version, so an unknown type, an edited or
 * hand-written message, or text that disagrees with its Inline UI all stay
 * plain text. */
export function inlineUiMessage(
  content: string,
  tags: readonly (readonly string[])[],
): Readonly<{ ui: InlineUi; text: string }> | undefined {
  const raw = tags.find(([name]) => name === INLINE_UI_TAG)?.[1];
  if (!raw || raw.length > MAX_TAG) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  // Received values must say their version; only an agent's input defaults.
  if (!isObject(value) || value.v !== INLINE_UI_VERSION) return;
  const read = readInlineUi(value);
  if (!("ui" in read)) return;
  const suffix = `\n\n${fallbackText(read.ui)}`;
  if (!content.endsWith(suffix)) return;
  const text = content.slice(0, -suffix.length);
  return text.trim() ? Object.freeze({ ui: read.ui, text }) : undefined;
}
