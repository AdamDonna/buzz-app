// Starting and checking an ACP agent's harness from its confirmed launch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS } from "../../features/agent-harness/acp/process";
import { flush } from "../goose/goose-testing";
import { fakeHarness } from "./acp-testing";
import { approve, type Config, DEFAULT_CONFIG, UNCONFIRMED } from "./config";
import { check, HarnessProcess, READY } from "./harness";

const confirmed = (value: Partial<Config> = {}) =>
  approve({
    ...DEFAULT_CONFIG,
    preset: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    workspace: "~/work",
    ...value,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("check", () => {
  it("starts the confirmed launch through `env`, protected env last, then stops it", async () => {
    const fake = fakeHarness();
    const value = await confirmed({
      args: ["acp", "--model", "x y"],
      env: { FOO: "1" },
    });
    expect(await check(fake.spawn, value)).toBe(READY);
    const [harness] = fake.harnesses;
    expect(harness?.options.cwd).toBe("~/work");
    expect(harness?.options.args).toEqual([
      "cursor-agent",
      "acp",
      "--model",
      "x y",
    ]);
    expect(harness?.options.env).toEqual({
      FOO: "1",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
    });
    // The protected blanks come after the owner's env, so they win.
    expect(Object.keys(harness?.options.env ?? {})).toEqual([
      "FOO",
      "BUZZ_PRIVATE_KEY",
      "BUZZ_AUTH_TAG",
      "BUZZ_RELAY_URL",
    ]);
    expect(harness?.killed).toBe(true);
    // Check opens no session.
    expect(harness?.sent("session/new")).toEqual([]);
  });

  it("names the preset's install hint when the program is missing or can't run", async () => {
    for (const exitCode of [127, 126]) {
      const fake = fakeHarness({ exitCode });
      expect(await check(fake.spawn, await confirmed())).toBe(
        "cursor-agent wasn't found or couldn't run. Install the Cursor CLI: https://cursor.com/cli",
      );
    }
    const fake = fakeHarness({ exitCode: 127 });
    const custom = await confirmed({ preset: "custom", command: "my-acp" });
    expect(await check(fake.spawn, custom)).toBe(
      "my-acp wasn't found or couldn't run. Check it's installed and on your PATH.",
    );
  });

  it("reports another early exit by what the harness said", async () => {
    const fake = fakeHarness({ exitCode: 1 });
    expect(await check(fake.spawn, await confirmed())).toBe(
      "env: harness: No such file or directory",
    );
  });

  it("refuses a harness without HTTP MCP", async () => {
    const fake = fakeHarness({
      capabilities: { mcpCapabilities: { http: false } },
    });
    expect(await check(fake.spawn, await confirmed())).toBe(
      "This Cursor cannot reach Buzz tools (no HTTP MCP support)",
    );
    expect(fake.harnesses[0]?.killed).toBe(true);
  });

  it("stops a harness that never answers initialize", async () => {
    const value = await confirmed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = fakeHarness({ silent: ["initialize"] });
    const checking = check(fake.spawn, value);
    // The approval digest resolves outside the fake clock.
    while (!fake.harnesses[0]?.sent("initialize").length)
      await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(await checking).toBe("Cursor did not answer initialize in 60s");
    expect(fake.harnesses[0]?.killed).toBe(true);
  });

  it("runs nothing once the launch changed after it was confirmed", async () => {
    const value = await confirmed();
    for (const changed of [
      { ...value, command: "other" },
      { ...value, args: ["acp", "--yolo"] },
      { ...value, env: { FOO: "1" } },
      { ...value, workspace: "~/elsewhere" },
    ]) {
      const fake = fakeHarness();
      expect(await check(fake.spawn, changed)).toBe(UNCONFIRMED);
      expect(fake.harnesses).toEqual([]);
    }
  });

  it("runs nothing with a reserved env name, whatever its approval says", async () => {
    const fake = fakeHarness();
    const value = await confirmed();
    expect(
      await check(fake.spawn, {
        ...value,
        env: { BUZZ_PRIVATE_KEY: "nsec1leak" },
      }),
    ).toBe("`BUZZ_PRIVATE_KEY` is reserved for Buzz and can't be set here.");
    expect(fake.harnesses).toEqual([]);
  });
});

describe("HarnessProcess", () => {
  it("kills a harness that is still starting when stopped", async () => {
    const fake = fakeHarness({ silent: ["initialize"], holdExit: true });
    const g = { id: 1, launch: await confirmed() };
    const harness = new HarnessProcess(fake.spawn, fake.serve, () => g);
    const starting = harness.get();
    await vi.waitFor(() => expect(fake.harnesses).toHaveLength(1));
    harness.stop();
    await expect(starting).rejects.toThrow("The harness was stopped");
    expect(fake.harnesses[0]?.killed).toBe(true);
  });

  it("starts a generation's own launch again after its harness exits", async () => {
    const fake = fakeHarness();
    const g = { id: 1, launch: await confirmed() };
    const harness = new HarnessProcess(fake.spawn, fake.serve, () => g);
    const first = await harness.get();
    await first.kill();
    await flush();
    await harness.get();
    expect(fake.harnesses).toHaveLength(2);
  });

  it("keeps an old generation's process while held, and stops it on release", async () => {
    const fake = fakeHarness();
    const launch = await confirmed();
    let current = { id: 1, launch };
    const harness = new HarnessProcess(fake.spawn, fake.serve, () => current);
    const old = current;
    await harness.get(old);
    const lease = harness.hold(old);
    current = { id: 2, launch };
    harness.reap();
    await flush();
    expect(fake.harnesses[0]?.killed).toBeFalsy();
    lease.release();
    lease.release();
    await flush();
    expect(fake.harnesses[0]?.killed).toBe(true);
  });

  it("restarts the current process within its tries", async () => {
    const fake = fakeHarness();
    const g = { id: 1, launch: await confirmed() };
    const harness = new HarnessProcess(fake.spawn, fake.serve, () => g);
    await harness.get();
    await expect(harness.restart({ backoffMs: 1 })).resolves.toEqual({
      ok: true,
    });
    expect(fake.harnesses).toHaveLength(2);
  });
});
