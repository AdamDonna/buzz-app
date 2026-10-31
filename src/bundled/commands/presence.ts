import type { PresenceControl } from "../../features/presence/activity";

/** Sets the manual presence preference and fails unless it took effect, so a
 * missing viewer or an unsaved choice never reads as success. */
export function choosePresence(
  presence: PresenceControl,
  preference: "away" | "auto",
) {
  presence.setPreference(preference);
  const { preference: current, error } = presence.snapshot();
  if (current !== preference)
    throw new Error("Could not change your availability.");
  if (error) throw new Error(error);
}
