import { expect, it } from "vitest";
import {
  createRemindZone,
  parseRemind,
  REMIND_PARSE_MESSAGES,
  type RemindParseError,
} from "./remind-time";

// The spec vectors are in America/Chicago, where DST ends 2026-11-01. The zone
// is injected, so they hold under any process time zone.
const zone = createRemindZone("America/Chicago");

const wall = (local: string) => {
  const [year, month, day, hour, minute] = (local.match(/\d+/g) ?? []).map(
    Number,
  ) as [number, number, number, number, number];
  return zone.wallToInstant(year, month, day, hour, minute);
};

const local = (instant: number) => {
  const w = zone.instantToWall(instant);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
};

const NOW = wall("2026-10-28 10:00");
const parse = (args: string, now = NOW) => parseRemind(args, { now, zone });

type Outcome = { note: string; due: string } | { error: RemindParseError };

function expectOutcome(args: string, expected: Outcome, now = NOW) {
  const result = parse(args, now);
  if ("error" in expected) {
    expect(result).toEqual({ ok: false, error: expected.error });
    return;
  }
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.note).toBe(expected.note);
  expect(local(result.dueAt)).toBe(expected.due);
}

it("pins the spec calendar: Wednesday 2026-10-28 10:00 Chicago, DST ending 2026-11-01", () => {
  expect(local(NOW)).toBe("2026-10-28 10:00");
  expect(zone.instantToWall(NOW).weekday).toBe(3);
  expect(new Date(NOW).toISOString()).toBe("2026-10-28T15:00:00.000Z");
  expect(wall("2026-11-04 10:00") - NOW).toBe((7 * 24 + 1) * 3_600_000);
  expect(new Date(wall("2026-11-04 10:00")).toISOString()).toBe(
    "2026-11-04T16:00:00.000Z",
  );
});

it("rejects an unknown zone name", () => {
  expect(() => createRemindZone("Not/AZone")).toThrow(RangeError);
});

const WHEN_VECTORS: readonly (readonly [string, string | RemindParseError])[] =
  [
    ["in 20 minutes", "2026-10-28 10:20"],
    ["in an hour", "2026-10-28 11:00"],
    ["in 2 hrs", "2026-10-28 12:00"],
    ["in 3 days", "2026-10-31 10:00"],
    ["in 1 week", "2026-11-04 10:00"],
    ["at 3pm", "2026-10-28 15:00"],
    ["at 3:30 pm", "2026-10-28 15:30"],
    ["at 15:00", "2026-10-28 15:00"],
    ["at 9am", "2026-10-29 09:00"],
    ["at 10am", "2026-10-29 10:00"],
    ["at noon", "2026-10-28 12:00"],
    ["at midnight", "2026-10-29 00:00"],
    ["tomorrow", "2026-10-29 09:00"],
    ["tomorrow at 4pm", "2026-10-29 16:00"],
    ["on friday", "2026-10-30 09:00"],
    ["Friday at 2pm", "2026-10-30 14:00"],
    ["on wednesday", "2026-11-04 09:00"],
    ["next monday", "2026-11-02 09:00"],
    ["next week", "2026-11-02 09:00"],
    ["at 3", "ambiguousHour"],
    ["at 25:00", "invalidTime"],
    ["at 13pm", "invalidTime"],
    ["in 0 minutes", "invalidTime"],
    ["in 400 days", "outOfRange"],
    ["yesterday", "missingTime"],
  ];

const outcomeOf = (due: string): Outcome =>
  /^\d{4}-/.test(due)
    ? { note: "stretch", due }
    : { error: due as RemindParseError };

it.each(WHEN_VECTORS)(
  "resolves <when> %j at the end of the text: %s",
  (when, due) => {
    expectOutcome(`me stretch ${when}`, outcomeOf(due));
  },
);

it.each(WHEN_VECTORS.filter(([, due]) => /^\d{4}-/.test(due)))(
  "resolves <when> %j at the start of the text the same way: %s",
  (when, due) => {
    expectOutcome(`me ${when} to stretch`, { note: "stretch", due });
    expectOutcome(`me ${when} stretch`, { note: "stretch", due });
  },
);

it.each<readonly [string, Outcome]>([
  [
    "me to submit the report in 20 minutes",
    { note: "submit the report", due: "2026-10-28 10:20" },
  ],
  [
    "me tomorrow at 4pm to call Sam",
    { note: "call Sam", due: "2026-10-29 16:00" },
  ],
  [
    "me check the deploy at 3pm",
    { note: "check the deploy", due: "2026-10-28 15:00" },
  ],
  ["me in 2 hours", { error: "missingNote" }],
  ["me to stretch", { error: "missingTime" }],
  ["@sam to stretch in 1 hour", { error: "notPersonal" }],
  ["", { error: "usage" }],
  ["me", { error: "usage" }],
  ["mega stretch in 1 hour", { error: "notPersonal" }],
  ["ME to Stretch IN 5 MIN", { note: "Stretch", due: "2026-10-28 10:05" }],
  ["me tomorrow at 4pm", { error: "missingNote" }],
  [
    "me to ring at 3pm tomorrow at 4pm",
    { note: "ring at 3pm", due: "2026-10-29 16:00" },
  ],
  [
    "me in an hour to call Sam on friday",
    { note: "in an hour to call Sam", due: "2026-10-30 09:00" },
  ],
  ["me to toggle at 3", { error: "ambiguousHour" }],
  [
    "me to to stretch in 5 minutes",
    { note: "to stretch", due: "2026-10-28 10:05" },
  ],
  [
    "me to\nstretch\nin 5 minutes",
    { note: "stretch", due: "2026-10-28 10:05" },
  ],
  [
    "me stretch  in   5   minutes",
    { note: "stretch", due: "2026-10-28 10:05" },
  ],
  ["me stretchat 3pm", { error: "missingTime" }],
])("parses /remind %j", (args, expected) => {
  expectOutcome(args, expected);
});

