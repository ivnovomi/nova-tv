import type { Shortcut } from "../../lib/types";

/**
 * One game, several ways to open it: Minecraft's launcher and its modpacks
 * (`group`), or the same game here and on a PC of the house (same id). NOVA
 * shows one tile per game and asks which way when there's more than one.
 */

const GROUP_NAMES: Record<string, string> = { minecraft: "Minecraft" };
const PREF = "nova.gameVariant.";

/** The tile a game belongs to. */
export function gameKey(game: Shortcut): string {
  if (game.group) return `group:${game.group}`;
  // `pc:<pc>:steam:730` is the same game as `steam:730`.
  return game.id.replace(/^pc:[^:]+:/, "");
}

/** Tiles that stand for several ways to open a game (they ask which one). */
const tiles = new WeakSet<Shortcut>();

export function isGroupTile(item: Shortcut): boolean {
  return tiles.has(item);
}

export function lastVariant(key: string): string | null {
  try {
    return localStorage.getItem(PREF + key);
  } catch {
    return null;
  }
}

export function rememberVariant(key: string, id: string) {
  try {
    localStorage.setItem(PREF + key, id);
  } catch {}
}

/** The way NOVA proposes first: the last one chosen, else the plain game here, else the first. */
function preferred(key: string, list: Shortcut[]): Shortcut {
  const remembered = lastVariant(key);
  return (
    list.find((g) => g.id === remembered) ??
    list.find((g) => g.id === "launcher:minecraft") ??
    list.find((g) => g.source !== "pc" && !g.id.startsWith("modrinth:") && !g.id.startsWith("curseforge:")) ??
    list[0]
  );
}

/** One tile per game, in the order given (most recent first stays first). */
export function groupGames(games: Shortcut[]): Shortcut[] {
  const groups = new Map<string, Shortcut[]>();
  for (const g of games) {
    const key = gameKey(g);
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  return [...groups].map(([key, list]) => {
    if (list.length === 1) return list[0];
    const pick = preferred(key, list);
    const group = list.find((g) => g.group)?.group;
    const tile: Shortcut = { ...pick, name: (group && GROUP_NAMES[group]) ?? pick.name };
    tiles.add(tile);
    return tile;
  });
}

/** Every way to open `game`'s tile (the preferred one first). */
export function variantsOf(games: Shortcut[], game: Shortcut): Shortcut[] {
  const key = gameKey(game);
  const list = games.filter((g) => gameKey(g) === key);
  const first = preferred(key, list);
  return [first, ...list.filter((g) => g !== first)];
}
