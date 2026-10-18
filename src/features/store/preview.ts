/**
 * Development only: an example catalogue to design the store before the
 * official one exists. Except Pluto TV (NOVA's own plugin), these plugins are
 * made up. Production builds never show it (see model.ts).
 */
import type { PluginPermissions, StoreCatalog, StoreEntry } from "../../lib/types";
import { bannerArt, iconArt, shotArt, type ShotKind } from "./art";

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

function entry(
  id: string,
  name: string,
  glyph: string,
  accent: string,
  category: string,
  tagline: string,
  description: string,
  permissions: PluginPermissions,
  shots: [ShotKind, string][],
  extra: Partial<StoreEntry> = {},
): StoreEntry {
  return {
    id,
    name,
    version: "1.0.0",
    tagline,
    description,
    author: { name: "Estudio de ejemplo", verified: false },
    category,
    audience: "everyone",
    icon: iconArt(accent, glyph),
    banner: bannerArt(accent, glyph, id),
    accent,
    screenshots: shots.map(([kind, caption]) => ({ url: shotArt(accent, kind, id, glyph), caption })),
    permissions,
    changelog: [{ version: "1.0.0", date: now - 3 * DAY, notes: ["Primera versión en la tienda de NOVA."] }],
    languages: ["es"],
    updatedAt: now - 3 * DAY,
    reviewedAt: now - 2 * DAY,
    tags: [],
    package: { url: "https://example.invalid/preview.novapkg", sha256: "0".repeat(64), signature: null, size: 24_000 },
    ...extra,
  };
}

const plugins: StoreEntry[] = [
  entry(
    "es.novatv.pluto-tv",
    "Pluto TV",
    "📺",
    "#f5c400",
    "tv",
    "Cientos de canales gratis, con su guía",
    "Dibujos, anime, cine, series, MTV, realities y mucho más, gratis y legal con anuncios. Los canales llegan a la TV de NOVA con su número y su guía de las próximas horas, y en los perfiles infantiles solo salen los infantiles.\n\nCada emisión se pide justo al sintonizar, firmada con una sesión que el plugin renueva solo.",
    { network: ["*.pluto.tv"], channels: true, guide: true },
    [
      ["guide", "La guía de Pluto TV, dentro de la de NOVA"],
      ["player", "Directo a pantalla completa"],
      ["home", "Sus canales, junto a la TDT"],
    ],
    {
      author: { name: "NOVA TV", verified: true },
      version: "1.1.0",
      changelog: [
        { version: "1.1.0", date: now - 2 * DAY, notes: ["Categorías en inglés para las regiones fuera de España.", "Opción para mostrar el anime en perfiles infantiles."] },
        { version: "1.0.0", date: now - 20 * DAY, notes: ["Pluto TV pasa de venir integrado en NOVA a ser un plugin."] },
      ],
      languages: ["es", "en"],
      package: { url: "https://example.invalid/pluto.novapkg", sha256: "0".repeat(64), signature: null, size: 9_300 },
    },
  ),
  entry(
    "es.ejemplo.marcador",
    "Marcador",
    "⚽",
    "#22c55e",
    "sports",
    "Resultados en directo y avisos de gol",
    "Los partidos de hoy en «Para ti», con el marcador al minuto. Elige tus equipos y NOVA te avisa de cada gol aunque estés viendo otra cosa.",
    { network: ["api.marcador.example"], rows: true, notify: true, search: true },
    [
      ["home", "Los partidos de hoy en tu inicio"],
      ["grid", "Todas las ligas"],
    ],
  ),
  entry(
    "es.ejemplo.ondas",
    "Ondas",
    "📻",
    "#f97316",
    "music",
    "Miles de emisoras de radio en tu tele",
    "Radios de toda España y del mundo como canales de NOVA: música, deportes, noticias. Con lo que está sonando en la guía.",
    { network: ["api.ondas.example", "*.streams.example"], channels: true, guide: true, rows: true, search: true },
    [
      ["guide", "Lo que suena en cada emisora"],
      ["home", "Tus emisoras favoritas"],
      ["player", "A pantalla completa, con su carátula"],
    ],
  ),
  entry(
    "es.ejemplo.cuentacuentos",
    "Cuentacuentos",
    "🦊",
    "#ec4899",
    "kids",
    "Cuentos animados para los peques",
    "Cuentos clásicos narrados y animados, para antes de dormir. Pensado para los perfiles infantiles: sin anuncios, sin enlaces fuera y con fondos tranquilos para el salvapantallas.",
    { network: ["cuentos.example"], rows: true, screensaver: true },
    [
      ["home", "Un cuento nuevo cada día"],
      ["grid", "Todos los cuentos"],
      ["player", "Narrados y animados"],
    ],
  ),
  entry(
    "es.ejemplo.cielo",
    "Cielo",
    "⛅",
    "#38bdf8",
    "tools",
    "El tiempo de tu ciudad, en grande",
    "La previsión de tu ciudad en «Para ti», el cielo de ahora como fondo del salvapantallas y un aviso si va a llover. Usa la ciudad que elijas en NOVA, nunca tu ubicación exacta.",
    { network: ["api.cielo.example"], rows: true, screensaver: true, notify: true, location: true },
    [
      ["home", "La previsión en tu inicio"],
      ["player", "El salvapantallas, según el tiempo"],
    ],
  ),
  entry(
    "es.ejemplo.filmoteca",
    "Filmoteca Libre",
    "🎞️",
    "#a855f7",
    "movies",
    "Clásicos del cine de dominio público",
    "Cientos de películas que ya son de todos: cine mudo, clásicos de Hollywood, serie B y documentales históricos, restaurados y listos para ver.",
    { network: ["filmoteca.example"], rows: true, search: true },
    [
      ["grid", "Por décadas y géneros"],
      ["player", "Restauradas"],
      ["home", "Recomendaciones cada semana"],
    ],
  ),
  entry(
    "es.ejemplo.titulares",
    "Titulares",
    "📰",
    "#ef4444",
    "news",
    "Las noticias del día, de un vistazo",
    "Los titulares de los principales medios en una fila de «Para ti», y un aviso solo cuando pasa algo importante de verdad.",
    { network: ["api.titulares.example"], rows: true, notify: true, search: true },
    [["home", "Lo último, en tu inicio"]],
  ),
  entry(
    "es.ejemplo.galaxia",
    "Galaxia",
    "🌌",
    "#6366f1",
    "tools",
    "Fondos del universo para tu salvapantallas",
    "Nebulosas, galaxias y planetas en alta resolución mientras la tele descansa. Una imagen nueva cada día.",
    { network: ["img.galaxia.example"], screensaver: true },
    [["player", "Una imagen nueva cada día"]],
    { package: { url: "https://example.invalid/galaxia.novapkg", sha256: "0".repeat(64), signature: null, size: 6_100 } },
  ),
];

