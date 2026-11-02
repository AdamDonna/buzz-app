// The ACP agent settings that sync across devices (NIP-AP
// `buzz.agent.settings`): the preset, model, effort and scope. The launch
// itself (command, args, env, workspace and its approval) never syncs: a
// preset is a choice from the built-in list, not an executable.
import {
  pickSettings,
  type SettingsSchema,
} from "../../features/agents/agent-config";
import { type Config, DEFAULT_CONFIG } from "./config";
import { CUSTOM, PRESETS } from "./presets";

export const syncedSettingsSchema = {
  preset: [...PRESETS.map((p) => p.id), CUSTOM],
  model: "string",
  effort: "string",
  scope: ["thread", "channel"],
} as const satisfies SettingsSchema;

export const syncedSettings = (config: Config) =>
  pickSettings(syncedSettingsSchema, config);

/** Synced fields override; one the accepted copy leaves out takes the plugin
 * default, never this device's value. Everything else stays this device's. */
export const withSyncedSettings = (
  config: Config,
  settings: Readonly<Record<string, string>>,
): Config =>
  ({
    ...config,
    ...syncedSettings(DEFAULT_CONFIG),
    ...pickSettings(syncedSettingsSchema, settings),
  }) as Config;
