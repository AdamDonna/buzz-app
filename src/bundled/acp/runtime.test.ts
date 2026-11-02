// ACP agents' turns, end to end against a fake plain-ACP harness.
import { describe, expect, it, vi } from "vitest";
import { modelCache, picks } from "./models";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { Delivery } from "../../features/agents/service";
import type { Host } from "../../features/host/service";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import { flush } from "../goose/goose-testing";
import { fakeHarness } from "./acp-testing";
import { approve, type Config, DEFAULT_CONFIG } from "./config";
import { missing } from "./harness";
import manifest from "./manifest.json";
import { AcpRuntime } from "./runtime";

const appClient = vi.hoisted(() => vi.fn());
vi.mock("../../buzz-mcp/app-client", async (actual) => {
  const real = await actual<typeof import("../../buzz-mcp/app-client")>();
  return {
    ...real,
    appClient: appClient.mockImplementation(real.appClient),
  };
});

const self = "c".repeat(64);
const alice = "a".repeat(64);
const mallory = "b".repeat(64);
const channel = "chan-1";
const INSTRUCTIONS = "Always answer in haiku.";

/** A host that grants only what the manifest declares, as the native host
 * does, so the runtime can't rely on an undeclared grant. */
function declared(fake: ReturnType<typeof fakeHarness>): Host {
  const { processes, files } = manifest.host as {
    processes: { id: string }[];
    files?: boolean;
  };
  const refuse = async () => {
    throw new Error("Files are not declared");
  };
  return {
    spawn: (id: string, ...rest: unknown[]) => {
      if (!processes.some((process) => process.id === id))
        throw new Error(`Process ${id} is not declared`);
      return (fake.spawn as (...args: unknown[]) => unknown)(id, ...rest);
    },
    serveMcp: fake.serve,
    resolveDirectory: files ? async (path: string) => path : refuse,
    readFile: files ? async () => new Uint8Array() : refuse,
  } as unknown as Host;
}

const FAILED = "⚠️ I couldn't finish that. Details are in my activity.";

const message = (id: string, content: string, pubkey = alice): RelayEvent =>
  ({
    id: id.repeat(64).slice(0, 64),
    pubkey,
    kind: 9,
    created_at: 100 + Number(id),
    content,
    tags: [
      ["h", channel],
      ["p", self],
    ],
    sig: "",
  }) as RelayEvent;

const confirmed = (value: Partial<Config> = {}) =>
  approve({
    ...DEFAULT_CONFIG,
    preset: "opencode",
    command: "opencode",
    args: ["acp"],
    instructions: INSTRUCTIONS,
    ...value,
  });

/** A runtime for one of Alice's agents in `channel`, on a fake harness. */
function setup(
  options: Parameters<typeof fakeHarness>[0] = {},
  {
    core = async () => null,
    added = () => [],
    read = async (_filters: { ids?: string[] }[]) => [] as RelayEvent[],
    solo = false,
    canvas,
    storage = memoryStorage(),
  }: {
    /** Where saved conversations and models are kept. */
    storage?: Storage;
    solo?: boolean;
    /** The channel's Canvas. */
    canvas?: string;
    core?: () => Promise<string | null | undefined>;
    added?: () => readonly AddedTool[];
    read?: (filters: { ids?: string[] }[]) => Promise<RelayEvent[]>;
  } = {},
) {
  const fake = fakeHarness(options);
  const host = declared(fake);
  const session = {
    read: vi.fn(read),
    channels: {
      list: () => ({
        channels: [
          {
            id: channel,
            name: "general",
            channelType: solo ? "solo" : "stream",
            members: [],
          },
        ],
      }),
    },
    relayAuthor: "relay-author",
    workflowAuthority: "workflow-authority",
    channelWrites: { startingCanvas: () => undefined },
    canvas: {
      available: canvas !== undefined,
      read: vi.fn(async () =>
        canvas === undefined
          ? null
          : {
              pubkey: alice,
              kind: 40100,
              created_at: 1,
              tags: [],
              content: canvas,
            },
      ),
    },
    names: { resolve: (pubkey: string) => (pubkey === alice ? "Alice" : "") },
    profiles: { ensure: vi.fn(async () => {}), snapshot: () => new Map() },
    agentMemories: { read: vi.fn(async () => ({ entries: [] })) },
    mePlacement: {
      snapshot: () => ({ status: "ready" }),
      refresh: vi.fn(async () => {}),
      has: () => false,
    },
  };
  const relay = {
    snapshot: () => ({ status: "ready", session, viewer: alice }),
  } as unknown as RelayData;
  const cache = modelCache(storage);
  const runtime = new AcpRuntime(
    host,
    () => relay,
    core,
    added,
    cache,
    storage,
  );
  const published: { content: string; tags: string[][] }[] = [];
  const agent = {
    pubkey: self,
    name: "Opal",
    owner: alice,
    type: "buzz.acp/acp",
    publish: vi.fn(async (template: (typeof published)[number]) => {
      published.push(template);
      return { ...message("9", template.content), ...template };
    }),
    query: vi.fn(async () => [] as RelayEvent[]),
  };
  const workingUntil = vi.fn((_done: Promise<unknown>) => undefined);
  const deliver = (
    event: RelayEvent,
    config: Config,
    signal = new AbortController().signal,
    extra: Partial<Delivery> = {},
  ) => {
    const ignored = vi.fn();
    const run = runtime.run({
      trigger: { type: "mention", event },
      channelId: channel,
      agent,
      config,
      signal,
      workingUntil,
      ignored,
      ...extra,
    } as unknown as Delivery);
    return { run, ignored };
  };
  const sync = (config: Config) =>
    runtime.sync([
      { ...agent, config } as unknown as Parameters<
        AcpRuntime["sync"]
      >[0][number],
    ]);
  return {
    fake,
    runtime,
    deliver,
    sync,
    published,
    workingUntil,
    cache,
    storage,
  };
}

