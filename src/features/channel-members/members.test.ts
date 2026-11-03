import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import { PublishRejected, type OutgoingEvent } from "../relay/outbox";
import { matchesEvent } from "../relay/projection";
import { keypair, roster, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import {
  addChannelMember,
  addChannelMembersAtOnce,
  canAddMembers,
} from "./members";

const cleanups: (() => void)[] = [];
it.each([
  ["guest", "member", false],
  ["guest", "guest", false],
  ["member", "guest", true],
  ["owner", "guest", true],
  [undefined, "guest", false],
  [undefined, "member", true],
] as const)(
  "keeps invitation eligibility separate from the %s viewer's %s admission default",
  (viewerRole, joinRole, allowed) => {
    expect(
      canAddMembers(
        { viewer: "viewer", outbox: { supports: () => true } },
        {
          id: "channel",
          name: "Updates",
          channelType: "stream",
          joinRole,
          viewerRole,
          members: viewerRole ? ["viewer"] : [],
          ...(viewerRole === "guest" || !viewerRole
            ? { readOnly: true as const }
            : {}),
        },
      ),
    ).toBe(allowed);
  },
);
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function setup(
  type = "stream",
  visibility: "private" | "public" = "private",
  joinRole: "member" | "guest" = "member",
) {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  let members = [viewer.pubkey];
  let personRole: string | undefined;
  let clock = 1700000000;
  let fail = "";
  let unknown = false;
  let loseReceipt = false;
  let apply = true;
  let foreign = false;
  let agent = false;
  let echo = false;
  let failRoster = false;
  let failSave = false;
  let failAcknowledgement = false;
  const published: RelayEvent[] = [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (fail) throw unknown ? new Error(fail) : new PublishRejected(fail);
    if (apply) members = [...new Set([...members, person.pubkey])];
    clock++;
    published.push(event);
    if (loseReceipt) throw new Error("Receipt lost after membership applied");
    return event;
  });
  let records: readonly OutgoingEvent[] = [];
  const create = () =>
    createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        media: () => undefined,
        readAgentLibrary: async () => ({
          definitions: [],
          identities: agent ? [{ pubkey: person.pubkey, name: "Agent" }] : [],
        }),
        writer: {
          kinds: [9, 9000, 9007],
          sign: async (template) => signed(viewer, template),
          publish: async (event) => {
            await publish(event);
          },
        },
        query: async (filters) => {
          if (
            failRoster &&
            published.length &&
            filters.some((filter) => filter.kinds?.includes(39002))
          )
            throw new Error("Roster unavailable");
          return [
            ...(echo ? published : []),
            signed(relay, {
              kind: 39000,
              content: "",
              tags: [
                ["d", id],
                ["t", type],
                [visibility],
                ["join_role", joinRole],
                ["name", "Design"],
              ],
            }),
            personRole
              ? signed(relay, {
                  kind: 39002,
                  content: "",
                  created_at: clock,
                  tags: [
                    ["d", id],
                    ...members.map((key) =>
                      key === person.pubkey && personRole
                        ? ["p", key, "", personRole]
                        : ["p", key],
                    ),
                  ],
                })
              : roster(foreign ? person : relay, id, members, clock),
          ].filter((event) =>
            filters.some((filter) => matchesEvent(event, filter)),
          );
        },
      },
      {
        outboxStorage: {
          load: () => structuredClone(records),
          save: (next) => {
            if (
              failSave ||
              (failAcknowledgement && next.some((item) => item.acknowledged))
            )
              throw new Error("Storage unavailable");
            records = structuredClone(next);
          },
        },
      },
    );
  let owner = create();
  cleanups.push(() => owner.dispose());
  return {
    get session() {
      return owner.session;
    },
    dispose: () => owner.dispose(),
    records: () => records,
    guard: () => {
      records = records.map((item) => ({ ...item, guarded: true }));
    },
    legacy: () => {
      records = records.map(
        ({ recovery: _recovery, acknowledged: _acknowledged, ...item }) => item,
      );
    },
    setAcknowledgementFailure: (value: boolean) => {
      failAcknowledgement = value;
    },
    restart: () => {
      owner.dispose();
      owner = create();
    },
    id,
    person,
    viewer,
    publish,
    setLostReceipt: (value: boolean) => {
      loseReceipt = value;
    },
    profileAdd: (active = () => true) =>
      owner.session.channelWrites.addAgents(id, [person.pubkey], active),
    setSaveFailure: (value: boolean) => {
      failSave = value;
    },
    setEcho: () => {
      echo = true;
    },
    setRosterFailure: (value: boolean) => {
      failRoster = value;
    },
    removePerson: () => {
      members = [viewer.pubkey];
      clock++;
    },
    confirmPerson: (role?: string) => {
      members = [viewer.pubkey, person.pubkey];
      personRole = role;
      clock++;
    },
    managedAdd: () => owner.session.memberAdditions.add(id, person.pubkey),
    setFail: (value: string, uncertain = false) => {
      fail = value;
      unknown = uncertain;
    },
    setApply: (value: boolean) => {
      apply = value;
    },
    setForeign: () => {
      foreign = true;
    },
    removeViewer: () => {
      members = [];
      clock++;
    },
    setAgent: async () => {
      agent = true;
      await owner.session.agentChoices.refresh();
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
    },
    add: (signal = new AbortController().signal) =>
      addChannelMember(owner.session, id, person.pubkey, signal),
  };
}
it("adds a private-channel participant explicitly and confirms the live roster using membership capability alone", async () => {
  const t = setup();
  await t.ready();
  await t.add();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.publish.mock.calls[0]?.[0].tags).toEqual(
    expect.arrayContaining([
      ["h", t.id],
      ["p", t.person.pubkey],
    ]),
  );
  expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "member"]);
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
  await t.add();
  expect(t.publish).toHaveBeenCalledOnce();
});
it("uses the bot role for an existing library agent", async () => {
  const t = setup();
  await t.ready();
  await t.setAgent();
  await t.add();
  expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "bot"]);
});
it("adds a participant despite a private channel's saved Guest default", async () => {
  const t = setup("stream", "private", "guest");
  await t.ready();
  await t.managedAdd();
  expect(t.publish.mock.calls[0]?.[0].tags).toContainEqual(["role", "member"]);
});
it.each(["member", "guest"] as const)(
  "leaves the public %s admission default to the relay",
  async (joinRole) => {
    const t = setup("stream", "public", joinRole);
    await t.ready();
    await t.add();
    expect(
      t.publish.mock.calls[0]?.[0].tags.some(([tag]) => tag === "role"),
    ).toBe(false);
  },
);
it("does not resend an addition for someone already in the private channel", async () => {
  const t = setup("stream", "private", "guest");
  await t.ready();
  t.confirmPerson();
  await t.managedAdd();
  expect(t.publish).not.toHaveBeenCalled();
});
it.each(["guest", "admin"])(
  "does not replay a failed private addition over a newer %s admission after restart",
  async (role) => {
    const t = setup();
    await t.ready();
    t.setFail("Not committed");
    await expect(t.managedAdd()).rejects.toThrow(/Not committed/);
    const original = t.records()[0]?.event.id;
    t.confirmPerson(role);
    t.setFail("");
    t.restart();
    await t.ready();
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.records()[0]).toMatchObject({
      event: { id: original },
      acknowledged: true,
    });
    expect(t.session.channels.list().channels[0]?.members).toContain(
      t.person.pubkey,
    );
  },
);
it("preserves a rejected operation and retries its exact identity", async () => {
  const t = setup();
  await t.ready();
  t.setFail("This agent only accepts additions from its owner");
  await expect(t.add()).rejects.toThrow(/only accepts/);
  const first = t.publish.mock.calls[0]?.[0].id;
  expect(t.session.channels.list().channels[0]?.members).not.toContain(
    t.person.pubkey,
  );
  t.setFail("");
  await t.add();
  expect(t.publish.mock.calls[1]?.[0].id).toBe(first);
});
it("does not claim an accepted write is confirmed membership", async () => {
  const t = setup();
  await t.ready();
  t.setApply(false);
  await expect(t.add()).rejects.toThrow(/not confirmed in the member list/);
});
it("rejects stale permission and foreign roster evidence before publishing", async () => {
  const t = setup();
  await t.ready();
  t.setForeign();
  await expect(t.add()).rejects.toThrow(/refresh channel membership/);
  expect(t.publish).not.toHaveBeenCalled();
  const revoked = setup();
  await revoked.ready();
  revoked.removeViewer();
  await expect(revoked.add()).rejects.toThrow();
  expect(revoked.publish).not.toHaveBeenCalled();
});
it.each(["dm", "unknown"])("never expands a %s conversation", async (type) => {
  const t = setup(type);
  await t.ready();
  expect(canAddMembers(t.session, t.session.channels.list().channels[0])).toBe(
    false,
  );
  await expect(t.add()).rejects.toThrow(/cannot add/);
  expect(t.publish).not.toHaveBeenCalled();
});
it("adds a member to a system channel through the session, which plugins use", async () => {
  const t = setup("system");
  await t.ready();
  expect(t.session.channels.list().channels).toEqual([]);
  await t.session.channels.resolve?.([t.id]);
  expect(t.session.channels.get?.(t.id)?.channelType).toBe("system");
  await t.managedAdd();
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.publish.mock.calls[0]?.[0].tags).toEqual(
    expect.arrayContaining([
      ["h", t.id],
      ["p", t.person.pubkey],
    ]),
  );
  expect(t.session.channels.get?.(t.id)?.members).toContain(t.person.pubkey);
  expect(t.session.channels.list().channels).toEqual([]);
});
it("cancellation before intent and session disposal never publish", async () => {
  const t = setup();
  await t.ready();
  const cancel = new AbortController();
  cancel.abort();
  await expect(t.add(cancel.signal)).rejects.toThrow();
  t.dispose();
  await expect(t.add()).rejects.toThrow();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "retains an echoed addition through roster recovery (read fails: %s)",
  async (readFails) => {
    const t = setup();
    await t.ready();
    t.setEcho();
    t.setApply(false);
    t.setRosterFailure(readFails);
    await expect(t.managedAdd()).rejects.toThrow();
    await vi.waitFor(() =>
      expect(t.session.outbox?.snapshot()[0]?.delivery).toBe("seen"),
    );
    t.setRosterFailure(false);
    await expect(t.managedAdd()).rejects.toThrow(
      /not confirmed in the member list/,
    );
    expect(t.publish).toHaveBeenCalledOnce();
    t.confirmPerson();
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledOnce();
  },
);
it.each(["rejected", "unknown", "unconfirmed"])(
  "supersedes a completed accepted addition only on explicit Add and recovers the new %s request",
  async (failure) => {
    const t = setup();
    await t.ready();
    await t.managedAdd();
    const first = t.publish.mock.calls[0]?.[0].id;
    expect(t.session.outbox?.snapshot()).toEqual([]);
    expect(t.session.memberAdditions.snapshot()).toEqual([]);
    t.removePerson();
    await t.session.channelWrites.refreshMembership(t.id);
    expect(t.publish).toHaveBeenCalledOnce();
    if (failure !== "unconfirmed")
      t.setFail("Failed re-add", failure === "unknown");
    else t.setApply(false);
    await expect(t.managedAdd()).rejects.toThrow();
    const second = t.publish.mock.calls[1]?.[0].id;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    t.setFail("");
    t.setApply(true);
    if (failure === "unconfirmed") {
      await expect(t.managedAdd()).rejects.toThrow(
        /not confirmed in the member list/,
      );
      expect(t.publish).toHaveBeenCalledTimes(2);
      t.confirmPerson();
    }
    await t.managedAdd();
    const ids = t.publish.mock.calls.map(([event]) => event.id);
    expect(ids).toEqual(
      failure !== "unconfirmed" ? [first, second, second] : [first, second],
    );
  },
);

it("allows a new explicit addition after an expired failed request is dismissed", async () => {
  const t = setup();
  await t.ready();
  t.setFail("Rejected addition");
  await expect(t.managedAdd()).rejects.toThrow(/Rejected addition/);
  const first = t.publish.mock.calls[0]?.[0].id;
  if (!first) throw new Error("Expected invitation");
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + 16 * 60 * 1000);
  try {
    await expect(t.managedAdd()).rejects.toThrow(/addition expired/);
  } finally {
    now.mockRestore();
  }
  await t.session.outbox?.dismiss(first);
  expect(t.session.outbox?.snapshot()).toEqual([]);
  t.setFail("");
  await t.managedAdd();
  expect(t.publish).toHaveBeenCalledTimes(2);
  expect(t.publish.mock.calls[1]?.[0].id).not.toBe(first);
});

