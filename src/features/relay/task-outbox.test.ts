import { assert, afterEach, expect, it, vi } from "vitest";
import { createOutbox, type OutgoingEvent } from "./outbox";
import type { RelayEvent } from "./events";
import { keypair, signed, roster } from "./testing";
import { taskTokenTags } from "../messages/task-tokens";
import { taskFirstEventRecovery } from "../solo/task-mode";

const owners: ReturnType<typeof createOutbox>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("persists the signed event before binding it, and binds before local hearing or publication", async () => {
  const viewer = keypair();
  let records: readonly OutgoingEvent[] = [];
  const entered = deferred(),
    release = deferred(),
    published = deferred();
  const order: string[] = [];
  let persistedAtBinding: unknown;
  let bindingEvent: unknown;
  let bindingRecovery: unknown;
  const recovery = taskFirstEventRecovery({
    draftId: "draft",
    revision: 7,
    preparationId: "fingerprint-7",
    channelId: "task",
    regionLabel: "buzz.region:nexus:tasks",
  });
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (event) => signed(viewer, event),
      publish: async () => {
        order.push("publish");
        published.resolve();
      },
    },
    {
      load: () => [],
      save: (next) => {
        records = structuredClone(next);
      },
    },
    {
      afterSigned: async (event, saved) => {
        persistedAtBinding = records.find(
          (item) => item.event.id === event.id,
        )?.signed;
        bindingEvent = event;
        bindingRecovery = saved;
        order.push("bind");
        entered.resolve();
        await release.promise;
        return undefined;
      },
      holdPublish: () => {
        order.push("hear");
        return undefined;
      },
    },
  );
  owners.push(owner);
  await owner.ready;
  owner.outbox.send(
    { kind: 9, content: "hello", tags: [["h", "task"]] },
    recovery,
  );
  await vi.waitFor(() =>
    expect(owner.outbox.snapshot()[0]).toHaveProperty("signed"),
  );
  try {
    await entered.promise;
    expect(JSON.stringify(persistedAtBinding)).toBe(
      JSON.stringify(bindingEvent),
    );
    expect(bindingRecovery).toEqual(recovery);
    expect(order).toEqual(["bind"]);
  } finally {
    release.resolve();
  }
  await published.promise;
  expect(order).toEqual(["bind", "hear", "publish"]);
});

