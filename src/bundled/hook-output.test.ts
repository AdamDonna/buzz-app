import { expect, it } from "vitest";
import { nativeHookOutput, piHookOutput } from "./hook-output";

it("attributes native hook explanations without rewriting decisions or tool payloads", () => {
  const output = {
    decision: "block",
    reason: "Reply first",
    continue: false,
    stopReason: "Stop here",
    systemMessage: "Policy notice",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Reply first",
      additionalContext: "Policy context",
      updatedInput: { reason: "literal argument", command: "echo hello" },
      decision: { behavior: "deny", message: "Permission denied" },
    },
  };
  const original = structuredClone(output);
  expect(nativeHookOutput(output, "berd-call")).toEqual({
    ...output,
    reason: "[berd-call] Reply first",
    stopReason: "[berd-call] Stop here",
    systemMessage: "[berd-call] Policy notice",
    hookSpecificOutput: {
      ...output.hookSpecificOutput,
      permissionDecisionReason: "[berd-call] Reply first",
      additionalContext: "[berd-call] Policy context",
      decision: { behavior: "deny", message: "[berd-call] Permission denied" },
    },
  });
  expect(output).toEqual(original);
  expect(nativeHookOutput({ decision: "block" }, "policy")).toEqual({
    decision: "block",
    reason: "[policy]",
  });
  expect(
    nativeHookOutput(
      { hookSpecificOutput: { permissionDecision: "deny" } },
      "policy",
    ),
  ).toEqual({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: "[policy]",
    },
  });
  expect(nativeHookOutput({ continue: false }, "policy")).toEqual({
    continue: false,
    stopReason: "[policy]",
  });
  expect(nativeHookOutput({}, "policy")).toEqual({});
});

it("attributes Pi blocks and replacement output without changing arguments or image data", () => {
  expect(piHookOutput({ block: "Reply first" }, "berd-call")).toEqual({
    block: "[berd-call] Reply first",
  });
  const args = { arguments: { text: "literal text", block: "literal block" } };
  expect(piHookOutput(args, "policy")).toEqual(args);
  const output = {
    output: [
      { type: "text", text: "Replacement" },
      { type: "image", data: "bytes", mimeType: "image/png" },
    ],
    details: { text: "metadata" },
  };
  expect(piHookOutput(output, "policy")).toEqual({
    ...output,
    output: [{ type: "text", text: "[policy]" }, ...output.output],
  });
  expect(piHookOutput(null, "policy")).toBeNull();
});