it("keeps the exact failed request when durable dismissal fails", async () => {
  const t = setup();
  await t.ready();
  t.setFail("Rejected addition");
  await expect(t.managedAdd()).rejects.toThrow(/Rejected addition/);
  const first = t.publish.mock.calls[0]?.[0].id;
  if (!first) throw new Error("Expected invitation");
  t.setSaveFailure(true);
  await expect(t.session.outbox?.dismiss(first)).rejects.toThrow(
    /Storage unavailable/,
  );
  t.setSaveFailure(false);
  t.setFail("");
  await t.managedAdd();
  expect(t.publish.mock.calls.map(([event]) => event.id)).toEqual([
    first,
    first,
  ]);
});

it("does not mistake external retry and echo removal for dismissal of a failed addition", async () => {
  const t = setup();
  await t.ready();
  t.setFail("Rejected addition");
  await expect(t.managedAdd()).rejects.toThrow(/Rejected addition/);
  const first = t.publish.mock.calls[0]?.[0].id;
  if (!first) throw new Error("Expected invitation");
  t.setFail("");
  t.setApply(false);
  t.setEcho();
  t.session.outbox?.retry(first);
  await vi.waitFor(() =>
    expect(t.session.outbox?.snapshot()[0]?.delivery).toBe("seen"),
  );
  await expect(t.session.outbox?.dismiss(first)).rejects.toThrow(/Confirm/);
  await expect(t.managedAdd()).rejects.toThrow(
    /not confirmed in the member list/,
  );
  expect(t.publish.mock.calls.map(([event]) => event.id)).toEqual([
    first,
    first,
  ]);
});

