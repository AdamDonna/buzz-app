// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import {
  ActivityIndicatorPresentation,
  useActivityTypingReplacement,
  useReplacedTypers,
} from "./typing-presentation";

afterEach(cleanup);

const session = {} as RelaySession;

function Replacement({
  channelId,
  participants,
}: {
  channelId: string;
  participants: readonly string[];
}) {
  useActivityTypingReplacement(
    { session, channelId, threadRootId: undefined, pubkey: "" },
    true,
    participants,
  );
  return null;
}

it("re-renders a replaced-typers reader only when its conversation's keys change", () => {
  let renders = 0;
  let replaced: ReadonlySet<string> = new Set();
  function Reader() {
    renders++;
    replaced = useReplacedTypers(session, "alpha", undefined);
    return null;
  }
  const view = (alpha: readonly string[], beta: readonly string[]) => (
    <ActivityIndicatorPresentation>
      <Reader />
      <Replacement channelId="alpha" participants={alpha} />
      <Replacement channelId="beta" participants={beta} />
    </ActivityIndicatorPresentation>
  );
  const { rerender } = render(view(["one"], ["two"]));
  expect([...replaced]).toEqual(["one"]);
  const settled = renders;
  rerender(view(["one"], ["two", "three"]));
  expect(renders).toBe(settled + 1);
  rerender(view(["one", "four"], ["two", "three"]));
  expect([...replaced]).toEqual(["one", "four"]);
});
