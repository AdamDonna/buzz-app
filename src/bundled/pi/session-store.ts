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
  constructor(private readonly storage: AgentStore) {}

  async read(agent: string, place: string): Promise<PiSession | undefined> {
    const key = await this.storage.read(pointer(agent, place));
    return key === null ? undefined : this.load(agent, key, place);
  }

  async current(agent: string, place: string): Promise<PiSession> {
    const saved = await this.read(agent, place);
    if (saved) return saved;
    const key = await this.storage.add(
      pointer(agent, place),
      crypto.randomUUID(),
    );
    return this.load(agent, key, place);
  }

  private async load(
    agent: string,
    key: string,
    place: string,
  ): Promise<PiSession> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key))
      throw new Error("Invalid Pi session key");
    const text = await this.storage.read(state(agent, key));
    return text ? this.parse(text, key, place) : { key, place, at: 0 };
  }

  async save(agent: string, session: PiSession) {
    await this.storage.set(state(agent, session.key), JSON.stringify(session));
  }

  async replace(agent: string, place: string) {
    const key = crypto.randomUUID();
    await this.save(agent, { key, place, at: 0 });
    await this.storage.set(pointer(agent, place), key);
  }

  list(agent: string): PiSession[] {
    const prefix = `${PREFIX}${agent}:place:`;
    return this.storage
      .keys()
      .filter((key) => key.startsWith(prefix))
      .flatMap((key) => {
        const id = this.storage.get(key);
        const text = id && this.storage.get(state(agent, id));
        return text
          ? [this.parse(text, id as string, key.slice(prefix.length))]
          : [];
      });
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