it("does not reuse an older accepted request after dismissing a rejected re-add", async () => {
  const t = setup();
  await t.ready();
  await t.managedAdd();
  const first = t.publish.mock.calls[0]?.[0].id;
  t.removePerson();
  t.setFail("Rejected re-add");
  await expect(t.managedAdd()).rejects.toThrow(/Rejected re-add/);
  const second = t.publish.mock.calls[1]?.[0].id;
  if (!second) throw new Error("Expected re-add invitation");
  await t.session.outbox?.dismiss(second);
  t.setFail("");
  await t.managedAdd();
  const third = t.publish.mock.calls[2]?.[0].id;
  expect(third).toBeDefined();
  expect(third).not.toBe(first);
  expect(third).not.toBe(second);
});

it.each([false, true])(
  "re-adds after confirmed removal across session recreation (echo: %s)",
  async (echo) => {
    const t = setup();
    await t.ready();
    if (echo) t.setEcho();
    await t.managedAdd();
    const first = t.publish.mock.calls[0]?.[0].id;
    t.removePerson();
    t.restart();
    await t.ready();
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(t.publish.mock.calls[1]?.[0].id).not.toBe(first);
  },
);
it("retains echoed unconfirmed intent across recreation until signed membership confirms it", async () => {
  const t = setup();
  await t.ready();
  t.setEcho();
  t.setApply(false);
  await expect(t.managedAdd()).rejects.toThrow(/not confirmed/);
  await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("seen"));
  t.restart();
  await t.ready();
  await expect(t.managedAdd()).rejects.toThrow(/not confirmed/);
  expect(t.publish).toHaveBeenCalledOnce();
  t.confirmPerson();
  await t.managedAdd();
  expect(t.records()[0]).toMatchObject({ acknowledged: true });
  t.removePerson();
  t.setApply(true);
  t.restart();
  await t.ready();
  await t.managedAdd();
  expect(t.publish).toHaveBeenCalledTimes(2);
});
it.each(["unknown", "accepted"])(
  "protects %s additions from dismissal and recovers the same ID after restart",
  async (delivery) => {
    const t = setup();
    await t.ready();
    t.setApply(false);
    if (delivery === "unknown") t.setFail("Receipt lost", true);
    await expect(t.managedAdd()).rejects.toThrow();
    const first = t.publish.mock.calls[0]?.[0].id;
    if (!first) throw new Error("Expected invitation");
    await expect(t.session.outbox?.dismiss(first)).rejects.toThrow(/Confirm/);
    await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe(delivery));
    t.restart();
    await t.ready();
    await expect(t.session.outbox?.dismiss(first)).rejects.toThrow(/Confirm/);
    t.setFail("");
    t.setApply(true);
    await t.managedAdd();
    expect(t.publish.mock.calls.map(([event]) => event.id)).toEqual([
      first,
      first,
    ]);
  },
);

