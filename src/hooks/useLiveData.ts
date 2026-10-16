import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import type { NowPlaying, PlayStats } from "../lib/types";

/** Play time per game id, refreshed whenever the game watcher records more. */
export function usePlaytime(): Record<string, PlayStats> {
  const [stats, setStats] = useState<Record<string, PlayStats>>({});
  const load = useCallback(() => {
    api.playtime().then(setStats, () => {});
  }, []);
  useEffect(() => {
    load();
    if (!inTauri) return;
    const off = listen("playtime-changed", load);
    return () => {
      void off.then((f) => f());
    };
  }, [load]);
  return stats;
}

/** What Windows is playing right now (any app), pushed by the backend. */
export function useNowPlaying(): NowPlaying | null {
  const [now, setNow] = useState<NowPlaying | null>(null);
  useEffect(() => {
    api.nowPlaying().then(setNow, () => {});
    if (!inTauri) return;
    const off = listen<NowPlaying | null>("now-playing", (e) => setNow(e.payload));
    return () => {
      void off.then((f) => f());
    };
  }, []);
  return now;
}

/** 0 → null, 2700 → "45 min", 45000 → "12 h 30 min" */
export function formatPlaytime(seconds: number): string | null {
  if (seconds < 60) return null;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** "Jugado 12 h · ayer" */
export function playtimeLabel(stats?: PlayStats): string | null {
  if (!stats) return null;
  const total = formatPlaytime(stats.totalSeconds);
  const when = stats.lastPlayed ? lastPlayedLabel(stats.lastPlayed) : null;
  if (!total) return when ? `Jugado ${when}` : null;
  return when ? `Jugado ${total} · ${when}` : `Jugado ${total}`;
}

function lastPlayedLabel(unix: number): string {
  const days = Math.floor((startOfToday() - unix * 1000) / 86_400_000) + 1;
  if (unix * 1000 >= startOfToday()) return "hoy";
  if (days <= 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  return new Date(unix * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
