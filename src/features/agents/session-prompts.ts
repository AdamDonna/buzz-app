// What Buzz supplied each local agent session when it started, kept so the
// activity view can show it once at the top of the session. It is saved
// exactly as it was sent, in labeled pieces, and never rebuilt later: a
// session from before this was kept, or one dropped to keep the value small,
// shows none. The harness's own transcripts are never changed.
import {
  promptSections,
  type PromptSection,
  type TranscriptItem,
  type TranscriptTurn,
} from "./activity-transcript";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

/** One piece of what Buzz sent, labeled by where it came from. */
export type PromptPart = Readonly<{ label: string; text: string }>;
export const PROMPTS_PREFIX = "buzz.session-prompts.v1:";
/** Each agent's value is kept under this many UTF-8 bytes, the oldest
 * sessions dropped first. Agent storage takes 4 MiB a value, and the app
 * reads all of it at startup. */
export const PROMPTS_BUDGET = 1_000_000;

/** Sessions oldest first, each `[id, parts]`, a part `[label, text index]`.
 * Null parts mark a prompt that was too large to keep. Identical texts are
 * kept once. */
type Stored = {
  version: 1;
  texts: string[];
  sessions: [string, [string, number][] | null][];
};

const size = (text: string) => new TextEncoder().encode(text).length;

function read(text: string | null): Stored {
  try {
    const stored = JSON.parse(text ?? "null") as Stored | null;
    if (
      stored?.version === 1 &&
      Array.isArray(stored.texts) &&
      Array.isArray(stored.sessions)
    )
      return stored;
  } catch {}
  return { version: 1, texts: [], sessions: [] };
}

/** `sessions` with only the texts they use, each once. */
function packed(
  sessions: readonly (readonly [string, readonly PromptPart[] | null])[],
): Stored {
  const texts: string[] = [];
  const index = new Map<string, number>();
  const at = (text: string) => {
    let found = index.get(text);
    if (found === undefined) {
      found = texts.push(text) - 1;
      index.set(text, found);
    }
    return found;
  };
  return {
    version: 1,
    texts,
    sessions: sessions.map(([id, parts]) => [
      id,
      parts ? parts.map(({ label, text }) => [label, at(text)]) : null,
    ]),
  };
}

const promptsKey = (type: string, agent: AgentKey) =>
  `${PROMPTS_PREFIX}${type}:${agent}`;

/** Removes a membership's saved prompts, of every agent type. */
export async function removeSessionPrompts(
  storage: AgentStore,
  agent: AgentKey,
) {
  for (const key of storage.keys())
    if (key.startsWith(PROMPTS_PREFIX) && key.endsWith(`:${agent}`))
      await storage.set(key, null);
}

/** The saved prompts of one agent's sessions of one agent type. */
export function sessionPrompts(
  storage: AgentStore,
  type: string,
  agent: AgentKey,
) {
  const key = promptsKey(type, agent);
  const all = () => {
    const { texts, sessions } = read(storage.get(key));
    return sessions.map(
      ([id, parts]) =>
        [
          id,
          parts
            ? parts.flatMap(([label, text]) =>
                typeof texts[text] === "string"
                  ? [{ label, text: texts[text] }]
                  : [],
              )
            : null,
        ] as const,
    );
  };
  const get = (session: string) => all().find(([id]) => id === session)?.[1];
  return {
    get,
    /** Keeps what a new session was sent, unless one is kept for it already:
     * the first save wins. Only a runtime's new-session path calls this, so a
     * resumed or dropped session is never filled in. A failed save is
     * logged, never thrown, so the agent keeps working. */
    async save(session: string, parts: readonly PromptPart[]) {
      try {
        // Read, changed and written with no wait between, so saves of one
        // value never interleave and none drops another's session.
        const sessions = all();
        if (sessions.some(([id]) => id === session)) return;
        const kept = parts.filter((part) => part.text);
        sessions.push([
          session,
          size(JSON.stringify(packed([[session, kept]]))) > PROMPTS_BUDGET
            ? null
            : kept,
        ]);
        let value = JSON.stringify(packed(sessions));
        while (size(value) > PROMPTS_BUDGET && sessions.length > 1) {
          sessions.shift();
          value = JSON.stringify(packed(sessions));
        }
        await storage.set(key, value);
      } catch (error) {
        console.error("A session's prompt was not saved", error);
      }
    },
    /** `turns` with each shown session's saved prompt at its top. */
    shown: (turns: readonly TranscriptTurn[]) => withSessionPrompts(turns, get),
  };
}

/** The label of a piece sent with each turn rather than once; a session
 * keeps its first turn's copy. */
export const EACH_TURN = "each-turn";

/** The sections a saved prompt shows: each piece's own tagged sections, and
 * its other text under its label. A piece sent with each turn shows only its
 * tagged sections: its loose lines only restate the identity and say the
 * sections replace earlier ones. */
const sections = (parts: readonly PromptPart[]): PromptSection[] =>
  parts.flatMap(({ label, text }) =>
    label === EACH_TURN
      ? promptSections(text).filter((section) => section.tag !== "text")
      : promptSections(text).map((section) =>
          section.tag === "text" && label
            ? { tag: label, body: section.body }
            : section,
        ),
  );

/** `turns`, already cut to the shown window, with each session's prompt at
 * the top of its first shown turn. A session whose start is not shown is
 * marked continued; whether a turn starts a session never depends on whether
 * its prompt was kept. */
export function withSessionPrompts(
  turns: readonly TranscriptTurn[],
  prompt: (session: string) => readonly PromptPart[] | null | undefined,
): TranscriptTurn[] {
  const seen = new Set<string>();
  return turns.map((turn) => {
    const session = turn.sessionId;
    if (!session || seen.has(session)) return turn;
    seen.add(session);
    const parts = prompt(session);
    const item: TranscriptItem | undefined =
      parts === null
        ? {
            id: `${session}:system-prompt`,
            at: turn.startedAt,
            type: "status",
            text: "This session's system prompt was too large to keep.",
          }
        : parts?.length
          ? {
              id: `${session}:system-prompt`,
              at: turn.startedAt,
              type: "system",
              sections: sections(parts),
            }
          : undefined;
    return {
      ...turn,
      ...(turn.newSession ? {} : { continued: true }),
      items: item ? [item, ...turn.items] : turn.items,
    };
  });
}
