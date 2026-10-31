import { sidebarSections } from "../../bundled/channels/sidebar-sections";
import { savedHiddenDmIds } from "../../bundled/channels/useHiddenDms";
import { savedCollapsedSections } from "../../bundled/channels/useSidebarView";
import type { ChannelSummary } from "../relay/contracts";
import type { SidebarPreferences } from "../relay/sidebar-preferences";
import { inTeamInventory } from "./team-inventory";

/** The roster a sidebar labels: archived channels and hidden non-DMs are not shown. */
export function rosterListed(channel: ChannelSummary): boolean {
  return !channel.archived && (!channel.hidden || channel.channelType === "dm");
}

/** Which labelled roster channels the sidebar may place in a section. */
export function sidebarListed(channel: ChannelSummary): boolean {
  return (
    !channel.huddle && !channel.metadataPending && inTeamInventory(channel)
  );
}

/**
 * The shown sidebar rows nearest `id`: its own section's later rows, then
 * earlier ones, then the nearest expanded sections'. Order matches the
 * sidebar, so a neighbor takes the channel's place.
 */
export function sidebarNeighbors(
  sections: readonly Readonly<{
    key: string;
    rows: readonly Readonly<{ id: string }>[];
  }>[],
  collapsed: readonly string[],
  id: string,
): string[] | undefined {
  const at = sections.findIndex((section) =>
    section.rows.some((row) => row.id === id),
  );
  const placement = sections[at];
  if (!placement) return undefined;
  const shown = (section: typeof placement) =>
    collapsed.includes(section.key) ? [] : section.rows.map((row) => row.id);
  const own = shown(placement);
  const index = Math.max(own.indexOf(id), 0);
  return [
    ...own.slice(index + 1),
    ...own.slice(0, index).reverse(),
    ...sections.slice(at + 1).flatMap(shown),
    ...sections.slice(0, at).flatMap(shown).reverse(),
  ];
}

export type SidebarOrderSource = Readonly<{
  scope: string;
  channels: readonly ChannelSummary[];
  preferences?: SidebarPreferences | undefined;
  /** Direct messages the viewer hid, from the lifecycle service. */
  hiddenDms?: readonly string[] | undefined;
}>;

/** The sidebar's sections for a roster, read from the same saved state the
 * sidebar reads: preferences, hidden direct messages and collapsed sections.
 * `neighbors(id)` is empty for a channel the sidebar does not list. */
export function sidebarOrder(source: SidebarOrderSource) {
  const sections = sidebarSections(
    source.channels.filter(rosterListed).filter(sidebarListed),
    source.preferences,
    new Set([...savedHiddenDmIds(source.scope), ...(source.hiddenDms ?? [])]),
  );
  const collapsed = savedCollapsedSections(source.scope);
  return {
    listed: sections.flatMap((section) => section.rows.map((row) => row.id)),
    neighbors: (id: string) => sidebarNeighbors(sections, collapsed, id) ?? [],
  };
}
