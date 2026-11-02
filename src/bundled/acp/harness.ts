// An ACP agent's own harness process, started from the launch its owner
// confirmed, on the shared ACP client with no extensions: plain ACP's system
// prompt or a prepend, queued messages instead of steering, and
// `session/close` only when advertised.
import { AcpProcess } from "../../features/agent-harness/acp/process";
import {
  errorMessage,
  HintedError,
} from "../../features/agent-harness/acp/steps";
import { probeOptions } from "../../features/agent-harness/acp/transcript";
import type {
  AcpHooks,
  Generation,
  OptionState,
  ServeMcp,
  Settled,
  Spawn,
} from "../../features/agent-harness/acp/types";
import { config, type Launch, launch, UNCONFIRMED } from "./config";
import { preset } from "./presets";

/** How long Check waits for the harness to exit once it has answered. */
const CHECK_STOP_MS = 5_000;
/** How long Check waits for the harness to list its models. */
const PROBE_MS = 20_000;
/** Recheck's bounds: one deadline over every try, and a doubling backoff. */
const RESTART_DEADLINE_MS = 30_000;
const RESTART_TRIES = 3;
const RESTART_BACKOFF_MS = 1_000;

export const READY =
  "Ready to start. Sign-in problems show up on the first turn.";

/** The error for a launch whose program can't be found, with its install
 * hint. */
export const missing = (presetId: string, command: string) =>
  `${command} wasn't found or couldn't run. ${
    preset(presetId)?.install ?? "Check it's installed and on your PATH."
  }`;

/** The client's hooks for one launch: errors name the preset, and a missing
 * program shows its install hint. */
export function hooks(presetId: string, { command }: Launch): AcpHooks {
  return {
    label: preset(presetId)?.title ?? command,
    program: "harness",
    missing: missing(presetId, command),
    missingHint:
      preset(presetId)?.install ??
      "Check the harness is installed and on your PATH.",
    env: {},
    diagnoseStartup: true,
  };
}

/** Starts the confirmed launch of one read of `stored`, or throws why it
 * can't: the approval is checked against that same read. The process runs
 * `env command ...args`, so the argv reaches the harness exactly. */
export async function start(
  spawn: Spawn,
  stored: unknown,
  options: Readonly<{ serve?: ServeMcp; signal?: AbortSignal }> = {},
) {
  const snapshot = config(stored);
  const found = await launch(snapshot);
  // Only the unconfirmed launch's error is advice to post: the others can
  // quote what the owner typed, such as a value pasted into an env name.
  if ("error" in found)
    throw found.error === UNCONFIRMED
      ? new HintedError(UNCONFIRMED, UNCONFIRMED)
      : new Error(found.error);
  const { command, args, env, workspace } = found.launch;
  return AcpProcess.start(spawn, hooks(snapshot.preset, found.launch), {
    cwd: workspace,
    args: [command, ...args],
    env,
    ...options,
  });
}

/** One launch generation's process: started when first needed, and again
 * after it exits, while anything holds it or it is the current one. */
type Slot = {
  readonly launch: unknown;
  ready?: Promise<AcpProcess> | undefined;
  starting?: AbortController | undefined;
  holds: number;
};

/** One agent's harness processes, one per launch generation (an accepted
 * launch config, `Generation`). New sessions use the current generation; one
 * still opening or mid-turn on an older generation keeps that process alive
 * by holding it, and it stops once its last hold goes. */
export class HarnessProcess {
  private readonly slots = new Map<number, Slot>();
  private restarting: Promise<Settled> | undefined;
  private stopped = false;
  constructor(
    private readonly spawn: Spawn,
    private readonly serve: ServeMcp,
    /** The current generation, read when needed. */
    private readonly current: () => Generation,
  ) {}

  private slot(g: Generation) {
    let slot = this.slots.get(g.id);
    if (!slot) {
      slot = { launch: g.launch, holds: 0 };
      this.slots.set(g.id, slot);
    }
    return slot;
  }

  /** The process for exactly generation `g`, started from `g`'s launch,
   * never from current settings or another generation's. */
  get(g: Generation = this.current()): Promise<AcpProcess> {
    if (this.stopped)
      return Promise.reject(new Error("The harness was stopped"));
    const slot = this.slot(g);
    if (slot.ready) return slot.ready;
    const starting = new AbortController();
    const ready = start(this.spawn, slot.launch, {
      serve: this.serve,
      signal: starting.signal,
    });
    const forget = () => {
      if (slot.ready !== ready) return;
      slot.ready = undefined;
      slot.starting = undefined;
    };
    void ready.then((acp) => acp.exited.then(forget), forget);
    slot.ready = ready;
    slot.starting = starting;
    return ready;
  }

