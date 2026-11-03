import type { AgentStore } from "../../features/agents/store";

const PREFIX = "buzz.pi.sessions.v1:";
export type PiSession = Readonly<{
  key: string;
  place: string;
  at: number;
  opened?: true;
  conversation?: number;
}>;
const pointer = (agent: string, place: string) =>
  `${PREFIX}${agent}:place:${place}`;
const state = (agent: string, key: string) =>
  `${PREFIX}${agent}:session:${key}`;

export class PiSessionStore {
  private readonly inventory = new Map<string, Record<string, string>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly refreshes = new Map<string, object>();
  private readonly requests = new Map<string, object>();
  private readonly observed = new Map<
    string,
    Map<string, PiSession | undefined>
  >();
  constructor(private readonly storage: AgentStore) {}

  refresh(agent: string): Promise<void> {
    const held = this.refreshing.get(agent);
    if (held) return held;
    const pending = this.refreshInventory(agent).finally(() => {
      if (this.refreshing.get(agent) === pending) this.refreshing.delete(agent);
    });
    this.refreshing.set(agent, pending);
    return pending;
  }

  private async refreshInventory(agent: string) {
    const prefix = `${PREFIX}${agent}:`;
    for (;;) {
      const request = {};
      this.refreshes.set(agent, request);
      for (const key of this.requests.keys())
        if (key.startsWith(prefix)) this.requests.delete(key);
      const entries = await this.storage.scan(prefix);
      if (this.refreshes.get(agent) !== request) continue;
      this.inventory.set(agent, entries);
      this.observed.delete(agent);
      return;
    }
  }

  private entries(agent: string) {
    return (
      this.inventory.get(agent) ??
      Object.fromEntries(
        this.storage.keys().flatMap((key) => {
          if (!key.startsWith(`${PREFIX}${agent}:`)) return [];
          const value = this.storage.get(key);
          return value === null ? [] : [[key, value]];
        }),
      )
    );
  }

  async read(agent: string, place: string): Promise<PiSession | undefined> {
    const request = this.request(agent, place);
    const key = await this.storage.read(pointer(agent, place));
    if (key === null) {
      if (this.requests.get(pointer(agent, place)) === request)
        this.observe(agent, place, undefined);
      return;
    }
    return this.load(agent, key, place, request);
  }

  async current(agent: string, place: string): Promise<PiSession> {
    const saved = await this.read(agent, place);
    if (saved) return saved;
    const request = this.request(agent, place);
    const key = await this.storage.add(
      pointer(agent, place),
      crypto.randomUUID(),
    );
    return this.load(agent, key, place, request);
  }

  private async load(
    agent: string,
    key: string,
    place: string,
    request: object,
  ): Promise<PiSession> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key))
      throw new Error("Invalid Pi session key");
    const text = await this.storage.read(state(agent, key));
    const session = text ? this.parse(text, key, place) : { key, place, at: 0 };
    if (this.requests.get(pointer(agent, place)) === request)
      this.observe(agent, place, session);
    return session;
  }

  async save(agent: string, session: PiSession) {
    this.refreshes.delete(agent);
    const text = JSON.stringify(session);
    await this.storage.set(state(agent, session.key), text);
    this.refreshes.delete(agent);
    const inventory = this.inventory.get(agent);
    if (inventory) inventory[state(agent, session.key)] = text;
    if (this.observed.get(agent)?.get(session.place)?.key === session.key)
      this.observe(agent, session.place, session);
  }

  async replace(agent: string, place: string) {
    const key = crypto.randomUUID();
    const session = { key, place, at: 0 };
    await this.save(agent, session);
    await this.storage.set(pointer(agent, place), key);
    this.observe(agent, place, session);
  }

  async remove(agent: string, session: PiSession) {
    this.refreshes.delete(agent);
    await this.storage.set(state(agent, session.key), null);
    this.refreshes.delete(agent);
    const inventory = this.inventory.get(agent);
    if (inventory) delete inventory[state(agent, session.key)];
  }

  history(agent: string): PiSession[] {
    const prefix = `${PREFIX}${agent}:session:`;
    const sessions = new Map<string, PiSession>();
    for (const [key, text] of Object.entries(this.entries(agent))) {
      if (!key.startsWith(prefix)) continue;
      if (text) {
        const session = this.parse(text, key.slice(prefix.length));
        sessions.set(session.key, session);
      }
    }
    for (const session of this.list(agent)) sessions.set(session.key, session);
    return [...sessions.values()];
  }

  list(agent: string): PiSession[] {
    const prefix = `${PREFIX}${agent}:place:`;
    const listed = new Map<string, PiSession>();
    const entries = this.entries(agent);
    for (const [key, id] of Object.entries(entries)) {
      if (!key.startsWith(prefix)) continue;
      const text = entries[state(agent, id)];
      if (text)
        listed.set(
          key.slice(prefix.length),
          this.parse(text, id as string, key.slice(prefix.length)),
        );
    }
    for (const [place, session] of this.observed.get(agent) ?? []) {
      if (session) listed.set(place, session);
      else listed.delete(place);
    }
    return [...listed.values()];
  }

  private observe(
    agent: string,
    place: string,
    session: PiSession | undefined,
  ) {
    this.refreshes.delete(agent);
    this.requests.delete(pointer(agent, place));
    let current = this.observed.get(agent);
    if (!current) {
      current = new Map();
      this.observed.set(agent, current);
    }
    current.set(place, session);
  }

  private request(agent: string, place: string) {
    this.refreshes.delete(agent);
    const request = {};
    this.requests.set(pointer(agent, place), request);
    return request;
  }

  private parse(text: string, key: string, place?: string): PiSession {
    const value = JSON.parse(text) as PiSession;
    if (
      value.key !== key ||
      typeof value.place !== "string" ||
      (place !== undefined && value.place !== place) ||
      !Number.isFinite(value.at) ||
      (value.opened !== undefined && value.opened !== true) ||
      (value.conversation !== undefined &&
        (!Number.isSafeInteger(value.conversation) || value.conversation < 1))
    )
      throw new Error("Invalid Pi session state");
    return value;
  }
}
