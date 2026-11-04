import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../relay/session";
import type { IdentityNameView } from "../identity-names/service";
import { useNamesRevision } from "../identity-names/react";
import type { Profile } from "../relay/contracts";
import { peopleOrder } from "../profiles/people-order";
import { matchPerson } from "../search/person-match";
import {
  searchDebounce,
  SEARCH_DEBOUNCE_MS,
  searchable,
} from "../../shared/search-debounce";

export type Recipient = Profile & {
  pubkey: string;
  /** Current cached profile names, used only for matching a directory row. */
  aliases?: readonly string[];
};

export function recipientNames(person: Recipient, names?: IdentityNameView) {
  return [
    person.name,
    person.username,
    ...(person.aliases ?? []),
    names?.lookup(person.pubkey)?.name,
  ].filter((name): name is string => !!name);
}

type PeopleState = {
  session: RelaySession;
  query: string;
  people: Recipient[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
  /** The picker visit whose reads produced this entry. */
  visit?: object;
};
// Account/community lifetime only. Keep a bounded set of completed searches,
// not drafts or an additional persistent profile store.
const directories = new WeakMap<RelaySession, Map<string, PeopleState>>();
function empty(session: RelaySession, query: string): PeopleState {
  return {
    session,
    query,
    people: [],
    page: 0,
    hasMore: true,
    loading: true,
    error: "",
  };
}
function matching(
  people: Recipient[],
  query: string,
  names?: IdentityNameView,
) {
  const key = query.trim().toLowerCase();
  return people.filter(
    (person) =>
      recipientNames(person, names).some(
        (name) => matchPerson(name, query) !== undefined,
      ) ||
      (/^[0-9a-f]{64}$/.test(key) && person.pubkey === key),
  );
}
export function usePeople(session: RelaySession, query: string) {
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  useNamesRevision(session.names, !!query.trim());
  const cache = useMemo(() => {
    const existing = directories.get(session);
    if (existing) return existing;
    const created = new Map<string, PeopleState>();
    directories.set(session, created);
    return created;
  }, [session]);
  const [visit] = useState(() => ({}));
  const initial = useMemo(() => {
    const cached = cache.get(query);
    if (!query.trim()) return cached ?? empty(session, query);
    // A completed read proves absence only during the visit that made it, so
    // a reopened picker searches again for people added since.
    const exhausted = (entry?: PeopleState) =>
      entry?.hasMore === false && entry.visit === visit;
    // Text too short to search shows only people already read.
    const complete = exhausted(cache.get("")) || !searchable(query);
    const resumed = cached?.hasMore || exhausted(cached) ? cached : undefined;
    const known = new Map(
      [...cache.values()]
        .flatMap((entry) => entry.people)
        .map((person) => [person.pubkey, person]),
    );
    return {
      ...(resumed ?? empty(session, query)),
      people: [...known.values()],
      loading: !complete && (resumed?.loading ?? true),
      hasMore: !complete && (resumed?.hasMore ?? true),
    };
  }, [cache, session, query, visit]);
  const [state, setState] = useState(initial);
  const request = useRef<
    | {
        controller: AbortController;
        loading: boolean;
        people: Recipient[];
      }
    | undefined
  >(undefined);
  const load = useCallback(
    async function load(
      page: number,
      owned: NonNullable<typeof request.current>,
    ) {
      if (owned.loading || owned.controller.signal.aborted) return;
      owned.loading = true;
      setState((current) => ({ ...current, loading: true, error: "" }));
      try {
        const result = await session.directMessages.people(
          query,
          page,
          owned.controller.signal,
        );
        if (owned.controller.signal.aborted) return;
        const next: PeopleState = {
          session,
          query,
          page,
          hasMore: result.hasMore,
          loading: false,
          error: "",
          visit,
          people: [
            ...new Map(
              [...owned.people, ...result.people].map((person) => [
                person.pubkey,
                person,
              ]),
            ).values(),
          ],
        };
        owned.people = next.people;
        cache.delete(query);
        cache.set(query, next);
        if (cache.size > 20) {
          const oldest = [...cache.keys()].find((key) => key !== "");
          if (oldest !== undefined) cache.delete(oldest);
        }
        setState(next);
      } catch (reason) {
        if (!owned.controller.signal.aborted) {
          if (import.meta.env.DEV)
            console.warn("[people] Directory read failed", {
              page,
              searching: !!query.trim(),
              error: reason instanceof Error ? reason.message : "Unknown error",
            });
          setState((current) => ({
            ...current,
            loading: false,
            error:
              reason instanceof Error
                ? reason.message
                : "Could not load people.",
          }));
        }
      } finally {
        owned.loading = false;
      }
    },
    [session, query, cache, visit],
  );
  useEffect(() => {
    const owned: NonNullable<typeof request.current> = {
      controller: new AbortController(),
      loading: false,
      people: initial.people,
    };
    request.current = owned;
    setState(initial);
    // Returning to a completed query resumes its pages without reshuffling.
    const cancel =
      initial.page || !initial.hasMore
        ? undefined
        : searchDebounce(
            () => void load(1, owned),
            query ? SEARCH_DEBOUNCE_MS : 0,
          );
    return () => {
      cancel?.();
      owned.controller.abort();
    };
  }, [load, query, initial]);
  useEffect(() => {
    if (
      state.session !== session ||
      state.query !== query ||
      !state.page ||
      state.loading ||
      state.error ||
      !state.hasMore
    )
      return;
    const owned = request.current;
    // Continue both browsing and searching: an entire page may be filtered out
    // by recipient eligibility without exhausting the matching directory.
    const timer = setTimeout(() => {
      if (owned) void load(state.page + 1, owned);
    }, 100);
    return () => clearTimeout(timer);
  }, [state, session, query, load]);
  const visible =
    state.session === session && state.query === query ? state : initial;
  const browsed = cache.get("");
  // Keep raw directory rows so a later name/username can match them. As in
  // global search, typed queries also include profiles already known here.
  const known = new Map(
    visible.people.map((person) => [person.pubkey, person]),
  );
  if (query.trim())
    for (const [pubkey, profile] of profiles) {
      if (profile.nameIsFallback && !profile.username) continue;
      const person = known.get(pubkey);
      known.set(
        pubkey,
        person
          ? { ...person, aliases: recipientNames({ ...profile, pubkey }) }
          : { ...profile, pubkey },
      );
    }
  return {
    people: matching([...known.values()], query, session.names).sort(
      peopleOrder(query),
    ),
    loading: visible.loading || (visible.hasMore && !visible.error),
    error: visible.error,
    hasMore: visible.hasMore,
    /** Text too short to search, so people not yet read may still match. */
    tooShort:
      !!query.trim() &&
      !searchable(query) &&
      !(browsed?.hasMore === false && browsed.visit === visit),
    loadMore() {
      if (
        state.session === session &&
        state.query === query &&
        state.hasMore &&
        request.current
      )
        void load(state.page + 1, request.current);
    },
  };
}
