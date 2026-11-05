import { useSyncExternalStore } from "react";

/** A device-local boolean choice with an independent unsaved fallback. */
export function devicePreference(preferenceKey: string, changedEvent: string) {
  let unsavedPreference: boolean | undefined;

  function read(): boolean {
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
  function usePreference() {
    return useSyncExternalStore(subscribe, read);
  }
  function set(enabled: boolean): string | null {
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

  return { read, usePreference, set };
}
