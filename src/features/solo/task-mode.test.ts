import { afterEach, expect, it, vi } from "vitest";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import { keypair, signed } from "../relay/testing";
import { createOutbox, type OutgoingEvent } from "../relay/outbox";
import * as soloNavigation from "../channel-navigation/solo-navigation";
import {
  recordTaskFirstEvent,
  taskFirstEventRecovery,
  validateTaskMembers,
  validateTaskPublication,
  TASK_MODE_LABEL,
} from "./task-mode";
import { taskTokenTags } from "../messages/task-tokens";
import { eventDto } from "../relay/events";
import type { SoloTaskMode } from "../channel-navigation/solo-navigation-contract";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(
  allowHistorical = false,
  isInformational?: SoloTaskMode["isInformational"],
) {
  const viewer = keypair();
  const h = createSoloRegionFixture(viewer.pubkey);
  cleanups.push(h.dispose);
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const eligible = new Set([a, b]);
  const historical = new Set([a, b]);
  const isParticipant = vi.fn(
    (channelId: string, key: string) =>
      channelId === "task" && historical.has(key),
  );
  const recordFirstEvent = vi.fn(async (input: { preparationId: string }) => {
    if (input.preparationId !== "prepared:7")
      throw new Error("Prepared revision changed");
  });
  const source = await h.register({
    task: {
      ...(isInformational ? { isInformational } : {}),
      prepare: async () => ({ ok: false, reason: "unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent,
      participants: {
        eligible: (key) => eligible.has(key),
        ...(allowHistorical ? { isParticipant } : {}),
        defaultRecipient: () => a,
        makePrimary: async () => {},
        maxRecipients: 1,
      },
    },
  });
  const channel = {
    id: "task",
    name: "Task",
    channelType: "solo" as const,
    creator: viewer.pubkey,
    members: [viewer.pubkey, a, b],
    labels: ["buzz.solo", source.handle.label, TASK_MODE_LABEL],
  };
  h.roster([channel]);
  const event = (recipients = [a], tags: string[][] = []) =>
    signed(viewer, {
      kind: 9,
      content: "Do work",
      tags: [
        ["h", channel.id],
        ...recipients.map((key) => ["p", key]),
        ...tags,
      ],
    });
  return {
    ...h,
    viewer,
    source,
    eligible,
    isParticipant,
    recordFirstEvent,
    a,
    b,
    channel,
    event,
  };
}

it("fails closed after disposal or a missing owning region while preserving legacy region chats", async () => {
  const f = await fixture();
  expect(validateTaskPublication(f.session, f.event())?.region).toBe("work");
  await f.source.fiber.dispose();
  expect(() => validateTaskPublication(f.session, f.event())).toThrow(
    "Nexus is unavailable",
  );
  f.roster([{ ...f.channel, labels: ["buzz.solo", TASK_MODE_LABEL] }]);
  expect(() => validateTaskPublication(f.session, f.event())).toThrow(
    "Nexus is unavailable",
  );
  f.roster([{ ...f.channel, labels: ["buzz.solo", f.source.handle.label] }]);
  expect(validateTaskPublication(f.session, f.event())).toBeUndefined();
});

it("checks the whole membership and exact explicit target before local delivery", async () => {
  const f = await fixture();
  f.eligible.delete(f.b);
  expect(() => validateTaskPublication(f.session, f.event([f.a]))).toThrow(
    "participant",
  );
  f.roster([{ ...f.channel, members: [f.viewer.pubkey, f.a] }]);
  expect(() => validateTaskPublication(f.session, f.event([f.b]))).toThrow(
    "selected task agent",
  );
  f.eligible.add(f.b);
  expect(() => validateTaskPublication(f.session, f.event([f.a, f.b]))).toThrow(
    "Tag one agent",
  );
});

it("retains confirmed historical members without authorizing revoked recipients or additions", async () => {
  const f = await fixture(true);
  f.eligible.delete(f.a);
  expect(validateTaskPublication(f.session, f.event([f.b]))?.region).toBe(
    "work",
  );
  expect(() => validateTaskPublication(f.session, f.event([f.a]))).toThrow(
    "selected task agent",
  );
  for (const key of [f.a, f.viewer.pubkey, "c".repeat(64)]) {
    expect(() =>
      validateTaskPublication(f.session, {
        ...f.event(),
        kind: 9000,
        tags: [
          ["h", "task"],
          ["p", key],
        ],
      }),
    ).toThrow("participant");
  }
});

it("refuses unknown roster keys, mismatched channel evidence and unreadable historical policy", async () => {
  const f = await fixture(true);
  for (const key of ["c".repeat(64), "d".repeat(64)]) {
    f.roster([{ ...f.channel, members: [...f.channel.members, key] }]);
    expect(() => validateTaskMembers(f.session, "task")).toThrow("participant");
  }
  f.eligible.delete(f.a);
  f.roster([{ ...f.channel, id: "other" }]);
  expect(() => validateTaskMembers(f.session, "other")).toThrow("participant");
  f.roster([f.channel]);
  f.isParticipant.mockReturnValue("yes" as unknown as boolean);
  expect(() => validateTaskMembers(f.session, "task")).toThrow("participant");
  f.isParticipant.mockImplementation(() => {
    throw new Error("Historical policy unavailable");
  });
  expect(() => validateTaskMembers(f.session, "task")).toThrow(
    "Historical policy unavailable",
  );
});

it("binds the exact preparation identity and revision before exposing the first event", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const input = {
    draftId: "draft",
    revision: 7,
    preparationId: "prepared:7",
    channelId: "task",
    regionLabel: f.source.handle.label,
  };
  const event = f.event();
  const beforeLocal = await recordTaskFirstEvent(
    f.session,
    event,
    taskFirstEventRecovery(input),
    signal,
  );
  expect(f.recordFirstEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      preparationId: "prepared:7",
      revision: 7,
      eventId: event.id,
      binding: f.source.binding(),
    }),
    expect.any(AbortSignal),
  );
  await expect(
    recordTaskFirstEvent(
      f.session,
      event,
      taskFirstEventRecovery({ ...input, preparationId: "prepared:old" }),
      signal,
    ),
  ).rejects.toThrow("Prepared revision changed");
  await expect(
    recordTaskFirstEvent(
      f.session,
      event,
      taskFirstEventRecovery({ ...input, channelId: "other" }),
      signal,
    ),
  ).rejects.toThrow("does not match");
  f.eligible.delete(f.a);
  expect(() => beforeLocal()).toThrow("participant");
});

