import type { ComposerToken } from "../conversation/contracts";
import { composerToken, composerTokenName } from "./composer-token";

export const TASK_TOKENS_TAG = "nexus.tokens.v1";
const MAX_BYTES = 16 * 1024;

function checked(value: unknown): readonly ComposerToken[] {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new Error("Choose between 1 and 32 task tokens.");
  const tokens = value.map(composerToken);
  if (tokens.some((token) => !token))
    throw new Error("A task token is invalid. Select it again.");
  const keys = new Set(
    tokens.map((token) =>
      JSON.stringify([
        token?.kind,
        token?.id,
        token?.kind === "nexus.skill" ? token.target : "",
      ]),
    ),
  );
  if (keys.size !== tokens.length)
    throw new Error("Remove duplicate task tokens before sending.");
  return tokens as readonly ComposerToken[];
}

export function taskTokenTags(tokens: readonly ComposerToken[]): string[][] {
  if (!tokens.length) return [];
  const json = JSON.stringify(checked(tokens));
  if (new TextEncoder().encode(json).length > MAX_BYTES)
    throw new Error("Task tokens are too large. Remove some before sending.");
  return [[TASK_TOKENS_TAG, json]];
}

/** Unknown versions are inert. Never recover execution identity from prose. */
export function readTaskTokens(
  tags: readonly (readonly string[])[],
): readonly ComposerToken[] {
  const found = tags.filter(([name]) => name === TASK_TOKENS_TAG);
  if (!found.length) return [];
  const tag = found[0];
  if (
    found.length !== 1 ||
    tag?.length !== 2 ||
    typeof tag[1] !== "string" ||
    new TextEncoder().encode(tag[1]).length > MAX_BYTES
  )
    throw new Error("This message has invalid task tokens.");
  let value: unknown;
  try {
    value = JSON.parse(tag[1]);
  } catch {
    throw new Error("This message has invalid task tokens.");
  }
  return checked(value);
}

/** Literal fallback for clients without token support. It is not a skill load,
 * a resolved repository, an extra mention, or an access grant. */
export function taskTokenFallback(tokens: readonly ComposerToken[]) {
  return tokens
    .map((token) => {
      const label = composerTokenName(token);
      const fence = "`".repeat(
        Math.max(
          0,
          ...[...label.matchAll(/`+/g)].map((match) => match[0].length),
        ) + 1,
      );
      return `Task reference: ${fence} ${label} ${fence}`;
    })
    .join("\n");
}
