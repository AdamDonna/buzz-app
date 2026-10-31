import { describe, expect, it, vi } from "vitest";
import { runInlineAction } from "./actions";
import { readInlineUi } from "./spec";

const general = "11111111-1111-4111-8111-111111111111";
const ui = (value: unknown) => {
  const read = readInlineUi(value);
  if (!("ui" in read)) throw new Error(read.error);
  return read.ui;
};
const action = ui({
  type: "action",
  actions: [
    { label: "Join #general", do: "join_channel", channel: general },
    { label: "Open #general", do: "open_channel", channel: general },
  ],
});
const host = () => ({
  join: vi.fn(async () => {}),
  open: vi.fn(),
  answer: vi.fn(async () => {}),
});

describe("Inline UI actions", () => {
  it("joins, then answers once the join is confirmed", async () => {
    const order: string[] = [];
    const h = {
      join: vi.fn(async () => void order.push("join")),
      open: vi.fn(),
      answer: vi.fn(async () => void order.push("answer")),
    };
    await runInlineAction(action, "0", h);
    expect(h.join).toHaveBeenCalledWith(general);
    expect(h.answer).toHaveBeenCalledWith("0");
    expect(order).toEqual(["join", "answer"]);
  });

  it("never answers a join that failed", async () => {
    const h = host();
    h.join.mockRejectedValueOnce(new Error("Not allowed"));
    await expect(runInlineAction(action, "0", h)).rejects.toThrow(
      "Not allowed",
    );
    expect(h.answer).not.toHaveBeenCalled();
  });

  it("opens a channel without answering", async () => {
    const h = host();
    await runInlineAction(action, "1", h);
    expect(h.open).toHaveBeenCalledWith(general);
    expect(h.join).not.toHaveBeenCalled();
    expect(h.answer).not.toHaveBeenCalled();
  });

  it("joins a listed channel by id, and refuses anything not offered", async () => {
    const h = host();
    await runInlineAction(
      ui({ type: "list", channels: [general] }),
      general,
      h,
    );
    expect(h.join).toHaveBeenCalledWith(general);
    expect(h.answer).toHaveBeenCalledWith(general);
    const other = "22222222-2222-4222-8222-222222222222";
    await expect(
      runInlineAction(ui({ type: "list", channels: [general] }), other, h),
    ).rejects.toThrow("That isn’t one of its actions");
    await expect(runInlineAction(action, "2", h)).rejects.toThrow(
      "That isn’t one of its actions",
    );
    await expect(
      runInlineAction(ui({ type: "choice", options: ["a", "b"] }), "0", h),
    ).rejects.toThrow("That isn’t one of its actions");
  });
});
