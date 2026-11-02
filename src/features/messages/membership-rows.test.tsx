// @vitest-environment jsdom
import { assert, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { profileTarget } from "../profiles/target";
import type { ChannelMessage, MembershipChange } from "../relay/contracts";
import {
  membershipRows,
  membershipDescription,
  withoutStartingAgents,
} from "./membership-rows";
import { MembershipRow } from "./MembershipRow";
import { geometrySignature } from "./geometry";
const wes = "a".repeat(64),
  pinky = "b".repeat(64),
  brain = "c".repeat(64);
const profiles = new Map([
  [wes, { name: "Wes" }],
  [pinky, { name: "Pinky" }],
  [brain, { name: "Brain" }],
]);
function row(
  id: string,
  membership?: MembershipChange,
  createdAt = 100,
): ChannelMessage {
  return {
    id,
    channelId: "a",
    authorId: "relay",
    content: "",
    createdAt,
    ...(membership ? { membership } : {}),
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
  };
}
const joined = (actor: string, target: string): MembershipChange => ({
  type: "member_joined",
  actor,
  target,
});
const left = (target: string): MembershipChange => ({
  type: "member_left",
  actor: target,
  target,
});
const removed = (actor: string, target: string): MembershipChange => ({
  type: "member_removed",
  actor,
  target,
});
it("matches the grouped invitation wording and keeps pronouns grammatical", () => {
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(wes, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky added by you, along with Brain");
  expect(
    membershipDescription([row("1", joined(pinky, wes))], profiles, wes).text,
  ).toBe("You were added by Pinky");
  // Every member name, and only a member name, is tagged with its identity.
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(wes, brain))],
      profiles,
      wes,
    ).parts,
  ).toEqual([
    { id: pinky, text: "Pinky" },
    { text: " added by " },
    { id: wes, text: "you" },
    { text: ", along with " },
    { id: brain, text: "Brain" },
  ]);
  expect(
    membershipDescription(
      [row("1", joined(pinky, pinky)), row("2", joined(brain, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky joined along with Brain");
  expect(
    membershipDescription(
      [row("1", joined(wes, pinky)), row("2", joined(brain, brain))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky arrived along with Brain");
  expect(
    membershipDescription([row("1", removed(pinky, wes))], profiles, wes).text,
  ).toBe("You were removed by Pinky");
});
it("one departures row names leaves and removals without misattributing a remover", () => {
  const leaves = [row("1", left(pinky)), row("2", left(brain))];
  expect(membershipDescription(leaves, profiles).text).toBe(
    "Pinky, along with Brain, left the channel",
  );
  const rows = [
    ...leaves,
    row("3", removed(wes, pinky)),
    row("4", removed(brain, wes)),
  ];
  expect(membershipRows(rows).map((r) => r.id)).toEqual(["4"]);
  expect(membershipDescription(rows, profiles, wes).text).toBe(
    "Pinky departed along with Brain and you",
  );
  expect(
    membershipDescription(
      [row("1", removed(wes, pinky)), row("2", removed(brain, wes))],
      profiles,
      wes,
    ).text,
  ).toBe("Pinky was removed along with you");
  expect(
    membershipDescription(
      [row("1", removed(wes, pinky)), row("2", removed(wes, brain))],
      profiles,
    ).text,
  ).toBe("Pinky was removed by Wes, along with Brain");
});
it("only a message breaks a run: days, gaps and alternation collapse to two rows", () => {
  const midnight = new Date(2026, 8, 12).getTime() / 1000;
  const run = [
    row("j1", joined(pinky, pinky), midnight - 90_000),
    row("l1", left(brain), midnight - 80_000),
    row("j2", joined(wes, brain), midnight - 3_000),
    row("l2", removed(wes, pinky), midnight + 5_000),
    row("j3", joined(brain, brain), midnight + 20_000),
  ];
  const grouped = membershipRows(run);
  // Each row keeps its newest change's key and its oldest change's time.
  expect(grouped.map((r) => [r.id, r.createdAt])).toEqual([
    ["j3", midnight - 90_000],
    ["l2", midnight - 80_000],
  ]);
  expect(grouped.map((r) => r.membershipRows?.map((m) => m.id))).toEqual([
    ["j1", "j2", "j3"],
    ["l1", "l2"],
  ]);
  // Older history extends the rows without renaming them.
  const older = [
    row("j0", joined(wes, wes), midnight - 200_000),
    row("l0", left(wes), midnight - 100_000),
  ];
  expect(membershipRows([...older, ...run]).map((r) => r.id)).toEqual([
    "j3",
    "l2",
  ]);
  const message = row("chat", undefined, midnight + 30_000);
  const later = row("j4", joined(wes, wes), midnight + 40_000);
  expect(membershipRows([...run, message, later]).map((r) => r.id)).toEqual([
    "j3",
    "l2",
    "chat",
    "j4",
  ]);
  // A run with one kind of change stays one row.
  expect(membershipRows(run.filter((r) => r.id.startsWith("j")))).toHaveLength(
    1,
  );
});
it("a join and a departure in one run show on separate rows", () => {
  const rows = [
    row("1", joined(pinky, pinky)),
    row("2", joined(pinky, pinky)),
    row("3", left(pinky)),
  ];
  const grouped = membershipRows(rows);
  expect(grouped.map((r) => r.membershipRows ?? [r])).toEqual([
    rows.slice(0, 2),
    [rows[2]],
  ]);
  expect(membershipDescription(rows.slice(0, 2), profiles).text).toBe(
    "Pinky joined",
  );
});
it("the kind of change that came first leads, even within one second", () => {
  const grouped = membershipRows([
    row("left", left(pinky), 100),
    row("back", joined(pinky, pinky), 100),
  ]);
  expect(grouped.map((r) => r.id)).toEqual(["left", "back"]);
  // An older page can put the other kind first; both rows keep their keys.
  expect(
    membershipRows([
      row("earlier", joined(brain, brain), 50),
      row("left", left(pinky), 100),
      row("back", joined(pinky, pinky), 100),
    ]).map((r) => r.id),
  ).toEqual(["back", "left"]);
});
it("every grouped input remains represented for mixed three-event sequences", () => {
  const changes = [
    joined(wes, pinky),
    joined(pinky, pinky),
    joined(brain, brain),
    joined(brain, pinky),
    left(pinky),
    left(brain),
    removed(wes, pinky),
    removed(brain, pinky),
  ];
  for (const a of changes)
    for (const b of changes)
      for (const c of changes) {
        const rows = [row("a", a, 1), row("b", b, 2), row("c", c, 3)];
        const groups = membershipRows(rows);
        expect(groups.length).toBeLessThanOrEqual(2);
        expect(
          groups
            .flatMap((r) => r.membershipRows ?? [r])
            .map((r) => r.id)
            .sort(),
        ).toEqual(["a", "b", "c"]);
        expect(groups.map((r) => r.createdAt)).toEqual(
          [...groups.map((r) => r.createdAt)].sort((x, y) => x - y),
        );
        for (const group of groups) {
          const members = group.membershipRows ?? [group];
          const kinds = new Set(
            members.map((r) => r.membership?.type === "member_joined"),
          );
          expect(kinds.size).toBe(1);
          const description = membershipDescription(members, profiles);
          expect(description.text).not.toBe("");
          expect(description.targets).toEqual([
            ...new Set(members.map((r) => r.membership?.target)),
          ]);
        }
      }
});
it("caps visible names/avatars with an overflow count, retaining all names in the title", () => {
  const rows = [pinky, brain, wes, "d".repeat(64)].map((id, i) =>
    row(String(i), joined(id, id)),
  );
  const group = membershipRows(rows)[0];
  assert.exists(group);
  const html = renderToStaticMarkup(
    <MembershipRow
      row={group}
      profiles={profiles}
      media={() => undefined}
      viewer={wes}
      day={false}
    />,
  );
  expect(html).toContain("Pinky joined along with Brain, you, and 1 other");
  expect(html).toContain("+1");
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("button");
  expect(html).not.toContain("relay");
  expect(html).toContain("data-membership-row");
  expect(html).toContain("dddddddddd");
});
it.each([false, true])(
  "keeps small membership media requests with agent hint %s",
  (agent) => {
    const picture = "https://image.test/member.png";
    const media = vi.fn((url: string) => url);
    const html = renderToStaticMarkup(
      <MembershipRow
        row={row("join", joined(pinky, pinky))}
        profiles={new Map([[pinky, { name: "Pinky", picture }]])}
        agentPubkeys={new Set(agent ? [pinky] : [])}
        media={media}
        day={false}
      />,
    );
    expect(media).toHaveBeenCalledWith(picture, "small");
    expect(html).toContain(
      `data-avatar-shape="${agent ? "squircle" : "circle"}"`,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("button");
  },
);
it("actor/subject profile enrichment invalidates cached system-row geometry", () => {
  const rows = [row("a", joined(wes, pinky))];
  const original = geometrySignature(rows, profiles);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [pinky, { name: "Longer Pinky" }]]),
    ),
  ).not.toBe(original);
  expect(
    geometrySignature(
      rows,
      new Map([...profiles, [wes, { name: "Longer Wes" }]]),
    ),
  ).not.toBe(original);
});
it("member names open the subject's and the actor's profiles when the host can", () => {
  const open = vi.fn(() => true);
  const group = membershipRows([
    row("1", joined(wes, pinky)),
    row("2", joined(wes, brain)),
  ])[0];
  assert.exists(group);
  const mount = (canOpenLink: (target: string) => boolean) =>
    render(
      <MembershipRow
        row={group}
        profiles={profiles}
        agentPubkeys={new Set([brain])}
        media={() => undefined}
        viewer={wes}
        day={false}
        onOpenLink={open}
        canOpenLink={canOpenLink}
      />,
    );
  mount(() => true);
  const paragraph = screen.getByTitle("Pinky and Brain");
  expect(paragraph.textContent).toBe("Pinky added by you, along with Brain");
  const subject = screen.getByRole("button", { name: "View Pinky profile" });
  fireEvent.click(subject);
  expect(open).toHaveBeenLastCalledWith(profileTarget(pinky));
  // jsdom clicks never focus, so this proves the explicit focus that keeps a
  // return target for the profile tab under WebKit.
  expect(subject).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "View your profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(wes));
  const agent = screen.getByRole("button", { name: "View Brain profile" });
  // System notices name people as quiet text, never as mention chips.
  expect(agent).not.toHaveAttribute("data-mention-kind");
  fireEvent.click(agent);
  expect(open).toHaveBeenLastCalledWith(profileTarget(brain, { agent: true }));
  expect(screen.getAllByRole("button")).toHaveLength(3);
  cleanup();
  // A host that cannot open a profile keeps that name as plain prose.
  mount((target) => target === profileTarget(pinky));
  expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
    "Pinky",
  ]);
  expect(screen.getByTitle("Pinky and Brain").textContent).toBe(
    "Pinky added by you, along with Brain",
  );
  cleanup();
  render(
    <MembershipRow
      row={row("1", removed(pinky, brain))}
      profiles={profiles}
      media={() => undefined}
      viewer={wes}
      day={false}
      onOpenLink={open}
      canOpenLink={() => true}
    />,
  );
  expect(screen.getByTitle("Brain").textContent).toBe(
    "Brain was removed by Pinky",
  );
  fireEvent.click(screen.getByRole("button", { name: "View Pinky profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(pinky));
  // Without agent evidence, Brain opens as a person.
  fireEvent.click(screen.getByRole("button", { name: "View Brain profile" }));
  expect(open).toHaveBeenLastCalledWith(profileTarget(brain));
  expect(document.querySelector("[data-profile-target]")).toBeNull();
});

it("omits only the owner's starting agents once history reaches the start", () => {
  const added = (id: string, actor: string, target: string) =>
    row(id, { type: "member_joined", actor, target });
  const message = { ...row("message"), authorId: wes, content: "Hi" };
  const agents = new Set([pinky, brain]);
  const rows = [
    added("starting", wes, pinky),
    added("person", wes, "d".repeat(64)),
    added("by-agent", pinky, brain),
    message,
    added("later", wes, brain),
  ];
  expect(
    withoutStartingAgents(rows, wes, agents, true).map((row) => row.id),
  ).toEqual(["person", "by-agent", "message", "later"]);
  // Partial history cannot prove a leading arrival started the chat.
  expect(withoutStartingAgents(rows, wes, agents, false)).toBe(rows);
  expect(withoutStartingAgents(rows, undefined, agents, true)).toBe(rows);
  // A chat with no messages yet still started with its agents.
  expect(
    withoutStartingAgents([added("only", wes, pinky)], wes, agents, true),
  ).toEqual([]);
  // Setup churn hides as a whole, so no removal outlives its hidden addition.
  expect(
    withoutStartingAgents(
      [
        added("first", wes, pinky),
        row("removed", removed(wes, pinky)),
        row("left", left(brain)),
        added("again", wes, pinky),
        message,
      ],
      wes,
      agents,
      true,
    ).map((row) => row.id),
  ).toEqual(["left", "message"]);
});
