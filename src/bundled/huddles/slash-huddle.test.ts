// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type {
  SlashCommand,
  SlashCommandContext,
} from "../../features/conversation/contracts";
import type { HuddleAudio, OpenHuddleAudio } from "../../features/huddle/audio";
import type { HuddleBridge, HuddleUpdate } from "../../features/huddle/bridge";
import { createHuddles } from "../../features/huddle/service";
import { createHuddleWindow } from "../../features/huddle/window";
import type { WindowBridge } from "../../features/huddle/window";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import { huddleCommand } from "./slash-huddle";

const viewer = "ab".repeat(32);
const origin = "https://relay.example";
const scope = `${origin}:${viewer}`;
const channelId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000009";
const room = "00000000-0000-4000-8000-000000000002";
const design: ChannelSummary = {
  id: channelId,
  name: "Design",
  members: [viewer],
};

afterEach(() => {
  document.body.replaceChildren();
});

function harness(
  channels: ChannelSummary[] = [design],
  overrides: Partial<RelaySnapshot> = {},
) {
  const store = createRelaySession(null);
  const read = vi.fn<typeof store.session.read>(async () => []);
  const session = {
    ...store.session,
    read,
    channels: {
      ...store.session.channels,
      list: () => ({ status: "ready" as const, channels }),
    },
  };
  const connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope,
    origin,
    viewer,
    session,
    ...overrides,
  };
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const audio: HuddleAudio = {
    close: vi.fn(),
    mute: vi.fn(),
    play: vi.fn(),
    participants: vi.fn(),
  };
  let receive = (_: HuddleUpdate) => {};
  const bridge: HuddleBridge = {
    available: true,
    open: vi.fn(async (_id, _destination, _room, fn) => {
      receive = fn;
    }),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  const openAudio = vi.fn<OpenHuddleAudio>(async () => audio);
  const huddles = createHuddles(relay, bridge, openAudio);
  const windowBridge: WindowBridge = {
    open: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
  };
  const companion = createHuddleWindow(huddles, relay, windowBridge);
  const command: SlashCommand = huddleCommand({
    relay,
    huddles,
    showWindow: companion.open,
  });
  const run = (extra: Partial<SlashCommandContext> = {}) =>
    command.run({
      session: session as unknown as SlashCommandContext["session"],
      scope,
      channelId,
      args: "",
      recipients: [],
      signal: new AbortController().signal,
      ...extra,
    });
  return {
    run,
    receive: (update: HuddleUpdate) => receive(update),
    read,
    bridge,
    openAudio,
    huddles,
    windowBridge,
    async dispose() {
      await companion.dispose();
      await huddles.dispose();
      store.dispose();
    },
  };
}
const announcement = (id: string) =>
  signed(keypair(), {
    kind: 48100,
    tags: [["h", channelId]],
    created_at: Math.floor(Date.now() / 1000),
    content: JSON.stringify({ ephemeral_channel_id: id }),
  });

it.each([
  ["a channel", {}, design],
  [
    "a thread, which belongs to its channel's huddle",
    { threadRootId: "f".repeat(64) },
    design,
  ],
  [
    "a direct message",
    {},
    { ...design, name: "Honey", channelType: "dm" as const },
  ],
])(
  "starts a huddle in %s with its microphone prompt and one discovery read",
  async (_label, extra, channel) => {
    const h = harness([channel]);
    try {
      await expect(h.run(extra)).resolves.toEqual({
        done: true,
        notice: "Starting a huddle",
      });
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.openAudio).toHaveBeenCalledOnce();
      expect(h.bridge.open).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        {
          scope,
          viewer,
          relayUrl: origin,
          channelId,
          channelName: channel.name,
        },
        undefined,
        expect.any(Function),
      );
      expect(h.huddles.snapshot()).toMatchObject({
        phase: "connecting",
        destination: { channelId },
      });
    } finally {
      await h.dispose();
    }
  },
);

it("joins the newest running huddle instead of starting another", async () => {
  const h = harness();
  h.read.mockResolvedValueOnce([announcement(room)]);
  try {
    await expect(h.run()).resolves.toEqual({
      done: true,
      notice: "Joining the huddle",
    });
    expect(h.read).toHaveBeenCalledOnce();
    expect(h.bridge.open).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ channelId }),
      room,
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});