it("refuses a skill after a recipient switch and never executes future token versions", async () => {
  const f = await fixture();
  const tokens = taskTokenTags([
    {
      kind: "nexus.skill",
      id: JSON.stringify({ path: "/task/repo/SKILL.md" }),
      label: "/Review",
      target: f.a,
    },
  ]);
  expect(
    validateTaskPublication(f.session, f.event([f.a], tokens)),
  ).toBeDefined();
  expect(() =>
    validateTaskPublication(f.session, f.event([f.b], tokens)),
  ).toThrow("another agent");
  expect(
    validateTaskPublication(
      f.session,
      f.event([f.b], [["nexus.tokens.v2", "future"]]),
    ),
  ).toBeDefined();
});

it("applies task policy to every signed member addition, including a direct outbox retry", async () => {
  const f = await fixture();
  const addition = signed(f.viewer, {
    kind: 9000,
    content: "",
    tags: [
      ["h", f.channel.id],
      ["p", f.b],
    ],
  });
  expect(validateTaskPublication(f.session, addition)?.region).toBe("work");
  f.eligible.delete(f.b);
  expect(() => validateTaskPublication(f.session, addition)).toThrow(
    "participant",
  );
  await f.source.fiber.dispose();
  expect(() => validateTaskPublication(f.session, addition)).toThrow(
    "Nexus is unavailable",
  );
});

