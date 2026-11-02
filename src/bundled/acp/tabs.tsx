// An ACP agent's settings: a preset or a typed command, its args and env, and
// the screen where the owner confirms the exact launch before it can run.
import {
  type FocusEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Transcript } from "../../features/agents/activity-transcript";
import { ActivityTranscript } from "../../features/agents/ActivityTranscript";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import type {
  AgentCreateProps,
  AgentViewProps,
} from "../../features/agents/service";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  approve,
  approved,
  type Config,
  problems,
  config as readConfig,
  shownValue,
  withPreset,
} from "./config";
import { READY } from "./harness";
import { type ModelCache, picks } from "./models";
import { CUSTOM, preset, PRESETS } from "./presets";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const PRESET_GROUPS = [
  {
    label: "",
    options: [
      ...PRESETS.map(({ id, title, verified }) => ({
        value: id,
        label: verified ? title : `${title} (unverified)`,
      })),
      { value: CUSTOM, label: "Custom command" },
    ],
  },
];

type Row = Readonly<{ name: string; value: string }>;
const rowsOf = (env: Config["env"]): Row[] =>
  Object.entries(env).map(([name, value]) => ({ name, value }));
const replaced = (rows: readonly Row[], at: number, row: Row) =>
  rows.map((old, index) => (index === at ? row : old));
/** What an env row is called to a screen reader: its place, and its name
 * once it has one. Draft rows can share a name. */
const rowLabel = ({ name }: Row, index: number) =>
  `variable ${index + 1}${name.trim() ? ` (${name.trim()})` : ""}`;
/** The launch fields whose problems wait until the owner leaves them. */
type Part = "command" | "args" | "env" | "workspace";
const envOf = (rows: readonly Row[]) =>
  Object.fromEntries(
    rows.filter(({ name }) => name.trim()).map((r) => [r.name.trim(), r.value]),
  );