it.each([false, true])(
  "finishes restored uncertain delivery from roster proof without resending (legacy: %s)",
  async (legacy) => {
    const t = setup();
    await t.ready();
    t.setFail("Receipt lost", true);
    await expect(t.managedAdd()).rejects.toThrow();
    await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("unknown"));
    if (legacy) t.legacy();
    t.confirmPerson();
    t.restart();
    await t.ready();
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.records()[0]).toMatchObject({
      delivery: "unknown",
      acknowledged: true,
    });
    t.removePerson();
    t.setFail("");
    t.restart();
    await t.ready();
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledTimes(2);
  },
);
it("protects a legacy echoed invitation until roster confirmation, including across restart", async () => {
  const t = setup();
  await t.ready();
  t.setEcho();
  t.setApply(false);
  await expect(t.managedAdd()).rejects.toThrow();
  await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("seen"));
  const first = t.records()[0]?.event.id;
  if (!first) throw new Error("Expected invitation");
  t.legacy();
  t.restart();
  await t.ready();
  await expect(t.managedAdd()).rejects.toThrow(/not confirmed/);
  await expect(t.session.outbox?.dismiss(first)).rejects.toThrow(/Confirm/);
  expect(t.publish).toHaveBeenCalledOnce();
  t.confirmPerson();
  await t.managedAdd();
  expect(t.records()[0]?.acknowledged).toBe(true);
  t.removePerson();
  t.setApply(true);
  t.restart();
  await t.ready();
  await t.managedAdd();
  expect(t.publish).toHaveBeenCalledTimes(2);
});
it("does not supersede an invitation when saving roster confirmation failed before restart", async () => {
  const t = setup();
  await t.ready();
  t.setEcho();
  t.setAcknowledgementFailure(true);
  await expect(t.managedAdd()).rejects.toThrow(/Storage unavailable/);
  await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("seen"));
  expect(t.records()[0]?.recovery).toBeDefined();
  expect(t.records()[0]?.acknowledged).toBeUndefined();
  t.removePerson();
  t.setAcknowledgementFailure(false);
  t.restart();
  await t.ready();
  await expect(t.managedAdd()).rejects.toThrow(/not confirmed/);
  expect(t.publish).toHaveBeenCalledOnce();
  t.confirmPerson();
  await t.managedAdd();
  expect(t.records()[0]?.acknowledged).toBe(true);
});
it("does not revive a completed receipt after failed re-add dismissal and restart", async () => {
  const t = setup();
  await t.ready();
  await t.managedAdd();
  t.removePerson();
  t.setFail("Rejected");
  await expect(t.managedAdd()).rejects.toThrow(/Rejected/);
  const second = t.publish.mock.calls[1]?.[0].id;
  if (!second) throw new Error("Expected invitation");
  await t.session.outbox?.dismiss(second);
  t.restart();
  await t.ready();
  t.setFail("");
  await t.managedAdd();
  expect(new Set(t.publish.mock.calls.map(([event]) => event.id)).size).toBe(3);
});

