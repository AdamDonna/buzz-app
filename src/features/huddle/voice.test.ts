import { afterEach, expect, it, vi } from "vitest";
import type {
  Agent,
  Agents,
  AgentVoicePipe,
  RegisteredAgentType,
} from "../agents/service";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { HuddleSnapshot } from "./service";
import type { HuddleBridge, HuddleUpdate } from "./bridge";
import { createHuddleVoices } from "./voice";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const origin = "https://relay.example.com";
const agent = (pubkey: string): Agent => ({
  key: pubkey,
  pubkey,
  name: pubkey,
  owner: "owner",
  relay: origin,
  type: "test/voice",
  place: "here",
  config: {},
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
});
function observable() {
  const listeners = new Set<() => void>();
  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    notify() {
      for (const fn of [...listeners]) fn();
    },
  };
}
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
});
function setup() {
  const h = observable(),
    a = observable(),
    r = observable(),
    m = observable();
  let call: HuddleSnapshot = {
    phase: "connected",
    id: "human",
    room: "room",
    muted: false,
    participants: ["owner", "stranger"],
    destination: {
      viewer: "owner",
      scope: "scope",
      relayUrl: origin,
      channelId: "parent",
      channelName: "Parent",
    },
  };
  let room: ChannelSummary = {
    id: "room",
    name: "Room",
    members: ["owner", "a", "b"],
  };
  let running = [agent("a"), agent("b")];
  const connections = new Map<
    string,
    { input: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  >();
  const seatArgs = new Map<string, AgentVoicePipe>();
  const voice = vi.fn(async (seat: AgentVoicePipe) => {
    seatArgs.set(seat.agent.pubkey, seat);
    const connection = { input: vi.fn(), close: vi.fn() };
    connections.set(seat.agent.pubkey, connection);
    return connection;
  });
  let types = [
    { key: "test/voice", voice },
  ] as unknown as RegisteredAgentType[];
  const callbacks = new Map<string, (event: HuddleUpdate) => void>();
  const bridge = {
    available: true,
    open: vi.fn<HuddleBridge["open"]>(
      async (_id, _destination, _room, receive, key) => {
        callbacks.set(required(key), receive);
      },
    ),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  let snapshot = {
    status: "ready",
    scope: "scope",
    viewer: "owner",
    session: {
      channels: {
        get: (id: string) =>
          id === "room" ? room : { id: "parent", members: ["a", "b", "owner"] },
        subscribeList: m.subscribe,
        resolve: async () => {},
      },
    },
  } as unknown as RelaySnapshot;
  const relay = {
    snapshot: () => snapshot,
    subscribe: r.subscribe,
  } as RelayData;
  const agents = {
    snapshot: () => ({ status: "ready", running }),
    subscribe: a.subscribe,
    types: () => types,
  } as unknown as Agents;
  const report = vi.fn();
  const listening = vi.fn();
  const start = () => {
    const dispose = createHuddleVoices(
      {
        snapshot: () => call,
        subscribe: h.subscribe,
        voiceListening: listening,
      },
      agents,
      relay,
      bridge,
      report,
    );
    disposals.push(dispose);
    return dispose;
  };
  return {
    bridge,
    voice,
    connections,
    seatArgs,
    callbacks,
    report,
    listening,
    start,
    call: (patch: Partial<HuddleSnapshot>) => {
      call = { ...call, ...patch };
      h.notify();
    },
    room: (patch: Partial<ChannelSummary>) => {
      room = { ...room, ...patch };
      m.notify();
    },
    agents: (next: Agent[]) => {
      running = next;
      a.notify();
    },
    types: () => {
      types = [];
      a.notify();
    },
    relay: (patch: Partial<RelaySnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      r.notify();
    },
  };
}
it("seats two room members independently and drops non-owner audio", async () => {
  const f = setup();
  f.start();
  await vi.waitFor(() => expect(f.connections.size).toBe(2));
  const samples = Array(960).fill(0.1);
  required(f.callbacks.get("a"))({ type: "audio", peer: "stranger", samples });
  required(f.callbacks.get("a"))({ type: "audio", peer: "b", samples });
  expect(required(f.connections.get("a")).input).not.toHaveBeenCalled();
  required(f.callbacks.get("a"))({ type: "audio", peer: "owner", samples });
  expect(required(f.connections.get("a")).input).toHaveBeenCalledWith(samples);
  expect(required(f.connections.get("b")).input).not.toHaveBeenCalled();
  await required(f.seatArgs.get("a")).output(samples);
  expect(f.bridge.send).toHaveBeenCalledWith(
    required(f.bridge.open.mock.calls[0])[0],
    samples,
  );
  f.room({ members: ["owner", "b"] });
  expect(required(f.seatArgs.get("a")).signal.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(required(f.connections.get("a")).close).toHaveBeenCalledOnce(),
  );
  expect(required(f.connections.get("b")).close).not.toHaveBeenCalled();
});
it.each([
  { members: ["owner"] },
  { members: [] },
  { cached: true as const },
  { pending: true as const },
  { archived: true as const },
  { readOnly: true as const },
])(
  "refuses parent-only, unknown, cached or inaccessible room membership: %j",
  async (patch) => {
    const f = setup();
    f.room(patch);
    const dispose = f.start();
    // Drain the scheduled native-open microtask before checking refusal.
    await Promise.resolve();
    expect(f.bridge.open).not.toHaveBeenCalled();
    await dispose();
    expect(f.bridge.open).not.toHaveBeenCalled();
    expect(f.voice).not.toHaveBeenCalled();
  },
);
it("keeps its opening config across snapshots but closes on protection revision", async () => {
  const f = setup();
  f.start();
  await vi.waitFor(() => expect(f.connections.size).toBe(2));
  const seated = required(f.seatArgs.get("a"));
  f.agents([agent("a"), agent("b")]);
  expect(seated.signal.aborted).toBe(false);
  await Promise.resolve();
  expect(f.bridge.open).toHaveBeenCalledTimes(2);
  f.agents([
    { ...agent("a"), config: { instructions: "changed" } },
    agent("b"),
  ]);
  expect(seated.signal.aborted).toBe(false);
  expect(seated.agent.config).toEqual({});
  f.agents([{ ...agent("a"), protectionRevision: 1 }, agent("b")]);
  expect(seated.signal.aborted).toBe(true);
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledTimes(3));
  expect(required(f.seatArgs.get("b")).signal.aborted).toBe(false);
});
it.each(["owner", "type", "relay", "agent"])(
  "closes seats on %s loss, and ignores late audio and errors",
  async (loss) => {
    const f = setup();
    f.start();
    await vi.waitFor(() => expect(f.connections.size).toBe(2));
    if (loss === "owner") f.call({ phase: "leaving", participants: [] });
    if (loss === "type") f.types();
    if (loss === "relay") f.relay({ status: "disconnected" });
    if (loss === "agent") f.agents([]);
    expect(required(f.seatArgs.get("a")).signal.aborted).toBe(true);
    required(f.callbacks.get("a"))({
      type: "audio",
      peer: "owner",
      samples: Array(960).fill(0),
    });
    await required(f.seatArgs.get("a")).output(Array(960).fill(0));
    required(f.seatArgs.get("a")).ended(new Error("late failure"));
    await vi.waitFor(() => expect(f.bridge.close).toHaveBeenCalledTimes(2));
    expect(f.bridge.send).not.toHaveBeenCalled();
    expect(required(f.connections.get("a")).input).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  },
);
it("closes a native open that finishes after leave without starting the harness", async () => {
  const f = setup();
  f.agents([agent("a")]);
  const gate = deferred<void>();
  f.bridge.open.mockImplementationOnce(() => gate.promise);
  f.start();
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledOnce());
  f.call({ phase: "idle" });
  gate.resolve();
  await vi.waitFor(() => expect(f.bridge.close).toHaveBeenCalledOnce());
  expect(f.voice).not.toHaveBeenCalled();
});
it("closes a late harness and waits for it before reseating", async () => {
  const f = setup();
  f.agents([agent("a")]);
  const connection = { input: vi.fn(), close: vi.fn() };
  const gate = deferred<typeof connection>();
  f.voice.mockImplementationOnce(() => gate.promise);
  f.start();
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
  f.call({ id: "next-human" });
  await vi.waitFor(() => expect(f.bridge.close).toHaveBeenCalledOnce());
  expect(f.bridge.open).toHaveBeenCalledOnce();
  gate.resolve(connection);
  await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(2));
  expect(connection.close).toHaveBeenCalledOnce();
});
it("reopens after a typed request releases close without another roster change", async () => {
  const f = setup();
  f.agents([agent("a")]);
  // The adapter retains its thread until the surviving typed request finishes.
  const typedRequest = deferred<void>();
  const close = vi.fn(() => typedRequest.promise);
  f.voice.mockImplementationOnce(async () => ({ input: vi.fn(), close }));
  f.start();
  try {
    await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
    f.call({ phase: "idle", participants: [] });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    f.call({
      phase: "connected",
      id: "rejoined-human",
      participants: ["owner"],
    });
    // Native cleanup completed, but the harness still holds its reservation.
    await vi.waitFor(() => expect(f.bridge.close).toHaveBeenCalledOnce());
    expect(f.bridge.open).toHaveBeenCalledOnce();
    typedRequest.resolve();
    await vi.waitFor(() => expect(f.bridge.open).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.voice).toHaveBeenCalledTimes(2));
  } finally {
    typedRequest.resolve();
  }
});
it("renews leases, closes on harness failure, and does not retry on roster noise", async () => {
  vi.useFakeTimers();
  const f = setup();
  f.start();
  await vi.waitFor(() => expect(f.connections.size).toBe(2));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.bridge.touch).toHaveBeenCalledTimes(2);
  required(f.seatArgs.get("a")).ended(new Error("unsupported"));
  await vi.waitFor(() =>
    expect(required(f.connections.get("a")).close).toHaveBeenCalledOnce(),
  );
  f.call({ participants: ["owner", "stranger", "b"] });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.voice).toHaveBeenCalledTimes(2);
  expect(f.bridge.touch).toHaveBeenCalledTimes(3);
  expect(f.report).toHaveBeenCalledOnce();
});

