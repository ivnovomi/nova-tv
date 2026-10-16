import { useSyncExternalStore } from "react";
import { api, inTauri } from "../lib/api";
import type { Profile, ProfilesInfo } from "../lib/types";

/**
 * Who's watching. The rules themselves live in Rust (a children's profile only
 * ever receives what it may see); this store just mirrors the state for the UI.
 */
let info: ProfilesInfo | null = null;
const listeners = new Set<() => void>();

function set(next: ProfilesInfo) {
  info = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useProfiles(): ProfilesInfo | null {
  return useSyncExternalStore(subscribe, () => info);
}

export function activeProfile(i: ProfilesInfo | null = info): Profile | null {
  return i?.profiles.find((p) => p.id === i.active) ?? i?.profiles[0] ?? null;
}

export function useActiveProfile(): Profile | null {
  return activeProfile(useProfiles());
}

/** Settings opened by a parent from a children's profile (for a few minutes). */
export function isUnlocked(i: ProfilesInfo | null = info) {
  return !!i?.unlockedUntil && i.unlockedUntil * 1000 > Date.now();
}

/** Avatars to pick from: friendly for every age. */
export const AVATARS = ["😎", "🦊", "🐼", "🦁", "🐸", "🐙", "🦄", "🐶", "🐱", "🐵", "🚀", "⚽", "🎮", "🎧", "🌈", "🍕", "👾", "🌙"];
export const COLORS = ["#6e6cff", "#3fd5f2", "#ff5c9a", "#ffb547", "#3ddc97", "#b46bff", "#ff6b4a", "#4a8bff"];

const apply = (p: Promise<ProfilesInfo>) =>
  p.then((next) => {
    set(next);
    return next;
  });

export const profiles = {
  async load() {
    if (!inTauri) return null;
    return apply(api.profilesGet());
  },
  switchTo: (id: string, pin?: string) => apply(api.profileSwitch(id, pin)),
  save: (input: Parameters<typeof api.profileSave>[0]) => apply(api.profileSave(input)),
  remove: (id: string) => apply(api.profileDelete(id)),
  setPin: (pin: string, current?: string) => apply(api.parentalSetPin(pin, current)),
  removePin: (current: string) => apply(api.parentalRemovePin(current)),
  unlock: (pin: string) => apply(api.parentalUnlock(pin)),
  lock: () => apply(api.parentalLock()),
  /** Leaving a children's profile for an adult one needs the parental PIN. */
  needsPin(target: Profile) {
    const current = activeProfile();
    return !!info?.hasPin && !!current?.kids && !target.kids && !isUnlocked();
  },
};
