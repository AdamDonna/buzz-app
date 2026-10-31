import type { Context } from "@deepseek-ai/cordis";
import { createStatusSheet } from "../../src/features/user-status/sheet";

/** The services `buzz.commands` injects. These fixtures mount only a composer,
 * so there is no viewer to set presence for and no profile menu to bind. */
export function provideCommandServices(context: Context) {
  context.provide("presence", {
    snapshot: () => ({
      status: "online",
      preference: "auto",
      error: undefined,
    }),
    setPreference: () => false,
  });
  context.provide("statusSheet", createStatusSheet().sheet);
}