it.each(["ready", "cancel", "abort", "revoked", "ordinary"] as const)(
  "checks creation readiness at the durable binding boundary (%s)",
  async (outcome) => {
    const f = await fixture();
    let resolve = () => {},
      reject = (_error: Error) => {};
    const ready = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const starting = vi.fn(() => ready);
    const session = {
      ...f.session,
      channelWrites: { ...f.session.channelWrites, starting },
    };
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(f.service);
    cleanups.push(() => lookup.mockRestore());
    const controller = new AbortController();
    const recovery = taskFirstEventRecovery({
      draftId: "draft",
      revision: 7,
      preparationId: "prepared:7",
      channelId: "task",
      regionLabel: f.source.handle.label,
    });
    const pending = recordTaskFirstEvent(
      session,
      f.event(),
      outcome === "ordinary" ? undefined : recovery,
      controller.signal,
    );
    try {
      if (outcome === "ordinary") {
        await pending;
        expect(starting).not.toHaveBeenCalled();
        expect(f.recordFirstEvent).not.toHaveBeenCalled();
        return;
      }
      expect(starting).toHaveBeenCalledWith("task");
      expect(f.recordFirstEvent).not.toHaveBeenCalled();
      if (outcome === "cancel") {
        const failed = expect(pending).rejects.toThrow("Create cancelled");
        reject(new Error("Create cancelled"));
        await failed;
      } else if (outcome === "abort") {
        const failed = expect(pending).rejects.toThrow("Binding ended");
        controller.abort(new Error("Binding ended"));
        await failed;
        resolve();
        await ready;
      } else {
        if (outcome === "revoked") f.eligible.delete(f.a);
        const completed =
          outcome === "revoked"
            ? expect(pending).rejects.toThrow("participant")
            : pending;
        resolve();
        await completed;
      }
      expect(f.recordFirstEvent).toHaveBeenCalledTimes(
        outcome === "ready" ? 1 : 0,
      );
    } finally {
      resolve();
    }
  },
);

it.each(["cancel", "timeout", "rebind"] as const)(
  "retains and retries the same signed first message after a creation wait %s",
  async (outcome) => {
    const f = await fixture();
    let resolve = () => {},
      reject = (_error: Error) => {},
      entered = () => {},
      published = () => {};
    const ready = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    const delivery = new Promise<void>((done) => {
      published = done;
    });
    let barrier: Promise<void> | undefined = ready;
    let records: readonly OutgoingEvent[] = [];
    const session = {
      ...f.session,
      channelWrites: { ...f.session.channelWrites, starting: () => barrier },
    };
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(f.service);
    cleanups.push(() => lookup.mockRestore());
    const recovery = taskFirstEventRecovery({
      draftId: "draft",
      revision: 7,
      preparationId: "prepared:7",
      channelId: "task",
      regionLabel: f.source.handle.label,
    });
    const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(f.viewer, template),
    );
    const publish = vi.fn(async (_event: ReturnType<typeof signed>) => {
      published();
    });
    vi.useFakeTimers();
    const owner = createOutbox(
      f.viewer.pubkey,
      { sign, publish },
      {
        load: () => [],
        save: (next) => {
          records = structuredClone(next);
        },
      },
      {
        afterSigned: (event, saved, signal) => {
          entered();
          return recordTaskFirstEvent(session, event, saved, signal);
        },
      },
    );
    try {
      await owner.ready;
      const event = f.event();
      const id = owner.outbox.send(
        { kind: 9, content: event.content, tags: event.tags },
        recovery,
      );
      const failure = expect(owner.outbox.whenPrepared(id)).rejects.toThrow();
      await waiting;
      const original = records.find((item) => item.event.id === id)?.signed;
      expect(original).toBeDefined();
      expect(f.recordFirstEvent).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      if (outcome === "cancel") reject(new Error("Create cancelled"));
      else if (outcome === "timeout") await vi.advanceTimersByTimeAsync(10_000);
      else f.reconnect();
      await failure;
      expect(
        owner.outbox.snapshot().find((item) => item.event.id === id),
      ).toMatchObject({
        delivery: "failed",
        signed: original,
        recovery,
        ...(outcome === "timeout"
          ? { error: "Delivery timed out; check or retry this message" }
          : {}),
      });
      resolve();
      if (outcome !== "cancel") await ready;
      barrier = Promise.resolve();
      owner.outbox.retry(id);
      await owner.outbox.whenPrepared(id);
      await delivery;
      expect(f.recordFirstEvent).toHaveBeenCalledTimes(1);
      expect(sign).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(publish.mock.calls[0]?.[0])).toBe(
        JSON.stringify(original),
      );
    } finally {
      resolve();
      owner.dispose();
      vi.useRealTimers();
    }
  },
);