/** A `Storage` that lives only as long as the test. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
}

/** Resolves once a turn has settled and its report step has finished. */
async function reported(
  runtime: { subscribe(listener: () => void): () => void },
  workingUntil: { mock: { calls: unknown[][] } },
) {
  await vi.waitFor(() => expect(workingUntil.mock.calls).toHaveLength(1));
  await workingUntil.mock.calls[0]?.[0];
  // Subscribed before the report step's continuation runs; that step ends by
  // notifying, after any post it makes.
  await new Promise<void>((resolve) => {
    const stop = runtime.subscribe(() => {
      stop();
      resolve();
    });
  });
}

describe("AcpRuntime", () => {
  it("runs an owner's mention in the confirmed harness, with Buzz tools over HTTP MCP", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    expect(harness?.options.args).toEqual(["opencode", "acp"]);
    const [opened] = harness?.opened ?? [];
    expect(opened?.mcpServers).toEqual([
      expect.objectContaining({ type: "http", name: "buzz" }),
    ]);
    // No extension `_meta`, and no standard prompt it didn't advertise.
    expect(opened).not.toHaveProperty("_meta");
    expect(opened).not.toHaveProperty("systemPrompt");
    const sessionId = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(sessionId, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((tool) => tool.name)).toContain("send");
    // Buzz tools act with the relay session's authorities, as Goose's do.
    expect(appClient).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        relayAuthor: "relay-author",
        signingAuthority: "workflow-authority",
      }),
    );
  });

  it("hands a Solo chat's Canvas to each turn, and a shared channel's to none", async () => {
    const config = await confirmed();
    for (const solo of [true, false]) {
      const { fake, deliver, sync } = setup(
        {},
        { solo, canvas: "Use tokens." },
      );
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const text = fake.harnesses[0]?.turns[0]?.text ?? "";
      if (solo) {
        expect(text).toContain("<workspace-canvas>");
        expect(text).toContain("Use tokens.");
      } else expect(text).not.toContain("workspace-canvas");
    }
  });

  it("leads only a new session's first prompt with the instructions", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    const [one, two] = fake.harnesses[0]?.turns ?? [];
    expect(one?.text).toContain(INSTRUCTIONS);
    expect(one?.text).toContain("@Opal one");
    expect(two?.sessionId).toBe(one?.sessionId);
    expect(two?.text).toContain("@Opal two");
    expect(two?.text).not.toContain(INSTRUCTIONS);
  });

  it("sends the instructions as ACP's appended system prompt when advertised", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [opened] = fake.harnesses[0]?.opened ?? [];
    const prompt = opened?.systemPrompt as {
      mode: string;
      content: { text: string }[];
    };
    expect(prompt.mode).toBe("append");
    expect(prompt.content[0]?.text).toContain(INSTRUCTIONS);
    expect(fake.harnesses[0]?.turns[0]?.text).not.toContain(INSTRUCTIONS);
  });

  it("closes sessions with session/close only when advertised", async () => {
    for (const close of [false, true]) {
      const config = await confirmed();
      const { fake, runtime, deliver, sync } = setup({
        capabilities: {
          mcpCapabilities: { http: true },
          ...(close && { sessionCapabilities: { close: {} } }),
        },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      await flush(50);
      runtime.dispose();
      await flush(50);
      const harness = fake.harnesses[0];
      expect(harness?.sent("session/cancel")).toHaveLength(1);
      expect(harness?.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(fake.servers.every((server) => server.closed)).toBe(true);
      expect(harness?.killed).toBe(true);
    }
  });

  it("ignores a mention from someone other than the owner", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    const { run, ignored } = deliver(
      message("1", "@Opal rm -rf", mallory),
      config,
    );
    await run;
    await flush(50);
    expect(ignored).toHaveBeenCalled();
    expect(fake.harnesses).toEqual([]);
  });

  it.each([
    ["a provider error", "Request failed: https://p.test/v1?key=SENTINEL"],
    ["a plain answer", "Here is my answer, SENTINEL"],
  ])(
    "posts nothing for %s the harness wrote without send",
    async (_, chunk) => {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        chunk,
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      expect(published).toEqual([]);
    },
  );

  it("says in the thread that it can't run an unconfirmed launch", async () => {
    const config = { ...(await confirmed()), command: "edited" };
    const { fake, deliver, sync, published } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toContain(
      "Confirm this agent's command in its settings.",
    );
    expect(fake.harnesses).toEqual([]);
  });

  it("gives a missing program's install hint, and nothing it wrote", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({ exitCode: 127 });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(
      `${FAILED} Install OpenCode: https://opencode.ai`,
    );
  });

  it("names no custom command in a missing program's hint", async () => {
    const config = await confirmed({
      preset: "custom",
      command: "/private/CLIENT_SECRET_SYNTHETIC/agent",
      args: [],
    });
    const { runtime, deliver, sync, published, workingUntil } = setup({
      exitCode: 127,
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await reported(runtime, workingUntil);
    expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("CLIENT_SECRET_SYNTHETIC"),
    });
    expect(published.map((event) => event.content)).toEqual([
      `${FAILED} Check the harness is installed and on your PATH.`,
    ]);
  });

  it("keeps a stored config's validation error local, secret and all", async () => {
    // As stored, outside Settings: a value pasted into an env name's slot.
    const config = {
      ...(await confirmed()),
      env: { "API_KEY=SYNTHETIC_SECRET": "" },
    };
    const { fake, runtime, deliver, sync, published, workingUntil } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await reported(runtime, workingUntil);
    expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("SYNTHETIC_SECRET"),
    });
    expect(published.map((event) => event.content)).toEqual([FAILED]);
    expect(fake.harnesses).toEqual([]);
  });

  it("gives no hint for a harness error that imitates ours", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      promptError: {
        code: -32603,
        message: `Oops. ${missing(config.preset, config.command)}`,
      },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("says only that it failed when the harness refuses Buzz tools", async () => {
    const config = await confirmed();
    const { deliver, sync, published } = setup({
      capabilities: { mcpCapabilities: { http: false } },
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("leads a new session with the core memory the host keeps", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup(
      {},
      { core: async () => "Prefers tabs." },
    );
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.turns[0]?.text).toContain("Prefers tabs.");
  });

  it("lists plugin-added tools, and reopens an idle session when they change", async () => {
    const tool = (name: string): AddedTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      call: async () => ({ content: [] }) as never,
    });
    let added: readonly AddedTool[] = [tool("pin")];
    const config = await confirmed();
    const { fake, deliver, sync } = setup({}, { added: () => added });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const [harness] = fake.harnesses;
    const one = harness?.turns[0]?.sessionId ?? "";
    const listed = await harness?.mcp(one, "tools/list");
    const result = listed?.result as { tools?: { name: string }[] } | undefined;
    expect(result?.tools?.map((t) => t.name)).toContain("pin");
    await flush(50);
    added = [tool("pin"), tool("star")];
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    expect(harness?.turns[1]?.sessionId).not.toBe(one);
  });

  it("restarts the harness when its launch changes, and keeps it otherwise", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    sync({ ...config, instructions: "Be brief." });
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(false);
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    await flush(50);
    expect(fake.harnesses[0]?.killed).toBe(true);
    await deliver(message("2", "@Opal again"), next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    expect(fake.harnesses[1]?.options.args).toEqual([
      "opencode",
      "acp",
      "--port",
      "0",
    ]);
  });

  it("keeps a busy turn on its launch's process and opens the next message on the new one", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({ hold: true });
    sync(config);
    const first = message("1", "@Opal hello");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const next = await confirmed({ args: ["acp", "--port", "0"] });
    sync(next);
    await flush(50);
    // The running turn keeps its process.
    expect(fake.harnesses[0]?.killed).toBe(false);
    const reply = message("2", "@Opal again");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, next).run;
    await vi.waitFor(() => expect(fake.harnesses[1]?.turns).toHaveLength(1));
    expect(fake.harnesses[1]?.options.args).toContain("--port");
    expect(fake.harnesses[1]?.turns[0]?.text).toContain("@Opal again");
    expect(fake.harnesses[0]?.sent("session/prompt")).toHaveLength(1);
    // Its process stops once that turn is done.
    fake.harnesses[0]?.turns[0]?.finish();
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
  });

  it("serves a message on the launch it opened with when the launch changes while it loads", async () => {
    const config = await confirmed();
    let loaded!: (events: RelayEvent[]) => void;
    const { fake, deliver, sync, published } = setup(
      {},
      { read: () => new Promise((resolve) => (loaded = resolve)) },
    );
    sync(config);
    const root = message("1", "@Opal hello");
    const reply = message("2", "@Opal again");
    reply.tags.push(["e", root.id, "", "reply"]);
    const { run } = deliver(reply, config);
    await vi.waitFor(() => expect(loaded).toBeDefined());
    sync(await confirmed({ args: ["acp", "--port", "0"] }));
    loaded([]);
    await run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(fake.harnesses[0]?.options.args).not.toContain("--port");
    expect(fake.harnesses).toHaveLength(1);
    expect(published).toHaveLength(0);
  });

  describe("resume", () => {
    const resumable = { mcpCapabilities: { http: true }, loadSession: true };
    /** One conversation's first turn, then a second turn in a new runtime
     * (as after an app restart) sharing the same storage. */
    async function twoRuns(
      first: Config,
      second: Config,
      capabilities: Record<string, unknown> = resumable,
      options: Parameters<typeof fakeHarness>[0] = {},
    ) {
      const one = setup({ capabilities, ...options });
      one.sync(first);
      const root = message("1", "@Opal hello");
      await one.deliver(root, first).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      const two = setup({ capabilities }, { storage: one.storage });
      two.sync(second);
      const reply = message("2", "@Opal again");
      reply.tags.push(["e", root.id, "", "reply"]);
      await two.deliver(reply, second).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      return two.fake.harnesses[0] as NonNullable<
        (typeof two.fake.harnesses)[0]
      >;
    }

    it("loads the saved session and sends only what it hasn't seen, without instructions", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      const harness = await twoRuns(config, config);
      expect(harness.sent("session/load")[0]?.params).toMatchObject({
        sessionId: "session-1",
      });
      expect(harness.sent("session/new")).toHaveLength(0);
      expect(harness.turns[0]?.text).toContain("@Opal again");
      expect(harness.turns[0]?.text).not.toContain(INSTRUCTIONS);
    });

    it("prefers session/resume when advertised", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, {
        ...resumable,
        sessionCapabilities: { resume: {} },
      });
      expect(harness.sent("session/resume")).toHaveLength(1);
      expect(harness.sent("session/load")).toHaveLength(0);
    });

    it("opens fresh, with instructions, when what the session opened with changed", async () => {
      const config = await confirmed({ instructions: INSTRUCTIONS });
      for (const changed of [
        { ...config, instructions: "Be brief." },
        { ...config, scope: "channel" as const },
        await confirmed({ instructions: INSTRUCTIONS, args: ["acp", "-v"] }),
      ]) {
        const harness = await twoRuns(config, changed);
        expect(harness.sent("session/load")).toHaveLength(0);
        expect(harness.sent("session/new")).toHaveLength(1);
      }
    });

    it("opens fresh when the harness can't load sessions", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, {
        mcpCapabilities: { http: true },
      });
      expect(harness.sent("session/load")).toHaveLength(0);
      expect(harness.sent("session/new")).toHaveLength(1);
    });

    it("keeps no pointer when the first prompt fails", async () => {
      const config = await confirmed();
      const harness = await twoRuns(config, config, resumable, {
        promptError: { code: -32603, message: "boom" },
      });
      expect(harness.sent("session/load")).toHaveLength(0);
      expect(harness.sent("session/new")).toHaveLength(1);
    });
  });

  describe("coverage", () => {
    const at = (event: RelayEvent, created_at: number) => ({
      ...event,
      created_at,
    });
    const inThread = (event: RelayEvent): RelayEvent => ({
      ...event,
      tags: [...event.tags, ["e", "f".repeat(64), "", "reply"]],
    });

    it("delivers a distinct message from a covered second, and a late older one", async () => {
      const config = await confirmed({ scope: "channel" });
      const { fake, deliver, sync } = setup();
      sync(config);
      await deliver(at(message("5", "@Opal first"), 105), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      await flush(20);
      await deliver(at(message("6", "@Opal same second"), 105), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
      await flush(20);
      await deliver(at(message("2", "@Opal late"), 102), config).run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(3));
      const turns = fake.harnesses[0]?.turns ?? [];
      expect(turns[1]?.text).toContain("@Opal same second");
      expect(turns[2]?.text).toContain("@Opal late");
      // The same event again is covered.
      await flush(20);
      await deliver(at(message("6", "@Opal same second"), 105), config).run;
      await flush(50);
      expect(turns).toHaveLength(3);
    });

    it("keeps identity coverage across a resume", async () => {
      const config = await confirmed({ scope: "channel" });
      const capabilities = {
        mcpCapabilities: { http: true },
        loadSession: true,
      };
      const first = at(message("5", "@Opal first"), 105);
      const tie = at(message("6", "@Opal same second"), 105);
      const one = setup({ capabilities });
      one.sync(config);
      await one.deliver(first, config).run;
      await vi.waitFor(() =>
        expect(one.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      await flush(20);
      one.runtime.dispose();
      // The resumed session reads both from the relay; only the tie is new.
      const two = setup(
        { capabilities },
        { storage: one.storage, read: async () => [first, tie] },
      );
      two.sync(config);
      await two.deliver(tie, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = two.fake.harnesses;
      expect(harness?.sent("session/load")).toHaveLength(1);
      expect(harness?.turns[0]?.text).toContain("@Opal same second");
      expect(harness?.turns[0]?.text).not.toContain("@Opal first");
    });

    it("carries a failed late message into a later prompt, live and after a resume", async () => {
      const config = await confirmed({ scope: "channel" });
      const capabilities = {
        mcpCapabilities: { http: true },
        loadSession: true,
      };
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal late b"), 90));
      const c = inThread(at(message("3", "@Opal c"), 110));
      const d = inThread(at(message("4", "@Opal d"), 120));
      // The relay has only what has arrived.
      const seen: RelayEvent[] = [];
      const read = async () => [...seen];
      const one = setup({ capabilities, hold: true }, { read });
      one.sync(config);
      const turns = () => one.fake.harnesses[0]?.turns ?? [];
      seen.push(a);
      await one.deliver(a, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.finish();
      await flush(20);
      seen.push(b);
      await one.deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      seen.push(c);
      await one.deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      // Refused again: still owed across a restart.
      turns()[2]?.fail(-32603, "refused");
      await flush(20);
      one.runtime.dispose();
      const two = setup(
        { capabilities },
        { storage: one.storage, read: async () => [b, a, c] },
      );
      two.sync(config);
      await two.deliver(d, config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      const [harness] = two.fake.harnesses;
      expect(harness?.sent("session/load")).toHaveLength(1);
      expect(harness?.turns[0]?.text).toContain("@Opal late b");
      expect(harness?.turns[0]?.text).not.toContain("@Opal a");
      // Once carried by a successful prompt, it is no longer owed.
      await flush(20);
      await two.deliver(inThread(at(message("5", "@Opal e"), 130)), config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(2),
      );
      expect(harness?.turns[1]?.text).not.toContain("@Opal late b");
    });

    /** A session where A succeeded and late B was refused, so B is owed. */
    const owedB = async () => {
      const config = await confirmed({ scope: "channel" });
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal late b"), 90));
      const seen: RelayEvent[] = [a];
      const one = setup(
        {
          capabilities: { mcpCapabilities: { http: true }, loadSession: true },
          hold: true,
        },
        { read: async () => [...seen] },
      );
      one.sync(config);
      const turns = () => one.fake.harnesses[0]?.turns ?? [];
      await one.deliver(a, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.finish();
      await flush(20);
      seen.push(b);
      await one.deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      const next = (id: string, created: number) => {
        const event = inThread(at(message(id, `@Opal ${id}`), created));
        seen.push(event);
        return event;
      };
      return { ...one, config, b, turns, next };
    };

    it("still owes a message whose carrying turn was stopped", async () => {
      const { deliver, config, turns, next } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
      await deliver(next("3", 110), config, undefined, { interruptible }).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      await interruptible.mock.calls[0]?.[0]();
      turns()[2]?.finish("cancelled");
      await flush(20);
      await deliver(next("4", 120), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(4));
      expect(turns()[3]?.text).toContain("@Opal late b");
    });

    it("carries a failed message into a successor already waiting", async () => {
      const { deliver, config, turns, next } = await owedB();
      await deliver(next("3", 110), config).run;
      await flush(20);
      turns()[1]?.fail(-32603, "refused");
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
    });

    it("still owes a message after an early final send and a refused prompt", async () => {
      const { deliver, config, turns, next, fake } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      await deliver(next("3", 110), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      await fake.harnesses[0]?.mcp(turns()[2]?.sessionId ?? "", "tools/call", {
        name: "send",
        arguments: { text: "early", audience: "everyone", final: true },
      });
      await flush(20);
      turns()[2]?.fail(-32603, "refused");
      await flush(20);
      await deliver(next("4", 120), config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(4));
      expect(turns()[3]?.text).toContain("@Opal late b");
    });

    it("fetches an owed message by id after a restart, past the recent window", async () => {
      const { runtime, storage, config, b, turns } = await owedB();
      turns()[1]?.fail(-32603, "refused");
      await flush(20);
      runtime.dispose();
      const replies = Array.from({ length: 201 }, (_, i) =>
        inThread(at(message(`r${i}`, `@Opal reply ${i}`), 200 + i)),
      );
      // The relay honours the filters: the thread window holds only the
      // newest 200 replies; B comes back only when asked for by id.
      const two = setup(
        {
          capabilities: { mcpCapabilities: { http: true }, loadSession: true },
        },
        {
          storage,
          read: async (filters) => [
            ...replies.slice(-200),
            ...(filters.some((f) => f.ids?.includes(b.id)) ? [b] : []),
          ],
        },
      );
      two.sync(config);
      await two.deliver(inThread(at(message("t", "@Opal t"), 500)), config).run;
      await vi.waitFor(() =>
        expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
      );
      expect(two.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
      expect(two.fake.harnesses[0]?.turns[0]?.text).toContain("@Opal late b");
    });

    /** `event` as a reply in the thread rooted at `root`. */
    const under = (root: string, event: RelayEvent): RelayEvent => ({
      ...event,
      tags: [...event.tags, ["e", root.repeat(64).slice(0, 64), "", "reply"]],
    });
    /** A relay that honours id, thread and channel filters over `seen`. */
    const honouring =
      (seen: RelayEvent[]) =>
      async (filters: { ids?: string[]; "#e"?: string[] }[]) =>
        seen.filter((event) =>
          filters.some((f) =>
            f.ids
              ? f.ids.includes(event.id)
              : f["#e"]
                ? event.tags.some((t) => t[0] === "e" && t[1] === f["#e"]?.[0])
                : true,
          ),
        );

    for (const elsewhere of ["another thread", "a top-level post"])
      it(`recovers a failed message from one thread in ${elsewhere}, then after a restart`, async () => {
        const config = await confirmed({ scope: "channel" });
        const capabilities = {
          mcpCapabilities: { http: true },
          loadSession: true,
        };
        const a = under("1", at(message("2", "@Opal a"), 100));
        const b = under("1", at(message("3", "@Opal late b"), 90));
        const c = at(message("4", "@Opal c"), 110);
        const place = (event: RelayEvent) =>
          elsewhere === "a top-level post" ? event : under("9", event);
        const seen: RelayEvent[] = [a];
        const one = setup(
          { capabilities, hold: true },
          { read: honouring(seen) },
        );
        one.sync(config);
        const turns = () => one.fake.harnesses[0]?.turns ?? [];
        await one.deliver(a, config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(1));
        turns()[0]?.finish();
        await flush(20);
        seen.push(b, place(c));
        await one.deliver(b, config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(2));
        turns()[1]?.fail(-32603, "refused");
        await flush(20);
        await one.deliver(place(c), config).run;
        await vi.waitFor(() => expect(turns()).toHaveLength(3));
        expect(turns()[2]?.text).toContain("@Opal late b");
        turns()[2]?.fail(-32603, "refused");
        await flush(20);
        one.runtime.dispose();
        const d = place(at(message("5", "@Opal d"), 120));
        seen.push(d);
        const two = setup(
          { capabilities },
          { storage: one.storage, read: honouring(seen) },
        );
        two.sync(config);
        await two.deliver(d, config).run;
        await vi.waitFor(() =>
          expect(two.fake.harnesses[0]?.turns).toHaveLength(1),
        );
        expect(two.fake.harnesses[0]?.sent("session/load")).toHaveLength(1);
        expect(two.fake.harnesses[0]?.turns[0]?.text).toContain("@Opal late b");
      });

    it("keeps a thread-scoped session to its own thread's messages", async () => {
      const config = await confirmed({ scope: "thread" });
      const b = under("1", at(message("3", "@Opal late b"), 90));
      const c = under("9", at(message("4", "@Opal c"), 110));
      const d = under("1", at(message("5", "@Opal d"), 120));
      const seen = [b, c, d];
      const { fake, deliver, sync } = setup(
        { hold: true },
        { read: honouring(seen) },
      );
      sync(config);
      const turns = () => fake.harnesses[0]?.turns ?? [];
      await deliver(b, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      turns()[0]?.fail(-32603, "refused");
      await flush(20);
      await deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      expect(turns()[1]?.text).not.toContain("@Opal late b");
      turns()[1]?.finish();
      await flush(20);
      await deliver(d, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(3));
      expect(turns()[2]?.text).toContain("@Opal late b");
      expect(turns()[2]?.text).not.toContain("@Opal c");
    });

    it("posts nothing for a waiting delivery cancelled by its signal, and still owes it", async () => {
      const config = await confirmed({ scope: "channel" });
      const a = inThread(at(message("1", "@Opal a"), 100));
      const b = inThread(at(message("2", "@Opal b"), 101));
      const c = inThread(at(message("3", "@Opal c"), 102));
      const model = (value: string) => ({ value, name: value });
      const { fake, deliver, sync, published } = setup(
        {
          capabilities: { mcpCapabilities: { http: true } },
          configOptions: [
            {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "x",
              options: [model("x"), model("y")],
            },
          ],
          hold: true,
        },
        { read: async () => [a, b, c] },
      );
      sync(config);
      const turns = () => fake.harnesses[0]?.turns ?? [];
      const signal = new AbortController().signal;
      await deliver(a, config, signal, { model: "y" }).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(1));
      // A harness-default turn waits in line behind the running turn.
      const cancel = new AbortController();
      await deliver(b, config, cancel.signal).run;
      await flush(20);
      cancel.abort(new Error("cancelled"));
      await flush(20);
      expect(published).toEqual([]);
      turns()[0]?.finish();
      await flush(20);
      await deliver(c, config).run;
      await vi.waitFor(() => expect(turns()).toHaveLength(2));
      expect(turns()[1]?.text).toContain("@Opal b");
      expect(published).toEqual([]);
    });

    it("counts only rendered context as seen", async () => {
      const config = await confirmed({ scope: "channel" });
      const earlier = Array.from({ length: 20 }, (_, i) =>
        inThread(at(message(`e${i}`, `@Opal early ${i}`), 100)),
      );
      const { fake, deliver, sync } = setup({}, { read: async () => earlier });
      sync(config);
      await deliver(inThread(at(message("t", "@Opal trigger"), 100)), config)
        .run;
      await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
      const turns = fake.harnesses[0]?.turns ?? [];
      expect(turns[0]?.text).toContain("@Opal early 19");
      expect(turns[0]?.text).not.toContain("@Opal early 0");
      await flush(20);
      await deliver(earlier[0] as RelayEvent, config).run;
      await vi.waitFor(() => expect(turns).toHaveLength(2));
      expect(turns[1]?.text).toContain("@Opal early 0");
    });
  });

  it("keeps a retired session's tools in its own thread when a replacement opens", async () => {
    const config = await confirmed({ scope: "channel" });
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const t1 = message("1", "@Opal one");
    const a = message("2", "@Opal in one");
    a.tags.push(["e", t1.id, "", "root"]);
    await deliver(a, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    const retired = fake.harnesses[0]?.turns[0]?.sessionId ?? "";
    const edited = { ...config, instructions: "Be brief." };
    sync(edited);
    const t2 = message("3", "@Opal two");
    const b = message("4", "@Opal in two");
    b.tags.push(["e", t2.id, "", "root"]);
    await deliver(b, edited).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(2));
    expect(fake.harnesses[0]?.turns[1]?.sessionId).not.toBe(retired);
    await fake.harnesses[0]?.mcp(retired, "tools/call", {
      name: "send",
      arguments: { text: "answer for one", audience: "everyone" },
    });
    const sent = published.find((item) => item.content === "answer for one");
    // A plain send answers in A's thread, not B's.
    expect(sent?.tags).toContainEqual(["e", a.id, "", "reply"]);
    expect(JSON.stringify(sent?.tags)).not.toContain(b.id);
  });

  it("re-initializes the harness on Recheck", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, runtime } = setup();
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(await runtime.recheck(self)).toBeUndefined();
    await vi.waitFor(() => expect(fake.harnesses).toHaveLength(2));
    expect(fake.harnesses[1]?.sent("initialize")).toHaveLength(1);
  });

  it("feeds the model picker from the session's options and applies the pinned model", async () => {
    const config = await confirmed({ model: "b" });
    const { fake, deliver, sync, cache } = setup({
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "a",
          options: [
            { value: "a", name: "A" },
            { value: "b", name: "B" },
          ],
        },
      ],
    });
    sync(config);
    await deliver(message("1", "@Opal hello"), config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(
      fake.harnesses[0]?.sent("session/set_config_option")[0]?.params,
    ).toMatchObject({
      configId: "model",
      value: "b",
    });
    expect(picks(cache, config).models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("leaves nothing running when a delivery is cancelled while the harness starts", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({
      silent: ["initialize"],
    });
    sync(config);
    const cancel = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await deliver(message("1", "@Opal hello"), config, cancel.signal).run;
      // The approval digest resolves outside the fake clock.
      while (!fake.harnesses[0]?.sent("initialize").length)
        await new Promise((resolve) => setImmediate(resolve));
      cancel.abort(new Error("cancelled"));
      // The start is shared by the agent's messages, so the cancel gives up
      // only this one; the unanswered start is then bounded and killed.
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(fake.harnesses[0]?.killed).toBe(true));
    await flush(50);
    expect(fake.harnesses).toHaveLength(1);
    expect(fake.harnesses[0]?.sent("session/new")).toEqual([]);
    expect(fake.servers.every((server) => server.closed)).toBe(true);
  });

  it("adds the preset's sign-in hint only when the first turn needs a login", async () => {
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { deliver, sync, published } = setup({
        promptError: { code, message: "No luck" },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await vi.waitFor(() => expect(published).toHaveLength(1));
      const [report] = published;
      expect(report?.content).toBe(
        code === -32000 ? `${FAILED} Run \`opencode auth login\`.` : FAILED,
      );
    }
  });

  it("keeps a failed turn's error in its activity, out of the channel", async () => {
    const error = "Request failed: https://p.test/v1?key=SENTINEL";
    for (const code of [-32000, -32603]) {
      const config = await confirmed();
      const { runtime, deliver, sync, published, workingUntil } = setup({
        promptError: { code, message: error },
      });
      sync(config);
      await deliver(message("1", "@Opal hello"), config).run;
      await reported(runtime, workingUntil);
      // The host records what `done` settles with in the turn's activity.
      expect(await workingUntil.mock.calls[0]?.[0]).toMatchObject({
        ok: false,
        error: expect.stringContaining("SENTINEL"),
      });
      expect(published).toHaveLength(1);
      expect(published[0]?.content).not.toContain("SENTINEL");
    }
  });

  it("hands the host a stopper that cancels the mention's running turn", async () => {
    const config = await confirmed();
    const { fake, deliver, sync } = setup({ hold: true });
    sync(config);
    const interruptible = vi.fn<NonNullable<Delivery["interruptible"]>>();
    await deliver(message("1", "@Opal hi"), config, undefined, {
      interruptible,
    }).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    expect(interruptible).toHaveBeenCalledTimes(1);
    const harness = fake.harnesses[0];
    expect(harness?.sent("session/cancel")).toEqual([]);
    await interruptible.mock.calls[0]?.[0]();
    await vi.waitFor(() =>
      expect(harness?.sent("session/cancel")).toHaveLength(1),
    );
  });

  it("gives no sign-in hint when a refusal follows the sign-in error", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({ hold: true });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    // Queued behind the running prompt, so one turn answers both.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await flush(50);
    const harness = fake.harnesses[0];
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint to a refusal after a sign-in error while the session opened", async () => {
    const config = await confirmed();
    let open!: () => void;
    const opening = new Promise<void>((resolve) => (open = resolve));
    const { fake, deliver, sync, published } = setup({ hold: true, opening });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.opened).toHaveLength(1));
    // Both arrive before the session has seen a message, so both are first.
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    open();
    const harness = fake.harnesses[0];
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(1));
    harness?.turns[0]?.fail(-32000, "Authentication required");
    await vi.waitFor(() => expect(harness?.turns).toHaveLength(2));
    harness?.turns[1]?.finish("refusal");
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(published[0]?.content).toBe(FAILED);
  });

  it("gives no sign-in hint for a later turn that needs a login", async () => {
    const config = await confirmed();
    const { fake, deliver, sync, published } = setup({
      promptError: {
        code: -32000,
        message: "Authentication required",
        from: 1,
      },
    });
    sync(config);
    const first = message("1", "@Opal one");
    await deliver(first, config).run;
    await vi.waitFor(() => expect(fake.harnesses[0]?.turns).toHaveLength(1));
    await flush(50);
    const reply = message("2", "@Opal two");
    reply.tags.push(["e", first.id, "", "reply"]);
    await deliver(reply, config).run;
    await vi.waitFor(() => expect(published).toHaveLength(1));
    expect(fake.harnesses).toHaveLength(1);
    expect(published[0]?.content).toBe(FAILED);
  });
});