it("keeps `at 3pm` out of the note when a longer phrase ends the text", () => {
  expectOutcome("me ring at 3pm tomorrow at 4pm", {
    note: "ring at 3pm",
    due: "2026-10-29 16:00",
  });
  expectOutcome("me ring tomorrow at 4pm", {
    note: "ring",
    due: "2026-10-29 16:00",
  });
});

it("takes the due time as strictly after now and at most 365 days ahead", () => {
  expectOutcome("me x at 10:00", { note: "x", due: "2026-10-29 10:00" });
  expectOutcome("me x in 365 days", { note: "x", due: "2027-10-28 10:00" });
  expectOutcome("me x in 52 weeks", { note: "x", due: "2027-10-27 10:00" });
  expectOutcome("me x in 366 days", { error: "outOfRange" });
  expectOutcome("me x in 53 weeks", { error: "outOfRange" });
  expectOutcome("me x in 99999999999999999999 minutes", {
    error: "outOfRange",
  });
});

it.each([
  ["300000000 days", "in 300000000 days"],
  ["100000000 weeks", "in 100000000 weeks"],
  ["20-digit days", "in 99999999999999999999 days"],
  ["20-digit weeks", "in 99999999999999999999 weeks"],
  ["400-digit days", `in ${"9".repeat(400)} days`],
])(
  "rejects %s as out of range instead of overflowing the date",
  (_label, when) => {
    expectOutcome(`me x ${when}`, { error: "outOfRange" });
  },
);

it("resolves a wall time that DST skips forward, and one it repeats to its first occurrence", () => {
  const eve = wall("2027-03-13 23:00");
  const inGap = parse("me x at 2:30am", eve);
  if (!inGap.ok) throw new Error("expected a time");
  expect(new Date(inGap.dueAt).toISOString()).toBe("2027-03-14T08:30:00.000Z");
  expect(local(inGap.dueAt)).toBe("2027-03-14 03:30");
  expect(inGap.dueAt).toBeGreaterThan(eve);
  expectOutcome("me x at 3am", { note: "x", due: "2027-03-14 03:00" }, eve);
  expectOutcome(
    "me x tomorrow at 2am",
    { note: "x", due: "2027-03-14 03:00" },
    eve,
  );
  const gapDay = parse("me x in 1 day", wall("2027-03-13 02:30"));
  if (!gapDay.ok) throw new Error("expected a time");
  expect(local(gapDay.dueAt)).toBe("2027-03-14 03:30");

  const fallEve = wall("2026-10-31 23:00");
  const overlap = parse("me x at 1:30am", fallEve);
  if (!overlap.ok) throw new Error("expected a time");
  expect(new Date(overlap.dueAt).toISOString()).toBe(
    "2026-11-01T06:30:00.000Z",
  );
  expectOutcome("me x at 2am", { note: "x", due: "2026-11-01 02:00" }, fallEve);
});

it("makes minutes and hours exact durations and days and weeks wall-clock across DST", () => {
  const eve = wall("2026-10-31 12:00");
  const hours = parse("me x in 24 hours", eve);
  const days = parse("me x in 1 day", eve);
  const weeks = parse("me x in 1 week", eve);
  if (!hours.ok || !days.ok || !weeks.ok) throw new Error("expected a time");
  expect(hours.dueAt - eve).toBe(24 * 3_600_000);
  expect(local(hours.dueAt)).toBe("2026-11-01 11:00");
  expect(local(days.dueAt)).toBe("2026-11-01 12:00");
  expect(days.dueAt - eve).toBe(25 * 3_600_000);
  expect(local(weeks.dueAt)).toBe("2026-11-07 12:00");
});

it("resolves wall-clock phrases in the injected zone, not the process zone", () => {
  const now = Date.UTC(2026, 9, 28, 15, 0);
  const due = (timeZone: string) => {
    const result = parseRemind("me x tomorrow", {
      now,
      zone: createRemindZone(timeZone),
    });
    return result.ok ? new Date(result.dueAt).toISOString() : result.error;
  };
  expect(due("UTC")).toBe("2026-10-29T09:00:00.000Z");
  expect(due("America/Chicago")).toBe("2026-10-29T14:00:00.000Z");
  expect(due("Asia/Tokyo")).toBe("2026-10-30T00:00:00.000Z");
});

it("has a message for every rejection, and the personal one names the command", () => {
  expect(Object.keys(REMIND_PARSE_MESSAGES).sort()).toEqual(
    [
      "ambiguousHour",
      "invalidTime",
      "missingNote",
      "missingTime",
      "notPersonal",
      "outOfRange",
      "usage",
    ].sort(),
  );
  expect(REMIND_PARSE_MESSAGES.notPersonal).toBe(
    "Reminders are personal. Use /remind me …",
  );
});
