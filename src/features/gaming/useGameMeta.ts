import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../../lib/api";
import type { GameMeta, Shortcut } from "../../lib/types";
import { groupGames } from "./groups";

/** Steam-store artwork/details per game id, refreshed as the backend fetches them. */
export function useGameMeta() {
  const [meta, setMeta] = useState<Record<string, GameMeta>>({});

  const load = useCallback(() => {
    api.gameMetadata().then(setMeta, () => {});
  }, []);

  useEffect(() => {
    load();
    if (!inTauri) return;
    let timer: number | undefined;
    const off = listen("metadata-changed", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    });
    return () => {
      window.clearTimeout(timer);
      void off.then((f) => f());
    };
  }, [load]);

  return meta;
}

/** Steam tools/apps (e.g. Blender) are not games: keep them out of NOVA PLAY. */
export function isGame(meta?: GameMeta) {
  return !meta?.kind || meta.kind === "game";
}

/** Recent first; Steam tools filtered out; one tile per game (see groups.ts). */
export function playable(games: Shortcut[], meta: Record<string, GameMeta>) {
  return groupGames(games.filter((g) => isGame(meta[g.id])));
}

export const PLATFORM: Record<string, string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  ubisoft: "Ubisoft",
  xbox: "Xbox",
  launcher: "Lanzador",
  user: "Añadido",
};

/** "Riot Games", "Minecraft Launcher"… for games behind a launcher, "En TORRE · Steam" for a PC's; the store otherwise. */
export function platformLabel(game: Shortcut) {
  if (game.source === "launcher" || game.source === "pc") return game.description ?? PLATFORM[game.source] ?? "Juego";
  return PLATFORM[game.source] ?? "Juego";
}