it("starts a new huddle when the running one is known to have ended", async () => {
  const h = harness();
  h.read.mockResolvedValue([announcement(room)]);
  try {
    await h.run();
    h.receive({ type: "ended", error: "The huddle has ended." });
    await vi.waitFor(() => expect(h.huddles.snapshot().phase).toBe("error"));
    await expect(h.run()).resolves.toEqual({
      done: true,
      notice: "Starting a huddle",
    });
    expect(h.bridge.open).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ channelId }),
      undefined,
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});

it("fails with the reason and starts nothing when the microphone is refused", async () => {
  const h = harness();
  h.openAudio.mockRejectedValueOnce(new Error("Microphone access was denied."));
  try {
    await expect(h.run()).rejects.toThrow("Microphone access was denied.");
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.huddles.snapshot().phase).toBe("error");
  } finally {
    await h.dispose();
  }
});

it("fails with the reason when the native call cannot open or discovery fails", async () => {
  const h = harness();
  try {
    h.bridge.open = vi.fn(async () => {
      throw new Error("The audio relay is unreachable.");
    });
    await expect(h.run()).rejects.toThrow("The audio relay is unreachable.");
    h.read.mockRejectedValueOnce(new Error("Relay read failed."));
    await expect(h.run()).rejects.toThrow("Relay read failed.");
    expect(h.openAudio).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

it.each([
  [
    "an archived channel",
    [{ ...design, archived: true as const }],
    {},
    "Huddles are not available in an archived channel.",
  ],
  [
    "a read-only channel",
    [{ ...design, readOnly: true as const }],
    {},
    "Huddles are not available in a read-only channel.",
  ],
  [
    "a channel known only from cache",
    [{ ...design, cached: true as const }],
    {},
    "Reconnect to this channel before starting a huddle.",
  ],
  [
    "a channel the viewer is not in",
    [{ ...design, members: ["cd".repeat(32)] }],
    {},
    "Join this channel before starting a huddle.",
  ],
  [
    "a channel that is not loaded",
    [{ ...design, id: otherId }],
    {},
    "This chat is not loaded yet. Try again in a moment.",
  ],
  ["arguments", [design], { args: "now" }, "Usage: /huddle"],
])(
  "refuses in %s without touching the microphone, relay or call state",
  async (_label, channels, extra, message) => {
    const h = harness(channels);
    try {
      await expect(h.run(extra)).rejects.toThrow(message);
      expect(h.read).not.toHaveBeenCalled();
      expect(h.openAudio).not.toHaveBeenCalled();
      expect(h.bridge.open).not.toHaveBeenCalled();
      expect(h.huddles.snapshot().phase).toBe("idle");
    } finally {
      await h.dispose();
    }
  },
);

it.each([
  ["the relay is not ready", { status: "connecting" as const }],
  ["the session belongs to another community", { scope: "other:x" }],
])("refuses while %s", async (_label, overrides) => {
  const h = harness([design], overrides);
  try {
    await expect(h.run()).rejects.toThrow(
      "Connect to this community before starting a huddle.",
    );
    expect(h.openAudio).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

const ops: ChannelSummary = { ...design, id: otherId, name: "Ops" };
const opsDestination = {
  scope,
  viewer,
  relayUrl: origin,
  channelId: otherId,
  channelName: "Ops",
};
const designDestination = {
  ...opsDestination,
  channelId,
  channelName: "Design",
};

async function connect(
  h: ReturnType<typeof harness>,
  destination: typeof opsDestination,
) {
  await h.huddles.join(destination);
  h.receive({ type: "connected", room, participants: [viewer] });
  await vi.waitFor(() => expect(h.huddles.snapshot().phase).toBe("connected"));
}

it("shows the connected huddle, in this channel or another, through the real window", async () => {
  const h = harness([design, ops]);
  try {
    await connect(h, opsDestination);
    h.read.mockClear();
    await vi.waitFor(() => expect(h.windowBridge.open).toHaveBeenCalled());
    const opened = vi.mocked(h.windowBridge.open).mock.calls.length;
    await expect(h.run()).resolves.toEqual({
      done: true,
      notice: "Showing your active huddle",
    });
    expect(h.windowBridge.open).toHaveBeenCalledTimes(opened + 1);
    const capsule = document.createElement("button");
    capsule.id = "huddle-capsule";
    document.body.append(capsule);
    await h.run({ channelId: otherId });
    expect(document.activeElement).toBe(capsule);
    expect(h.windowBridge.open).toHaveBeenCalledTimes(opened + 1);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.openAudio).toHaveBeenCalledTimes(1);
    expect(h.bridge.open).toHaveBeenCalledTimes(1);
    expect(h.bridge.close).not.toHaveBeenCalled();
    expect(h.huddles.snapshot().destination?.channelId).toBe(otherId);
  } finally {
    await h.dispose();
  }
});

it("fails visibly when the connected huddle's window cannot be shown", async () => {
  const h = harness();
  try {
    await connect(h, designDestination);
    await vi.waitFor(() => expect(h.windowBridge.open).toHaveBeenCalled());
    vi.mocked(h.windowBridge.open).mockRejectedValueOnce(
      new Error("The window failed."),
    );
    await expect(h.run()).rejects.toThrow("The window failed.");
  } finally {
    await h.dispose();
  }
});

it.each([
  ["connecting", "A huddle is already connecting.", false],
  ["leaving", "Wait for your current huddle to finish leaving.", true],
])(
  "refuses honestly while a call is %s, without showing a window or touching the call",
  async (phase, message, leaving) => {
    const h = harness([design, ops]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await h.huddles.join(opsDestination);
      if (leaving) {
        h.bridge.close = vi.fn(() => gate);
        void h.huddles.leave();
      }
      expect(h.huddles.snapshot().phase).toBe(phase);
      h.read.mockClear();
      await expect(h.run()).rejects.toThrow(message);
      await expect(h.run({ channelId: otherId })).rejects.toThrow(message);
      expect(h.windowBridge.open).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.openAudio).toHaveBeenCalledTimes(1);
      expect(h.bridge.open).toHaveBeenCalledTimes(1);
      expect(h.huddles.snapshot().phase).toBe(phase);
      if (!leaving) expect(h.bridge.close).not.toHaveBeenCalled();
    } finally {
      release();
      await h.dispose();
    }
  },
);

it.each([
  ["connecting", "A huddle is already connecting.", false],
  ["connected", "Showing your active huddle", true],
])(
  "re-checks for a call that began in another channel during discovery (%s)",
  async (_phase, outcome, connected) => {
    const h = harness([design, ops]);
    let finish = (_events: Awaited<ReturnType<typeof h.read>>) => {};
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const result = Promise.resolve(h.run()).then(
        (value) => value.notice,
        (error: Error) => error.message,
      );
      await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce());
      if (connected) await connect(h, opsDestination);
      else await h.huddles.join(opsDestination);
      finish([]);
      await expect(result).resolves.toBe(outcome);
      expect(h.openAudio).toHaveBeenCalledTimes(1);
      expect(h.bridge.open).toHaveBeenCalledTimes(1);
      expect(h.huddles.snapshot().destination?.channelId).toBe(otherId);
    } finally {
      await h.dispose();
    }
  },
);

it("does not report success for a call in another conversation when join does nothing", async () => {
  const h = harness([design, ops]);
  const join = h.huddles.join;
  vi.spyOn(h.huddles, "join").mockImplementationOnce(async () => {
    await join(opsDestination);
  });
  try {
    await expect(h.run()).rejects.toThrow("Another huddle is already active.");
  } finally {
    await h.dispose();
  }
});

it("fails, rather than report success, when the call ends before it connects", async () => {
  const h = harness();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.bridge.open = vi.fn(async () => {
    await gate;
  });
  try {
    const settled = Promise.resolve(h.run()).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalled());
    void h.huddles.leave();
    release();
    await expect(settled).resolves.toBe(
      "The huddle ended before it connected.",
    );
  } finally {
    release();
    await h.dispose();
  }
});

it("does not open the microphone when the composer moves on during discovery", async () => {
  const h = harness();
  const controller = new AbortController();
  h.read.mockImplementationOnce(async () => {
    controller.abort();
    return [];
  });
  try {
    await expect(h.run({ signal: controller.signal })).rejects.toThrow();
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.huddles.snapshot().phase).toBe("idle");
  } finally {
    await h.dispose();
  }
});
