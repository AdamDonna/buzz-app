// Long-tail harnesses an owner can start from. Choosing one prefills the
// command and args; nothing here is launched until the owner confirms it.
// A preset counts as verified only after an authenticated `session/new` and a
// Buzz tool call over HTTP MCP have passed through the desktop app.

export type Preset = Readonly<{
  id: string;
  title: string;
  command: string;
  args: readonly string[];
  /** How to install or set up the harness, shown when its program is missing. */
  install: string;
  /** How to sign in, shown when a turn fails on login. */
  login: string;
  verified: boolean;
}>;

export const CUSTOM = "custom";

export const PRESETS: readonly Preset[] = [
  {
    id: "cursor",
    title: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    install: "Install the Cursor CLI: https://cursor.com/cli",
    login: "Run `cursor-agent login`.",
    verified: false,
  },
  {
    id: "opencode",
    title: "OpenCode",
    command: "opencode",
    args: ["acp"],
    install: "Install OpenCode: https://opencode.ai",
    login: "Run `opencode auth login`.",
    verified: false,
  },
  {
    id: "amp",
    title: "Amp",
    command: "amp-acp",
    args: [],
    install: "Install `amp` and the `amp-acp` adapter.",
    login: "Run `amp-acp --setup` to set your API key.",
    verified: false,
  },
  {
    id: "gemini",
    title: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    install: "Install Gemini CLI: https://github.com/google-gemini/gemini-cli",
    login: "Run `gemini` once to sign in with Google, or set `GEMINI_API_KEY`.",
    verified: false,
  },
  {
    id: "devin",
    title: "Devin",
    command: "devin",
    args: ["acp"],
    install: "Install the Devin CLI.",
    login: "Run `devin` once to sign in in your browser.",
    verified: false,
  },
  {
    id: "grok",
    title: "Grok Build",
    command: "grok",
    args: ["agent", "--always-approve", "stdio"],
    install: "Install the Grok CLI.",
    login: "Run `grok` once to sign in.",
    verified: false,
  },
  {
    id: "kimi",
    title: "Kimi Code",
    command: "kimi",
    args: ["acp"],
    install: "Install Kimi Code: https://code.kimi.com",
    login: "Run `kimi` once to sign in.",
    verified: false,
  },
  {
    id: "omp",
    title: "Oh My Pi",
    command: "omp",
    args: ["acp"],
    install: "Install Oh My Pi; it needs Bun on your PATH.",
    login: "Run `omp` once to sign in.",
    verified: false,
  },
];

export const preset = (id: string) => PRESETS.find((p) => p.id === id);
