// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberAdministrationState } from "../../features/channel-members/administration";
import type { MemberRole } from "../../features/channel-members/administration-protocol";
import type { SlashCommandContext } from "../../features/conversation/contracts";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { Navigation } from "../../features/navigation/controller";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";
import { readView, writeView } from "../../shared/view-state";
import { isAvailable } from "../../features/conversation/slash-command";
import { membershipCommands } from "./membership";

const viewer = "1".repeat(64);
const alice = { pubkey: "a".repeat(64), name: "Alice" };
const bob = { pubkey: "b".repeat(64), name: "Bob" };
const stranger = { pubkey: "c".repeat(64), name: "Stranger" };
const boss = { pubkey: "d".repeat(64), name: "Boss" };
const channelId = "5f1b8f3a-0c47-4c3e-8d57-2f6a7a1d9b10";
const elsewhere = "9a2c4e6f-1b3d-4f5a-8c7e-0d1f2a3b4c5d";
const scope = `https://relay.example.test:${viewer}`;
const partition = { communityOrigin: "https://relay.example.test", viewer };

type Overrides = {
  [K in keyof ChannelSummary]?: ChannelSummary[K] | undefined;
};

function summary(over: Overrides = {}): ChannelSummary {
  return {
    id: channelId,
    name: "general",
    channelType: "stream",
    viewerRole: "member",
    members: [viewer],
    ...over,
  } as ChannelSummary;
}

