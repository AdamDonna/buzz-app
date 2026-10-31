import { describe, expect, it, vi } from "vitest";
import type { SlashCommandContext } from "../../features/conversation/contracts";
import {
  isAvailable,
  runsInScope,
} from "../../features/conversation/slash-command";
import type { ComposerSession } from "../../features/messages/composer-session";
import type { Navigation } from "../../features/navigation/controller";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelAdminCommands } from "./channel-admin";

const viewer = "1".repeat(64);
const alice = { pubkey: "a".repeat(64), name: "Alice" };
const bob = { pubkey: "b".repeat(64), name: "Bob" };
const robot = { pubkey: "c".repeat(64), name: "Robot" };
const channelId = "5f1b8f3a-0c47-4c3e-8d57-2f6a7a1d9b10";
const dmId = "9a2c4e6f-1b3d-4f5a-8c7e-0d1f2a3b4c5d";
const scope = `https://relay.example.test:${viewer}`;

type Overrides = {
  [K in keyof ChannelSummary]?: ChannelSummary[K] | undefined;
};

function summary(over: Overrides = {}): ChannelSummary {
  return {
    id: channelId,
    name: "general",
    channelType: "stream",
    viewerRole: "owner",
    members: [viewer],
    ...over,
  } as ChannelSummary;
}

type Options = {
  details?: boolean;
  lifecycle?: boolean;
  confirm?: "completed" | "cancelled" | Error | undefined;
  canEdit?: boolean;
  canArchive?: boolean;
  muteWritable?: boolean;
  muted?: string[];
  preferencesLoaded?: boolean;
  dms?: boolean;
};

function world(channel: ChannelSummary = summary(), options: Options = {}) {
  const channels = [channel];
  const current = {
    channelId,
    name: channel.name,
    description: "About",
    visibility: "public" as const,
    version: "v1",
    canEdit: options.canEdit ?? true,
  };
  const details = {
    available: options.details ?? true,
    load: vi.fn(async () => current),
    save: vi.fn(async () => {}),
  };
  const lifecycle = {
    available: options.lifecycle ?? true,
    load: vi.fn(async () => ({ canArchive: options.canArchive ?? true })),
    run: vi.fn(async () => {}),
  };
  const confirmation = "confirm" in options ? options.confirm : "completed";
  const confirmChannelAction = vi.fn(async () => {
    if (confirmation instanceof Error) throw confirmation;
    return confirmation ?? "completed";
  });
  let muted = [...(options.muted ?? [])];
  const preferences = {
    muteWritable: options.muteWritable ?? true,
    snapshot: vi.fn(() =>
      options.preferencesLoaded === false
        ? { data: undefined }
        : { data: { muted: [...muted] } },
    ),
    setMute: vi.fn(async (id: string, on: boolean) => {
      muted = on ? [...muted, id] : muted.filter((key) => key !== id);
      return muted;
    }),
  };
  const directMessages = {
    available: options.dms ?? true,
    open: vi.fn(async (_keys: readonly string[], _signal: AbortSignal) => dmId),
    delivered: vi.fn(async () => {}),
    delivery: vi.fn((): string | undefined => undefined),
    people: vi.fn(),
  };
  const send = vi.fn(async () => "event-1");
  const dismiss = vi.fn(async () => {});
  const navigation = {
    open: vi.fn(async () => ({ status: "opened" as const })),
  };
  const session = {
    viewer,
    channels: {
      list: () => ({ status: "ready", channels }),
      get: (id: string) => channels.find((item) => item.id === id),
      subscribeList: () => () => {},
    },
    channelDetails: details,
    channelLifecycle: lifecycle,
    sidebarPreferences: preferences,
    directMessages,
    messages: { send },
    outbox: { supports: () => true, dismiss },
    agentChoices: { snapshot: () => ({ identities: [] }) },
    profiles: {
      snapshot: () =>
        new Map([[robot.pubkey, { name: "Robot", isAgent: true }]]),
    },
  } as unknown as ComposerSession;
  return {
    channels,
    details,
    lifecycle,
    confirmChannelAction,
    preferences,
    directMessages,
    send,
    dismiss,
    navigation,
    session,
  };
}

type World = ReturnType<typeof world>;