it("never replaces a legacy invitation after recovery adoption fails to save", async () => {
  const t = setup();
  await t.ready();
  t.setEcho();
  t.setApply(false);
  await expect(t.managedAdd()).rejects.toThrow();
  await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("seen"));
  t.legacy();
  t.restart();
  await t.ready();
  t.setSaveFailure(true);
  await expect(t.managedAdd()).rejects.toThrow(/Storage unavailable/);
  expect(t.publish).toHaveBeenCalledOnce();
  t.setSaveFailure(false);
  await expect(t.managedAdd()).rejects.toThrow(/not confirmed/);
  expect(t.publish).toHaveBeenCalledOnce();
  expect(t.records()[0]?.recovery).toBeDefined();
  t.confirmPerson();
  await t.managedAdd();
  expect(t.publish).toHaveBeenCalledOnce();
});

it("does not bypass profile eligibility when recovering a guarded invitation after restart", async () => {
  const t = setup();
  await t.ready();
  t.setFail("Receipt lost", true);
  await expect(t.managedAdd()).rejects.toThrow();
  await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("unknown"));
  const first = t.records()[0]?.event.id;
  t.guard();
  t.restart();
  await t.ready();
  t.setFail("");
  await expect(t.managedAdd()).rejects.toThrow(/agent’s profile/);
  expect(t.publish.mock.calls.map(([event]) => event.id)).toEqual([first]);
});

