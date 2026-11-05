// A published Builderlab agent card. `buzz://agent/new?card=<id>` carries only
// the card's id; its draft is `<id>/agent.json` on this build's avatars CDN,
// never on a host the link names, so a printed QR stays small however long
// the instructions are. Buzz mobile reads the same file.
import { AGENT_CARD_ID } from "../navigation/buzz-links";
import { checkText } from "./agent-share";

const PRODUCTION = "https://d2z0pbxrxbsiz5.cloudfront.net";
// Keyed by the build's Builderlab, as Buzz mobile's account environment; every
// other build reads the production cards, which are public.
const CDNS: Readonly<Record<string, string>> = {
  "https://app.builderlabstaging.xyz": "https://d10hx6rb3fdt3l.cloudfront.net",
};

/** The avatars CDN that serves this build's cards. */
export function agentCardCdn(
  build = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  try {
    return CDNS[new URL(build).origin] ?? PRODUCTION;
  } catch {
    return PRODUCTION;
  }
}

/** Far above any real card. */
const MAX_BYTES = 2 * 1024 * 1024;

/** What a card fills in on Create agent; nothing is created from it unseen. */
export type AgentCardDraft = Readonly<{
  name: string;
  /** An HTTPS image URL. */
  picture: string;
  instructions: string;
}>;

const INVALID = "This agent card is invalid.";

/** Reads a card's `agent.json`: `id` (the link's), `name` and an HTTPS
 * `avatarUrl` are required, `instructions` optional. Other keys, such as
 * `model` (a Builderlab model id) and `description`, are left out. */
export function parseAgentCard(json: unknown, id: string): AgentCardDraft {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new Error(INVALID);
  const card = json as Record<string, unknown>;
  const name = typeof card.name === "string" ? card.name.trim() : "";
  const instructions = card.instructions ?? "";
  let avatar: URL | undefined;
  try {
    avatar = new URL(String(card.avatarUrl));
  } catch {}
  if (
    card.id !== id ||
    !name ||
    typeof instructions !== "string" ||
    avatar?.protocol !== "https:" ||
    !avatar.hostname
  )
    throw new Error(INVALID);
  try {
    checkText(name, instructions);
  } catch {
    throw new Error(INVALID);
  }
  return { name, picture: avatar.href, instructions: instructions.trim() };
}

/** Fetches card `id` from `cdn`. Errors carry wording for the owner. */
export async function fetchAgentCard(
  id: string,
  signal: AbortSignal,
  cdn = agentCardCdn(),
): Promise<AgentCardDraft> {
  if (!AGENT_CARD_ID.test(id)) throw new Error(INVALID);
  let response: Response;
  try {
    response = await fetch(`${cdn}/${id}/agent.json`, {
      signal,
      headers: { accept: "application/json" },
      // A redirect could lead off the CDN.
      redirect: "error",
      credentials: "omit",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "Couldn’t load this agent card. Check your connection and try again.",
    );
  }
  if (response.status === 403 || response.status === 404)
    throw new Error("This agent card isn’t available.");
  if (!response.ok)
    throw new Error("Couldn’t load this agent card. Try again later.");
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("This agent card is too large.");
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES)
    throw new Error("This agent card is too large.");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error(INVALID);
  }
  return parseAgentCard(json, id);
}