function commandsFor(w: World) {
  const all = channelAdminCommands(w.navigation as unknown as Navigation);
  const byName = (name: string) => {
    const found = all.find((command) => command.name === name);
    if (!found) throw new Error(`No /${name}`);
    return found;
  };
  const run = async (
    name: string,
    args = "",
    recipients: readonly { pubkey: string; name: string }[] = [],
    over: Partial<SlashCommandContext> = {},
  ) =>
    byName(name).run({
      session: w.session,
      scope,
      channelId,
      args,
      recipients,
      signal: new AbortController().signal,
      confirmChannelAction: w.confirmChannelAction,
      ...over,
    });
  const available = (name: string) =>
    isAvailable(byName(name), {
      session: w.session,
      scope,
      channelId,
      conversation: "channel",
    });
  return { all, byName, run, available };
}

describe("availability", () => {
  const rows: [string, Overrides, boolean][] = [
    ["an owner", { viewerRole: "owner" }, true],
    ["an admin", { viewerRole: "admin" }, true],
    ["a member", { viewerRole: "member" }, false],
    ["an agent member", { viewerRole: "bot" }, false],
    ["a guest", { viewerRole: "guest" }, false],
    [
      "someone previewing an open channel",
      { members: [], viewerRole: undefined, readOnly: true },
      false,
    ],
    ["an owner of an archived channel", { archived: true }, false],
    ["an owner whose roster is only cached", { cached: true }, false],
    ["an owner of a DM", { channelType: "dm" }, false],
    ["an owner of a Solo chat", { channelType: "solo" }, false],
    [
      "an owner of a channel of unknown type",
      { channelType: undefined },
      false,
    ],
    ["an owner of a forum", { channelType: "forum" }, true],
  ];
  it.each(rows)(
    "for %s, /rename and /archive are offered: %s",
    (_label, over, offered) => {
      const { available } = commandsFor(world(summary(over)));
      expect({
        rename: available("rename"),
        archive: available("archive"),
      }).toEqual({
        rename: offered,
        archive: offered,
      });
    },
  );

  it.each([
    ["without channel editing", { details: false }, "rename"],
    ["without channel actions", { lifecycle: false }, "archive"],
  ] as const)(
    "hides only the command a connection %s cannot run",
    (_label, options, hidden) => {
      const { available } = commandsFor(world(summary(), options));
      expect(
        (["rename", "archive"] as const).filter((name) => !available(name)),
      ).toEqual([hidden]);
    },
  );

  it("hides both in a channel the session does not know", () => {
    const w = world();
    const { byName } = commandsFor(w);
    for (const name of ["rename", "archive"])
      expect(
        isAvailable(byName(name), {
          session: w.session,
          scope,
          channelId: dmId,
          conversation: "thread",
        }),
      ).toBe(false);
  });

  it.each([
    ["channel", true],
    ["thread", true],
    ["dm", false],
  ] as const)(
    "offers /rename and /archive in a %s conversation: %s, and /mute and /dm in every one",
    (conversation, offered) => {
      const w = world();
      const { byName } = commandsFor(w);
      const here = (name: string) =>
        runsInScope(byName(name), conversation) &&
        isAvailable(byName(name), {
          session: w.session,
          scope,
          channelId,
          conversation,
        });
      expect({
        rename: here("rename"),
        archive: here("archive"),
        mute: here("mute"),
        dm: here("dm"),
      }).toEqual({
        rename: offered,
        archive: offered,
        mute: true,
        dm: true,
      });
    },
  );

  it("offers /mute and /dm everywhere, and /rename and /archive in channels and their threads", () => {
    const { all } = commandsFor(world());
    expect(
      all.map(({ name, aliases, scopes, available, mentionsAreArguments }) => [
        name,
        aliases ?? [],
        scopes ?? "any",
        !!available,
        !!mentionsAreArguments,
      ]),
    ).toEqual([
      ["rename", [], ["channel", "thread"], true, false],
      ["archive", [], ["channel", "thread"], true, false],
      ["mute", [], "any", false, false],
      ["dm", ["msg"], "any", false, true],
    ]);
  });
});

