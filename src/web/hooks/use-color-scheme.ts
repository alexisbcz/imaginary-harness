import { useSyncExternalStore } from "react";

const query = "(prefers-color-scheme: dark)";

/** The system's light or dark preference, followed live. */
export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => (window.matchMedia(query).matches ? "dark" : "light"),
  );
}
