// The production Bestie page with only the host data boundary replaced: the
// account has no saved Bestie, so the page shows Choose your bestie. `?gone`
// saves Zed, who is no longer here, so the chooser shows in his place.
import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import * as bestie from "../../src/bundled/bestie/index";
import type { RelayData } from "../../src/features/relay/service";
import "../../src/shared/styles/globals.css";

const OWNER = "f".repeat(64);
const ADA = "a".repeat(64);
const CARA = "c".repeat(64);
const ZED = "e".repeat(64);
const gone = new URLSearchParams(location.search).has("gone");
const choice = (pubkey: string, name: string) => ({
  pubkey,
  name,
  managed: true,
});
const choices = {
  status: "ready",
  complete: true,
  pending: false,
  identities: [choice(ADA, "Ada"), choice(CARA, "Cara"), choice(ZED, "Zed")],
  // Zed is no longer in the community.
  selectable: [choice(ADA, "Ada"), choice(CARA, "Cara")],
  archives: { status: "ready", archived: [], readAt: 1 },
};
const listeners = new Set<() => void>();
const list = { status: "ready", channels: [] };
let record: string | undefined = gone ? ZED : undefined;
const connection = {
  status: "ready",
  origin: "https://relay.example",
  viewer: OWNER,
  scope: `https://relay.example:${OWNER}`,
  session: {
    viewer: OWNER,
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList: () => () => {},
    },
    mainAgent: {
      read: async () => record,
      write: async (agent: string | null) => {
        record = agent ?? undefined;
      },
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
      refresh: async () => {},
    },
  },
};
const relay = {
  snapshot: () => connection,
  subscribe: () => () => {},
  retry: () => {},
} as unknown as RelayData;
// Ada runs on this device; Cara is hosted.
const snapshot = {
  agents: [
    { pubkey: ADA, name: "Ada", place: "here" },
    { pubkey: CARA, name: "Cara", place: "hosted" },
  ],
  running: [],
};
const types: never[] = [];
let Page: ComponentType<Record<string, unknown>> | undefined;
const ctx = {
  relay,
  navigation: {},
  conversation: {},
  agents: {
    registerTab: () => {},
    snapshot: () => snapshot,
    subscribe: () => () => {},
    types: () => types,
  },
  // The plugin's background effects aren't part of the page.
  effect: () => {},
  pages: {
    register: (page: { component: typeof Page }) => {
      Page = page.component;
    },
  },
};
(bestie.apply as (ctx: unknown) => void)(ctx);
if (!Page) throw new Error("The Bestie plugin registered no page");
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Page />);
