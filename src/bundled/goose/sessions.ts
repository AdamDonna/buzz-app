// One agent's goose sessions, in that agent's own `goose-acp` process. The
// sessions themselves live in the shared ACP client.
import {
  AgentSessions as AcpAgentSessions,
  type SessionsOptions as AcpSessionsOptions,
} from "../../features/agent-harness/acp/agent-sessions";
import type { AcpProcess } from "../../features/agent-harness/acp/process";
import { GooseProcess, type GooseHost, type ServeMcp } from "./goose";
import type {
  SavedConversation,
  SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

export {
  abortable,
  absolute,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
  type SavedConversation,
  type SessionStore,
} from "../../features/agent-harness/acp/agent-sessions";

/** The `goose-acp` one agent's sessions open in, started in the home folder
 * when a session first needs it, and again after it exits. Its own process,
 * so its environment carries only this agent's Buzz credential. */
export class AgentProcess {
  private ready: Promise<AcpProcess> | undefined;
  constructor(
    private readonly host: GooseHost,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
    /** The agent as its latest delivery named it, once known. */
    private readonly agent: () =>
      | Readonly<{ pubkey: string; relay: string }>
      | undefined = () => undefined,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const agent = this.agent();
    const ready = (async () =>
      GooseProcess.start(this.host.spawn, {
        cwd: await this.host.resolveDirectory("~"),
        serve: this.serve,
        ...(agent && { agent: { pubkey: agent.pubkey, relay: agent.relay } }),
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((goose) => goose.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready?.then((goose) => goose.kill()).catch(() => undefined);
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in its own process. */
export class AgentSessions extends AcpAgentSessions {
  constructor(options: SessionsOptions) {
    super({ ...options, label: "goose" });
  }
}

/** Saved conversations per agent; the least recently used are forgotten. */
const SAVED_LIMIT = 200;

/** Conversations saved in local storage, by agent and then conversation. */
export function localSessions(
  storage: Storage,
  agent: string,
  name = "buzz.goose.sessions.v1",
): SessionStore & {
  /** Saved conversations, most recently used first. */
  list(): [string, SavedConversation][];
} {
  const readAll = (): Record<string, Record<string, SavedConversation>> => {
    try {
      const value = JSON.parse(storage.getItem(name) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const list = (saved: Record<string, SavedConversation> = {}) =>
    Object.entries(saved)
      .filter(([, conversation]) => typeof conversation?.at === "number")
      .sort(([, a], [, b]) => b.at - a.at);
  return {
    list: () => list(readAll()[agent]),
    set: (key, saved) => {
      const all = readAll();
      const kept = list({ ...all[agent], [key]: saved }).slice(0, SAVED_LIMIT);
      all[agent] = Object.fromEntries(kept);
      try {
        storage.setItem(name, JSON.stringify(all));
      } catch (error) {
        console.warn("goose sessions were not saved", error);
      }
    },
  };
}