it.each([false, true])(
  "profile re-add skips a Members-acknowledged receipt (restart: %s)",
  async (restart) => {
    const t = setup();
    await t.ready();
    await t.setAgent();
    t.setLostReceipt(true);
    await expect(t.profileAdd()).rejects.toThrow(/Receipt lost/);
    const first = t.publish.mock.calls[0]?.[0].id;
    expect(t.session.outbox?.snapshot()[0]).toMatchObject({
      guarded: true,
      delivery: "unknown",
    });
    await t.managedAdd();
    expect(t.publish).toHaveBeenCalledOnce();
    expect(t.records()[0]).toMatchObject({
      acknowledged: true,
      delivery: "unknown",
    });
    t.removePerson();
    t.setLostReceipt(false);
    if (restart) {
      t.restart();
      await t.ready();
      await t.setAgent();
    }
    await expect(t.profileAdd(() => false)).rejects.toThrow(/cancelled/);
    expect(t.publish).toHaveBeenCalledOnce();
    await t.profileAdd();
    const second = t.publish.mock.calls[1]?.[0].id;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(t.session.channels.list().channels[0]?.members).toContain(
      t.person.pubkey,
    );
  },
);
it.each([false, true])(
  "profile retry preserves its unacknowledged invitation (restart: %s)",
  async (restart) => {
    const t = setup();
    await t.ready();
    await t.setAgent();
    t.setFail("Receipt lost", true);
    await expect(t.profileAdd()).rejects.toThrow(/Receipt lost/);
    const first = t.publish.mock.calls[0]?.[0].id;
    await vi.waitFor(() => expect(t.records()[0]?.delivery).toBe("unknown"));
    if (restart) {
      t.restart();
      await t.ready();
      await t.setAgent();
    }
    t.setFail("");
    await t.profileAdd();
    expect(t.publish.mock.calls.map(([event]) => event.id)).toEqual([
      first,
      first,
    ]);
  },
);

/** A private channel whose relay applies every `p` a kind:9000 names, or only
 * the first, as a relay without batch support does. */
