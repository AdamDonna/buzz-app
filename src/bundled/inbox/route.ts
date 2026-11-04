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
const filters: Readonly<Record<string, readonly JsonValue[]>> = {
  attention: ["all", "unread"],
  activity: ["all", "threads", "mentions", "dms"],
  show: ["inbox", "archived"],
  sender: ["everyone", "humans", "agents"],
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
    keys.some(
      (key) =>
        !Object.hasOwn(filters, key) ||
        !filters[key]?.includes(value[key] as JsonValue),
    )
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