describe("/rename", () => {
  it("renames through the channel details capability, from the details it just read", async () => {
    const w = world();
    const result = await commandsFor(w).run("rename", "  #Planning\\_2027  ");
    expect(w.details.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ version: "v1", name: "general" }),
      expect.objectContaining({
        name: "Planning_2027",
        description: "About",
        visibility: "public",
      }),
      expect.any(AbortSignal),
    );
    expect(result).toEqual({
      done: true,
      notice: "Renamed this channel to #Planning_2027.",
    });
  });

  it.each([
    ["no name", "", [], "Say what to rename it to. Usage: /rename <name>"],
    ["only a #", "#", [], "Say what to rename it to. Usage: /rename <name>"],
    [
      "a mention",
      "@Alice",
      [alice],
      "A channel name is one line of plain text. Usage: /rename <name>",
    ],
    [
      "a channel link",
      "[\\#random](buzz://channel/x)",
      [],
      "A channel name is one line of plain text. Usage: /rename <name>",
    ],
    [
      "two lines",
      "one\ntwo",
      [],
      "A channel name is one line of plain text. Usage: /rename <name>",
    ],
    [
      "a name over 120 characters",
      "x".repeat(121),
      [],
      "Enter a channel name of 1–120 characters without a leading #.",
    ],
  ])(
    "rejects %s without reading or writing anything",
    async (_label, args, who, message) => {
      const w = world();
      await expect(commandsFor(w).run("rename", args, who)).rejects.toThrow(
        message,
      );
      expect(w.details.load).not.toHaveBeenCalled();
      expect(w.details.save).not.toHaveBeenCalled();
    },
  );

  it("refuses when the verified details say the viewer cannot edit, and writes nothing", async () => {
    const w = world(summary(), { canEdit: false });
    await expect(commandsFor(w).run("rename", "new")).rejects.toThrow(
      "You can't rename this channel.",
    );
    expect(w.details.save).not.toHaveBeenCalled();
  });

  it("says so, and writes nothing, when the name is unchanged", async () => {
    const w = world();
    await expect(commandsFor(w).run("rename", "general")).resolves.toEqual({
      done: true,
      notice: "This channel is already named #general.",
    });
    expect(w.details.save).not.toHaveBeenCalled();
  });

  it("fails visibly when the connection cannot edit channels, when reading fails and when saving fails", async () => {
    const off = world(summary(), { details: false });
    await expect(commandsFor(off).run("rename", "new")).rejects.toThrow(
      "Renaming channels is unavailable on this connection.",
    );
    const unread = world();
    unread.details.load.mockRejectedValueOnce(new Error("Offline"));
    await expect(commandsFor(unread).run("rename", "new")).rejects.toThrow(
      "Offline",
    );
    const refused = world();
    refused.details.save.mockRejectedValueOnce(
      new Error(
        "The change may have been saved. Check its status before trying again.",
      ),
    );
    await expect(commandsFor(refused).run("rename", "new")).rejects.toThrow(
      "The change may have been saved",
    );
  });
});

describe("/archive", () => {
  it("asks the app's own confirmation after checking permission, and finishes quietly once archived", async () => {
    const w = world();
    await expect(commandsFor(w).run("archive")).resolves.toEqual({
      done: true,
    });
    expect(w.lifecycle.load).toHaveBeenCalledExactlyOnceWith(
      channelId,
      expect.any(AbortSignal),
    );
    expect(w.confirmChannelAction).toHaveBeenCalledExactlyOnceWith(
      "archive",
      channelId,
    );
    expect(w.lifecycle.run).not.toHaveBeenCalled();
  });

  it("reports a declined confirmation as neither done nor failed", async () => {
    const w = world(summary(), { confirm: "cancelled" });
    await expect(commandsFor(w).run("archive")).resolves.toEqual({
      cancelled: true,
    });
  });

  it("fails visibly when the confirmed archive fails", async () => {
    const w = world(summary(), {
      confirm: new Error("Archive channel failed: Relay refused"),
    });
    await expect(commandsFor(w).run("archive")).rejects.toThrow(
      "Archive channel failed: Relay refused",
    );
  });

  it.each([
    [
      "the connection cannot run channel actions",
      { lifecycle: false },
      "Archiving channels is unavailable on this connection.",
    ],
    [
      "the verified permissions do not allow it",
      { canArchive: false },
      "You can't archive this channel.",
    ],
  ] as const)(
    "refuses, before asking, when %s",
    async (_label, options, message) => {
      const w = world(summary(), options);
      await expect(commandsFor(w).run("archive")).rejects.toThrow(message);
      expect(w.confirmChannelAction).not.toHaveBeenCalled();
    },
  );

  it("refuses where the app has no confirmation to ask", async () => {
    const w = world();
    await expect(
      commandsFor(w).run("archive", "", [], {
        confirmChannelAction: undefined,
      }),
    ).rejects.toThrow("Archiving asks for confirmation");
    expect(w.lifecycle.load).not.toHaveBeenCalled();
  });
});

