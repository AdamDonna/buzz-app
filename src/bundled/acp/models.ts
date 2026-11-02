// The models and efforts each confirmed launch has offered, kept on this
// device as a hint for the picker. Only a live session's own option state is
// the truth: a pick the session doesn't offer runs on its current choice.
import type {
  ConfigValue,
  OptionState,
} from "../../features/agent-harness/acp/types";
import type { Models } from "../../features/agents/service";
import type { Config } from "./config";

export const MODELS_KEY = "buzz.acp.models.v1";
/** Launches remembered; the least recently seen are forgotten. */
const LIMIT = 50;

type Seen = Readonly<{
  at: number;
  models: readonly ConfigValue[];
  /** Efforts per model, recorded only once that model was selected. */
  efforts: Readonly<Record<string, readonly ConfigValue[]>>;
}>;

/** Which launch a cache entry belongs to: the confirmed launch's digest and
 * its workspace. Undefined until the launch is confirmed. */
export const launchKey = ({ approval, workspace }: Config) =>
  approval ? `${approval}\0${workspace}` : undefined;

export function modelCache(storage: Storage) {
  const readAll = (): Record<string, Seen> => {
    try {
      const value = JSON.parse(storage.getItem(MODELS_KEY) ?? "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  };
  const listeners = new Set<() => void>();
  return {
    read: (key: string | undefined): Seen | undefined =>
      key === undefined ? undefined : readAll()[key],
    /** Records what a session on `key`'s launch offers now. */
    record(key: string, { model, effort }: OptionState) {
      if (!model) return;
      const all = readAll();
      const old = all[key];
      const next: Seen = {
        at: Date.now(),
        models: model.options,
        efforts: {
          ...old?.efforts,
          [model.currentValue]: effort?.options ?? [],
        },
      };
      if (
        JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...next, at: 0 })
      )
        return;
      all[key] = next;
      const kept = Object.entries(all)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, LIMIT);
      try {
        storage.setItem(MODELS_KEY, JSON.stringify(Object.fromEntries(kept)));
      } catch (error) {
        console.warn("ACP models were not saved", error);
      }
      for (const listener of listeners) listener();
    },
    /** Changes whenever `record` stores something new. */
    snapshot: () => storage.getItem(MODELS_KEY),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type ModelCache = ReturnType<typeof modelCache>;

/** The picker's models for `config`'s launch. A model whose efforts haven't
 * been seen offers none. */
export function picks(cache: ModelCache, value: Config): Models {
  const seen = cache.read(launchKey(value));
  return {
    current: value.model,
    models: (seen?.models ?? []).map(({ value: id, name }) => {
      const efforts = (seen?.efforts[id] ?? []).map((e) => ({
        id: e.value,
        label: e.name,
      }));
      return {
        id,
        label: name,
        efforts,
        ...(id === value.model && value.effort && { effort: value.effort }),
      };
    }),
  };
}

/** The name the cache knows for `config`'s model, else its id. */
export const modelName = (cache: ModelCache, value: Config) =>
  cache.read(launchKey(value))?.models.find((m) => m.value === value.model)
    ?.name ?? value.model;