function batchSetup(applyAll = true) {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const id = "33333333-3333-4333-8333-333333333333";
  let members = [viewer.pubkey];
  let clock = 1700000000;
  let records: readonly OutgoingEvent[] = [];
  const published: RelayEvent[] = [];
  let onPublish = () => {};
  let rosterReads = 0;
  let failRosterRead = 0;
  let rosterDown = false;
  const publish = vi.fn(async (event: RelayEvent) => {
    onPublish();
    const named = event.tags.flatMap(([tag, value]) =>
      tag === "p" && value ? [value] : [],
    );
    members = [...new Set([...members, ...named.slice(0, applyAll ? 100 : 1)])];
    clock++;
    published.push(event);
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      readAgentLibrary: async () => ({
        definitions: [],
        identities: [{ pubkey: agent.pubkey, name: "Agent" }],
      }),
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish: async (event) => {
          await publish(event);
        },
      },
      query: async (filters) => {
        if (filters.some((filter) => filter.kinds?.includes(39002)))
          if (++rosterReads === failRosterRead || rosterDown)
            throw new Error("Roster unavailable");
        return [
          signed(relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", id],
              ["t", "stream"],
              ["private"],
              ["join_role", "guest"],
              ["name", "Design"],
            ],
          }),
          roster(relay, id, members, clock),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  cleanups.push(() => owner.dispose());
  return {
    session: owner.session,
    id,
    agent,
    published,
    records: () => records,
    members: () => members,
    /** Runs as the relay receives each write, e.g. another owner's admission. */
    onPublish(run: () => void) {
      onPublish = run;
    },
    /** Fails the relay's nth roster read from now. */
    failRosterRead(nth: number) {
      failRosterRead = rosterReads + nth;
    },
    /** Fails every roster read until restored. */
    rosterDown(down: boolean) {
      rosterDown = down;
    },
    admit(key: string) {
      members = [...members, key];
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await vi.waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      await owner.session.agentChoices.refresh();
    },
    addAll: (keys: readonly string[]) =>
      Promise.all(
        keys.map((key) => owner.session.memberAdditions.add(id, key)),
      ),
  };
}
const people = (count: number) =>
  Array.from({ length: count }, () => keypair().pubkey);

it("adds people requested together in one write per role and 100 people", async () => {
  const t = batchSetup();
  await t.ready();
  const humans = people(101);
  await t.addAll([...humans, t.agent.pubkey]);
  expect(
    t.published.map((event) => [
      event.tags.filter(([tag]) => tag === "p").length,
      event.tags.find(([tag]) => tag === "role")?.[1],
    ]),
  ).toEqual([
    [100, "member"],
    [1, "member"],
    [1, "bot"],
  ]);
  expect(t.members()).toEqual(
    expect.arrayContaining([...humans, t.agent.pubkey]),
  );
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
  expect(t.records().filter((item) => !item.acknowledged)).toEqual([]);
});

it("adds anyone a relay without batch support missed one at a time", async () => {
  const t = batchSetup(false);
  await t.ready();
  const [first = "", second = "", third = ""] = people(3);
  await t.addAll([first, second, third]);
  expect(
    t.published.map((event) =>
      event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : [])),
    ),
  ).toEqual([[first, second, third], [second], [third]]);
  expect(t.members()).toEqual(expect.arrayContaining([first, second, third]));
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
});

it("leaves a pending single addition to resume, never batching its person again", async () => {
  const t = batchSetup();
  await t.ready();
  const [earlier = "", fresh = "", other = ""] = people(3);
  const id = t.session.outbox?.send(
    {
      kind: 9000,
      content: "",
      tags: [
        ["h", t.id],
        ["p", earlier],
        ["role", "member"],
      ],
    },
    { key: `member-add:${t.id}:${earlier}`, value: "1" },
  );
  await vi.waitFor(() => expect(t.published).toHaveLength(1));
  await t.addAll([earlier, fresh, other]);
  // The earlier write landed, so it is confirmed rather than sent again.
  expect(t.published.map((event) => event.id)).toEqual([
    id,
    expect.any(String),
  ]);
  expect(t.published[1]?.tags.filter(([tag]) => tag === "p")).toEqual([
    ["p", fresh],
    ["p", other],
  ]);
  expect(t.records().filter((item) => !item.acknowledged)).toEqual([]);
});

it("reads the roster again before a later write, so it never names someone admitted meanwhile", async () => {
  const t = batchSetup();
  await t.ready();
  const [first = "", second = ""] = people(2);
  // Another owner admits the agent, at any role, while the people's write is held.
  t.onPublish(() => {
    t.onPublish(() => {});
    t.admit(t.agent.pubkey);
  });
  await t.addAll([first, second, t.agent.pubkey]);
  expect(t.published).toHaveLength(1);
  expect(
    t.published[0]?.tags.some(([, value]) => value === t.agent.pubkey),
  ).toBe(false);
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
});