/** Whether the stored config's approval covers its launch as saved. */
function useApproved(value: Config) {
  const [current, setCurrent] = useState(false);
  const key = JSON.stringify(value);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` follows `key`.
  useEffect(() => {
    let live = true;
    approved(value).then((ok) => live && setCurrent(ok));
    return () => {
      live = false;
    };
  }, [key]);
  return current;
}

/** The exact launch, as the owner confirms it: argv, workspace, env names, and
 * the value of `PATH` only. */
export function Confirmation({ value }: Readonly<{ value: Config }>) {
  const names = Object.keys(value.env).sort();
  return (
    <dl className="grid gap-2">
      <dt>Runs</dt>
      <dd>
        <code>{JSON.stringify([value.command, ...value.args])}</code>
      </dd>
      <dt>In</dt>
      <dd>
        <code>{value.workspace}</code>
      </dd>
      <dt>Environment</dt>
      <dd>
        {names.length === 0
          ? "No extra variables."
          : names.map((name) => {
              const shown = shownValue(name, value.env[name] ?? "");
              return (
                <div key={name}>
                  <code>{shown === undefined ? name : `${name}=${shown}`}</code>
                </div>
              );
            })}
      </dd>
    </dl>
  );
}

const DEFAULT = "";
const SCOPE_GROUPS = [
  {
    label: "",
    options: [
      { value: "thread", label: "Each thread is its own session" },
      { value: "channel", label: "A channel's messages share one session" },
    ],
  },
];

/** A sign-in the harness asked for on a failed turn: the methods it
 * advertised, as text from the harness, never run. */
export type SignIn = Readonly<{
  methods: readonly Readonly<{ name: string; description?: string }>[];
}>;

/** One conversation in the History list. */
export type Conversation = Readonly<{
  key: string;
  channelId: string;
  root?: string;
  at: number;
  status?: "Working" | "Idle";
  title?: string;
  /** Whether a transcript can be read: a saved harness session. */
  replayable: boolean;
}>;

/** What the tabs read from and ask of the runtime. */
export type TabsRuntime = Readonly<{
  subscribe(listener: () => void): () => void;
  signIn(agent: string): SignIn | undefined;
  /** Restarts the agent's harness after the owner signs in. */
  recheck(agent: string): Promise<string | undefined>;
  conversations(agent: string): readonly Conversation[];
  /** Whether the agent's harness can replay its sessions; undefined until
   * known. */
  replays(agent: string): boolean | undefined;
  transcript(
    agent: string,
    key: string,
    signal: AbortSignal,
  ): Promise<Transcript | undefined>;
}>;

/** The model and effort pickers for `value`'s launch, from what its sessions
 * and Check have offered. A launch nothing has run yet offers only the
 * harness's own. */
function ModelFields({
  value,
  cache,
  onChange,
  disabled,
}: Readonly<{
  value: Config;
  cache: ModelCache;
  onChange(value: Config): void;
  disabled: boolean;
}>) {
  useSyncExternalStore(cache.subscribe, cache.snapshot);
  const { models } = picks(cache, value);
  const known = models.some((model) => model.id === value.model);
  const efforts = models.find((model) => model.id === value.model)?.efforts;
  const options = [
    { value: DEFAULT, label: "Harness default" },
    ...(value.model && !known
      ? [{ value: value.model, label: value.model }]
      : []),
    ...models.map((model) => ({ value: model.id, label: model.label })),
  ];
  return (
    <>
      <Select
        label="Model"
        variant="field"
        value={value.model}
        disabled={disabled}
        groups={[{ label: "", options }]}
        onValueChange={(model) => onChange({ ...value, model, effort: "" })}
      />
      {efforts && efforts.length > 0 && (
        <Select
          label="Thinking"
          variant="field"
          value={value.effort}
          disabled={disabled}
          groups={[
            {
              label: "",
              options: [
                { value: DEFAULT, label: "Harness default" },
                ...efforts.map((e) => ({ value: e.id, label: e.label })),
              ],
            },
          ]}
          onValueChange={(effort) => onChange({ ...value, effort })}
        />
      )}
    </>
  );
}

/** Sign-in guidance after a turn failed on login: the preset's own advice,
 * the methods the harness named, and Recheck once the owner signed in. */
function SignInGuidance({
  agent,
  presetId,
  runtime,
}: Readonly<{ agent: string; presetId: string; runtime: TabsRuntime }>) {
  const signIn = useSyncExternalStore(runtime.subscribe, () =>
    runtime.signIn(agent),
  );
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<string>();
  if (!signIn) return null;
  const recheck = async () => {
    setChecking(true);
    setFailed(undefined);
    try {
      setFailed(await runtime.recheck(agent));
    } finally {
      setChecking(false);
    }
  };
  return (
    <section role="alert" className="grid gap-2">
      <h3 className="m-0 text-body">Sign in to the harness</h3>
      <p>
        Its last turn failed because it needs you to sign in.{" "}
        {preset(presetId)?.login ?? "Sign in the way your harness documents."}
      </p>
      {signIn.methods.length > 0 && (
        <div>
          <p>The harness says it supports these (instructions from it):</p>
          <ul>
            {signIn.methods.map((method) => (
              <li key={method.name}>
                {method.name}
                {method.description ? `: ${method.description}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Button loading={checking} onClick={recheck}>
          Recheck
        </Button>
      </div>
      {failed && <p className="buzz-field-error">Recheck failed: {failed}</p>}
    </section>
  );
}

