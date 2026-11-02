import { expect, it } from "vitest";
import type { EventData } from "../relay/events";
import { eventBody, readEventBody } from "./turn-records";

const pubkey = "b".repeat(64);
const event = { id: "e".repeat(64), pubkey, kind: 9 } as EventData;

it("reads back the author and request of an event body, whatever the request holds", () => {
  // JSON leaves U+2028 and U+2029 as they are, so a record's line holds them.
  for (const request of [
    "plain <it>",
    "two\nlines",
    "line\u2028separator",
    "paragraph\u2029separator",
  ])
    expect(readEventBody(eventBody(event, request))).toEqual({
      pubkey,
      request,
    });
});

it("reads only a record that is one line", () => {
  const body = eventBody(event, "fix it");
  expect(readEventBody(body.replace("{", '{\n"x":1,'))).toBeUndefined();
  expect(readEventBody(`hi\n${body}`)).toBeUndefined();
});