it.each(["stop", "failure"])(
  "clears listening before pending %s teardown",
  async (reason) => {
    const f = setup();
    f.agents([agent("a")]);
    const closed = deferred<void>();
    const close = vi.fn(() => closed.promise);
    const connection = { input: vi.fn(), close };
    const opened = deferred<typeof connection>();
    f.voice.mockImplementationOnce((seat) => {
      f.seatArgs.set("a", seat);
      return opened.promise;
    });
    f.start();
    try {
      await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
      expect(f.listening).not.toHaveBeenCalled();
      opened.resolve({ input: vi.fn(), close });
      await vi.waitFor(() =>
        expect(f.listening).toHaveBeenLastCalledWith("human", "a", true),
      );
      if (reason === "stop") f.call({ phase: "idle" });
      else required(f.seatArgs.get("a")).ended(new Error("disconnected"));
      expect(f.listening).toHaveBeenLastCalledWith("human", "a", false);
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(f.bridge.open).toHaveBeenCalledOnce();
    } finally {
      opened.resolve({ input: vi.fn(), close });
      closed.resolve();
    }
  },
);

it("closes once when clearing listening re-enters subscribers", async () => {
  const f = setup();
  f.agents([agent("a")]);
  f.listening.mockImplementation(() => f.call({}));
  f.start();
  await vi.waitFor(() =>
    expect(f.listening).toHaveBeenLastCalledWith("human", "a", true),
  );
  f.agents([]);
  await vi.waitFor(() => expect(f.bridge.close).toHaveBeenCalledOnce());
});

it("never marks an aborted pending adapter as listening", async () => {
  const f = setup();
  f.agents([agent("a")]);
  const connection = { input: vi.fn(), close: vi.fn() };
  const opened = deferred<typeof connection>();
  f.voice.mockImplementationOnce(() => opened.promise);
  const dispose = f.start();
  await vi.waitFor(() => expect(f.voice).toHaveBeenCalledOnce());
  f.agents([]);
  expect(f.listening).toHaveBeenLastCalledWith("human", "a", false);
  opened.resolve(connection);
  await dispose();
  expect(f.listening).toHaveBeenLastCalledWith("human", "a", false);
  expect(f.listening).not.toHaveBeenCalledWith("human", "a", true);
  expect(connection.close).toHaveBeenCalledOnce();
});