export function createTabs({
  check,
  cache,
  runtime,
}: Readonly<{
  /** Starts the saved, confirmed harness once and says what it found. */
  check(config: Config): Promise<string>;
  cache: ModelCache;
  runtime: TabsRuntime;
}>) {
  /** The New agent dialog's part: harness, command, workspace and
   * instructions. The command is confirmed later, in Settings. */
  function Create({
    config: raw,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    const value = readConfig(raw);
    return (
      <div className="grid gap-4">
        <Select
          label="Harness"
          variant="field"
          value={value.preset}
          disabled={disabled}
          groups={PRESET_GROUPS}
          onValueChange={(id) => onChange(withPreset(value, id))}
        />
        <Field
          label="Command"
          description="You confirm the exact command in the agent's settings before it runs."
        >
          <Input
            value={value.command}
            disabled={disabled}
            onValueChange={(command) =>
              onChange({ ...value, command, preset: CUSTOM })
            }
          />
        </Field>
        <Field label="Workspace" description="The folder the harness works in.">
          <Input
            value={value.workspace}
            disabled={disabled}
            onValueChange={(workspace) => onChange({ ...value, workspace })}
          />
        </Field>
        <AgentInstructions
          value={value.instructions}
          disabled={disabled}
          onChange={(instructions) => onChange({ ...value, instructions })}
        />
      </div>
    );
  }

  /** The compact model field: a new draft has no confirmed launch yet, so it
   * shows the harness's own. */
  function CreateModel({
    config: raw,
    onChange,
    disabled,
  }: AgentCreateProps<Config>) {
    return (
      <ModelFields
        value={readConfig(raw)}
        cache={cache}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  function SettingsTab({ agent, save, settingsHost }: AgentViewProps<Config>) {
    const saved = readConfig(agent.config);
    const [draft, setDraft] = useState(saved);
    const [rows, setRows] = useState(() => rowsOf(saved.env));
    // Untouched, the stored argv stays exact, so one the box can't show is refused.
    const [args, setArgs] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirming, setConfirming] = useState(false);
    const [confirmError, setConfirmError] = useState("");
    const [checking, setChecking] = useState(false);
    const [checked, setChecked] = useState<{ ready: boolean; text: string }>();
    // An edited field's problems wait until the owner leaves it or saves.
    const [left, setLeft] = useState<ReadonlySet<Part>>(new Set());
    const [submitted, setSubmitted] = useState(false);
    // Focus moving within a field's group doesn't leave it.
    const leave = (part: Part) => (event: FocusEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null))
        return;
      if (!left.has(part)) setLeft(new Set([...left, part]));
    };
    // The env control to focus once rows re-render, after Add or Remove.
    const env = useRef<HTMLFieldSetElement>(null);
    const [focusing, setFocusing] = useState<string>();
    useEffect(() => {
      if (focusing === undefined) return;
      env.current?.querySelector<HTMLElement>(focusing)?.focus();
      setFocusing(undefined);
    }, [focusing]);
    // A preset switch needs a new confirmation, even back to the same command.
    const [reset, setReset] = useState(false);
    const current = useApproved(saved) && !reset;
    const edited: Config = {
      ...draft,
      approval: reset ? "" : saved.approval,
      args:
        args === undefined ? saved.args : args === "" ? [] : args.split("\n"),
      env: envOf(rows),
    };
    const configChanged = JSON.stringify(edited) !== JSON.stringify(saved);
    const changed = configChanged || Boolean(settingsHost?.pendingSave);
    const found = problems(edited);
    // Until then the field counts as saved, so stored problems show at once.
    const counted = (part: Part) => submitted || left.has(part);
    const shown = problems({
      ...edited,
      command: counted("command") ? edited.command : saved.command,
      args: counted("args") ? edited.args : saved.args,
      env: counted("env") ? edited.env : saved.env,
      workspace: counted("workspace") ? edited.workspace : saved.workspace,
    });
    const launchChanged =
      JSON.stringify([
        edited.command,
        edited.args,
        edited.env,
        edited.workspace,
      ]) !==
      JSON.stringify([saved.command, saved.args, saved.env, saved.workspace]);
    const run = async (work: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await work();
      } catch (reason) {
        setError(message(reason));
      } finally {
        setBusy(false);
      }
    };
    // Saving a launch the owner hasn't confirmed drops the approval.
    const submit = () => {
      setSubmitted(true);
      // A Check still running would report on a launch no longer saved.
      if (found.length > 0 || checking) return;
      return run(async () => {
        await save(
          (await approved(edited)) ? edited : { ...edited, approval: "" },
        );
        setChecked(undefined);
        setReset(false);
        setSubmitted(false);
        setLeft(new Set());
      });
    };
    const closeDialog = () => {
      setConfirming(false);
      setConfirmError("");
    };
    // Its failure stays in the dialog, where Confirm can be tried again.
    const confirm = async () => {
      setBusy(true);
      setConfirmError("");
      try {
        await save(await approve(saved));
        setConfirming(false);
      } catch (reason) {
        setConfirmError(message(reason));
      } finally {
        setBusy(false);
      }
    };
    const runCheck = async () => {
      setChecking(true);
      setChecked(undefined);
      try {
        const text = await check(saved);
        setChecked({ ready: text === READY, text });
      } catch (reason) {
        setChecked({ ready: false, text: message(reason) });
      } finally {
        setChecking(false);
      }
    };
    const removeRow = (index: number) => {
      const next = rows.filter((_, i) => i !== index);
      setRows(next);
      // The row that took its place, else the one before, else Add.
      const target = Math.min(index, next.length - 1);
      setFocusing(
        target < 0 ? "[data-env-add]" : `[data-env-remove="${target}"]`,
      );
    };
    return (
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {settingsHost?.typeControl?.(configChanged)}
        <SignInGuidance
          agent={agent.pubkey}
          presetId={saved.preset}
          runtime={runtime}
        />
        {!saved.command && preset(saved.preset) && (
          <p role="status">
            Set up on this device: choose{" "}
            <Button
              variant="ghost"
              onClick={() => {
                const next = withPreset(edited, saved.preset);
                setDraft(next);
                setArgs(next.args.join("\n"));
                setReset(true);
              }}
            >
              Use {preset(saved.preset)?.title}
            </Button>{" "}
            to fill in its command, then save and confirm it.
          </p>
        )}
        <Select
          label="Harness"
          variant="field"
          value={draft.preset}
          groups={PRESET_GROUPS}
          onValueChange={(id) => {
            const next = withPreset(edited, id);
            setDraft(next);
            setArgs(next.args.join("\n"));
            setReset(true);
          }}
        />
        <Field
          label="Command"
          description="A program on your PATH or an absolute path. It runs without a shell."
        >
          <Input
            value={draft.command}
            onBlur={leave("command")}
            onValueChange={(command) =>
              setDraft({ ...draft, command, preset: CUSTOM })
            }
          />
        </Field>
        <Field label="Arguments" description="One argument per line.">
          <Textarea
            value={args ?? saved.args.join("\n")}
            onBlur={leave("args")}
            onChange={(event) => {
              setArgs(event.target.value);
              setDraft({ ...draft, preset: CUSTOM });
            }}
          />
        </Field>
        <fieldset ref={env} className="grid gap-2" onBlur={leave("env")}>
          <legend>Environment</legend>
          <p>
            Extra variables for the harness. Values are hidden, except PATH.
          </p>
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place.
            <div key={index} className="flex gap-2">
              <Input
                aria-label={`Name of ${rowLabel(row, index)}`}
                data-env-name={index}
                value={row.name}
                onValueChange={(name) =>
                  setRows(replaced(rows, index, { ...row, name }))
                }
              />
              <Input
                aria-label={`Value of ${rowLabel(row, index)}`}
                type={row.name.trim() === "PATH" ? "text" : "password"}
                value={row.value}
                onValueChange={(value) =>
                  setRows(replaced(rows, index, { ...row, value }))
                }
              />
              <Button
                aria-label={`Remove ${rowLabel(row, index)}`}
                data-env-remove={index}
                onClick={() => removeRow(index)}
              >
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button
              data-env-add=""
              onClick={() => {
                setRows([...rows, { name: "", value: "" }]);
                setFocusing(`[data-env-name="${rows.length}"]`);
              }}
            >
              Add variable
            </Button>
          </div>
        </fieldset>
        <Field
          label="Workspace"
          description="The folder the harness works in. Use ~/ for your home folder."
        >
          <Input
            value={draft.workspace}
            onBlur={leave("workspace")}
            onValueChange={(workspace) => setDraft({ ...draft, workspace })}
          />
        </Field>
        <ModelFields
          value={edited}
          cache={cache}
          disabled={false}
          onChange={({ model, effort }) =>
            setDraft({ ...draft, model, effort })
          }
        />
        <Select
          label="Sessions"
          variant="field"
          value={draft.scope}
          groups={SCOPE_GROUPS}
          onValueChange={(scope) =>
            setDraft({
              ...draft,
              scope: scope === "channel" ? "channel" : "thread",
            })
          }
        />
        <AgentInstructions
          value={draft.instructions}
          disabled={false}
          description="Sent ahead of the first message of every session."
          onChange={(instructions) => setDraft({ ...draft, instructions })}
        />
        {shown.map((problem) => (
          <p key={problem} role="alert" className="buzz-field-error">
            {problem}
          </p>
        ))}
        {error && (
          <p role="alert" className="buzz-field-error">
            {error}
          </p>
        )}
        <p>
          The harness also loads the MCP servers in its own configuration, next
          to the Buzz tools.
        </p>
        <p>
          {launchChanged
            ? "You changed the command. After you save, confirm it again before the agent can run."
            : current
              ? "You confirmed this command."
              : "This command needs your confirmation before the agent can run."}
        </p>
        {checked &&
          (checked.ready ? (
            <p role="status">{checked.text}</p>
          ) : (
            <p role="alert" className="buzz-field-error">
              Check failed: {checked.text}
            </p>
          ))}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="prominent"
            loading={busy}
            disabled={!changed || checking}
            focusableWhenDisabled
          >
            Save
          </Button>
          <Button
            disabled={configChanged || current || problems(saved).length > 0}
            onClick={() => setConfirming(true)}
          >
            Confirm command
          </Button>
          <Button
            loading={checking}
            disabled={configChanged || !current || busy}
            onClick={runCheck}
          >
            Check
          </Button>
        </div>
        {confirming && (
          <Dialog
            open
            preventClose={busy}
            onOpenChange={(open) => {
              if (!open) closeDialog();
            }}
            title="Run this command?"
            description="This agent runs exactly this, with your permissions, each time it starts."
            actions={
              <>
                <Button disabled={busy} onClick={closeDialog}>
                  Cancel
                </Button>
                <Button variant="prominent" loading={busy} onClick={confirm}>
                  Confirm
                </Button>
              </>
            }
          >
            <Confirmation value={saved} />
            {confirmError && (
              <p role="alert" className="buzz-field-error">
                Couldn't save your confirmation: {confirmError}
              </p>
            )}
          </Dialog>
        )}
      </form>
    );
  }

  /** The agent's conversations on this device, each with its transcript
   * when the harness can replay it. */
  function HistoryTab({ agent }: AgentViewProps<Config>) {
    const rows = useSyncExternalStore(runtime.subscribe, () =>
      runtime.conversations(agent.pubkey),
    );
    const replays = useSyncExternalStore(runtime.subscribe, () =>
      runtime.replays(agent.pubkey),
    );
    const [open, setOpen] = useState<string>();
    const [read, setRead] = useState<
      | { status: "loading" }
      | { status: "done"; transcript: Transcript }
      | { status: "error"; error: string }
    >();
    useEffect(() => {
      if (open === undefined) return;
      const abort = new AbortController();
      setRead({ status: "loading" });
      runtime
        .transcript(agent.pubkey, open, abort.signal)
        .then((transcript) =>
          setRead(
            transcript
              ? { status: "done", transcript }
              : {
                  status: "error",
                  error: "This harness can't replay its transcripts.",
                },
          ),
        )
        .catch(
          (reason) =>
            !abort.signal.aborted &&
            setRead({ status: "error", error: message(reason) }),
        );
      return () => abort.abort();
    }, [agent.pubkey, open]);
    const label = (row: Conversation) =>
      row.title ||
      `${row.channelId.slice(0, 8)} · ${row.root ? `thread ${row.root.slice(0, 8)}` : "channel"}`;
    if (open !== undefined)
      return (
        <div className="grid gap-4">
          <div>
            <Button variant="ghost" onClick={() => setOpen(undefined)}>
              Back
            </Button>
          </div>
          {read?.status === "loading" && <p role="status">Reading…</p>}
          {read?.status === "error" && (
            <p role="alert" className="buzz-field-error">
              {read.error}
            </p>
          )}
          {read?.status === "done" && (
            <ActivityTranscript
              transcript={read.transcript}
              agentName={agent.name}
              state={() => undefined}
            />
          )}
        </div>
      );
    if (!rows.length) return <p>No conversations on this device yet.</p>;
    return (
      <div className="grid gap-2">
        {replays === false && <p>This harness can't replay its transcripts.</p>}
        <ul className="grid gap-1">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center gap-2">
              <span className="grow">
                {label(row)}
                {row.status ? ` · ${row.status}` : ""} ·{" "}
                {new Date(row.at).toLocaleString()}
              </span>
              {replays !== false && row.replayable && (
                <Button variant="ghost" onClick={() => setOpen(row.key)}>
                  Transcript
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return { Create, CreateModel, SettingsTab, HistoryTab };
}