it("adds the rest one at a time when the roster can't be read again between writes", async () => {
  const t = batchSetup();
  await t.ready();
  const [first = "", second = ""] = people(2);
  // The first read precedes the people's write; the second, before the agent's, fails.
  t.failRosterRead(2);
  await t.addAll([first, second, t.agent.pubkey]);
  expect(
    t.published.map((event) =>
      event.tags.filter(([tag]) => tag === "p" || tag === "role"),
    ),
  ).toEqual([
    [
      ["p", first],
      ["p", second],
      ["role", "member"],
    ],
    [
      ["p", t.agent.pubkey],
      ["role", "bot"],
    ],
  ]);
  expect(t.members()).toContain(t.agent.pubkey);
  expect(t.session.memberAdditions.snapshot()).toEqual([]);
});

it("keeps a batch until everyone it names is in the roster or has their own addition", async () => {
  const t = batchSetup(false);
  await t.ready();
  const [first = "", second = "", third = ""] = people(3);
  // The relay adds only the first person; then no roster read succeeds, so
  // nobody else gets a receipt of their own.
  t.onPublish(() => {
    t.onPublish(() => {});
    t.rosterDown(true);
  });
  const failed = await Promise.allSettled([
    t.session.memberAdditions.add(t.id, first),
    t.session.memberAdditions.add(t.id, second),
    t.session.memberAdditions.add(t.id, third),
  ]);
  expect(failed.every((result) => result.status === "rejected")).toBe(true);
  expect(t.published).toHaveLength(1);
  // The saved batch, which a restart restores, is everyone's only record.
  const [batch] = t.records().filter((item) => !item.acknowledged);
  expect(batch?.recovery?.key).toMatch(/^member-add:batch:/);
  expect(batch?.event.id).toBe(t.published[0]?.id);
  t.rosterDown(false);
  await t.addAll([first, second, third]);
  expect(t.members()).toEqual(expect.arrayContaining([first, second, third]));
  expect(t.records().filter((item) => !item.acknowledged)).toEqual([]);
});

it("reads the roster again after a write that couldn't be sent", async () => {
  const t = batchSetup();
  await t.ready();
  const [first = "", second = ""] = people(2);
  const outbox = t.session.outbox;
  if (!outbox) throw new Error("Outbox unavailable");
  // Another owner admits the agent while the people's write fails to send.
  const send = vi.fn<typeof outbox.send>(() => {
    t.admit(t.agent.pubkey);
    throw new Error("Outbox storage is full");
  });
  const session = Object.create(t.session, {
    outbox: { value: Object.create(outbox, { send: { value: send } }) },
  }) as RelaySession;
  const added = await addChannelMembersAtOnce(
    session,
    t.id,
    [first, second, t.agent.pubkey],
    new Map(),
    new AbortController().signal,
  );
  // The roster read before the agent's write omits it, so nothing else is sent.
  expect(send).toHaveBeenCalledOnce();
  expect(added.size).toBe(0);
});

it("leaves out someone archived while the roster is read", async () => {
  const t = batchSetup();
  await t.ready();
  const [first = "", second = "", archived = ""] = people(3);
  let hidden: readonly string[] = [];
  const channelWrites = t.session.channelWrites;
  const session = Object.create(t.session, {
    archives: {
      value: { ...t.session.archives, snapshot: () => ({ archived: hidden }) },
    },
    channelWrites: {
      value: Object.create(channelWrites, {
        refreshMembership: {
          value: async (id: string) => {
            const roster = await channelWrites.refreshMembership(id);
            hidden = [archived];
            return roster;
          },
        },
      }),
    },
  }) as RelaySession;
  await addChannelMembersAtOnce(
    session,
    t.id,
    [first, second, archived],
    new Map(),
    new AbortController().signal,
  );
  expect(
    t.published.map((event) =>
      event.tags.flatMap(([tag, value]) => (tag === "p" ? [value] : [])),
    ),
  ).toEqual([[first, second]]);
});