type World = {
  channels: ChannelSummary[];
  roles: Record<string, MemberRole>;
  /** Pubkeys whose addition, removal or join the relay refuses, with why. */
  refused: Map<string, string>;
  administration: {
    available: boolean;
    snapshot: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  lifecycle: { available: boolean; run: ReturnType<typeof vi.fn> };
  /** Direct messages the lifecycle service reports as hidden. */
  hidden: string[];
  /** The sidebar's saved preferences, if any. */
  preferences: { data?: SidebarPreferences };
  add: ReturnType<typeof vi.fn>;
  navigation: {
    open: ReturnType<typeof vi.fn>;
    here: { target: unknown };
  };
  session: ComposerSession;
};

function world(
  channel: ChannelSummary = summary(),
  options: {
    supports?: boolean;
    administration?: boolean;
    lifecycle?: boolean;
    roster?: Record<string, MemberRole>;
    /** Other listed channels, in sidebar order, before and after this one. */
    before?: ChannelSummary[];
    after?: ChannelSummary[];
    canRemove?: boolean;
  } = {},
): World {
  const channels = [
    ...(options.before ?? []),
    channel,
    ...(options.after ?? []),
  ];
  const roles: Record<string, MemberRole> = {
    [viewer]: "owner",
    [alice.pubkey]: "member",
    [bob.pubkey]: "member",
    [boss.pubkey]: "owner",
    ...options.roster,
  };
  const refused = new Map<string, string>();
  const authority = () => ({
    roles: { ...roles },
    canManage: true,
    canRemove: options.canRemove ?? true,
    canRemoveOwnedAgent: options.canRemove ?? true,
    system: false,
  });
  let state = {
    status: "idle",
    authority: { ...authority(), roles: {}, canRemove: false },
  } as MemberAdministrationState;
  const administration = {
    available: options.administration ?? true,
    snapshot: vi.fn(() => state),
    refresh: vi.fn(async () => {
      state = { status: "ready", authority: authority() };
    }),
    run: vi.fn(
      async (
        _id: string,
        change: { pubkey: string; role: "remove"; expectedRole: MemberRole },
      ) => {
        const reason = refused.get(change.pubkey);
        if (reason) {
          state = {
            ...state,
            status: "error",
            operation: { change, status: "failed" },
            error: reason,
          };
          return;
        }
        delete roles[change.pubkey];
        state = {
          status: "ready",
          authority: authority(),
          operation: { change, status: "confirmed" },
        };
      },
    ),
  };
  const hidden: string[] = [];
  const preferences: { data?: SidebarPreferences } = {};
  const lifecycle = {
    available: options.lifecycle ?? true,
    snapshot: () => ({ hidden }),
    run: vi.fn(async (action: string, id: string) => {
      const reason = refused.get(id);
      if (reason) throw new Error(reason);
      if (action === "leave")
        channels.splice(
          0,
          channels.length,
          ...channels.filter((item) => item.id !== id),
        );
    }),
  };
  const add = vi.fn(async (id: string, pubkey: string) => {
    const reason = refused.get(pubkey);
    if (reason) throw new Error(reason);
    channels.splice(
      0,
      channels.length,
      ...channels.map((item) =>
        item.id === id
          ? { ...item, members: [...(item.members ?? []), pubkey] }
          : item,
      ),
    );
  });
  const here: { target: unknown } = {
    target: {
      version: 1,
      kind: "conversation",
      scope: partition,
      channelId: channel.id,
    },
  };
  const navigation = {
    here,
    open: vi.fn(async () => ({ status: "opened" as const })),
    snapshot: () => ({ entry: here }),
  };
  const session = {
    viewer,
    channels: {
      list: () => ({ status: "ready", channels }),
      get: (id: string) => channels.find((item) => item.id === id),
      subscribeList: () => () => {},
    },
    outbox: { supports: () => options.supports ?? true },
    memberAdditions: { add },
    memberAdministration: administration,
    channelLifecycle: lifecycle,
    sidebarPreferences: { snapshot: () => preferences },
  } as unknown as ComposerSession;
  return {
    channels,
    roles,
    refused,
    administration,
    lifecycle,
    hidden,
    preferences,
    add,
    navigation,
    session,
  };
}

function commandsFor(w: World) {
  const all = membershipCommands(w.navigation as unknown as Navigation);
  const byName = (name: string) => {
    const found = all.find((command) => command.name === name);
    if (!found) throw new Error(`No /${name}`);
    return found;
  };
  const place = (
    over: Partial<SlashCommandContext> = {},
  ): SlashCommandContext => ({
    session: w.session,
    scope,
    channelId,
    args: "",
    recipients: [],
    signal: new AbortController().signal,
    ...over,
  });
  const run = async (
    name: string,
    args = "",
    recipients: readonly { pubkey: string; name: string }[] = [],
    over: Partial<SlashCommandContext> = {},
  ) => byName(name).run(place({ args, recipients, ...over }));
  const available = (name: string) =>
    isAvailable(byName(name), {
      session: w.session,
      scope,
      channelId,
      conversation: "channel",
    });
  return { all, byName, run, available };
}

const link = (id: string, name = "general") =>
  `[\\#${name}](buzz://channel/${id})`;

describe("availability", () => {
  const rows: [
    string,
    Overrides,
    { invite: boolean; remove: boolean; leave: boolean },
  ][] = [
    ["an owner", { viewerRole: "owner" }, yes(true, true, true)],
    ["an admin", { viewerRole: "admin" }, yes(true, true, true)],
    ["a member", { viewerRole: "member" }, yes(true, false, true)],
    ["an agent member", { viewerRole: "bot" }, yes(true, false, true)],
    ["a guest", { viewerRole: "guest" }, yes(false, false, true)],
    [
      "someone previewing an open channel",
      {
        members: [],
        viewerRole: undefined,
        readOnly: true,
        visibility: "public",
      },
      yes(true, false, false),
    ],
    [
      "someone previewing a guest-only open channel",
      {
        members: [],
        viewerRole: undefined,
        readOnly: true,
        joinRole: "guest",
      },
      yes(false, false, false),
    ],
    [
      "an owner of an archived channel",
      { viewerRole: "owner", archived: true },
      yes(false, false, true),
    ],
    [
      "an owner whose member list has not loaded",
      { viewerRole: "owner", members: undefined },
      yes(false, true, true),
    ],
    [
      "a member whose member list has not loaded",
      { viewerRole: "member", members: undefined },
      yes(false, false, true),
    ],
    [
      "an owner whose roster is only cached",
      { viewerRole: "owner", cached: true },
      yes(true, false, false),
    ],
    [
      "an owner of a DM",
      { viewerRole: "owner", channelType: "dm" },
      yes(false, false, false),
    ],
    [
      "an owner of a Solo chat",
      { viewerRole: "owner", channelType: "solo" },
      yes(false, false, false),
    ],
    [
      "an owner of a channel whose type is not known yet",
      { viewerRole: "owner", channelType: undefined },
      yes(false, false, false),
    ],
    [
      "an owner of a forum",
      { viewerRole: "owner", channelType: "forum" },
      yes(true, true, true),
    ],
  ];
  function yes(invite: boolean, remove: boolean, leave: boolean) {
    return { invite, remove, leave };
  }
  it.each(rows)("for %s", (_label, over, expected) => {
    const { available } = commandsFor(world(summary(over)));
    expect({
      invite: available("invite"),
      remove: available("remove"),
      leave: available("leave"),
    }).toEqual(expected);
  });

  it.each([
    ["relay that cannot add members", { supports: false }, "invite"],
    [
      "connection without member administration",
      { administration: false },
      "remove",
    ],
    ["connection without channel actions", { lifecycle: false }, "leave"],
  ] as const)(
    "hides the command a %s cannot run",
    (_label, options, hidden) => {
      const { available } = commandsFor(
        world(summary({ viewerRole: "owner" }), options),
      );
      expect(
        (["invite", "remove", "leave"] as const).filter(
          (name) => !available(name),
        ),
      ).toEqual([hidden]);
    },
  );

  it("hides every channel command in a channel the session does not know", () => {
    const w = world();
    const { byName } = commandsFor(w);
    for (const name of ["invite", "remove", "leave"])
      expect(
        isAvailable(byName(name), {
          session: w.session,
          scope,
          channelId: elsewhere,
          conversation: "thread",
        }),
      ).toBe(false);
  });

  it("offers /join and /who everywhere, and the channel commands only in channels and their threads", () => {
    const { all } = commandsFor(world());
    const shape = Object.fromEntries(
      all.map(({ name, scopes, available }) => [
        name,
        { scopes, checked: !!available },
      ]),
    );
    expect(shape).toEqual({
      invite: { scopes: ["channel", "thread"], checked: true },
      remove: { scopes: ["channel", "thread"], checked: true },
      join: { scopes: undefined, checked: false },
      leave: { scopes: ["channel", "thread"], checked: true },
      who: { scopes: undefined, checked: false },
    });
    expect(all.map(({ name, aliases }) => [name, aliases ?? []])).toEqual([
      ["invite", []],
      ["remove", ["kick"]],
      ["join", []],
      ["leave", ["part"]],
      ["who", ["members"]],
    ]);
  });
});

describe("/invite", () => {
  it("adds each mentioned person in order and confirms", async () => {
    const w = world();
    const result = await commandsFor(w).run("invite", "@Alice @Bob", [
      alice,
      bob,
    ]);
    expect(w.add.mock.calls).toEqual([
      [channelId, alice.pubkey],
      [channelId, bob.pubkey],
    ]);
    expect(result).toEqual({ done: true, notice: "Added Alice and Bob." });
  });

  it("names who failed on a partial failure, then finishes the rest on a rerun", async () => {
    const w = world();
    const { run } = commandsFor(w);
    w.refused.set(bob.pubkey, "The relay refused this member");
    await expect(run("invite", "@Alice @Bob", [alice, bob])).rejects.toThrow(
      "Added Alice. Couldn't add Bob (The relay refused this member).",
    );
    expect(w.add).toHaveBeenCalledTimes(2);
    w.refused.clear();
    w.add.mockClear();
    await expect(run("invite", "@Alice @Bob", [alice, bob])).resolves.toEqual({
      done: true,
      notice: "Added Bob.",
    });
    expect(w.add.mock.calls).toEqual([[channelId, bob.pubkey]]);
  });

  it("never reports success when every addition fails", async () => {
    const w = world();
    w.refused.set(alice.pubkey, "Archived identities cannot be added");
    w.refused.set(bob.pubkey, "Offline");
    await expect(
      commandsFor(w).run("invite", "@Alice @Bob", [alice, bob]),
    ).rejects.toThrow(
      "Couldn't add Alice (Archived identities cannot be added), Bob (Offline).",
    );
  });

  it.each([
    ["no one", "", []],
    ["a name that did not resolve to a person", "alice", []],
    ["a mention beside text it cannot place", "@Alice and bob", [alice]],
    ["a person the text does not mention", "@Alice", [alice, bob]],
  ])("rejects %s with the usage and adds no one", async (_label, args, who) => {
    const w = world();
    await expect(commandsFor(w).run("invite", args, who)).rejects.toThrow(
      "Mention each person with @. Usage: /invite @user…",
    );
    expect(w.add).not.toHaveBeenCalled();
  });

  it("treats a repeated mention once, and an escaped name as its mention", async () => {
    const w = world();
    const odd = { pubkey: "e".repeat(64), name: "Al_ice*" };
    await commandsFor(w).run("invite", "@Al\\_ice\\* @Alice @Alice", [
      odd,
      alice,
      alice,
    ]);
    expect(w.add.mock.calls).toEqual([
      [channelId, odd.pubkey],
      [channelId, alice.pubkey],
    ]);
  });

  it("says so, and changes nothing, when everyone is already a member", async () => {
    const w = world(summary({ members: [viewer, alice.pubkey, bob.pubkey] }));
    await expect(
      commandsFor(w).run("invite", "@Alice @Bob", [alice, bob]),
    ).resolves.toEqual({
      done: true,
      notice: "Alice and Bob are already in this channel.",
    });
    expect(w.add).not.toHaveBeenCalled();
  });

  it("stops without reporting once the send is abandoned", async () => {
    const w = world();
    const abandon = new AbortController();
    w.add.mockImplementationOnce(async () => abandon.abort());
    await expect(
      commandsFor(w).run("invite", "@Alice @Bob", [alice, bob], {
        signal: abandon.signal,
      }),
    ).rejects.toThrow();
    expect(w.add).toHaveBeenCalledTimes(1);
  });
});

describe("/remove", () => {
  it("removes each mentioned member through member administration and confirms", async () => {
    const w = world();
    const result = await commandsFor(w).run("remove", "@Alice @Bob", [
      alice,
      bob,
    ]);
    expect(w.administration.refresh).toHaveBeenCalledWith(channelId);
    expect(
      w.administration.run.mock.calls.map(([id, change]) => [id, change]),
    ).toEqual([
      [
        channelId,
        { pubkey: alice.pubkey, expectedRole: "member", role: "remove" },
      ],
      [
        channelId,
        { pubkey: bob.pubkey, expectedRole: "member", role: "remove" },
      ],
    ]);
    expect(result).toEqual({ done: true, notice: "Removed Alice and Bob." });
  });

  it("names who failed on a partial failure and never reports success", async () => {
    const w = world();
    w.refused.set(
      bob.pubkey,
      "Membership or permissions changed. Refresh members and roles before trying again.",
    );
    await expect(
      commandsFor(w).run("remove", "@Alice @Bob", [alice, bob]),
    ).rejects.toThrow(
      "Removed Alice. Couldn't remove Bob (Membership or permissions changed. Refresh members and roles before trying again.).",
    );
  });

  it("counts a thrown administration error as that person's failure and carries on", async () => {
    const w = world();
    w.administration.run.mockRejectedValueOnce(
      new Error("A member operation is still in progress."),
    );
    await expect(
      commandsFor(w).run("remove", "@Alice @Bob", [alice, bob]),
    ).rejects.toThrow(
      "Removed Bob. Couldn't remove Alice (A member operation is still in progress).",
    );
  });

  it("explains each member it will not remove, and removes no one", async () => {
    const w = world();
    const self = { pubkey: viewer, name: "Me" };
    await expect(
      commandsFor(w).run("remove", "@Me @Stranger @Boss", [
        self,
        stranger,
        boss,
      ]),
    ).rejects.toThrow(
      "Stranger is already out of this channel. Couldn't remove Me (you can't remove yourself; use /leave), Boss (owners can't be removed).",
    );
    expect(w.administration.run).not.toHaveBeenCalled();
  });

  it("fails, rather than calling everyone already out, when the roles were cleared mid-command", async () => {
    const w = world();
    const authority = {
      canManage: true,
      canRemove: true,
      canRemoveOwnedAgent: true,
      system: false,
    };
    w.administration.snapshot
      .mockReturnValueOnce({
        status: "ready",
        authority: { ...authority, roles: { [viewer]: "owner" } },
      })
      .mockReturnValue({
        status: "idle",
        authority: { ...authority, roles: {} },
      });
    await expect(
      commandsFor(w).run("remove", "@Alice @Bob", [alice, bob]),
    ).rejects.toThrow(
      "Couldn't remove Alice (member roles are unavailable), Bob (member roles are unavailable).",
    );
    expect(w.administration.run).not.toHaveBeenCalled();
  });

  it("finishes on a rerun: someone the first run removed is already out, not a failure", async () => {
    const w = world();
    const { run } = commandsFor(w);
    w.refused.set(bob.pubkey, "The relay refused this member");
    await expect(run("remove", "@Alice @Bob", [alice, bob])).rejects.toThrow(
      "Removed Alice. Couldn't remove Bob (The relay refused this member).",
    );
    w.refused.clear();
    w.administration.run.mockClear();
    await expect(run("remove", "@Alice @Bob", [alice, bob])).resolves.toEqual({
      done: true,
      notice: "Removed Bob. Alice is already out of this channel.",
    });
    expect(w.administration.run).toHaveBeenCalledTimes(1);
    await expect(run("remove", "@Alice @Bob", [alice, bob])).resolves.toEqual({
      done: true,
      notice: "Alice and Bob are already out of this channel.",
    });
    expect(w.administration.run).toHaveBeenCalledTimes(1);
  });

  it("refuses, before any write, a member the refreshed roles say it may not remove", async () => {
    const w = world(summary({ viewerRole: "admin" }), { canRemove: false });
    await expect(
      commandsFor(w).run("remove", "@Alice", [alice]),
    ).rejects.toThrow("Couldn't remove Alice (you can't remove this member).");
    expect(w.administration.run).not.toHaveBeenCalled();
  });

  it("fails visibly when roles cannot be read", async () => {
    const w = world();
    w.administration.refresh.mockImplementation(async () => undefined);
    await expect(
      commandsFor(w).run("remove", "@Alice", [alice]),
    ).rejects.toThrow("Member roles are unavailable. Try again.");
    expect(w.administration.run).not.toHaveBeenCalled();
  });

  it("rejects no one with the usage", async () => {
    const w = world();
    await expect(commandsFor(w).run("remove", "", [])).rejects.toThrow(
      "Mention each person with @. Usage: /remove @user…",
    );
    expect(w.administration.refresh).not.toHaveBeenCalled();
  });

  it("is the same command under its hidden alias", () => {
    const { byName } = commandsFor(world());
    expect(byName("remove").aliases).toEqual(["kick"]);
  });
});

describe("/join", () => {
  let w: World;
  beforeEach(() => {
    w = world(summary({ id: channelId }));
  });

  it("joins an open channel the viewer is not in, then opens it only after the draft clears", async () => {
    const open = summary({
      id: elsewhere,
      name: "random",
      members: [],
      readOnly: true,
      viewerRole: undefined,
    });
    w.channels.push(open);
    const result = await commandsFor(w).run("join", link(elsewhere, "random"));
    expect(w.lifecycle.run).toHaveBeenCalledWith(
      "join",
      elsewhere,
      expect.any(AbortSignal),
    );
    expect(w.navigation.open).not.toHaveBeenCalled();
    expect(result).toMatchObject({ done: true });
    if (!("after" in result && result.after)) throw new Error("No after");
    result.after();
    expect(w.navigation.open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "conversation",
      scope: partition,
      channelId: elsewhere,
    });
  });

  it("just opens a channel the viewer already belongs to", async () => {
    w.channels.push(summary({ id: elsewhere, name: "random" }));
    const result = await commandsFor(w).run("join", link(elsewhere, "random"));
    expect(w.lifecycle.run).not.toHaveBeenCalled();
    if (!("after" in result && result.after)) throw new Error("No after");
    result.after();
    expect(w.navigation.open).toHaveBeenCalledOnce();
  });

  it("has the relay confirm a membership that is only cached", async () => {
    w.channels.push(summary({ id: elsewhere, cached: true }));
    await commandsFor(w).run("join", link(elsewhere));
    expect(w.lifecycle.run).toHaveBeenCalledOnce();
  });

  it("fails visibly and opens nothing when the channel cannot be joined", async () => {
    w.channels.push(summary({ id: elsewhere, members: [] }));
    w.refused.set(elsewhere, "Only active public channels can be joined.");
    const { run } = commandsFor(w);
    await expect(run("join", link(elsewhere))).rejects.toThrow(
      "Only active public channels can be joined.",
    );
    expect(w.navigation.open).not.toHaveBeenCalled();
  });

  it("fails visibly when the connection cannot join", async () => {
    const offline = world(summary({ id: channelId }), { lifecycle: false });
    offline.channels.push(summary({ id: elsewhere, members: [] }));
    await expect(
      commandsFor(offline).run("join", link(elsewhere)),
    ).rejects.toThrow("Joining channels is unavailable on this connection.");
  });

  it.each([
    ["no channel", ""],
    ["a channel typed as plain text", "#general"],
    ["a bare name", "general"],
    [
      "a message link",
      `[#general](buzz://channel/${elsewhere}/${"f".repeat(64)})`,
    ],
    ["two channels", `${link(elsewhere)} ${link(channelId)}`],
  ])("rejects %s with the usage", async (_label, args) => {
    await expect(commandsFor(w).run("join", args)).rejects.toThrow(
      "Pick the channel from the # list. Usage: /join #channel",
    );
    expect(w.lifecycle.run).not.toHaveBeenCalled();
  });
});

