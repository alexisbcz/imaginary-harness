import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const query = "(prefers-color-scheme: dark)";
const storageKey = "richelieu.theme";
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be unavailable (private windows, blocked site data): fall back to the system.
  }
  return "system";
}

let preference = readPreference();

/** Chooses light, dark, or following the system, remembered in this browser. */
export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
  } catch {
    // The choice still applies for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", onChange);
  listeners.add(onChange);
  // Another tab changing the theme changes it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return;
    preference = readPreference();
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    media.removeEventListener("change", onChange);
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The chosen theme: light, dark, or "system". */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference);
}

/** The scheme in effect: the chosen theme, or the system's preference followed live. */
export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () => {
    if (preference !== "system") return preference;
    return window.matchMedia(query).matches ? "dark" : "light";
  });
}
