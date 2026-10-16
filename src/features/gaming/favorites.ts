import { useSyncExternalStore } from "react";
import { activeProfile } from "../../app/profiles";

/** Favourite games, per profile (pinned to their own shelf in NOVA PLAY). */
const key = () => `nova.play.favorites.${activeProfile()?.id ?? "principal"}`;
const listeners = new Set<() => void>();
let cache: { key: string; ids: string[] } | null = null;

function read(): string[] {
  const k = key();
  if (cache?.key === k) return cache.ids;
  let ids: string[] = [];
  try {
    ids = JSON.parse(localStorage.getItem(k) ?? "[]") as string[];
  } catch {}
  cache = { key: k, ids };
  return ids;
}

export const favorites = {
  toggle(id: string): boolean {
    const ids = read();
    const on = !ids.includes(id);
    const next = on ? [id, ...ids] : ids.filter((x) => x !== id);
    try {
      localStorage.setItem(key(), JSON.stringify(next));
    } catch {}
    cache = { key: key(), ids: next };
    listeners.forEach((l) => l());
    return on;
  },
};

export function useFavoriteGames(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}