describe("/mute", () => {
  it("toggles by the confirmed state and says which state it is now in", async () => {
    const w = world();
    const { run } = commandsFor(w);
    await expect(run("mute")).resolves.toEqual({
      done: true,
      notice: "Muted #general.",
    });
    await expect(run("mute")).resolves.toEqual({
      done: true,
      notice: "Unmuted #general.",
    });
    expect(w.preferences.setMute.mock.calls).toEqual([
      [channelId, true],
      [channelId, false],
    ]);
  });

  it("names a direct message as this conversation", async () => {
    const w = world(summary({ channelType: "dm", name: "alice-bob" }));
    await expect(commandsFor(w).run("mute")).resolves.toEqual({
      done: true,
      notice: "Muted this conversation.",
    });
  });

  it("fails visibly when muting is unavailable or the write fails, changing nothing", async () => {
    const off = world(summary(), { muteWritable: false });
    await expect(commandsFor(off).run("mute")).rejects.toThrow(
      "Muting is unavailable on this connection.",
    );
    expect(off.preferences.setMute).not.toHaveBeenCalled();
    const unloaded = world(summary(), { preferencesLoaded: false });
    await expect(commandsFor(unloaded).run("mute")).rejects.toThrow(
      "Your mute settings haven't loaded yet. Try again in a moment.",
    );
    expect(unloaded.preferences.setMute).not.toHaveBeenCalled();
    const failing = world();
    failing.preferences.setMute.mockRejectedValueOnce(new Error("Offline"));
    await expect(commandsFor(failing).run("mute")).rejects.toThrow("Offline");
  });
});

