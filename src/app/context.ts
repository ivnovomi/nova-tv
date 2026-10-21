import { createContext, useContext } from "react";
import type { FeedItem, Library, RecentMedia, Screen, Shortcut, ShortcutKind, WatchEntry } from "../lib/types";

export type Dialog =
  | { type: "add-exe"; kind: ShortcutKind; suggestedName?: string }
  | { type: "add-steam" }
  | { type: "add-web" }
  | { type: "confirm-remove"; item: Shortcut }
  | { type: "confirm-clear-history" }
  /** Juegos desde tu PC (from NOVA PLAY). */
  | { type: "pc-games" }
  /** A game with several ways to open it: which one. */
  | { type: "game-variants"; title: string; variants: Shortcut[] }
  | null;

export interface Nova {
  library: Library | null;
  libraryError: string | null;
  recentMedia: RecentMedia[];
  launching: string | null;
  enterGaming: () => void;
  history: WatchEntry[];
  feed: FeedItem[];
  playVideo: (videoId: string, position?: number) => void;
  /** A Twitch live channel, in Twitch's official player. */
  playTwitch: (login: string, name: string) => void;
  removeHistory: (key: string) => void;
  navigate: (screen: Screen) => void;
  launch: (item: Shortcut) => void;
  pickAndOpenMedia: () => void;
  openMedia: (path: string) => void;
  forgetMedia: (path: string) => void;
  openDialog: (d: Dialog) => void;
  reload: () => void;
}

export const NovaContext = createContext<Nova | null>(null);

export function useNova(): Nova {
  const ctx = useContext(NovaContext);
  if (!ctx) throw new Error("NovaContext missing");
  return ctx;
}

/** Most recently launched first, then the rest in their original order. */
export function byRecent(items: Shortcut[], recent: string[]): Shortcut[] {
  const rank = new Map(recent.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}