it("keeps a refused preparation signed and retries after reload with the same content, tokens and event ID", async () => {
  const viewer = keypair();
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => records,
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const recovery = taskFirstEventRecovery({
    draftId: "draft",
    revision: 7,
    preparationId: "fingerprint-7",
    channelId: "task",
    regionLabel: "buzz.region:nexus:tasks",
  });
  const heard = vi.fn();
  const sign = vi.fn(async (event: Parameters<typeof signed>[1]) =>
    signed(viewer, event),
  );
  const first = createOutbox(
    viewer.pubkey,
    { sign, publish: vi.fn(async () => {}) },
    storage,
    {
      afterSigned: async () => {
        throw new Error("Prepared revision changed");
      },
      holdPublish: () => {
        heard();
        return undefined;
      },
    },
  );
  owners.push(first);
  await first.ready;
  const failed = deferred();
  first.outbox.subscribe(() => {
    if (first.outbox.snapshot()[0]?.delivery === "failed") failed.resolve();
  });
  const id = first.outbox.send(
    {
      kind: 9,
      content: "hello\nTask reference: ` Repository @repo `",
      tags: [
        ["h", "task"],
        ...taskTokenTags([
          {
            kind: "nexus.repository",
            id: "github.com/org/repo",
            label: "@repo",
            verified: false,
          },
        ]),
      ],
    },
    recovery,
  );
  await vi.waitFor(() =>
    expect(first.outbox.snapshot()[0]).toMatchObject({ delivery: "failed" }),
  );
  await failed.promise;
  expect(heard).not.toHaveBeenCalled();
  const saved = records[0]?.signed;
  expect(saved?.id).toBe(id);
  first.dispose();
  const done = deferred();
  const publish = vi.fn(async (_event) => {
    done.resolve();
  });
  let reboundEvent: unknown;
  let reboundRecovery: unknown;
  const second = createOutbox(viewer.pubkey, { sign, publish }, storage, {
    afterSigned: async (event, binding) => {
      reboundEvent = event;
      reboundRecovery = binding;
      return undefined;
    },
  });
  owners.push(second);
  await second.ready;
  expect(publish).not.toHaveBeenCalled();
  second.outbox.retry(id);
  await done.promise;
  expect(JSON.stringify(reboundEvent)).toBe(JSON.stringify(saved));
  expect(reboundRecovery).toEqual(recovery);
  expect(JSON.stringify(publish.mock.calls[0]?.[0])).toBe(
    JSON.stringify(saved),
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("restores the guarded create and first message with fresh policy and their original signed bytes", async () => {
  const { createRelaySession } = await import("./session");
  const { createSoloRegionFixture } = await import(
    "../channel-navigation/solo-navigation-testing"
  );
  const soloNavigation = await import("../channel-navigation/solo-navigation");
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const region = createSoloRegionFixture(viewer.pubkey);
  let eligible = true;
  const recordFirstEvent = vi.fn(async () => {});
  const source = await region.register({
    task: {
      prepare: async () => ({ ok: false, reason: "Unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent,
      participants: {
        eligible: (key) => eligible && key === agent.pubkey,
        defaultRecipient: () => agent.pubkey,
        makePrimary: async () => {},
      },
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  const channelId = "22222222-2222-4222-8222-222222222222";
  let records: readonly OutgoingEvent[] = [];
  const storage = {
    load: () => structuredClone(records),
    save: (next: readonly OutgoingEvent[]) => {
      records = structuredClone(next);
    },
  };
  const blocked = deferred();
  const sign = vi.fn(async (event: Parameters<typeof signed>[1]) =>
    signed(viewer, event),
  );
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    channelIdentity: true as const,
    media: () => undefined,
    query: async (filters: readonly { kinds?: readonly number[] }[]) =>
      filters.some((filter) => filter.kinds?.includes(39002))
        ? [roster(relay, channelId, [viewer.pubkey, agent.pubkey])]
        : [],
    writer: {
      kinds: [9, 9007],
      sign,
      publish: vi.fn(async () => {
        await blocked.promise;
      }),
    },
  };
  const first = createRelaySession(transport, { outboxStorage: storage });
  let second: ReturnType<typeof createRelaySession> | undefined;
  try {
    assert.exists(first.session.outbox);
    await first.session.outbox.ready();
    const start = first.session.channelWrites.start(
      channelId,
      "Original task",
      [agent.pubkey],
      undefined,
      false,
      undefined,
      {
        labels: [source.handle.label, "solo-task-mode:v1"],
        active: () => eligible,
      },
    );
    void start.ready.catch(() => {});
    const messageId = first.session.messages.send(
      channelId,
      "Original message",
      [agent.pubkey],
      [],
      taskFirstEventRecovery({
        draftId: "draft",
        revision: 1,
        preparationId: "frozen-1",
        channelId,
        regionLabel: source.handle.label,
      }),
    );
    await vi.waitFor(() =>
      expect(records.filter((item) => item.signed)).toHaveLength(2),
    );
    const saved = structuredClone(records);
    first.dispose();
    const createEntered = deferred(),
      allowCreate = deferred(),
      messagePublished = deferred();
    const publish = vi.fn(async (event: RelayEvent) => {
      if (event.kind === 9007) {
        createEntered.resolve();
        await allowCreate.promise;
      } else messagePublished.resolve();
    });
    second = createRelaySession(
      { ...transport, writer: { ...transport.writer, publish } },
      { outboxStorage: storage },
    );
    const restored = second.session;
    const outbox = restored.outbox;
    assert.exists(outbox);
    await outbox.ready();
    expect(() => outbox.retry(start.create)).toThrow(/cancelled/);
    eligible = false;
    expect(() =>
      restored.channelWrites.resumeStart(
        start.create,
        channelId,
        viewer.pubkey,
        () => eligible,
      ),
    ).toThrow(/cancelled/);
    expect(publish).not.toHaveBeenCalled();
    expect(
      restored.channels.list().channels.find((item) => item.id === channelId),
    ).toBeUndefined();
    eligible = true;
    const resumed = restored.channelWrites.resumeStart(
      start.create,
      channelId,
      viewer.pubkey,
      () => eligible,
    );
    outbox.retry(messageId, () => eligible);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    await createEntered.promise;
    expect(recordFirstEvent).not.toHaveBeenCalled();
    expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([9007]);
    allowCreate.resolve();
    await resumed.ready;
    await vi.waitFor(() => expect(recordFirstEvent).toHaveBeenCalledTimes(1));
    // The create's roster refresh can invalidate the simultaneous mention
    // preflight. That safe refusal is retried deliberately with the same event.
    await vi.waitFor(() => {
      const error = outbox
        .snapshot()
        .find((item) => item.event.id === messageId)?.error;
      expect(publish.mock.calls.length === 2 || !!error).toBe(true);
    });
    const error = outbox
      .snapshot()
      .find((item) => item.event.id === messageId)?.error;
    if (error) {
      expect(error).toMatch(/membership changed/);
      outbox.retry(messageId, () => eligible);
    }
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
    await messagePublished.promise;
    expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([9007, 9]);
    for (const [event] of publish.mock.calls) {
      expect(JSON.stringify(event)).toBe(
        JSON.stringify(
          saved.find((item) => item.event.id === event.id)?.signed,
        ),
      );
    }
    expect(sign).toHaveBeenCalledTimes(2);
    // A confirmed create can be reopened without dispatching it again.
    restored.channelWrites.resumeStart(
      start.create,
      channelId,
      viewer.pubkey,
      () => eligible,
    );
    expect(publish).toHaveBeenCalledTimes(2);
  } finally {
    first.dispose();
    second?.dispose();
    blocked.resolve();
    lookup.mockRestore();
    await region.dispose();
  }
});

it("whenPrepared ends after durable binding and synchronous policy, without waiting for relay ACK", async () => {
  const viewer = keypair(),
    bound = deferred(),
    releaseBinding = deferred(),
    ack = deferred();
  let durable: readonly OutgoingEvent[] = [];
  const owner = createOutbox(
    viewer.pubkey,
    {
      sign: async (event) => signed(viewer, event),
      publish: async () => ack.promise,
    },
    {
      load: () => [],
      save: (next) => {
        durable = structuredClone(next);
      },
    },
    {
      afterSigned: async (event) => {
        expect(
          JSON.stringify(
            durable.find((item) => item.event.id === event.id)?.signed,
          ),
        ).toBe(JSON.stringify(event));
        bound.resolve();
        await releaseBinding.promise;
        return () => {};
      },
    },
  );
  owners.push(owner);
  await owner.ready;
  const id = owner.outbox.send({
    kind: 9,
    content: "task",
    tags: [["h", "task"]],
  });
  let finished = false;
  const prepared = owner.outbox.whenPrepared(id).then((event) => {
    finished = true;
    return event;
  });
  await bound.promise;
  expect(finished).toBe(false);
  releaseBinding.resolve();
  expect((await prepared).id).toBe(id);
  expect(owner.outbox.snapshot()[0]?.delivery).toBe("sending");
  ack.resolve();
});

it.each(["sign", "persist", "hook", "policy", "dispose"])(
  "whenPrepared rejects %s failure and retains the saved operation",
  async (failure) => {
    const viewer = keypair(),
      entered = deferred(),
      held = deferred();
    const owner = createOutbox(
      viewer.pubkey,
      {
        sign: async (event) => {
          if (failure === "sign") throw new Error("sign failed");
          if (failure === "dispose") {
            entered.resolve();
            await held.promise;
          }
          return signed(viewer, event);
        },
        publish: async () => {},
      },
      {
        load: () => [],
        save: (next) => {
          if (failure === "persist" && next.some((item) => item.signed))
            throw new Error("persist failed");
        },
      },
      {
        afterSigned: async () => {
          if (failure === "hook") throw new Error("hook failed");
          return () => {
            if (failure === "policy") throw new Error("policy failed");
          };
        },
      },
    );
    owners.push(owner);
    await owner.ready;
    const id = owner.outbox.send({
      kind: 9,
      content: "task",
      tags: [["h", "task"]],
    });
    const prepared = expect(owner.outbox.whenPrepared(id)).rejects.toThrow();
    if (failure === "dispose") {
      await entered.promise;
      owner.dispose();
      held.resolve();
    }
    await prepared;
    expect(owner.outbox.snapshot().some((item) => item.event.id === id)).toBe(
      true,
    );
  },
);

it("a verified echo settles a queued whenPrepared wait without claiming local binding", async () => {
  const viewer = keypair(),
    release = deferred();
  const saved = signed(viewer, {
    kind: 9,
    content: "queued",
    tags: [["h", "task"]],
  });
  const publish = vi.fn(async () => release.promise);
  const afterSigned = vi.fn(async () => undefined);
  const owner = createOutbox(
    viewer.pubkey,
    { sign: async (event) => signed(viewer, event), publish },
    {
      load: () => [
        {
          event: saved,
          delivery: "unknown",
          recovery: taskFirstEventRecovery({
            draftId: "queued-draft",
            revision: 1,
            preparationId: "frozen",
            channelId: "task",
            regionLabel: "buzz.region:example:work",
          }),
        },
      ],
      save: () => {},
    },
    { afterSigned },
  );
  owners.push(owner);
  await owner.ready;
  for (let i = 0; i < 3; i++)
    owner.outbox.send({
      kind: 9,
      content: `occupied ${i}`,
      tags: [["h", "task"]],
    });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(3));
  const id = saved.id;
  owner.outbox.retry(id);
  const prepared = expect(owner.outbox.whenPrepared(id)).rejects.toThrow(
    /reload to verify/,
  );
  const queued = owner.outbox.snapshot().find((item) => item.event.id === id);
  assert.exists(queued);
  expect(queued.signed).toBeUndefined();
  owner.observe([signed(viewer, queued.event)]);
  await prepared;
  expect(afterSigned).toHaveBeenCalledTimes(3);
  release.resolve();
});
