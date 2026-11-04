import type { RelaySession } from "../relay/session";
import { foldProfiles } from "../relay/profiles";
import { matchPerson } from "../search/person-match";
import { typedPublicKey } from "../../shared/identity/public-key";

export const MEMBER_SEARCH_PAGE_SIZE = 30;

/** One bounded server-ranked page; never substitute a scan of cached profiles. */
export async function searchMembers(
  session: RelaySession,
  query: string,
  page: number,
  signal: AbortSignal,
) {
  const text = query.trim();
  if (!text || text.length > 256 || !Number.isSafeInteger(page) || page < 1)
    throw new Error("Enter a name or public key to search.");
  // An incomplete public key remains an ordinary query while typing.
  const exact = typedPublicKey(text);
  const events = exact
    ? await session.read(
        [{ kinds: [0], authors: [exact], limit: MEMBER_SEARCH_PAGE_SIZE }],
        { signal },
      )
    : await session.searchProfiles(text, {
        limit: MEMBER_SEARCH_PAGE_SIZE,
        page,
        signal,
      });
  signal.throwIfAborted();
  const profiles = foldProfiles(
    events.filter(
      (event) => event.kind === 0 && (!exact || event.pubkey === exact),
    ),
  );
  // Rank the relay's page by the shared name rule.
  const score = (name: string) => matchPerson(name, text)?.tier ?? 4;
  return {
    people: [...profiles]
      .map(([pubkey, profile]) => ({ pubkey, ...profile }))
      .sort(
        (a, b) =>
          score(a.name) - score(b.name) ||
          a.name.localeCompare(b.name) ||
          a.pubkey.localeCompare(b.pubkey),
      ),
    more: !exact && events.length >= MEMBER_SEARCH_PAGE_SIZE,
  };
}
export type MemberSearchResult = Awaited<ReturnType<typeof searchMembers>>;