function information(
  f: Awaited<ReturnType<typeof fixture>>,
  tags: string[][] = [],
) {
  return eventDto(
    signed(f.viewer, {
      kind: 9,
      content: "Committed source information",
      tags: [
        ["h", f.channel.id],
        ["example.information", "committed"],
        ...tags,
      ],
    }),
  );
}

it("admits verified owner information through only the current source policy", async () => {
  const policy = vi.fn(() => true);
  const f = await fixture(false, policy);
  const event = information(f);
  expect(validateTaskPublication(f.session, event)?.region).toBe("work");
  expect(policy).toHaveBeenCalledExactlyOnceWith(f.channel.id, event);
  expect(Object.isFrozen(event)).toBe(true);
  expect(Object.isFrozen(event.tags)).toBe(true);
  expect(Object.isFrozen(event.tags[0])).toBe(true);
});

it.each(["recipient", "tokens"] as const)(
  "refuses recognized information carrying %s even if ordinary admission would allow it",
  async (extra) => {
    const f = await fixture(false, () => true);
    const tags =
      extra === "recipient"
        ? [["p", f.a]]
        : taskTokenTags([
            {
              kind: "nexus.repository",
              id: "github.com/org/repo",
              label: "repo",
              verified: false,
            },
          ]);
    expect(() =>
      validateTaskPublication(f.session, information(f, tags)),
    ).toThrow("Informational task notices");
  },
);

it.each(["absent", "false", "throw"] as const)(
  "keeps recipient-free publication closed when the source policy is %s",
  async (outcome) => {
    const f = await fixture(
      false,
      outcome === "absent"
        ? undefined
        : () => {
            if (outcome === "throw")
              throw new Error("Source policy unavailable");
            return false;
          },
    );
    expect(() => validateTaskPublication(f.session, information(f))).toThrow(
      outcome === "throw" ? "Source policy unavailable" : "selected task agent",
    );
  },
);

it.each(["unproved", "other author", "duplicate destination"] as const)(
  "does not grant informational admission to an event with %s",
  async (outcome) => {
    const policy = vi.fn(() => true);
    const f = await fixture(false, policy);
    const template = {
      kind: 9,
      content: "Committed source information",
      tags: [
        ["h", f.channel.id],
        ...(outcome === "duplicate destination" ? [["h", "other"]] : []),
      ],
    };
    const raw = signed(
      outcome === "other author" ? keypair() : f.viewer,
      template,
    );
    const event = outcome === "unproved" ? raw : eventDto(raw);
    expect(() => validateTaskPublication(f.session, event)).toThrow(
      "selected task agent",
    );
    expect(policy).not.toHaveBeenCalled();
  },
);

it("keeps malformed task-token and live task-member guards ahead of informational policy", async () => {
  const policy = vi.fn(() => true);
  const f = await fixture(false, policy);
  expect(() =>
    validateTaskPublication(
      f.session,
      information(f, [["nexus.tokens.v1", "invalid"]]),
    ),
  ).toThrow("invalid task tokens");
  f.eligible.delete(f.b);
  expect(() => validateTaskPublication(f.session, information(f))).toThrow(
    "participant",
  );
  expect(policy).not.toHaveBeenCalled();
});

