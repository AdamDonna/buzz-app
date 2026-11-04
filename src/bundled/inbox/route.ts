import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import type { ActivityFilter, SenderFilter, ShowFilter } from "./InboxFilters";

/** Inbox's page address; the route contract below applies only to it. */
export const inboxTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
} as const;

/** Filters an open asks the Inbox page to show; omitted choices stay as saved.
 * Drafts has none of the conversation filters, so it stands alone. */
export type InboxRoute =
  | {
      attention?: "all" | "unread";
      activity?: ActivityFilter;
      show?: ShowFilter;
      sender?: SenderFilter;
    }
  | { drafts: true };
type Filters = Required<Exclude<InboxRoute, { drafts: true }>>;
// Keyed by each union so a value added to one fails to compile until listed here.
const filters: {
  readonly [K in keyof Filters]: Readonly<Record<Filters[K], true>>;
} = {
  attention: { all: true, unread: true },
  activity: { all: true, threads: true, mentions: true, dms: true },
  show: { inbox: true, archived: true },
  sender: { everyone: true, humans: true, agents: true },
};

function inboxRoute(params: JsonValue | undefined): InboxRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  const keys = Object.keys(value);
  // buzz:// plugin links carry every route value as a string.
  if (keys.includes("drafts"))
    return keys.length === 1 &&
      (value.drafts === true || value.drafts === "true")
      ? { drafts: true }
      : undefined;
  if (
    keys.some((key) => {
      const choice = value[key];
      return (
        !Object.hasOwn(filters, key) ||
        typeof choice !== "string" ||
        !Object.hasOwn(filters[key as keyof Filters], choice)
      );
    })
  )
    return;
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as InboxRoute;
}

export const isInboxRoute = (params: JsonValue) => !!inboxRoute(params);

/** The route a visit carries, if any; a plain Inbox open has none. */
export function routeOf(target: OpenTarget | undefined) {
  if (target?.kind !== "page" || target.route?.version !== 1) return;
  return inboxRoute(target.route.params);
}

/** An open that shows the Inbox page with these filters applied. */
export const inboxRouteTarget = (params: InboxRoute): OpenTarget => ({
  ...inboxTarget,
  route: { version: 1, params },
});
