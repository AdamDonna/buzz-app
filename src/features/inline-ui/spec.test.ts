import { describe, expect, it } from "vitest";
import {
  INLINE_UI_TAG,
  fallbackText,
  inlineUiContent,
  inlineUiMessage,
  readInlineUi,
  type InlineUi,
} from "./spec";

const general = "11111111-1111-4111-8111-111111111111";
const design = "22222222-2222-4222-8222-222222222222";

const ok = (value: unknown) => {
  const read = readInlineUi(value);
  if (!("ui" in read)) throw new Error(read.error);
  return read.ui;
};
const error = (value: unknown) => {
  const read = readInlineUi(value);
  return "error" in read ? read.error : undefined;
};
const message = (ui: InlineUi, text = "Pick one.") => ({
  content: inlineUiContent(text, ui),
  tags: [
    ["h", "chan"],
    [INLINE_UI_TAG, JSON.stringify(ui)],
  ],
});

describe("Inline UI format", () => {
  it("reads each type, defaulting the version and trimming labels", () => {
    expect(
      ok({ type: "choice", options: [" Warm ", "Direct"], own: true }),
    ).toEqual({ v: 1, type: "choice", options: ["Warm", "Direct"], own: true });
    expect(
      ok({
        type: "action",
        for: "mentioned",
        actions: [
          { label: "Join #general", do: "join_channel", channel: general },
        ],
      }),
    ).toEqual({
      v: 1,
      type: "action",
      for: "mentioned",
      actions: [
        { label: "Join #general", do: "join_channel", channel: general },
      ],
    });
    expect(ok({ v: 1, type: "list", channels: [general, design] })).toEqual({
      v: 1,
      type: "list",
      channels: [general, design],
    });
    expect(ok({ type: "form", form: "agent_profile" })).toEqual({
      v: 1,
      type: "form",
      form: "agent_profile",
    });
    expect(
      ok({
        type: "checklist",
        steps: [{ label: "Say hi" }, { label: "Join", joined: general }],
      }),
    ).toEqual({
      v: 1,
      type: "checklist",
      steps: [{ label: "Say hi" }, { label: "Join", joined: general }],
    });
  });

  it("allows emoji sequences and treats own: false as absent", () => {
    expect(
      ok({
        type: "choice",
        options: ["🧑\u200d💻 Code review", "❤\ufe0f Docs"],
      }).type,
    ).toBe("choice");
    expect(ok({ type: "choice", options: ["a", "b"], own: false })).toEqual({
      v: 1,
      type: "choice",
      options: ["a", "b"],
    });
  });

  it("explains what is wrong, in the agent's terms", () => {
    expect(error("x")).toBe("ui must be an object.");
    expect(error({ type: "poll" })).toBe(
      "ui.type must be one of choice, action, list, form, checklist.",
    );
    expect(error({ v: 2, type: "choice" })).toBe("ui.v must be 1.");
    expect(error({ type: "choice", options: ["One"] })).toBe(
      "ui.options must list 2–6 items.",
    );
    expect(error({ type: "choice", options: ["a", "A"] })).toBe(
      "ui.options repeat “A”.",
    );
    expect(error({ type: "choice", options: ["a", "two\nlines"] })).toBe(
      "Each option must be one line of 1–80 characters.",
    );
    // Separators and bidi controls break the line or reorder the label.
    for (const bad of ["two\u2028lines", "two\u2029lines", "\u202eevil"])
      expect(error({ type: "choice", options: ["a", bad] })).toBe(
        "Each option must be one line of 1–80 characters.",
      );
    // A label can't carry a link, so the plain text can't read as another
    // Inline UI's.
    expect(
      error({
        type: "checklist",
        steps: [{ label: `Read: join buzz://channel/${general}` }],
      }),
    ).toBe("Each step label can't contain a buzz:// link.");
    expect(error({ type: "choice", options: ["a", "b"], rows: [] })).toBe(
      "ui has unknown fields: rows.",
    );
    expect(error({ type: "choice", options: ["a", "b"], for: "all" })).toBe(
      "ui.for must be mentioned.",
    );
    expect(
      error({
        type: "action",
        actions: [{ label: "Wipe", do: "delete_channel", channel: general }],
      }),
    ).toBe("An action's do must be join_channel or open_channel.");
    expect(error({ type: "list", channels: ["general"] })).toBe(
      "Each ui.channels item must be a channel id.",
    );
    // A list names channels; it never carries rows of its own.
    expect(
      error({ type: "list", channels: [general], rows: ["#general"] }),
    ).toBe("ui has unknown fields: rows.");
    expect(error({ type: "form", form: "anything" })).toBe(
      "ui.form must be agent_profile.",
    );
    // Only the agent's owner can answer a form, so it takes no audience.
    expect(
      error({ type: "form", form: "agent_profile", for: "mentioned" }),
    ).toBe("ui has unknown fields: for.");
  });

  it("writes a plain-text version built only from the value", () => {
    expect(
      fallbackText(
        ok({ type: "choice", options: ["Warm", "Direct"], own: true }),
      ),
    ).toBe("1. Warm\n2. Direct\n\nOr reply with your own answer.");
    expect(
      fallbackText(
        ok({
          type: "action",
          actions: [
            { label: "Take a look", do: "join_channel", channel: general },
            { label: "Peek", do: "open_channel", channel: design },
          ],
        }),
      ),
      // The text says what each button does, whatever its label.
    ).toBe(
      `- Take a look: join buzz://channel/${general}\n- Peek: open buzz://channel/${design}`,
    );
    expect(
      fallbackText(ok({ type: "list", channels: [general, design] })),
    ).toBe(`- buzz://channel/${general}\n- buzz://channel/${design}`);
    expect(
      fallbackText(
        ok({
          type: "checklist",
          steps: [{ label: "Say hi" }, { label: "Join", joined: general }],
        }),
      ),
    ).toBe(`- [ ] Say hi\n- [ ] Join: join buzz://channel/${general}`);
  });

  it("reads a received message only while its text matches its Inline UI", () => {
    const ui = ok({ type: "choice", options: ["Warm", "Direct"] });
    const { content, tags } = message(ui);
    expect(inlineUiMessage(content, tags)).toEqual({ ui, text: "Pick one." });
    // Edited or hand-written text that no longer ends with the plain-text version.
    expect(
      inlineUiMessage(content.replace("Direct", "Rude"), tags),
    ).toBeUndefined();
    // The tag says something the text doesn't.
    const other = ok({ type: "choice", options: ["Warm", "Rude"] });
    expect(
      inlineUiMessage(content, [[INLINE_UI_TAG, JSON.stringify(other)]]),
    ).toBeUndefined();
    // Only the plain-text version, with no question above it.
    expect(inlineUiMessage(fallbackText(ui), tags)).toBeUndefined();
  });

  it("leaves unknown versions, unknown types and malformed tags as plain text", () => {
    const ui = ok({ type: "choice", options: ["Warm", "Direct"] });
    const { content } = message(ui);
    const tagged = (value: string) =>
      inlineUiMessage(content, [[INLINE_UI_TAG, value]]);
    expect(tagged(JSON.stringify({ ...ui, v: 2 }))).toBeUndefined();
    expect(tagged(JSON.stringify({ ...ui, type: "carousel" }))).toBeUndefined();
    // A received value must say its version.
    const { v: _v, ...unversioned } = ui;
    expect(tagged(JSON.stringify(unversioned))).toBeUndefined();
    expect(tagged("{not json")).toBeUndefined();
    expect(tagged("x".repeat(9000))).toBeUndefined();
    expect(inlineUiMessage(content, [])).toBeUndefined();
  });
});
