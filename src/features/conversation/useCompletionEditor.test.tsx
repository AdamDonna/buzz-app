// @vitest-environment jsdom
import { renderHook, cleanup } from "@testing-library/react";
import { StrictMode, createRef } from "react";
import { afterEach, expect, it } from "vitest";
import type { ComposerInputElement } from "../messages/composer-dom";
import { useCompletionEditor } from "./useCompletionEditor";

afterEach(cleanup);
it("keeps each composer's signal across query rerenders and hidden states, and aborts it on disposal", () => {
  const input = createRef<ComposerInputElement>();
  const first = renderHook(
    ({ enabled }) => useCompletionEditor(input, enabled),
    {
      initialProps: { enabled: true },
      wrapper: StrictMode,
    },
  );
  const signal = first.result.current.composerSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false); // Effect replay did not retain an aborted controller.
  first.rerender({ enabled: false });
  first.rerender({ enabled: true });
  expect(first.result.current.composerSignal).toBe(signal);
  const second = renderHook(() => useCompletionEditor(input, true), {
    wrapper: StrictMode,
  });
  const other = second.result.current.composerSignal;
  expect(other).not.toBe(signal);
  first.unmount();
  expect(signal?.aborted).toBe(true);
  expect(other?.aborted).toBe(false);
  second.unmount();
  expect(other?.aborted).toBe(true);
});
