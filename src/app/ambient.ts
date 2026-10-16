import { useEffect, useSyncExternalStore } from "react";

/**
 * Ambient backdrop: the screen's focused content (a thumbnail, game art, the
 * programme on air…) becomes the app's backdrop and tints the whole UI, like
 * Google TV / Apple TV. Screens set it; the shell renders it.
 */
export interface Ambient {
  /** Image sources to try in order. */
  images: string[];
  /** CSS background used when there's no image (or while it loads). */
  fallback?: string;
  /** Changes the crossfade even if images repeat. */
  key: string;
}

const PREF = "nova.ambient";
let current: Ambient | null = null;
let enabled = (() => {
  try {
    return localStorage.getItem(PREF) !== "off";
  } catch {
    return true;
  }
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const ambient = {
  set(next: Ambient | null) {
    if (next?.key === current?.key) return;
    current = next;
    emit();
  },
  get enabled() {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    try {
      localStorage.setItem(PREF, on ? "on" : "off");
    } catch {}
    emit();
  },
};

export function useAmbient(): { value: Ambient | null; enabled: boolean } {
  const value = useSyncExternalStore(subscribe, () => current);
  const on = useSyncExternalStore(subscribe, () => enabled);
  return { value, enabled: on };
}

/** Clears the backdrop when a screen without one is shown. */
export function useClearAmbient() {
  useEffect(() => ambient.set(null), []);
}
