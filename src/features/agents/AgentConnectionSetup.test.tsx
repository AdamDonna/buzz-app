// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgentConnectionForm,
  connectionDraft,
  connectionMentions,
} from "./AgentConnectionSetup";
import type { Agents, RegisteredAgentType } from "./service";
import type { ChannelMessage } from "../relay/contracts";
import type { PortableAgent } from "./native";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
const candidate: PortableAgent = {
  source: "installed",
  pubkey: "a".repeat(64),
  name: "Helper",
  relay: "wss://example.test",
  connection: {
    runtime: "goose",
    provider: "anthropic",
    model: "saved-model",
    effort: "high",
  },
};
const type = {
  key: "buzz.goose/goose",
  title: "Goose",
  defaults: () => ({ config: { model: "", effort: "" } }),
  importShared: (saved: {
    runtime?: string;
    provider?: string;
    model: string;
  }) =>
    saved.runtime === "goose"
      ? { provider: saved.provider, model: saved.model, effort: "" }
      : undefined,
} as RegisteredAgentType;

it("restores compatible saved selections without silently substituting an unavailable runtime", () => {
  expect(connectionDraft(candidate, [type])).toEqual({
    type: type.key,
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  expect(
    connectionDraft(
      {
        ...candidate,
        connection: { runtime: "buzz-agent", model: "saved-model" },
      },
      [type],
    ),
  ).toBeUndefined();
  expect(
    connectionDraft({ ...candidate, connection: { runtime: "goose" } }, [type])
      ?.config,
  ).toMatchObject({ model: "", effort: "" });
});

it("connects the exact identity with reviewed defaults and retains errors for retry", async () => {
  const port = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue({ notes: [] });
  const types = [type];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm agents={agents} candidate={candidate} scope="scope" />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Connection interrupted",
  );
  expect(port).toHaveBeenCalledWith({
    source: "installed",
    pubkey: candidate.pubkey,
    type: type.key,
    scope: "scope",
    config: { provider: "anthropic", model: "saved-model", effort: "high" },
  });
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(
    await screen.findByRole("heading", { name: / connected$/ }),
  ).toBeVisible();
});

it.each(["dm", "stream", "forum"] as const)(
  "persists channel-scoped dismissal for the exact owned %s identity and preserves explicit connection",
  async (channelType) => {
    const { schnorr } = await import("@noble/curves/secp256k1.js");
    const { bytesToHex } = await import("nostr-tools/utils");
    const secret = new Uint8Array(32);
    secret[31] = 1;
    const viewer = bytesToHex(schnorr.getPublicKey(secret));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`nostr:agent-auth:${candidate.pubkey}:`),
    );
    const profile = {
      id: "f".repeat(64),
      kind: 0,
      pubkey: candidate.pubkey,
      created_at: 1,
      content: "{}",
      tags: [
        [
          "auth",
          viewer,
          "",
          bytesToHex(schnorr.sign(new Uint8Array(digest), secret)),
        ],
      ],
    };
    const view = { status: "ready", events: [profile] };
    let choices: {
      complete: boolean;
      identities: { pubkey: string; managed: boolean; messageable: boolean }[];
    } = { complete: false, identities: [] };
    const profiles = new Map([
      [candidate.pubkey, { name: candidate.name, isAgent: true }],
    ]);
    const listeners = new Set<() => void>();
    let presence = "offline";
    const noop = () => () => {};
    const reply = vi.fn();
    const observe = vi.fn(() => ({
      snapshot: () => view,
      subscribe: noop,
      dispose: () => {},
    }));
    const session = {
      messages: { reply },
      scope: "scope",
      viewer,
      observe,
      profiles: {
        subscribe: noop,
        snapshot: () => profiles,
        event: () => profile,
      },
      agentChoices: {
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        snapshot: () => choices,
      },
      presence: {
        status: () => presence,
        subscribe: (_key: string, listener: () => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    } as unknown as import("../relay/session").RelaySession;
    const types = [type];
    const snapshot = {};
    const portable = vi.fn(async () => ({
      agents: [candidate],
      warnings: [],
      here: [],
    }));
    const agents = {
      port: vi
        .fn()
        .mockRejectedValueOnce(new Error("Import interrupted"))
        .mockResolvedValue({ notes: [] }),
      types: () => types,
      snapshot: () => snapshot,
      subscribe: noop,
      find: () => undefined,
      portable,
    } as unknown as Agents;
    const channel = {
      id: "dm",
      name: "Helper",
      channelType,
      members: [viewer, candidate.pubkey],
      viewerRole: "member",
    } as import("../relay/contracts").ChannelSummary;
    const { AgentConnectionSetup } = await import("./AgentConnectionSetup");
    const { AgentsContext } = await import("./react");
    const { act } = await import("@testing-library/react");
    const setup = (sessionValue = session, channelValue = channel) => (
      <ToastProvider>
        <AgentsContext.Provider value={agents}>
          <AgentConnectionSetup
            session={sessionValue}
            channel={channelValue}
            rows={[
              {
                id: "b".repeat(64),
                channelId: channel.id,
                createdAt: 1,
                content: "Hello",
                attachments: [],
                reactions: [],
                replyCount: 0,
                participants: [],
                threadRootId: "c".repeat(64),
                authorId: viewer,
                mentions: [candidate.pubkey, "human"],
              },
            ]}
          />
        </AgentsContext.Provider>
      </ToastProvider>
    );
    let mounted = render(setup());
    await waitFor(() => expect(portable).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    act(() => {
      choices = {
        complete: true,
        identities: [
          { pubkey: candidate.pubkey, managed: false, messageable: true },
        ],
      };
      for (const listener of [...listeners]) listener();
    });
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    act(() => {
      choices = { complete: true, identities: [] };
      for (const listener of [...listeners]) listener();
    });
    expect(
      await screen.findByRole("heading", { name: /^Connect / }),
    ).toBeVisible();
    expect(portable).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledExactlyOnceWith([
      { kinds: [0], authors: [candidate.pubkey], limit: 1 },
    ]);
    const user = userEvent.setup();
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
    await user.click(
      screen.getByRole("button", {
        name: "Dismiss connection setup for Helper",
      }),
    );
    expect(
      await screen.findByText("Could not save dismissal. Try again."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect" })).toBeVisible();
    storage.mockRestore();
    await user.click(
      screen.getByRole("button", {
        name: "Dismiss connection setup for Helper",
      }),
    );
    expect(
      screen.queryByRole("region", { name: "Agent connection setup" }),
    ).toBeNull();
    expect(agents.port).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    // Navigation to another channel remains eligible; returning retains dismissal.
    mounted.rerender(setup(session, { ...channel, id: "other-channel" }));
    await screen.findByRole("button", { name: "Connect" });
    mounted.rerender(setup());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    // A fresh mount reads durable state, as after reload. A new scope is independent.
    mounted.unmount();
    mounted = render(setup());
    await waitFor(() => expect(observe).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    mounted.rerender(setup({ ...session, scope: "other-viewer-community" }));
    await user.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Import interrupted",
    );
    act(() => {
      presence = "online";
      for (const listener of [...listeners]) listener();
    });
    expect(screen.queryByRole("heading", { name: /^Connect / })).toBeNull();
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Import interrupted",
    );
    if (channelType !== "dm") {
      act(() => {
        presence = "offline";
        for (const listener of [...listeners]) listener();
      });
      await user.click(await screen.findByRole("button", { name: "Connect" }));
      await screen.findByRole("button", { name: "Ask Helper to respond" });
      expect(reply).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", { name: "Ask Helper to respond" }),
      );
      expect(reply).toHaveBeenCalledExactlyOnceWith(
        channel.id,
        "c".repeat(64),
        "Please respond to my message above.",
        [candidate.pubkey],
        [],
        "b".repeat(64),
      );
    }
  },
);

it("keeps dismissal disabled while an explicit import is pending", async () => {
  let finish!: (result: { notes: string[] }) => void;
  const port = vi.fn(
    () =>
      new Promise<{ notes: string[] }>((resolve) => {
        finish = resolve;
      }),
  );
  const types = [type];
  const snapshot = {};
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  const onDismiss = vi.fn();
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      onDismiss={onDismiss}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  const dismiss = screen.getByRole("button", {
    name: "Dismiss connection setup for Helper",
  });
  try {
    expect(port).toHaveBeenCalledOnce();
    expect(dismiss).toBeDisabled();
    await user.click(dismiss);
    expect(onDismiss).not.toHaveBeenCalled();
  } finally {
    finish({ notes: [] });
  }
  await screen.findByRole("heading", { name: "Helper connected" });
  expect(dismiss).toBeEnabled();
  await user.click(dismiss);
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("removes a disabled harness from the choices and never imports from a preview", async () => {
  const { act } = await import("@testing-library/react");
  let types: readonly RegisteredAgentType[] = [type];
  const snapshot = {};
  const listeners = new Set<() => void>();
  const port = vi.fn();
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      preview
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Preview only");
  expect(port).not.toHaveBeenCalled();
  act(() => {
    types = [];
    for (const listener of [...listeners]) listener();
  });
  expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
    "Choose harness",
  );
  expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  expect(screen.queryByText("Goose")).toBeNull();
});

it("uses only explicit own delivered mentions and deduplicates to the latest request", () => {
  const row: ChannelMessage = {
    channelId: "channel",
    createdAt: 1,
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    id: "first",
    authorId: "viewer",
    mentions: ["agent", "viewer"],
    content: "@someone",
  };
  const rows: ChannelMessage[] = [
    row,
    { ...row, id: "latest" },
    { ...row, authorId: "other", mentions: ["other-agent"] },
    { ...row, id: "edited", edited: true },
    { ...row, id: "delegated", signerId: "someone-else" },
    { ...row, id: "failed", delivery: "failed" },
    { ...row, id: "sending", delivery: "sending" },
    { ...row, id: "unknown", delivery: "unknown" },
  ];
  const found = connectionMentions(rows, "viewer");
  expect([...found.keys()]).toEqual(["agent"]);
  expect(found.get("agent")?.id).toBe("latest");
});

it("requires an explicit follow-up after import and preserves send failure for retry", async () => {
  const types = [type];
  const snapshot = {};
  const port = vi.fn(async () => ({ notes: [] }));
  const sendAgain = vi
    .fn()
    .mockRejectedValueOnce(new Error("Cannot send here"))
    .mockResolvedValue(undefined);
  const agents = {
    types: () => types,
    snapshot: () => snapshot,
    subscribe: () => () => {},
    port,
  } as unknown as Agents;
  render(
    <AgentConnectionForm
      agents={agents}
      candidate={candidate}
      scope="scope"
      onSendAgain={sendAgain}
    />,
  );
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Ask Helper to respond" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("button", { name: "Ask Helper to respond" });
  expect(sendAgain).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Ask Helper to respond" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot send here",
  );
  await user.click(
    screen.getByRole("button", { name: "Ask Helper to respond" }),
  );
  expect(
    await screen.findByRole("button", { name: "Follow-up queued" }),
  ).toBeDisabled();
  expect(sendAgain).toHaveBeenCalledTimes(2);
  expect(port).toHaveBeenCalledOnce();
});
