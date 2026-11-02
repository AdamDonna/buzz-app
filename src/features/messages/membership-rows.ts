import type {
  ChannelMessage,
  MembershipChange,
  Profile,
} from "../relay/contracts";

export type TimelineRow = ChannelMessage & {
  membershipRows?: readonly ChannelMessage[];
};
/** A Solo chat implies the agents its owner started it with; omit the owner's
 * agent additions and removals before the first message once history reaches
 * the chat's start. Later changes, people and agents added by someone else
 * still show. */
export function withoutStartingAgents(
  rows: readonly ChannelMessage[],
  owner: string | undefined,
  agents: ReadonlySet<string>,
  complete: boolean,
): readonly ChannelMessage[] {
  if (!complete || !owner) return rows;
  const first = rows.findIndex((row) => !row.membership);
  const start = first === -1 ? rows.length : first;
  const starting = (row: ChannelMessage) =>
    (row.membership?.type === "member_joined" ||
      row.membership?.type === "member_removed") &&
    row.membership.actor === owner &&
    agents.has(row.membership.target);
  return rows.some((row, index) => index < start && starting(row))
    ? rows.filter((row, index) => index >= start || !starting(row))
    : rows;
}

const departure = (change: MembershipChange | undefined) =>
  change?.type === "member_left" || change?.type === "member_removed";

/** Each run of adjacent membership changes, whatever its span, shows as at
 * most two rows: arrivals and departures. Only a message breaks a run. A row
 * keeps its newest change's key, so prepended history never renames it, and
 * takes its oldest change's time; the row whose kind came first leads, so
 * rows and day dividers stay in order. */
export function membershipRows(
  rows: readonly ChannelMessage[],
): readonly TimelineRow[] {
  const result: TimelineRow[] = [];
  const group = (members: readonly ChannelMessage[]): TimelineRow[] => {
    const newest = members.at(-1);
    const oldest = members[0];
    if (!newest || !oldest) return [];
    return [
      members.length === 1
        ? newest
        : { ...newest, createdAt: oldest.createdAt, membershipRows: members },
    ];
  };
  for (let index = 0; index < rows.length; ) {
    const row = rows[index];
    if (!row) break;
    if (!row.membership) {
      result.push(row);
      index++;
      continue;
    }
    let end = index;
    while (rows[end + 1]?.membership) end++;
    const run = rows.slice(index, end + 1);
    const arrivals = group(
      run.filter((member) => !departure(member.membership)),
    );
    const departures = group(
      run.filter((member) => departure(member.membership)),
    );
    // The kind that happened first leads, even when both share a second.
    result.push(
      ...(departure(row.membership)
        ? [...departures, ...arrivals]
        : [...arrivals, ...departures]),
    );
    index = end + 1;
  }
  return result;
}

/** A prose segment; `id` marks a member name that may open that profile. */
export type MembershipPart = { text: string; id?: string };

export function membershipDescription(
  rows: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  viewer?: string,
  resolveName?: (id: string, fallback: string) => string,
) {
  const changes = rows.flatMap((row) =>
    row.membership ? [row.membership] : [],
  );
  const first = changes[0];
  if (!first) return { targets: [], parts: [], text: "", title: "" };
  const targets = [...new Set(changes.map((change) => change.target))];
  const name = (id: string, subject = false): MembershipPart => ({
    id,
    text:
      id === viewer
        ? subject
          ? "You"
          : "you"
        : (resolveName?.(id, profiles.get(id)?.name ?? id.slice(0, 10)) ??
          profiles.get(id)?.name ??
          id.slice(0, 10)),
  });
  const plain = (text: string): MembershipPart => ({ text });
  const list = (items: readonly MembershipPart[]) => {
    let next = 0;
    return new Intl.ListFormat(undefined, { type: "conjunction" })
      .formatToParts(items.map((item) => item.text))
      .map((part) =>
        part.type === "element"
          ? (items[next++] ?? plain(part.value))
          : plain(part.value),
      );
  };
  const lead = name(first.target, true);
  const others = targets.slice(1, 3);
  const overflow =
    targets.length > 3
      ? `${targets.length - 3} ${targets.length === 4 ? "other" : "others"}`
      : undefined;
  const rest = list([
    ...others.map((id) => name(id)),
    ...(overflow ? [plain(overflow)] : []),
  ]);
  const alongWith = (separator = "") =>
    rest.length ? [plain(`${separator} along with `), ...rest] : [];
  const be = first.target === viewer ? "were" : "was";
  let parts: MembershipPart[];
  if (departure(first)) {
    // One row holds a run's departures: leaves, removals or both.
    const removals = changes.every(({ type }) => type === "member_removed");
    const sameRemover =
      removals && changes.every(({ actor }) => actor === first.actor);
    parts = changes.every(({ type }) => type === "member_left")
      ? [
          lead,
          ...(rest.length ? [...alongWith(","), plain(",")] : []),
          plain(" left the channel"),
        ]
      : sameRemover
        ? [
            lead,
            plain(` ${be} removed by `),
            name(first.actor),
            ...alongWith(","),
          ]
        : removals
          ? [lead, plain(` ${be} removed`), ...alongWith()]
          : [lead, plain(" departed"), ...alongWith()];
  } else {
    const allSelf = changes.every(({ actor, target }) => actor === target);
    const allAdded = changes.every(({ actor, target }) => actor !== target);
    const sameAdder =
      allAdded && changes.every(({ actor }) => actor === first.actor);
    const action = allSelf
      ? [plain(" joined")]
      : sameAdder
        ? [
            plain(` ${first.target === viewer ? "were added" : "added"} by `),
            name(first.actor),
          ]
        : allAdded
          ? [plain(` ${be} added`)]
          : [plain(" arrived")];
    parts = [lead, ...action, ...alongWith(sameAdder ? "," : "")];
  }
  return {
    targets,
    parts,
    text: parts.map((part) => part.text).join(""),
    title: list(targets.map((id) => name(id)))
      .map((part) => part.text)
      .join(""),
  };
}
