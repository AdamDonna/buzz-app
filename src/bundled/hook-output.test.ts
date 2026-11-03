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
    reason: "[plugin: berd-call] Reply first",
    stopReason: "[plugin: berd-call] Stop here",
    systemMessage: "[plugin: berd-call] Policy notice",
    hookSpecificOutput: {
      ...output.hookSpecificOutput,
      permissionDecisionReason: "[plugin: berd-call] Reply first",
      additionalContext: "[plugin: berd-call] Policy context",
      decision: {
        behavior: "deny",
        message: "[plugin: berd-call] Permission denied",
      },
    },
  });
  expect(output).toEqual(original);
  expect(nativeHookOutput({ decision: "block" }, "policy")).toEqual({
    decision: "block",
    reason: "[plugin: policy]",
  });
  expect(
    nativeHookOutput(
      { hookSpecificOutput: { permissionDecision: "deny" } },
      "policy",
    ),
  ).toEqual({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: "[plugin: policy]",
    },
  });
  expect(nativeHookOutput({ continue: false }, "policy")).toEqual({
    continue: false,
    stopReason: "[plugin: policy]",
  });
  expect(nativeHookOutput({}, "policy")).toEqual({});
});

it("attributes Pi blocks and replacement output without changing arguments or image data", () => {
  expect(piHookOutput({ block: "Reply first" }, "berd-call")).toEqual({
    block: "[plugin: berd-call] Reply first",
  });
  expect(piHookOutput({ block: "" }, "policy")).toEqual({
    block: "[plugin: policy]",
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
    output: [{ type: "text", text: "[plugin: policy]" }, ...output.output],
  });
  expect(piHookOutput(null, "policy")).toBeNull();
});
