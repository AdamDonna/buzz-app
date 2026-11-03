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
  private readonly observed = new Map<
    string,
    Map<string, PiSession | undefined>
  >();
  constructor(private readonly storage: AgentStore) {}

  async read(agent: string, place: string): Promise<PiSession | undefined> {
    const observed = this.observed.get(agent)?.get(place);
    const key = await this.storage.read(pointer(agent, place));
    if (key === null) {
      if (this.observed.get(agent)?.get(place) === observed)
        this.observe(agent, place, undefined);
      return;
    }
    return this.load(agent, key, place, observed);
  }

  async current(agent: string, place: string): Promise<PiSession> {
    const saved = await this.read(agent, place);
    if (saved) return saved;
    const observed = this.observed.get(agent)?.get(place);
    const key = await this.storage.add(
      pointer(agent, place),
      crypto.randomUUID(),
    );
    return this.load(agent, key, place, observed);
  }

  private async load(
    agent: string,
    key: string,
    place: string,
    observed: PiSession | undefined,
  ): Promise<PiSession> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key))
      throw new Error("Invalid Pi session key");
    const text = await this.storage.read(state(agent, key));
    const session = text ? this.parse(text, key, place) : { key, place, at: 0 };
    if (this.observed.get(agent)?.get(place) === observed)
      this.observe(agent, place, session);
    return session;
  }

  async save(agent: string, session: PiSession) {
    await this.storage.set(state(agent, session.key), JSON.stringify(session));
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

  list(agent: string): PiSession[] {
    const prefix = `${PREFIX}${agent}:place:`;
    const listed = new Map<string, PiSession>();
    for (const key of this.storage.keys()) {
      if (!key.startsWith(prefix)) continue;
      const id = this.storage.get(key);
      const text = id && this.storage.get(state(agent, id));
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
    let current = this.observed.get(agent);
    if (!current) {
      current = new Map();
      this.observed.set(agent, current);
    }
    current.set(place, session);
  }

  private parse(text: string, key: string, place: string): PiSession {
    const value = JSON.parse(text) as PiSession;
    if (
      value.key !== key ||
      value.place !== place ||
      !Number.isFinite(value.at) ||
      (value.opened !== undefined && value.opened !== true) ||
      (value.conversation !== undefined &&
        (!Number.isSafeInteger(value.conversation) || value.conversation < 1))
    )
      throw new Error("Invalid Pi session state");
    return value;
  }
}
