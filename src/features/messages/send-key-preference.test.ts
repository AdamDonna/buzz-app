// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  sendWithModEnterPreference,
  setSendWithModEnterPreference,
} from "./send-key-preference";

afterEach(() => {
  vi.restoreAllMocks();
  setSendWithModEnterPreference(false);
  localStorage.clear();
});
it("defaults off, persists on, and treats unknown saved values as off", () => {
  localStorage.clear();
  expect(sendWithModEnterPreference()).toBe(false);
  expect(setSendWithModEnterPreference(true)).toBeNull();
  expect(sendWithModEnterPreference()).toBe(true);
  expect(localStorage.getItem("buzz-send-with-mod-enter.v1")).toBe("on");
  localStorage.setItem("buzz-send-with-mod-enter.v1", "unknown");
  expect(sendWithModEnterPreference()).toBe(false);
});
it("keeps the active choice when storage fails and can retry saving it", () => {
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("full");
    });
  expect(setSendWithModEnterPreference(true)).toMatch(/could not be saved/);
  expect(sendWithModEnterPreference()).toBe(true);
  storage.mockRestore();
  expect(setSendWithModEnterPreference(true)).toBeNull();
  expect(localStorage.getItem("buzz-send-with-mod-enter.v1")).toBe("on");
});
