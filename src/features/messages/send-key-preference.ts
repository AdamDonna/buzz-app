import { useSyncExternalStore } from "react";

/** Device-local choice: ⌘/Ctrl+Enter sends and Enter adds a line. Off by default. */
const preferenceKey = "buzz-send-with-mod-enter.v1";
const changedEvent = "buzz-send-with-mod-enter-changed";
let unsavedPreference: boolean | undefined;

export function sendWithModEnterPreference(): boolean {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return localStorage.getItem(preferenceKey) === "on";
  } catch {
    return false;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    unsavedPreference = undefined;
    listener();
  };
  window.addEventListener(changedEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changedEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
export function useSendWithModEnterPreference() {
  return useSyncExternalStore(subscribe, sendWithModEnterPreference);
}
export function setSendWithModEnterPreference(enabled: boolean): string | null {
  let error: string | null = null;
  unsavedPreference = enabled;
  try {
    localStorage.setItem(preferenceKey, enabled ? "on" : "off");
    unsavedPreference = undefined;
  } catch {
    error =
      "This choice is active, but could not be saved on this device. Try again.";
  }
  window.dispatchEvent(new Event(changedEvent));
  return error;
}