export const PREVIEW: StoreCatalog = {
  version: 1,
  updatedAt: now,
  featured: ["es.novatv.pluto-tv", "es.ejemplo.marcador", "es.ejemplo.cuentacuentos", "es.ejemplo.cielo"],
  collections: [
    { id: "top", title: "Lo más instalado", style: "ranked", ids: ["es.novatv.pluto-tv", "es.ejemplo.ondas", "es.ejemplo.marcador", "es.ejemplo.cielo", "es.ejemplo.titulares", "es.ejemplo.filmoteca"] },
    { id: "tv", title: "Más canales para tu TV", subtitle: "Llegan a la TV en directo con su número y su guía.", style: "wide", ids: ["es.novatv.pluto-tv", "es.ejemplo.ondas"] },
    {
      id: "peques",
      title: "Para los peques",
      subtitle: "Cuentos, dibujos y fondos tranquilos. Todo revisado para los perfiles infantiles.",
      style: "editorial",
      accent: "#ec4899",
      ids: ["es.ejemplo.cuentacuentos", "es.ejemplo.galaxia", "es.novatv.pluto-tv"],
    },
    { id: "nuevos", title: "Recién llegados", style: "cards", ids: ["es.ejemplo.galaxia", "es.ejemplo.titulares", "es.ejemplo.filmoteca", "es.ejemplo.cielo"] },
    { id: "aldia", title: "Para estar al día", style: "cards", ids: ["es.ejemplo.titulares", "es.ejemplo.cielo", "es.ejemplo.marcador"] },
  ],
  plugins,
};