describe("/dm", () => {
  const target = {
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://relay.example.test", viewer },
    channelId: dmId,
  };

  it("opens the conversation with everyone mentioned, then navigates only after", async () => {
    const w = world();
    const result = await commandsFor(w).run("dm", "@Alice @Bob", [alice, bob]);
    expect(w.directMessages.open).toHaveBeenCalledExactlyOnceWith(
      [alice.pubkey, bob.pubkey],
      expect.any(AbortSignal),
    );
    expect(w.send).not.toHaveBeenCalled();
    expect(w.navigation.open).not.toHaveBeenCalled();
    expect(result).toMatchObject({ done: true });
    expect(result).not.toHaveProperty("notice");
    (result as { after: () => void }).after();
    expect(w.navigation.open).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("sends the text after the mentions, waits for delivery, then opens", async () => {
    const w = world();
    const result = await commandsFor(w).run(
      "dm",
      "@Alice @Bob  lunch with @Bob?",
      [alice, bob],
    );
    expect(w.send).toHaveBeenCalledExactlyOnceWith(
      dmId,
      "lunch with @Bob?",
      [],
    );
    expect(w.directMessages.delivered).toHaveBeenCalledExactlyOnceWith(
      "event-1",
      dmId,
      expect.any(AbortSignal),
    );
    expect(w.directMessages.open.mock.invocationCallOrder[0]).toBeLessThan(
      w.send.mock.invocationCallOrder[0] ?? 0,
    );
    expect(w.navigation.open).not.toHaveBeenCalled();
    (result as { after: () => void }).after();
    expect(w.navigation.open).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("matches the longest name and an escaped name at the start", async () => {
    const w = world();
    const ann = { pubkey: "d".repeat(64), name: "Ann" };
    const annLee = { pubkey: "e".repeat(64), name: "Ann Lee" };
    const odd = { pubkey: "f".repeat(64), name: "Al_ice*" };
    await commandsFor(w).run("dm", "@Ann Lee @Al\\_ice\\* hi", [
      ann,
      annLee,
      odd,
    ]);
    expect(w.directMessages.open.mock.calls[0]?.[0]).toEqual([
      annLee.pubkey,
      odd.pubkey,
    ]);
    expect(w.send).toHaveBeenCalledWith(dmId, "hi", []);
  });

  it.each([
    ["no one", "", []],
    ["a name that did not resolve to a person", "alice hi", []],
    ["a mention only after the text", "hi @Alice", [alice]],
  ])(
    "rejects %s with the usage and opens nothing",
    async (_label, args, who) => {
      const w = world();
      await expect(commandsFor(w).run("dm", args, who)).rejects.toThrow(
        "Mention each person with @. Usage: /dm @user… [message]",
      );
      expect(w.directMessages.open).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "yourself",
      [{ pubkey: viewer, name: "Me" }],
      "You can't message yourself. Usage: /dm @user… [message]",
    ],
    [
      "nine people",
      Array.from({ length: 9 }, (_, index) => ({
        pubkey: index.toString(16).padStart(64, "9"),
        name: `P${index}`,
      })),
      "Choose between one and eight other people.",
    ],
    [
      "an agent you cannot message",
      [robot],
      "Robot isn't an agent you can message.",
    ],
  ])("refuses %s before opening anything", async (_label, who, message) => {
    const w = world();
    const args = who.map(({ name }) => `@${name}`).join(" ");
    await expect(
      commandsFor(w).run("dm", `${args} hello`, who),
    ).rejects.toThrow(message);
    expect(w.directMessages.open).not.toHaveBeenCalled();
    expect(w.send).not.toHaveBeenCalled();
  });

  it("allows exactly eight people", async () => {
    const w = world();
    const eight = Array.from({ length: 8 }, (_, index) => ({
      pubkey: index.toString(16).padStart(64, "9"),
      name: `P${index}`,
    }));
    await commandsFor(w).run(
      "dm",
      eight.map(({ name }) => `@${name}`).join(" "),
      eight,
    );
    expect(w.directMessages.open.mock.calls[0]?.[0]).toHaveLength(8);
  });

  it("fails visibly, and opens nothing, when the connection cannot start direct messages or opening fails", async () => {
    const off = world(summary(), { dms: false });
    await expect(commandsFor(off).run("dm", "@Alice", [alice])).rejects.toThrow(
      "This connection cannot start direct messages.",
    );
    const failing = world();
    failing.directMessages.open.mockRejectedValueOnce(new Error("Offline"));
    await expect(
      commandsFor(failing).run("dm", "@Alice hi", [alice]),
    ).rejects.toThrow("Offline");
    expect(failing.send).not.toHaveBeenCalled();
    expect(failing.navigation.open).not.toHaveBeenCalled();
  });

  it("keeps the draft and drops the failed event when the message provably did not send", async () => {
    const w = world();
    w.directMessages.delivered.mockRejectedValueOnce(
      new Error("Relay refused"),
    );
    w.directMessages.delivery.mockReturnValue("failed");
    await expect(
      commandsFor(w).run("dm", "@Alice hi", [alice]),
    ).rejects.toThrow("Couldn't send your message to Alice (Relay refused).");
    expect(w.dismiss).toHaveBeenCalledExactlyOnceWith("event-1");
    expect(w.navigation.open).not.toHaveBeenCalled();
  });

  it("says so when the failed event cannot be cleared from the outbox", async () => {
    const w = world();
    w.directMessages.delivered.mockRejectedValueOnce(
      new Error("Relay refused"),
    );
    w.directMessages.delivery.mockReturnValue("failed");
    w.dismiss.mockRejectedValueOnce(new Error("Storage is full"));
    await expect(
      commandsFor(w).run("dm", "@Alice hi", [alice]),
    ).rejects.toThrow(
      "Couldn't send your message to Alice (Relay refused), and the failed message couldn't be cleared from your outbox (Storage is full). Trying again may send it twice.",
    );
  });

  it("keeps the draft and the event, and warns of a duplicate, when delivery is unknown", async () => {
    const w = world();
    w.directMessages.delivered.mockRejectedValueOnce(new Error("Timed out"));
    w.directMessages.delivery.mockReturnValue("unknown");
    await expect(
      commandsFor(w).run("dm", "@Alice @Bob hi", [alice, bob]),
    ).rejects.toThrow(
      "Couldn't confirm your message to Alice and Bob (Timed out). It may have been sent; check the conversation before trying again.",
    );
    expect(w.dismiss).not.toHaveBeenCalled();
    expect(w.navigation.open).not.toHaveBeenCalled();
  });

  it("stops without reporting once the send is abandoned", async () => {
    const w = world();
    const abandon = new AbortController();
    w.directMessages.open.mockImplementationOnce(async () => {
      abandon.abort();
      return dmId;
    });
    await expect(
      commandsFor(w).run("dm", "@Alice hi", [alice], {
        signal: abandon.signal,
      }),
    ).rejects.toThrow();
    expect(w.send).not.toHaveBeenCalled();
  });
});
