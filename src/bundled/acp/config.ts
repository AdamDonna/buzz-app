// An ACP agent's settings, their validation, and the owner's approval of the
// exact command they launch. Everything here stays on this device: `carry`
// passes on only the instructions.
import type { Carry } from "../../features/agents/native";
import { CUSTOM, preset } from "./presets";

export type Scope = "thread" | "channel";

export type Config = Readonly<{
  /** A preset id, or `custom`. */
  preset: string;
  /** A program name or absolute path, run by `env` with no shell. */
  command: string;
  args: readonly string[];
  /** Extra environment variables for the harness. */
  env: Readonly<Record<string, string>>;
  /** The harness's working directory, absolute or `~/…`. */
  workspace: string;
  instructions: string;
  /** The model picked for new turns; empty is the harness's own. */
  model: string;
  /** The effort picked for new turns; empty is the harness's own. */
  effort: string;
  /** Whether a channel's top-level messages share one session or each thread
   * gets its own. */
  scope: Scope;
  /** The digest of the launch the owner last confirmed; empty when none. */
  approval: string;
}>;

export const DEFAULT_CONFIG: Config = Object.freeze({
  preset: CUSTOM,
  command: "",
  args: [],
  env: {},
  workspace: "~/.buzz",
  instructions: "",
  model: "",
  effort: "",
  scope: "thread",
  approval: "",
});

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];

/** Reads a stored config, dropping anything of the wrong shape. */
export function config(value: unknown): Config {
  const saved = (value && typeof value === "object" ? value : {}) as Partial<
    Record<keyof Config, unknown>
  >;
  const text = (key: keyof Config) =>
    typeof saved[key] === "string"
      ? (saved[key] as string)
      : (DEFAULT_CONFIG[key] as string);
  const env =
    saved.env && typeof saved.env === "object" && !Array.isArray(saved.env)
      ? Object.fromEntries(
          Object.entries(saved.env).filter(([, v]) => typeof v === "string"),
        )
      : {};
  return {
    preset: text("preset"),
    command: text("command"),
    args: strings(saved.args),
    env,
    workspace: text("workspace"),
    instructions: text("instructions"),
    model: text("model"),
    effort: text("effort"),
    scope: saved.scope === "channel" ? "channel" : "thread",
    approval: text("approval"),
  };
}

/** Switches to a preset: its command and args replace the current ones, and
 * the approval goes until the owner confirms again. */
export function withPreset(current: Config, id: string): Config {
  const chosen = preset(id);
  return {
    ...current,
    preset: chosen ? chosen.id : CUSTOM,
    ...(chosen && { command: chosen.command, args: [...chosen.args] }),
    approval: "",
  };
}

/** The forms the native host accepts for a process directory. */
const ABSOLUTE = /^(\/|~$|~\/)/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names reserved for the agent's identity; the host strips inherited ones but
 * lets a caller set them, so a harness must never get them from settings. */
const RESERVED = /^(BUZZ_|NOSTR_)/i;

/** What's wrong with a config's launch settings, in order; empty when it can
 * launch. */
export function problems(value: Config): string[] {
  const found: string[] = [];
  const { command, args, env, workspace } = value;
  if (!command.trim()) found.push("Enter the command that starts the harness.");
  else if (command.startsWith("-"))
    found.push("The command can't start with `-`.");
  else if (command.includes("=")) found.push("The command can't contain `=`.");
  if (!workspace.trim()) found.push("Choose a workspace.");
  else if (!ABSOLUTE.test(workspace))
    found.push("The workspace must be an absolute path or start with `~/`.");
  if (args.some((arg) => arg === "" || arg.includes("\n")))
    found.push("Arguments can't be empty or span lines.");
  const fields = [command, workspace, ...args, ...Object.entries(env).flat()];
  if (fields.some((field) => field.includes("\0")))
    found.push("Settings can't contain NUL characters.");
  for (const name of Object.keys(env)) {
    if (!ENV_NAME.test(name))
      found.push(`\`${name}\` isn't a valid environment variable name.`);
    else if (RESERVED.test(name))
      found.push(`\`${name}\` is reserved for Buzz and can't be set here.`);
  }
  return found;
}

/** The launch an approval covers, in one fixed order: command, args in order,
 * env sorted by name with values, and workspace. JSON gives each string one
 * unambiguous encoding, so no two launches encode the same. */
function canonical({ command, args, env, workspace }: Config) {
  const vars = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify([
    "buzz.acp/approval/1",
    command,
    args,
    vars,
    workspace,
  ]);
}

/** The SHA-256 digest, in hex, of the launch `value` would run. It holds no
 * secret: anything that writes the stored config can write a matching one.
 * If config sync or import ever carries the launch fields, this must become
 * an HMAC with a device-local key first. */
export async function digest(value: Config): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Records the owner's confirmation of `value`'s launch as it stands. */
export async function approve(value: Config): Promise<Config> {
  const [problem] = problems(value);
  if (problem) throw new Error(problem);
  return { ...value, approval: await digest(value) };
}

/** Whether the owner has confirmed exactly this launch. */
export async function approved(value: Config): Promise<boolean> {
  return value.approval !== "" && value.approval === (await digest(value));
}

export type Launch = Readonly<{
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  workspace: string;
}>;

export const UNCONFIRMED = "Confirm this agent's command in its settings.";

/** The launch to run, from one read of the stored config, or why it can't. */
export async function launch(
  stored: unknown,
): Promise<{ launch: Launch } | { error: string }> {
  const value = config(stored);
  const [problem] = problems(value);
  if (problem) return { error: problem };
  if (!(await approved(value))) return { error: UNCONFIRMED };
  const { command, args, env, workspace } = value;
  return { launch: { command, args, env, workspace } };
}

/** The env values safe to show: only `PATH`, which decides what `env` runs. */
export const shownValue = (name: string, value: string) =>
  name === "PATH" ? value : undefined;

/** What another agent type may take: the instructions, never the launch. */
export function carry(saved: unknown): Carry {
  const { instructions } = config(saved);
  return instructions.trim() ? { instructions } : {};
}

/** A brought-over agent's config: its instructions, and no approval, so it
 * can't launch until the owner confirms its command here. */
export const adopt = (from: Carry, saved: Config): Config => ({
  ...saved,
  instructions: from.instructions ?? saved.instructions,
  approval: "",
});
