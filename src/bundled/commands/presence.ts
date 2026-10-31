import type { PresenceControl } from "../../features/presence/activity";

/** Sets the manual presence preference and fails unless it took effect, so a
 * missing viewer or an unsaved choice never reads as success. */
export function choosePresence(
  presence: PresenceControl,
  preference: "away" | "auto",
) {
  if (!presence.setPreference(preference))
    throw new Error("Could not change your availability.");
  const { error } = presence.snapshot();
  if (error) throw new Error(error);
}