  /** Keeps `g`'s process alive until `release`, which is idempotent. */
  hold(g: Generation) {
    const slot = this.slot(g);
    slot.holds++;
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        slot.holds--;
        this.reap();
      },
    };
  }

  /** Stops every old generation's process that nothing holds. */
  reap() {
    const current = this.current().id;
    for (const [id, slot] of this.slots)
      if (id !== current && slot.holds === 0) {
        this.slots.delete(id);
        end(slot);
      }
  }

  /** Stops the current generation's process and starts its launch again, read
   * afresh, within `tries` and `deadlineMs`. One restart runs at a time; a
   * second call joins it. */
  restart(
    o: Readonly<{
      signal?: AbortSignal;
      deadlineMs?: number;
      tries?: number;
      backoffMs?: number;
    }> = {},
  ): Promise<Settled> {
    this.restarting ??= this.restartOnce(o).finally(() => {
      this.restarting = undefined;
    });
    return this.restarting;
  }
  private async restartOnce({
    signal,
    deadlineMs = RESTART_DEADLINE_MS,
    tries = RESTART_TRIES,
    backoffMs = RESTART_BACKOFF_MS,
  }: Readonly<{
    signal?: AbortSignal;
    deadlineMs?: number;
    tries?: number;
    backoffMs?: number;
  }>): Promise<Settled> {
    const g = this.current();
    const old = this.slots.get(g.id);
    if (old) {
      const ready = old.ready;
      old.ready = undefined;
      old.starting?.abort(new Error("The harness is restarting"));
      old.starting = undefined;
      await ready
        ?.then((acp) => acp.stop(CHECK_STOP_MS))
        .catch(() => undefined);
    }
    const bound = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(deadlineMs),
      this.disposed.signal,
    ]);
    let last: unknown = new Error("The harness didn't restart");
    for (let attempt = 0; attempt < tries; attempt++) {
      if (bound.aborted) break;
      if (attempt > 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs * 2 ** (attempt - 1));
          bound.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      if (bound.aborted) break;
      const ready = this.get(this.current());
      const slot = this.slots.get(this.current().id);
      const cancel = () => slot?.starting?.abort(bound.reason);
      bound.addEventListener("abort", cancel);
      try {
        await ready;
        return { ok: true };
      } catch (error) {
        last = error;
      } finally {
        bound.removeEventListener("abort", cancel);
      }
    }
    if (bound.aborted) last = bound.reason ?? last;
    return { ok: false, error: errorMessage(last) };
  }
  private readonly disposed = new AbortController();

  /** Stops every process, failing every session in them; a start in progress
   * is cancelled and its process killed. Nothing starts after it. */
  stop() {
    this.stopped = true;
    this.disposed.abort(new Error("The harness was stopped"));
    for (const slot of this.slots.values()) end(slot);
    this.slots.clear();
  }
}

/** Cancels `slot`'s start, or kills its process. */
function end(slot: Slot) {
  const ready = slot.ready;
  slot.ready = undefined;
  slot.starting?.abort(new Error("The harness was stopped"));
  slot.starting = undefined;
  void ready?.then((acp) => acp.kill()).catch(() => undefined);
}

/** Starts the confirmed harness once, the way a run does but opening no
 * session, and says whether it can run: why it can't (its program is
 * missing, it refuses Buzz tools, the launch isn't confirmed), or that it's
 * ready. */
export async function check(
  spawn: Spawn,
  stored: unknown,
  /** When given, a ready harness is also asked what models it offers, in one
   * more process of its own with no Buzz tools and no saved record. */
  probe?: Readonly<{
    resolveDirectory(path: string): Promise<string>;
    onState(state: OptionState): void;
  }>,
): Promise<string> {
  try {
    const acp = await start(spawn, stored);
    await acp.stop(CHECK_STOP_MS);
  } catch (error) {
    return errorMessage(error);
  }
  // Its failure leaves Check's answer as it was.
  if (probe)
    try {
      const cwd = await probe.resolveDirectory(config(stored).workspace);
      const state = await probeOptions(
        (o) => start(spawn, stored, o),
        cwd,
        AbortSignal.timeout(PROBE_MS),
      );
      if (state) probe.onState(state);
    } catch (error) {
      console.warn("ACP harness didn't list its models", error);
    }
  return READY;
}
