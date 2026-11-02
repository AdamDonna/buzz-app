import { assert, expect, it, vi } from "vitest";
import { createMessages } from "./messages";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import { keypair, message, signed } from "./testing";
import type { EventData } from "./events";
import type { ProfileQueries } from "./profile-directory";
import {
  INLINE_UI_TAG,
  inlineUiContent,
  readInlineUi,
} from "../inline-ui/spec";
import { ANSWER_TAG, SAVED, inlineUiAnswers } from "../inline-ui/answers";

const viewer = keypair();
const agent = keypair();
const relay = keypair();

const asking = (value: unknown, created = 1, tags: string[][] = []) => {
  const read = readInlineUi(value);
  assert("ui" in read);
  return message(
    agent,
    "channel",
    inlineUiContent("Pick one.", read.ui),
    created,
    [...tags, [INLINE_UI_TAG, JSON.stringify(read.ui)]],
  );
};
const choice = asking({
  type: "choice",
  options: ["Warm", "Direct"],
  own: true,
});

function setup(events: EventData[], owner?: string) {
  const writer = {
    kinds: [9],
    sign: vi.fn(async (event) => signed(viewer, event)),
    publish: vi.fn(async () => {}),
  };
  const { outbox } = createOutbox(viewer.pubkey, writer, {
    load: () => [],
    save: () => {},
  });
  let known: string | undefined;
  const ensure = vi.fn(async () => {
    known = owner;
  });
  const profiles = {
    ensure,
    owner: () => known,
  } as unknown as ProfileQueries;
  const messages = createMessages(
    outbox,
    viewer.pubkey,
    (id) => events.find((event) => event.id === id),
    () => [],
    () => {},
    () => true,
    undefined,
    undefined,
    undefined,
    profiles,
  );
  const sent = () => {
    const event = outbox.snapshot().at(-1)?.event;
    assert.exists(event);
    return event;
  };
  return { messages, sent, ensure };
}

it("sends an answer as a plain reply that tags the asker and counts once folded", async () => {
  const { messages, sent } = setup([choice]);
  await messages.answer(choice.id, "1");
  const event = sent();
  expect(event.content).toBe("Direct");
  expect(event.tags.slice(0, 3)).toEqual([
    ["h", "channel"],
    ["p", agent.pubkey],
    [ANSWER_TAG, choice.id, "1"],
  ]);
  // A top-level question gets a top-level answer.
  expect(event.tags.some(([name]) => name === "e")).toBe(false);
  const rows = foldMessages("channel", relay.pubkey, [choice, event]);
  expect(inlineUiAnswers(rows, () => undefined).get(choice.id)).toMatchObject([
    { authorId: viewer.pubkey, value: "1", content: "Direct" },
  ]);
});

it("answers in the asking message's thread", async () => {
  const root = message(agent, "channel", "Thread", 1);
  const inThread = asking({ type: "choice", options: ["a", "b"] }, 2, [
    ["e", root.id, "", "reply"],
  ]);
  const { messages, sent } = setup([root, inThread]);
  await messages.answer(inThread.id, "0");
  expect(sent().tags.slice(0, 3)).toEqual([
    ["h", "channel"],
    ["e", root.id, "", "root"],
    ["e", inThread.id, "", "reply"],
  ]);
});

it("refuses answers that aren't the viewer's to give or aren't offered", async () => {
  const { messages } = setup([choice]);
  await expect(messages.answer(choice.id, "5")).rejects.toThrow(
    "That isn’t one of its answers",
  );
  await expect(messages.answer("f".repeat(64), "0")).rejects.toThrow(
    "Load the message before answering it",
  );
  const tagged = asking(
    { type: "choice", options: ["a", "b"], for: "mentioned" },
    3,
    [["p", relay.pubkey]],
  );
  await expect(setup([tagged]).messages.answer(tagged.id, "0")).rejects.toThrow(
    "This isn’t yours to answer",
  );
  // A message whose text no longer matches its Inline UI isn't answerable.
  const plain = signed(agent, { ...choice, content: "Pick one." });
  await expect(setup([plain]).messages.answer(plain.id, "0")).rejects.toThrow(
    "Load the message before answering it",
  );
});

it("lets only the agent's verified owner answer its form", async () => {
  const form = asking({ type: "form", form: "agent_profile" });
  await expect(setup([form]).messages.answer(form.id, SAVED)).rejects.toThrow(
    "This isn’t yours to answer",
  );
  // The owner's form save loads the agent's profile before checking it.
  const { messages, sent, ensure } = setup([form], viewer.pubkey);
  await messages.answer(form.id, SAVED);
  expect(ensure).toHaveBeenCalledWith([agent.pubkey]);
  expect(sent().content).toBe("Saved your name and avatar.");
});
