import type { AgentExecution } from "../../features/agents/execution";
import type {
  Agent,
  Agents,
  Delivery,
  SessionControlAction,
  SessionPlace,
  StandaloneTurn,
} from "../../features/agents/service";
import type { PiRuntime, Place, Config, PiRuntimeOptions } from "./runtime";
import type { PiSetup } from "./setup";
import { PiSessionStore, type PiSession } from "./session-store";

const EMPTY_WORKING: readonly number[] = Object.freeze([]);

type Factory = (
  execution?: () => Promise<AgentExecution | undefined>,
  options?: PiRuntimeOptions,
) => PiRuntime;
type Open = {
  agent: string;
  session: PiSession;
  runtime: PiRuntime;
  display: number;
  stop(): void;
  lifetime: AbortController;
};

/** Each remote session owns one PiRuntime. Local agents use the shared runtime. */
export class PiSessions {
  readonly local: PiRuntime;
  readonly setup: PiSetup;
  private readonly store: PiSessionStore;
  private readonly opened = new Map<string, Open>();
  private readonly listeners = new Set<() => void>();
  private readonly displays = new Map<string, number>();
  private readonly views = new Map<string, readonly number[]>();
  private nextDisplay = 0;
  private disposed = false;
  private readonly lifetimes = new Map<string, object>();
  private readonly generations = new Map<string, object>();
  private readonly changes = new Map<string, Promise<void>>();
  private readonly selections = new Map<string, boolean>();
  private readonly inspections = new Map<string, Promise<boolean>>();
  private current: readonly Agent[] = [];

  constructor(
    private readonly agents: Pick<
      Agents,
      "storage" | "execution" | "inspectExecution" | "executionBinding"
    >,
    private readonly factory: Factory,
  ) {
    this.store = new PiSessionStore(agents.storage);
    this.local = factory(undefined, {
      route: (delivery, key) => this.route(delivery, key),
    });
    this.setup = this.local.setup;
    this.local.subscribe(() => this.notify());
  }

