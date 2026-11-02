// ACP agents: an agent type for any harness that speaks the Agent Client
// Protocol, started from a preset or a command the owner types and confirms.
import { isTauri } from "@tauri-apps/api/core";
import type { PluginModule } from "../../plugins/api";
import { adopt, carry, type Config, config, DEFAULT_CONFIG } from "./config";
import { check } from "./harness";
import { launchKey, modelCache, modelName, picks } from "./models";
import { preset } from "./presets";
import { AcpRuntime } from "./runtime";
import { syncedSettingsSchema, withSyncedSettings } from "./settings";
import { createTabs } from "./tabs";

export const TYPE_ID = "acp";
/** A turn's run returns once the harness has it, so this bounds only the
 * hand-over. */
const HANDOVER_MS = 2 * 60_000;

export const inject = ["agents", "host"];
export const apply: PluginModule["apply"] = (ctx) => {
  // Only the desktop app can start a harness, and its launch runs POSIX
  // `env`, which stock Windows lacks; no unusable type elsewhere.
  if (!isTauri() || !/Mac|Linux/i.test(navigator.platform)) return;
  const { agents, host } = ctx;
  const spawn = host.spawn?.bind(host);
  if (!spawn) return;
  const typeKey = `${ctx.pluginOwner?.id ?? "buzz.acp"}/${TYPE_ID}`;
  const cache = modelCache(localStorage);
  const runtime = new AcpRuntime(
    host,
    agents.relay,
    (pubkey, signal) => agents.core(pubkey, signal),
    () => agents.tools(),
    cache,
  );
  const sync = () => {
    const snapshot = agents.snapshot();
    if (snapshot.status === "loading") return;
    runtime.sync(snapshot.running.filter((agent) => agent.type === typeKey));
  };
  const unsubscribe = agents.subscribe(sync);
  sync();
  ctx.effect(() => () => {
    unsubscribe();
    runtime.dispose();
  });
  const { Create, CreateModel, SettingsTab, HistoryTab } = createTabs({
    // Launches the way a run does, so it checks exactly what a run would
    // start, and records the models a ready harness offers.
    check: (value) =>
      check(spawn, value, {
        resolveDirectory: (path) =>
          host.resolveDirectory
            ? host.resolveDirectory(path)
            : Promise.reject(new Error("No workspace on this device")),
        onState: (state) => {
          const key = launchKey(value);
          if (key) cache.record(key, state);
        },
      }),
    cache,
    runtime,
  });
  agents.register<Config>({
    id: TYPE_ID,
    title: "ACP agent",
    description:
      "Any harness that speaks the Agent Client Protocol, from a preset or a command you confirm.",
    defaults: () => ({ config: DEFAULT_CONFIG }),
    Create,
    CreateModel,
    // Only the preset, model, effort and scope: command, args, env and
    // workspace never come from the relay, only from this device.
    syncedSettings: {
      schema: syncedSettingsSchema,
      withSynced: withSyncedSettings,
    },
    adopt,
    carry,
    summary: (agent) => {
      const value = config(agent.config);
      return value.model
        ? modelName(cache, value)
        : (preset(value.preset)?.title ?? (value.command || "ACP agent"));
    },
    describeMigration: (saved) => {
      const { model, effort, scope } = config(saved);
      return [
        { id: "model", label: "Model", isOverride: Boolean(model) },
        { id: "thinking", label: "Thinking", isOverride: Boolean(effort) },
        {
          id: "sessions",
          label: "Sessions",
          isOverride: scope !== DEFAULT_CONFIG.scope,
          unchangedKey: scope,
        },
      ];
    },
    models: (agent) => picks(cache, config(agent.config)),
    sessions: {
      list: (pubkey) =>
        runtime
          .conversations(pubkey)
          .map(({ channelId, root, at, status }) => ({
            channelId,
            ...(root && { root }),
            at,
            ...(status && { status }),
          })),
      subscribe: (listener) => runtime.subscribe(listener),
    },
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: SettingsTab,
      },
      {
        id: "history",
        title: "History",
        role: "activity",
        component: HistoryTab,
      },
    ],
    run: (delivery) => runtime.run(delivery),
    runOnce: (turn) => runtime.runOnce(turn),
    timeoutMs: HANDOVER_MS,
  });
};
