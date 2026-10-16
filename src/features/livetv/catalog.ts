import type { Channel } from "../../lib/types";
import { countryName } from "./store";

/**
 * The TV's catalogue, organised like a streaming app instead of 300 groups:
 * a few top tabs (Para ti, España, Pluto TV, Twitch, themes, Mundo…), some
 * with sub-tabs. Within a theme, what's closest comes first: Spain's TDT,
 * then Pluto TV and Twitch, then Spanish-speaking countries, then the world.
 */

export interface Sub {
  key: string;
  label: string;
  channels: Channel[];
}

export interface Tab {
  key: string;
  label: string;
  subs: Sub[];
}

const SPANISH_SPEAKING = ["ES", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "US", "UY", "PY", "BO", "CR", "DO", "GT", "HN", "NI", "PA", "SV", "PR", "CU"];

/** Spain's TDT groups that are themes in disguise. */
const TDT_THEME: Record<string, string> = {
  Informativos: "Noticias",
  "Informativos Int.": "Noticias",
  Deportivos: "Deportes",
  "Deportivos Int.": "Deportes",
  Infantiles: "Infantil",
  Musicales: "Música",
};

const THEME_TABS: { key: string; label: string; themes: string[] }[] = [
  { key: "noticias", label: "Noticias", themes: ["Noticias", "Economía y tiempo"] },
  { key: "deportes", label: "Deportes", themes: ["Deportes"] },
  { key: "cine", label: "Cine y series", themes: ["Cine", "Series", "Clásicos"] },
  { key: "infantil", label: "Infantil", themes: ["Infantil"] },
  { key: "musica", label: "Música", themes: ["Música"] },
  { key: "docs", label: "Documentales", themes: ["Documentales", "Cultura y educación"] },
  { key: "ocio", label: "Entretenimiento", themes: ["Entretenimiento", "Estilo de vida"] },
];

const SPAIN_SUBS: { key: string; label: string; groups: string[] }[] = [
  { key: "generalistas", label: "Generalistas", groups: ["Generalistas"] },
  { key: "informativos", label: "Noticias", groups: ["Informativos"] },
  { key: "deportes", label: "Deportes", groups: ["Deportivos"] },
  { key: "infantil", label: "Infantil", groups: ["Infantiles"] },
  { key: "streaming", label: "Streaming", groups: ["Streaming", "Eventuales"] },
];

/** Closeness to a viewer in Spain: TDT, Pluto/Twitch, playlists, Spanish-speaking world, the rest. */
function rank(c: Channel): number {
  if (c.source === "tdt" && c.region === "España") return 0;
  if (c.source === "fast" || c.source === "twitch") return 1;
  if (c.source === "playlist") return 2;
  const i = SPANISH_SPEAKING.indexOf((c.country ?? "").toUpperCase());
  return i >= 0 ? 3 + i / 100 : 4;
}

const byNumber = (a: Channel, b: Channel) => a.number - b.number;
const byCloseness = (a: Channel, b: Channel) => rank(a) - rank(b) || a.number - b.number;

function themesOf(c: Channel): string[] {
  const tdt = c.source === "tdt" ? TDT_THEME[c.group] : undefined;
  return tdt ? [tdt, ...c.categories] : c.categories;
}

const sub = (key: string, label: string, channels: Channel[]): Sub => ({ key, label, channels });

export function buildTabs(channels: Channel[], favorites: string[], recent: string[]): Tab[] {
  const byId = new Map(channels.map((c) => [c.id, c]));
  const tabs: Tab[] = [];
  const add = (key: string, label: string, subs: Sub[]) => {
    const kept = subs.filter((s) => s.channels.length);
    if (kept.length) tabs.push({ key, label, subs: kept });
  };

  // Para ti: favourites and what you watched lately.
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((c): c is Channel => !!c);
  add("parati", "Para ti", [sub("fav", "Favoritos", pick(favorites)), sub("recent", "Vistos hace poco", pick(recent))]);

  // España: Spain's TDT, the national groups first and every region together.
  const spain = channels.filter((c) => c.source === "tdt" && c.region === "España");
  const known = new Set(SPAIN_SUBS.flatMap((s) => s.groups));
  add("espana", "España", [
    ...SPAIN_SUBS.map((s) => sub(s.key, s.label, spain.filter((c) => s.groups.includes(c.group)).sort(byNumber))),
    sub("autonomicas", "Autonómicas y locales", spain.filter((c) => !known.has(c.group) && !TDT_THEME[c.group]).sort(byNumber)),
    sub("otros", "Más temáticos", spain.filter((c) => !known.has(c.group) && !!TDT_THEME[c.group]).sort(byNumber)),
  ]);

  // Pluto TV, in its own categories.
  const pluto = channels.filter((c) => c.source === "fast");
  add("pluto", "Pluto TV", [sub("all", "Todo", [...pluto].sort(byNumber)), ...[...new Set(pluto.map((c) => c.group))].map((g) => sub(g, g, pluto.filter((c) => c.group === g).sort(byNumber)))]);

  // Twitch: what's live now.
  add("twitch", "Twitch", [sub("live", "En directo ahora", channels.filter((c) => c.source === "twitch").sort(byNumber))]);

  // Themes, across every source, closest first; sub-tabs by origin.
  for (const t of THEME_TABS) {
    const list = channels.filter((c) => themesOf(c).some((k) => t.themes.includes(k))).sort(byCloseness);
    add(t.key, t.label, [
      sub("all", "Todo", list),
      sub("es", "España", list.filter((c) => c.source === "tdt" && c.region === "España")),
      sub("free", "Pluto TV y Twitch", list.filter((c) => c.source === "fast" || c.source === "twitch")),
      sub("world", "Resto del mundo", list.filter((c) => c.source === "world" || (c.source === "tdt" && c.region !== "España"))),
    ]);
  }

  // Mundo: by country, Spanish-speaking first, then by size.
  const world = channels.filter((c) => c.source === "world");
  const countries = new Map<string, Channel[]>();
  world.forEach((c) => {
    const code = (c.country ?? "INT").toUpperCase();
    countries.set(code, [...(countries.get(code) ?? []), c]);
  });
  const order = [...countries.entries()].sort((a, b) => {
    const ia = SPANISH_SPEAKING.indexOf(a[0]);
    const ib = SPANISH_SPEAKING.indexOf(b[0]);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return b[1].length - a[1].length;
  });
  add("mundo", "Mundo", [
    // Country names only: Windows has no flag emoji (it would show "MX México").
    ...order.map(([code, list]) => sub(code, countryName(code), list.sort(byNumber))),
    sub("tdti", "TDT internacional", channels.filter((c) => c.source === "tdt" && c.region !== "España").sort(byNumber)),
  ]);

  // The user's own playlists.
  const playlists = channels.filter((c) => c.source === "playlist");
  add("listas", "Mis listas", [...new Set(playlists.map((c) => c.region))].map((r) => sub(r, r, playlists.filter((c) => c.region === r).sort(byNumber))));

  return tabs;
}