it("never binds an informational notice as the first task event", async () => {
  const f = await fixture(false, () => true);
  await expect(
    recordTaskFirstEvent(
      f.session,
      information(f),
      taskFirstEventRecovery({
        draftId: "draft",
        revision: 7,
        preparationId: "prepared:7",
        channelId: f.channel.id,
        regionLabel: f.source.handle.label,
      }),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Informational task notices");
  expect(f.recordFirstEvent).not.toHaveBeenCalled();
});

it.each(["policy changed", "disposed", "member revoked", "rebound"] as const)(
  "rechecks an informational notice before publication after %s",
  async (change) => {
    let allowed = true;
    const f = await fixture(false, () => allowed);
    const revalidate = await recordTaskFirstEvent(
      f.session,
      information(f),
      undefined,
      new AbortController().signal,
    );
    if (change === "disposed" || change === "rebound")
      await f.source.fiber.dispose();
    if (change === "rebound")
      await f.register({
        task: {
          prepare: async () => ({ ok: false, reason: "unused" }),
          markChannelStarted: async () => "start",
          recordFirstEvent: async () => {},
          isInformational: () => false,
          participants: {
            eligible: (key) => f.eligible.has(key),
            defaultRecipient: () => f.a,
            makePrimary: async () => {},
            maxRecipients: 1,
          },
        },
      });
    if (change === "member revoked") f.eligible.delete(f.b);
    if (change === "policy changed") allowed = false;
    expect(() => revalidate()).toThrow(
      change === "disposed"
        ? "Nexus is unavailable"
        : change === "member revoked"
          ? "participant"
          : "selected task agent",
    );
  },
);

it("keeps an ordinary addressed owner message when the source predicate returns false", async () => {
  const policy = vi.fn(() => false);
  const f = await fixture(false, policy);
  expect(validateTaskPublication(f.session, eventDto(f.event()))?.region).toBe(
    "work",
  );
  expect(policy).toHaveBeenCalledOnce();
});

it("refuses a proof-bearing addressed owner message classified as information", async () => {
  const f = await fixture(false, () => true);
  expect(() => validateTaskPublication(f.session, eventDto(f.event()))).toThrow(
    "Informational task notices",
  );
});

it("does not trust a copied proof-bearing event", async () => {
  const policy = vi.fn(() => true);
  const f = await fixture(false, policy);
  expect(() =>
    validateTaskPublication(f.session, structuredClone(information(f))),
  ).toThrow("selected task agent");
  expect(policy).not.toHaveBeenCalled();
});

it("does not classify a three-field destination", async () => {
  const policy = vi.fn(() => true);
  const f = await fixture(false, policy);
  const event = eventDto(
    signed(f.viewer, {
      kind: 9,
      content: "Information",
      tags: [["h", f.channel.id, "extra"]],
    }),
  );
  expect(() => validateTaskPublication(f.session, event)).toThrow(
    "selected task agent",
  );
  expect(policy).not.toHaveBeenCalled();
});

it.each(["channel metadata", "ordinary channel"] as const)(
  "keeps %s outside informational policy",
  async (outcome) => {
    const policy = vi.fn(() => true);
    const f = await fixture(false, policy);
    if (outcome === "ordinary channel")
      f.roster([
        { ...f.channel, labels: ["buzz.solo", f.source.handle.label] },
      ]);
    const event = eventDto(
      signed(f.viewer, {
        kind: outcome === "channel metadata" ? 9000 : 9,
        content: "Information",
        tags: [["h", f.channel.id]],
      }),
    );
    expect(() => validateTaskPublication(f.session, event)).not.toThrow();
    expect(policy).not.toHaveBeenCalled();
  },
);

it("keeps unsigned saved draft validation on the ordinary path", async () => {
  const policy = vi.fn(() => true);
  const f = await fixture(false, policy);
  const saved = f.event();
  expect(
    validateTaskPublication(f.session, {
      id: saved.id,
      pubkey: saved.pubkey,
      created_at: saved.created_at,
      kind: saved.kind,
      content: saved.content,
      tags: saved.tags,
    })?.region,
  ).toBe("work");
  expect(policy).not.toHaveBeenCalled();
});