  private display(key: string) {
    let id = this.displays.get(key);
    if (id === undefined) {
      id = ++this.nextDisplay;
      this.displays.set(key, id);
    }
    return id;
  }
  private notify() {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setupFor(agent: string) {
    return this.local.setupFor(agent);
  }

  private live(agent: string) {
    const lifetime = this.lifetimes.get(agent) ?? {};
    this.lifetimes.set(agent, lifetime);
    return () => {
      if (this.disposed || this.lifetimes.get(agent) !== lifetime)
        throw new Error("Pi session was retired");
    };
  }

  private inspect(agent: string): Promise<boolean> {
    const held = this.inspections.get(agent);
    if (held) return held;
    const pending = this.agents
      .inspectExecution(agent)
      .then((binding) => {
        const remote = binding !== undefined;
        if (this.selections.get(agent) !== remote) {
          this.selections.set(agent, remote);
          this.notify();
        }
        return remote;
      })
      .finally(() => this.inspections.delete(agent));
    this.inspections.set(agent, pending);
    return pending;
  }

  private selection(agent: string) {
    if (this.agents.executionBinding(agent)) return true;
    const known = this.selections.get(agent);
    if (known === undefined && !this.inspections.has(agent))
      void this.inspect(agent).catch((error) =>
        console.warn(`Pi agent ${agent} selection read failed`, error),
      );
    return known;
  }

  private runtime(agent: string, session: PiSession): Open {
    if (this.disposed) throw new Error("Pi runtime is disposed");
    const held = this.opened.get(session.key);
    if (held) return held;
    const live = this.live(agent);
    const lifetimeSignal = new AbortController();
    const runtime = this.factory(
      async () => {
        lifetimeSignal.signal.throwIfAborted();
        live();
        if (this.opened.get(session.key) !== opened)
          throw new Error("Pi session was retired");
        const execution = await this.agents.execution(agent, {
          key: session.key,
          intent: opened.session.opened ? "existing" : "new",
          signal: lifetimeSignal.signal,
        });
        if (!execution)
          throw new Error("The remote Pi execution is unavailable");
        if (
          this.disposed ||
          lifetimeSignal.signal.aborted ||
          this.opened.get(session.key) !== opened
        ) {
          await execution.dispose();
          throw new Error("Pi session was retired");
        }
        if (!opened.session.opened) {
          const saved = { ...opened.session, opened: true as const };
          try {
            await this.store.save(agent, saved);
            opened.session = saved;
          } catch (error) {
            await execution.dispose();
            throw error;
          }
        }
        return execution;
      },
      {
        resume: () =>
          opened.session.conversation === undefined
            ? undefined
            : {
                key: opened.session.place,
                conversation: opened.session.conversation,
              },
        sessionKey: session.key,
        recordPlace: async (place, conversation, seen) => {
          if (place !== opened.session.place)
            throw new Error("Pi changed its session scope");
          opened.session = {
            ...opened.session,
            conversation,
            at: Math.max(opened.session.at, seen * 1000),
          };
          await this.store.save(agent, opened.session);
          this.notify();
        },
      },
    );
    runtime.sync(this.current.filter((item) => item.key === agent));
    const opened: Open = {
      agent,
      session,
      runtime,
      lifetime: lifetimeSignal,
      display: this.display(session.key),
      stop: runtime.subscribe(() => this.notify()),
    };
    this.opened.set(session.key, opened);
    return opened;
  }

  private async route(delivery: Delivery, place: string) {
    const agent = delivery.agent.key;
    const live = this.live(agent);
    const scope = `${agent}/${place}`;
    const generation = this.generations.get(scope) ?? {};
    this.generations.set(scope, generation);
    if (!(await this.inspect(delivery.agent.key))) return false;
    const changing = this.changes.get(scope);
    const run = async () => {
      await changing;
      delivery.signal.throwIfAborted();
      const session = await this.store.current(delivery.agent.key, place);
      live();
      if (this.generations.get(scope) !== generation)
        throw new Error("Pi session was retired");
      const opened = this.runtime(delivery.agent.key, session);
      await opened.runtime.run(delivery);
    };
    if (changing) delivery.workingUntil(run());
    else await run();
    return true;
  }
  run(delivery: Delivery) {
    return this.local.run(delivery);
  }

  async runOnce(turn: StandaloneTurn) {
    const live = this.live(turn.delivery.agent.key);
    if (!(await this.inspect(turn.delivery.agent.key)))
      return this.local.runOnce(turn);
    turn.signal.throwIfAborted();
    const text = await turn.prompt();
    if (
      text === undefined ||
      (turn.delivery.current && !turn.delivery.current())
    )
      return { ok: true };
    const session: PiSession = { key: crypto.randomUUID(), place: "", at: 0 };
    await this.store.save(turn.delivery.agent.key, session);
    let opened: Open | undefined;
    const abort = () => opened?.lifetime.abort(turn.signal.reason);
    try {
      turn.signal.throwIfAborted();
      live();
      opened = this.runtime(turn.delivery.agent.key, session);
      turn.signal.addEventListener("abort", abort, { once: true });
      if (turn.signal.aborted) abort();
      return await opened.runtime.runOnce({
        ...turn,
        prompt: async () => text,
      });
    } finally {
      turn.signal.removeEventListener("abort", abort);
      try {
        if (opened) await this.close(opened);
      } finally {
        await this.store.remove(turn.delivery.agent.key, session);
      }
    }
  }

  private async close(opened: Open) {
    opened.lifetime.abort(new Error("Pi session was retired"));
    this.opened.delete(opened.session.key);
    opened.stop();
    this.notify();
    const retired = opened.runtime.retire(opened.agent);
    opened.runtime.dispose();
    await retired;
  }
  async retire(agent: string) {
    this.lifetimes.delete(agent);
    await Promise.all([
      this.local.retire(agent),
      ...[...this.opened.values()]
        .filter((item) => item.agent === agent)
        .map((item) => this.close(item)),
    ]);
  }
  sync(agents: readonly Agent[]) {
    this.current = agents;
    this.local.sync(agents);
    for (const opened of this.opened.values()) {
      const current = agents.filter((agent) => agent.key === opened.agent);
      if (!current.length)
        void this.retire(opened.agent).catch((error) =>
          console.error(`Pi agent ${opened.agent} cleanup failed`, error),
        );
      else opened.runtime.sync(current);
    }
  }
  dispose() {
    this.disposed = true;
    this.local.dispose();
    for (const opened of this.opened.values())
      void this.close(opened).catch((error) =>
        console.error(`Pi agent ${opened.agent} cleanup failed`, error),
      );
  }

  async places(agent: string): Promise<Place[]> {
    if (!(await this.inspect(agent))) return this.local.places(agent);
    return this.store
      .list(agent)
      .filter((session) => session.conversation !== undefined)
      .map((session) => {
        const [channelId = session.place, root] = session.place.split("/");
        return {
          key: session.place,
          channelId,
          ...(root ? { root } : {}),
          at: session.at,
          conversation: this.display(session.key),
        };
      })
      .sort((a, b) => b.at - a.at);
  }
  sessions(agent: string) {
    const remote = this.selection(agent);
    if (remote === undefined) return [];
    if (!remote) return this.local.sessions(agent);
    return this.store
      .list(agent)
      .filter((session) => session.conversation !== undefined)
      .map((session) => {
        const [channelId = session.place, root] = session.place.split("/");
        const opened = this.opened.get(session.key);
        return {
          channelId,
          ...(root ? { root } : {}),
          at: session.at,
          status: opened?.runtime.working(agent).length ? "Working" : "Idle",
        };
      })
      .sort((a, b) => b.at - a.at);
  }
  working(agent: string) {
    const remote = this.selection(agent);
    if (remote === undefined) return EMPTY_WORKING;
    if (!remote) return this.local.working(agent);
    let view = this.views.get(agent);
    if (!view) {
      view = [...this.opened.values()]
        .filter(
          (item) => item.agent === agent && item.runtime.working(agent).length,
        )
        .map((item) => item.display);
      this.views.set(agent, view);
    }
    return view;
  }
  async transcript(
    agent: string,
    place: Place,
    working: boolean,
    signal: AbortSignal,
  ) {
    const live = this.live(agent);
    if (!(await this.inspect(agent)))
      return this.local.transcript(agent, place, working, signal);
    const session = await this.store.read(agent, place.key);
    if (session?.conversation === undefined)
      throw new Error("The Pi session has no conversation");
    live();
    return this.runtime(agent, session).runtime.transcript(
      agent,
      { ...place, conversation: session.conversation },
      working,
      signal,
    );
  }
  async usage(agent: string, since: number, signal: AbortSignal) {
    if (!this.current.some((item) => item.key === agent)) return [];
    const live = this.live(agent);
    if (!(await this.inspect(agent)))
      return this.local.usage(agent, since, signal);
    live();
    const usage = await Promise.all(
      this.store
        .history(agent)
        .filter(
          (session) =>
            session.conversation !== undefined && session.at >= since,
        )
        .map(async (session) =>
          (
            await this.runtime(agent, session).runtime.usage(
              agent,
              since,
              signal,
            )
          ).map((usage) => ({ ...usage, id: `${session.key}/${usage.id}` })),
        ),
    );
    return usage.flat();
  }
  async models(agent: Agent<Config>) {
    if (!(await this.inspect(agent.key))) return this.local.models(agent);
    return { current: agent.config.model, models: [] };
  }
  sessionState(agent: Agent, place: SessionPlace) {
    const remote = this.selection(agent.key);
    if (remote === undefined) return "idle";
    if (!remote) return this.local.sessionState(agent, place);
    const key = this.controlKey(agent, place);
    if (this.changes.has(`${agent.key}/${key}`)) return "active";
    return (
      [...this.opened.values()]
        .find((item) => item.agent === agent.key && item.session.place === key)
        ?.runtime.sessionState(agent, place) ?? "idle"
    );
  }
  async session(
    agent: Agent,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    const live = this.live(agent.key);
    if (!(await this.inspect(agent.key)))
      return this.local.session(agent, place, action);
    live();
    const key = this.controlKey(agent, place);
    if (this.sessionState(agent, place) !== "idle" && action !== "interrupt")
      throw new Error("Wait for the active turn to finish first.");
    if (action === "new") {
      const scope = `${agent.key}/${key}`;
      this.generations.set(scope, {});
      const done = Promise.resolve()
        .then(async () => {
          live();
          await this.store.replace(agent.key, key);
          await Promise.all(
            [...this.opened.values()]
              .filter(
                (item) =>
                  item.agent === agent.key && item.session.place === key,
              )
              .map((item) => this.close(item)),
          );
        })
        .finally(() => {
          this.changes.delete(scope);
          this.notify();
        });
      this.changes.set(scope, done);
      this.notify();
      return done;
    }
    await this.changes.get(`${agent.key}/${key}`);
    live();
    const session = await this.store.current(agent.key, key);
    if (session.conversation === undefined && !this.opened.has(session.key))
      return;
    live();
    await this.runtime(agent.key, session).runtime.session(
      agent,
      place,
      action,
    );
  }
  private controlKey(agent: Agent, place: SessionPlace) {
    return (agent.config as Config).scope === "channel" || !place.root
      ? place.channelId
      : `${place.channelId}/${place.root}`;
  }
  channelLabel(agent: string, channel: string) {
    return this.local.channelLabel(agent, channel);
  }
  subscribeChannels(agent: string, listener: () => void) {
    return this.local.subscribeChannels(agent, listener);
  }
}
