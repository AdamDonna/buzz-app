import type { ComposerToken } from "../conversation/contracts";

/** Copy only bounded JSON. A plugin cannot retain mutable editor metadata or
 * turn a token into a recipient through a label, prototype or callback. */
export function composerToken(value: unknown): ComposerToken | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || new TextEncoder().encode(json).length > 8192) return;
    const token = JSON.parse(json);
    if (
      !token ||
      typeof token !== "object" ||
      Array.isArray(token) ||
      typeof token.id !== "string" ||
      !token.id ||
      token.id.length > 4096 ||
      /\p{Cc}/u.test(token.id) ||
      typeof token.label !== "string" ||
      !token.label.trim() ||
      token.label.length > 256 ||
      /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(token.label)
    )
      return;
    if (token.kind === "nexus.repository") {
      if (
        typeof token.verified !== "boolean" ||
        (token.alias !== undefined && typeof token.alias !== "string")
      )
        return;
    } else if (token.kind === "nexus.skill") {
      if (
        typeof token.target !== "string" ||
        !/^[0-9a-f]{64}$/.test(token.target)
      )
        return;
    } else if (token.kind !== "nexus.project" && token.kind !== "nexus.folder")
      return;
    const freeze = (item: object) => {
      for (const nested of Object.values(item))
        if (nested && typeof nested === "object") freeze(nested);
      Object.freeze(item);
    };
    freeze(token);
    return token as ComposerToken;
  } catch {
    return;
  }
}

export function composerTokenName(token: ComposerToken) {
  const kind =
    token.kind === "nexus.project"
      ? "Project"
      : token.kind === "nexus.repository"
        ? "Repository"
        : token.kind === "nexus.folder"
          ? "Folder"
          : "Skill";
  return `${kind} ${token.label}`;
}
