import { afterEach, expect, it, vi } from "vitest";
import { nativeHuddles } from "../../features/huddle/bridge";
import { apply } from "./index";

vi.mock("../../features/huddle/bridge", () => ({
  nativeHuddles: { available: false },
}));
vi.mock("../../features/huddle/ring", () => ({
  createHuddleRing: () => () => {},
}));
vi.mock("../../features/huddle/window", () => ({
  createHuddleWindow: () => ({ open: async () => {}, dispose: async () => {} }),
}));
afterEach(() => {
  nativeHuddles.available = false;
});

function host() {
  const registerCommand = vi.fn();
  return {
    registerCommand,
    ctx: {
      relay: {
        snapshot: () => ({ status: "disconnected", session: {} }),
        subscribe: () => () => {},
      },
      conversation: {
        registerMessage: vi.fn(),
        registerCommand,
      },
      panels: { register: vi.fn() },
      navigation: { open: vi.fn() },
      agents: {},
      effect: vi.fn(),
    } as unknown as Parameters<typeof apply>[0],
  };
}

it("offers /huddle only where native huddles exist, for every conversation scope", () => {
  const unavailable = host();
  apply(unavailable.ctx);
  expect(unavailable.registerCommand).not.toHaveBeenCalled();
  nativeHuddles.available = true;
  const native = host();
  apply(native.ctx);
  expect(native.registerCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "huddle", usage: "/huddle" }),
  );
  expect(native.registerCommand.mock.calls[0]?.[0]).not.toHaveProperty(
    "scopes",
  );
});
