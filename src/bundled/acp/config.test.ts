import { describe, expect, it } from "vitest";
import {
  adopt,
  approve,
  approved,
  carry,
  config,
  DEFAULT_CONFIG,
  digest,
  launch,
  problems,
  UNCONFIRMED,
  withPreset,
  type Config,
} from "./config";
import { PRESETS } from "./presets";

const base: Config = {
  ...DEFAULT_CONFIG,
  command: "cursor-agent",
  args: ["acp"],
  env: { CURSOR_API_KEY: "secret" },
};

describe("problems", () => {
  it("accepts a complete launch", () => {
    expect(problems(base)).toEqual([]);
  });

  it.each([
    ["", "Enter the command"],
    ["  ", "Enter the command"],
    ["-i", "can't start with `-`"],
    ["FOO=bar", "can't contain `=`"],
  ])("rejects the command %j", (command, message) => {
    expect(problems({ ...base, command })[0]).toContain(message);
  });

  it.each([
    ["command", { command: "a\0b" }],
    ["an arg", { args: ["ok", "a\0b"] }],
    ["an env value", { env: { KEY: "a\0b" } }],
    ["the workspace", { workspace: "/tmp\0" }],
  ])("rejects NUL in %s", (_, change) => {
    expect(problems({ ...base, ...change })).toContain(
      "Settings can't contain NUL characters.",
    );
  });

  it.each(["relative/folder", "./here", "~user/x"])(
    "rejects the workspace %j",
    (workspace) => {
      expect(problems({ ...base, workspace })).toContain(
        "The workspace must be an absolute path or start with `~/`.",
      );
    },
  );

  it.each([["acp", ""], ["a\nb"]])("rejects the args %j", (...args) => {
    expect(problems({ ...base, args })).toContain(
      "Arguments can't be empty or span lines.",
    );
  });

  it.each(["1KEY", "A-B", "", "A B"])("rejects the env name %j", (name) => {
    expect(problems({ ...base, env: { [name]: "x" } })[0]).toContain(
      "isn't a valid environment variable name",
    );
  });

  it.each(["BUZZ_PRIVATE_KEY", "BUZZ_X", "NOSTR_KEY", "buzz_relay_url"])(
    "rejects the reserved env name %s",
    (name) => {
      expect(problems({ ...base, env: { [name]: "x" } })[0]).toContain(
        "is reserved for Buzz",
      );
    },
  );

  it("allows names that only contain BUZZ", () => {
    expect(problems({ ...base, env: { MY_BUZZ_X: "x" } })).toEqual([]);
  });
});

describe("approval", () => {
  it("holds for the confirmed launch, whatever the env order", async () => {
    const confirmed = await approve({ ...base, env: { A: "1", B: "2" } });
    expect(await approved(confirmed)).toBe(true);
    expect(await approved({ ...confirmed, env: { B: "2", A: "1" } })).toBe(
      true,
    );
  });

  it("is not needed for instructions", async () => {
    const confirmed = await approve(base);
    expect(await approved({ ...confirmed, instructions: "be brief" })).toBe(
      true,
    );
  });

  it.each<[string, Partial<Config>]>([
    ["the command", { command: "cursor" }],
    ["an arg", { args: ["acp", "--x"] }],
    ["the arg order", { args: ["b", "a"] }],
    ["an arg split", { args: ["a b"] }],
    ["an env value", { env: { CURSOR_API_KEY: "other" } }],
    ["an env name", { env: { OTHER_KEY: "secret" } }],
    ["an added env var", { env: { CURSOR_API_KEY: "secret", PATH: "/x" } }],
    ["the workspace", { workspace: "/tmp" }],
  ])("is lost when %s changes", async (_, change) => {
    const confirmed = await approve({ ...base, args: ["a", "b"] });
    expect(await approved({ ...confirmed, ...change })).toBe(false);
  });

  it("is lost on a preset switch, even to the same command", async () => {
    const confirmed = await approve(withPreset(base, "cursor"));
    expect(await approved(confirmed)).toBe(true);
    const switched = withPreset(confirmed, "cursor");
    expect(switched.approval).toBe("");
    expect(await approved(switched)).toBe(false);
  });

  it("is refused for an invalid launch", async () => {
    await expect(approve({ ...base, command: "" })).rejects.toThrow();
  });

  it("does not hold for an empty or forged approval", async () => {
    expect(await approved(base)).toBe(false);
    expect(await approved({ ...base, approval: "00".repeat(32) })).toBe(false);
  });
});

describe("launch", () => {
  it("returns the confirmed launch", async () => {
    const stored = await approve(base);
    expect(await launch(stored)).toEqual({
      launch: {
        command: "cursor-agent",
        args: ["acp"],
        env: { CURSOR_API_KEY: "secret" },
        workspace: "~/.buzz",
      },
    });
  });

  it("refuses an unconfirmed or changed launch", async () => {
    expect(await launch(base)).toEqual({ error: UNCONFIRMED });
    const stored = await approve(base);
    expect(await launch({ ...stored, args: ["other"] })).toEqual({
      error: UNCONFIRMED,
    });
  });

  it("refuses a reserved env name even with a matching digest", async () => {
    const forged = { ...base, env: { BUZZ_PRIVATE_KEY: "x" } };
    const stored = { ...forged, approval: await digest(forged) };
    expect(await launch(stored)).toEqual({
      error: expect.stringContaining("reserved for Buzz"),
    });
  });

  it("reads a malformed stored config as unconfirmed defaults", async () => {
    expect(config("junk")).toEqual(DEFAULT_CONFIG);
    expect(
      config({ args: ["a", 1], env: { A: "1", B: 2 }, command: 3 }),
    ).toMatchObject({ args: ["a"], env: { A: "1" }, command: "" });
    expect(await launch(null)).toEqual({
      error: "Enter the command that starts the harness.",
    });
  });
});

describe("presets", () => {
  it("are all unverified and valid", () => {
    for (const p of PRESETS) {
      expect(p.verified).toBe(false);
      expect(problems(withPreset(DEFAULT_CONFIG, p.id))).toEqual([]);
    }
  });
});

describe("carry and adopt", () => {
  it("carries only the instructions", async () => {
    const saved = await approve({ ...base, instructions: "Triage." });
    expect(carry(saved)).toEqual({ instructions: "Triage." });
    expect(carry({ ...saved, instructions: " " })).toEqual({});
  });

  it("can't launch an adopted config until it is confirmed again", async () => {
    const confirmed = await approve(base);
    const adopted = adopt(
      { instructions: "Triage.", workspace: "/elsewhere" },
      confirmed,
    );
    expect(adopted).toMatchObject({
      instructions: "Triage.",
      workspace: base.workspace,
      approval: "",
    });
    expect(await launch(adopted)).toEqual({ error: UNCONFIRMED });
    expect("launch" in (await launch(await approve(adopted)))).toBe(true);
  });
});