describe("/leave", () => {
  afterEach(() => localStorage.clear());
  // Roster order is deliberately not sidebar order: the sidebar sorts each
  // section by name, so "general" sits between "alpha" and "hotel".
  const other = (name: string, over: Overrides = {}) =>
    summary({
      id: `${name.slice(0, 4)}0000-0000-4000-8000-000000000000`,
      name,
      ...over,
    });
  const alpha = other("alpha");
  const bravo = other("bravo");
  const hotel = other("hotel");
  const zulu = other("zulu");
  const conversation = (id: string) => ({
    version: 1,
    kind: "conversation",
    scope: partition,
    channelId: id,
  });
  const emptyPage = {
    version: 1,
    kind: "page",
    pluginId: "buzz.channels",
    pageId: "channels",
    route: { version: 1, params: "empty" },
  };
  type Setup = (w: World) => void;

  it.each<[string, ChannelSummary[], ChannelSummary[], unknown, Setup?]>([
    [
      "the channel below it in the sidebar, not the next in the roster",
      [zulu],
      [alpha, hotel],
      conversation(hotel.id),
    ],
    [
      "the channel above it in the sidebar when none is below",
      [bravo, alpha],
      [],
      conversation(bravo.id),
    ],
    [
      "the first channel the sidebar lists, skipping huddle, loading, hidden and Solo ones",
      [
        other("bravo", { huddle: true }),
        other("charlie", { metadataPending: true }),
        other("delta", { hidden: true }),
        other("echo", { channelType: "solo" }),
      ],
      [other("foxtrot", { archived: true }), alpha, zulu],
      conversation(zulu.id),
    ],
    [
      "a direct message the sidebar shows",
      [],
      [other("kilo", { channelType: "dm" })],
      conversation(other("kilo").id),
    ],
    [
      "the empty channels page when the only direct message is hidden by the lifecycle service",
      [],
      [other("kilo", { channelType: "dm" })],
      emptyPage,
      (w) => w.hidden.push(other("kilo").id),
    ],
    [
      "the empty channels page when the only direct message is hidden in the sidebar",
      [],
      [other("kilo", { channelType: "dm" })],
      emptyPage,
      () => writeView(scope, "hidden-dms", [{ id: other("kilo").id }]),
    ],
    [
      "a starred channel, not one in a section the sidebar has collapsed",
      [],
      [hotel, other("yankee")],
      conversation(other("yankee").id),
      (w) => {
        w.preferences.data = {
          starred: [other("yankee").id],
          muted: [],
          sections: [],
          assignments: {},
        };
        writeView(scope, "channel-sidebar", { collapsed: ["channels"] });
      },
    ],
    [
      "the empty channels page when no channel is left",
      [other("bravo", { huddle: true })],
      [],
      emptyPage,
      () => writeView(scope, "selected-channel", channelId),
    ],
  ])(
    "leaves and opens %s itself, without waiting for the draft",
    async (_label, before, after, target, setup) => {
      const w = world(summary(), { before, after });
      setup?.(w);
      const result = await commandsFor(w).run("leave");
      expect(w.lifecycle.run).toHaveBeenCalledWith(
        "leave",
        channelId,
        expect.any(AbortSignal),
      );
      expect(w.channels.some((item) => item.id === channelId)).toBe(false);
      expect(w.navigation.open).toHaveBeenCalledExactlyOnceWith(target);
      expect(result).toEqual({ done: true, notice: "Channel left: general" });
      if (target === emptyPage)
        expect(readView(scope, "selected-channel", "unset")).toBe("unset");
    },
  );

  it("leaves a viewer who has already moved on where they are", async () => {
    const w = world(summary(), { after: [alpha] });
    w.navigation.here.target = conversation(alpha.id);
    expect(await commandsFor(w).run("leave")).toEqual({
      done: true,
      notice: "Channel left: general",
    });
    expect(w.lifecycle.run).toHaveBeenCalledOnce();
    expect(w.navigation.open).not.toHaveBeenCalled();
    w.navigation.here.target = { version: 1, kind: "settings", scope: null };
    await commandsFor(w).run("leave");
    expect(w.navigation.open).not.toHaveBeenCalled();
  });

  it("fails visibly, and stays on the channel, when the relay refuses", async () => {
    const w = world();
    w.refused.set(channelId, "Transfer ownership before leaving the channel.");
    await expect(commandsFor(w).run("leave")).rejects.toThrow(
      "Transfer ownership before leaving the channel.",
    );
    expect(w.navigation.open).not.toHaveBeenCalled();
  });

  it("fails visibly when the connection cannot leave", async () => {
    const w = world(summary(), { lifecycle: false });
    await expect(commandsFor(w).run("leave")).rejects.toThrow(
      "Leaving channels is unavailable on this connection.",
    );
  });

  it("is the same command under its hidden alias", () => {
    expect(commandsFor(world()).byName("leave").aliases).toEqual(["part"]);
  });
});

describe("/who", () => {
  it("opens this channel's member list once the draft clears", async () => {
    const w = world();
    const result = await commandsFor(w).run("who", "", [], {
      channelId: elsewhere,
    });
    expect(w.navigation.open).not.toHaveBeenCalled();
    if (!("after" in result && result.after)) throw new Error("No after");
    result.after();
    expect(w.navigation.open).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      kind: "conversation",
      scope: partition,
      channelId: elsewhere,
      panel: "members",
    });
    expect(result).not.toHaveProperty("notice");
  });

  it("fails visibly when the community scope is malformed", async () => {
    await expect(
      commandsFor(world()).run("who", "", [], { scope: "no-partition" }),
    ).rejects.toThrow("Invalid conversation destination");
  });
});
