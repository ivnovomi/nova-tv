import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ChevronRight, CloudOff, FlaskConical, PackageSearch, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useNova } from "../../app/context";
import { useActiveProfile } from "../../app/profiles";
import { useToast } from "../../components/Toasts";
import { useBackHandler } from "../../hooks/backStack";
import { focusElement, focusFirst } from "../../lib/spatialNav";
import type { StoreCollection, StoreEntry } from "../../lib/types";
import { liveTv } from "../livetv/store";
import { CATEGORIES, categoryLabel, features, newer, store, useStore, type StoreData } from "./model";
import { accentStyle, Aurora, bannerOf, Chip, InstallButton, PermissionSheet, PluginCard, PluginIcon, RankedCard, Verified, WideCard } from "./parts";
import { StoreDetail } from "./StoreDetail";

type View = { kind: "home" } | { kind: "plugin"; id: string } | { kind: "collection"; id: string };

const ROTATE_MS = 9000;

/** The page's main scroller (App's <main>). */
const scroller = () => document.querySelector("main");

// ───────────────────────── Spotlight ─────────────────────────

/** The big carousel: the featured plugin, its art, and its screenshots floating in 3D. */
function Spotlight({ entries, data, onOpen, onInstall, onOpenPlugin, onAccent }: {
  entries: StoreEntry[];
  data: StoreData;
  onOpen: (id: string) => void;
  onInstall: (e: StoreEntry) => void;
  onOpenPlugin: (e: StoreEntry) => void;
  onAccent: (accent: string | null | undefined) => void;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLElement>(null);
  const entry = entries[index % entries.length];

  useEffect(() => {
    if (paused || entries.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % entries.length), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, entries.length]);

  useEffect(() => {
    if (entry) onAccent(entry.accent);
  }, [entry, onAccent]);

  if (!entry) return null;
  const shots = entry.screenshots.slice(0, 3);
  const what = features(entry.permissions);

  return (
    <section
      ref={root}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !root.current?.contains(e.relatedTarget as Node) && setPaused(false)}
      style={accentStyle(entry.accent)}
      className="relative mx-[var(--gutter)] h-[clamp(27rem,54vh,36rem)] overflow-hidden rounded-[var(--radius-hero)] border border-line bg-bg-1 shadow-[0_3rem_6rem_-2rem_rgb(0_0_0/0.9)]"
      aria-roledescription="carrusel"
      aria-label="Destacados de la tienda"
    >
      <AnimatePresence initial={false}>
        <motion.div key={entry.id} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1 }}>
          <img src={bannerOf(entry)} alt="" draggable={false} className="kenburns absolute inset-0 size-full object-cover opacity-70" />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(3_5_12/0.97)_0%,rgb(3_5_12/0.85)_34%,rgb(3_5_12/0.25)_70%,rgb(3_5_12/0.5)_100%)]" />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg-0/80 to-transparent" />

          {/* Screenshots fanned out in perspective, floating. */}
          <div className="absolute right-[3%] top-1/2 hidden h-[78%] w-[50%] -translate-y-1/2 [perspective:1800px] lg:block" aria-hidden>
            {shots.map((s, i) => (
              <motion.div
                key={s.url}
                className="absolute inset-0"
                initial={{ opacity: 0, x: 80, rotateY: -30 }}
                animate={{ opacity: 1, x: 0, rotateY: -20 }}
                transition={{ duration: 0.9, delay: 0.15 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformStyle: "preserve-3d", zIndex: 3 - i }}
              >
                <div
                  className="store-float absolute aspect-video w-[78%] overflow-hidden rounded-[1.4rem] border border-white/15 shadow-[0_2.5rem_5rem_-1rem_rgb(0_0_0/0.85)]"
                  style={{
                    left: `${i * 11}%`,
                    top: `${8 + i * 17}%`,
                    transform: `translateZ(${-i * 120}px) rotateX(4deg)`,
                    animationDelay: `${-i * 2.3}s`,
                    boxShadow: i === 0 ? "0 2.5rem 6rem -1rem rgb(var(--a) / 0.45)" : undefined,
                  }}
                >
                  <img src={s.url} alt="" draggable={false} className="size-full object-cover" />
                  <div className="absolute inset-0 bg-[linear-gradient(120deg,rgb(255_255_255/0.18),transparent_40%)]" />
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="relative flex h-full max-w-[44rem] flex-col justify-center px-[clamp(2rem,4vw,4rem)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={entry.id} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
            <div className="flex items-center gap-6">
              <PluginIcon entry={entry} className="size-[clamp(5rem,7vw,7rem)]" glow />
              <div className="min-w-0">
                <p className="eyebrow flex items-center gap-2 text-[rgb(var(--a))]">
                  <Sparkles className="size-4" /> Destacado · {categoryLabel(entry.category)}
                </p>
                <h1 className="mt-1 truncate text-[clamp(2.8rem,4.4vw,4.8rem)] font-semibold leading-[1] tracking-[-0.03em]">{entry.name}</h1>
                <p className="mt-2 flex items-center gap-2 text-[1.05rem] text-ink-3">
                  {entry.author.name} {entry.author.verified && <Verified className="size-[1.1rem]" />}
                </p>
              </div>
            </div>
            <p className="mt-6 line-clamp-2 text-[clamp(1.25rem,1.6vw,1.6rem)] leading-snug text-ink-1">{entry.tagline}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {what.slice(0, 3).map(({ icon: Icon, title }) => (
                <Chip key={title} tone="accent">
                  <Icon className="size-4" /> {title}
                </Chip>
              ))}
              <Chip>{entry.audience === "adults" ? "+18" : "Para todos"}</Chip>
              <Chip>Gratis</Chip>
            </div>
          </motion.div>
        </AnimatePresence>

        <div className="mt-8 flex items-center gap-4">
          <InstallButton entry={entry} installed={data.installed[entry.id]} allowed={data.signed || data.developerMode} onInstall={() => onInstall(entry)} onOpenPlugin={() => onOpenPlugin(entry)} />
          <button data-nav data-store-id={entry.id} onClick={() => onOpen(entry.id)} className="focus-lift btn btn-ghost">
            Ver detalles <ChevronRight className="size-5" />
          </button>
        </div>

        {entries.length > 1 && (
          <div className="mt-8 flex items-center gap-2" role="tablist" aria-label="Destacados">
            {entries.map((e, i) => (
              <button key={e.id} data-nav role="tab" aria-selected={i === index} aria-label={e.name} onClick={() => setIndex(i)} onFocus={() => setIndex(i)} className="focus-ring grid h-7 place-items-center rounded-full px-1">
                <span className={`relative block h-[0.4rem] overflow-hidden rounded-full bg-white/20 transition-all duration-500 ${i === index ? "w-14" : "w-6"}`}>
                  {i === index && (
                    <span
                      key={`${e.id}-${paused}`}
                      className="store-timer absolute inset-0 rounded-full bg-white"
                      style={{ "--d": `${ROTATE_MS}ms`, animationPlayState: paused ? "paused" : "running" } as CSSProperties}
                    />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ───────────────────────── Shelves ─────────────────────────

function Shelf({ title, subtitle, action, children }: { title: string; subtitle?: string | null; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-12">
      <div className="mb-5 flex items-end justify-between gap-6 px-[var(--gutter)]">
        <div className="min-w-0">
          <h2 className="text-[1.8rem] font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-1 text-[1.05rem] text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="row-scroller items-end">{children}</div>
    </section>
  );
}

/** A collection as one big poster: its plugins' icons flying over the colour. */
function Editorial({ collection, entries, onOpen, onFocus }: { collection: StoreCollection; entries: StoreEntry[]; onOpen: () => void; onFocus: () => void }) {
  const accent = collection.accent ?? entries[0]?.accent;
  const art = collection.image ?? (entries[0] ? bannerOf(entries[0]) : undefined);
  return (
    <section className="mt-14 px-[var(--gutter)]">
      <button
        data-nav
        data-store-id={`collection:${collection.id}`}
        onClick={onOpen}
        onFocus={onFocus}
        style={accentStyle(accent)}
        className="focus-lift group relative flex h-[clamp(17rem,30vh,22rem)] w-full items-center overflow-hidden rounded-[var(--radius-hero)] border border-line text-left"
      >
        {art && <img src={art} alt="" draggable={false} className="absolute inset-0 size-full object-cover opacity-60 transition-transform duration-1000 group-focus:scale-105" />}
        <span className="absolute inset-0 bg-[radial-gradient(80%_120%_at_0%_50%,rgb(var(--a)/0.55),transparent_60%),linear-gradient(90deg,rgb(3_5_12/0.92),rgb(3_5_12/0.4)_70%)]" />
        <span className="relative max-w-[40rem] px-[clamp(2rem,4vw,4rem)]">
          <span className="eyebrow text-ink-1/80">Colección</span>
          <span className="mt-2 block text-[clamp(2.4rem,3.6vw,3.6rem)] font-semibold leading-[1.02] tracking-[-0.02em]">{collection.title}</span>
          {collection.subtitle && <span className="mt-3 block text-[1.2rem] text-ink-2">{collection.subtitle}</span>}
          <span className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-[1.05rem] font-semibold text-black">
            Ver la colección <ChevronRight className="size-5" />
          </span>
        </span>
        <span className="absolute right-[6%] top-1/2 hidden -translate-y-1/2 lg:block" aria-hidden>
          {entries.slice(0, 3).map((e, i) => (
            <span
              key={e.id}
              className="store-float absolute"
              style={{
                right: `${i * 7.5}rem`,
                top: `${(i % 2 ? 1 : -1) * 3 - 5}rem`,
                rotate: `${(i - 1) * 9}deg`,
                animationDelay: `${-i * 1.7}s`,
                zIndex: 3 - i,
              }}
            >
              <PluginIcon entry={e} className="size-[9.5rem]" glow />
            </span>
          ))}
        </span>
      </button>
    </section>
  );
}

// ───────────────────────── States ─────────────────────────

function Skeleton() {
  return (
    <div className="animate-pulse px-[var(--gutter)]" aria-label="Cargando la tienda">
      <div className="h-[clamp(27rem,54vh,36rem)] rounded-[var(--radius-hero)] bg-white/5" />
      <div className="mt-10 flex gap-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-12 w-36 rounded-full bg-white/5" />
        ))}
      </div>
      <div className="mt-10 flex gap-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-[19rem] w-[22rem] rounded-[var(--radius-card)] bg-white/5" />
        ))}
      </div>
    </div>
  );
}

function Unavailable({ error }: { error: string | null }) {
  const nova = useNova();
  return (
    <div className="mx-auto mt-[10vh] flex max-w-[40rem] flex-col items-center px-[var(--gutter)] text-center">
      <span className="grid size-24 place-items-center rounded-[2rem] bg-white/6">
        <CloudOff className="size-11 text-ink-3" />
      </span>
      <h1 className="mt-8 text-[2.4rem] font-semibold">La tienda no responde</h1>
      <p className="mt-3 text-[1.15rem] text-ink-2">Comprueba la conexión a internet. Mientras tanto, tus plugins siguen funcionando.</p>
      {error && <p className="mt-2 text-[0.95rem] text-ink-3">{error}</p>}
      <div className="mt-8 flex gap-3">
        <button data-nav data-autofocus onClick={() => void store.load(true)} className="focus-lift btn btn-primary">
          <RefreshCw className="size-5" /> Reintentar
        </button>
        <button data-nav onClick={() => nova.navigate("settings")} className="focus-lift btn btn-ghost">
          Tus plugins
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── The screen ─────────────────────────

export function StoreScreen() {
  const data = useStore();
  const nova = useNova();
  const toast = useToast();
  const profile = useActiveProfile();
  const [view, setView] = useState<View>({ kind: "home" });
  const [category, setCategory] = useState("all");
  const [accent, setAccent] = useState<string | null | undefined>(null);
  const [asking, setAsking] = useState<StoreEntry | null>(null);
  const returnTo = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const catalog = data?.catalog;
  const byId = useMemo(() => new Map((catalog?.plugins ?? []).map((p) => [p.id, p])), [catalog]);
  const pick = useCallback((ids: string[]) => ids.map((id) => byId.get(id)).filter((e): e is StoreEntry => !!e), [byId]);
  const allowed = !!data && (data.signed || data.developerMode);

  const go = (next: View) => {
    if (next.kind !== "home") returnTo.current = (document.activeElement as HTMLElement | null)?.dataset.storeId ?? returnTo.current;
    setView(next);
    scroller()?.scrollTo({ top: 0 });
  };

  // Back from a plugin or a collection: to the tile it was opened from.
  useBackHandler(() => setView({ kind: "home" }), view.kind !== "home");
  useEffect(() => {
    const t = window.setTimeout(() => {
      const target = view.kind === "home" && returnTo.current ? root.current?.querySelector<HTMLElement>(`[data-store-id="${CSS.escape(returnTo.current)}"]`) : null;
      if (target) focusElement(target);
      else focusFirst(root.current);
    }, 60);
    return () => window.clearTimeout(t);
  }, [view]);

  const openPlugin = (e: StoreEntry) => {
    if (e.permissions.channels) void liveTv.open();
    else if (e.permissions.rows) nova.navigate("home");
    else nova.navigate("settings");
  };
  const done = (e: StoreEntry, ok: boolean) => {
    if (ok) {
      toast.show(
        "success",
        `${e.name} instalado`,
        e.permissions.channels ? "Sus canales ya están en la TV en directo." : e.permissions.rows ? "Ya lo tienes en «Para ti»." : "Ya funciona en NOVA.",
      );
    } else toast.show("error", `No se pudo instalar ${e.name}`, "Mira el motivo en su página.");
  };

  if (profile?.kids) {
    return (
      <div className="mx-auto mt-[12vh] max-w-[36rem] px-[var(--gutter)] text-center">
        <ShieldCheck className="mx-auto size-16 text-ok" />
        <h1 className="mt-6 text-[2.2rem] font-semibold">La tienda es cosa de mayores</h1>
        <p className="mt-3 text-[1.15rem] text-ink-2">Pide a un adulto que instale lo que quieras ver.</p>
      </div>
    );
  }
  if (!data) return <Skeleton />;
  if (!catalog) return <Unavailable error={data.error} />;

  const updates = catalog.plugins.filter((p) => data.installed[p.id] && newer(p.version, data.installed[p.id]));
  const featured = pick(catalog.featured.length ? catalog.featured : catalog.plugins.slice(0, 4).map((p) => p.id));
  const usedCategories = CATEGORIES.filter((c) => c.id === "all" || catalog.plugins.some((p) => p.category === c.id));
  const cardProps = (e: StoreEntry) => ({ entry: e, installed: data.installed[e.id], onOpen: () => go({ kind: "plugin", id: e.id }), onFocus: () => setAccent(e.accent) });

  let body: ReactNode;
  if (view.kind === "plugin" && byId.get(view.id)) {
    const entry = byId.get(view.id)!;
    body = (
      <StoreDetail
        entry={entry}
        data={data}
        related={catalog.plugins.filter((p) => p.id !== entry.id && (p.category === entry.category || p.author.name === entry.author.name)).slice(0, 8)}
        onBack={() => setView({ kind: "home" })}
        onOpen={(id) => go({ kind: "plugin", id })}
        onInstall={() => setAsking(entry)}
        onOpenPlugin={() => openPlugin(entry)}
        onAccent={setAccent}
      />
    );
  } else if (view.kind === "collection") {
    const collection = catalog.collections.find((c) => c.id === view.id);
    const entries = pick(collection?.ids ?? []);
    body = (
      <div className="px-[var(--gutter)] pt-4">
        <button data-nav onClick={() => setView({ kind: "home" })} className="focus-lift btn btn-ghost">
          <ArrowLeft className="size-5" /> Tienda
        </button>
        <p className="eyebrow mt-10">Colección</p>
        <h1 className="mt-2 text-[clamp(2.6rem,4vw,4rem)] font-semibold tracking-[-0.02em]">{collection?.title}</h1>
        {collection?.subtitle && <p className="mt-3 max-w-[50rem] text-[1.25rem] text-ink-2">{collection.subtitle}</p>}
        <div className="mt-10 flex flex-wrap gap-6">
          {entries.map((e) => (
            <PluginCard key={e.id} {...cardProps(e)} />
          ))}
        </div>
      </div>
    );
  } else {
    const filtered = category === "all" ? [] : catalog.plugins.filter((p) => p.category === category);
    body = (
      <>
        <Spotlight entries={featured} data={data} onOpen={(id) => go({ kind: "plugin", id })} onInstall={setAsking} onOpenPlugin={openPlugin} onAccent={setAccent} />

        <nav className="no-scrollbar mt-9 flex gap-3 overflow-x-auto px-[var(--gutter)] py-2" aria-label="Categorías">
          {usedCategories.map(({ id, label, icon: Icon }) => {
            const on = category === id;
            return (
              <button
                key={id}
                data-nav
                aria-pressed={on}
                onClick={() => setCategory(id)}
                className={`focus-ring flex h-[3.4rem] shrink-0 items-center gap-2.5 rounded-full px-6 text-[1.1rem] font-semibold transition-colors ${on ? "bg-white text-black" : "bg-white/7 text-ink-2 focus:bg-white/14"}`}
              >
                <Icon className="size-5" /> {label}
              </button>
            );
          })}
        </nav>

        {category !== "all" ? (
          <section className="mt-10 px-[var(--gutter)]">
            <h2 className="text-[1.8rem] font-semibold tracking-tight">{categoryLabel(category)}</h2>
            <div className="mt-6 flex flex-wrap gap-6">
              {filtered.map((e) => (
                <PluginCard key={e.id} {...cardProps(e)} />
              ))}
            </div>
          </section>
        ) : (
          <>
            {updates.length > 0 && (
              <Shelf title="Actualizaciones disponibles" subtitle="Novedades de tus plugins, revisadas por el equipo de NOVA.">
                {updates.map((e) => (
                  <PluginCard key={e.id} {...cardProps(e)} />
                ))}
              </Shelf>
            )}
            {catalog.collections.map((c) => {
              const entries = pick(c.ids);
              if (c.style === "editorial") return <Editorial key={c.id} collection={c} entries={entries} onOpen={() => go({ kind: "collection", id: c.id })} onFocus={() => setAccent(c.accent ?? entries[0]?.accent)} />;
              return (
                <Shelf key={c.id} title={c.title} subtitle={c.subtitle}>
                  {entries.map((e, i) =>
                    c.style === "ranked" ? <RankedCard key={e.id} rank={i + 1} {...cardProps(e)} /> : c.style === "wide" ? <WideCard key={e.id} {...cardProps(e)} /> : <PluginCard key={e.id} {...cardProps(e)} />,
                  )}
                </Shelf>
              );
            })}
            <Shelf title="Todos los plugins" subtitle={`${catalog.plugins.length} en la tienda, todos revisados y firmados por el equipo de NOVA.`}>
              {[...catalog.plugins]
                .sort((a, b) => a.name.localeCompare(b.name, "es"))
                .map((e) => (
                  <PluginCard key={e.id} {...cardProps(e)} />
                ))}
            </Shelf>
          </>
        )}
      </>
    );
  }

  return (
    <div ref={root} className="relative pb-20">
      <Aurora accent={accent} />
      <div className="relative">
        {data.preview && (
          <p className="mx-[var(--gutter)] mb-4 flex items-center gap-3 rounded-2xl border border-warn/30 bg-warn/10 px-5 py-3 text-[1rem] text-[#ffe7b0]">
            <FlaskConical className="size-5 shrink-0" /> Vista previa de desarrollo: el catálogo oficial aún no existe, así que se ven plugins de ejemplo (solo Pluto TV es de verdad).
          </p>
        )}
        {!data.preview && data.error && (
          <p className="mx-[var(--gutter)] mb-4 flex items-center gap-3 rounded-2xl bg-white/6 px-5 py-3 text-[1rem] text-ink-2">
            <CloudOff className="size-5 shrink-0" /> Sin conexión con la tienda: ves el catálogo guardado.
          </p>
        )}
        <AnimatePresence mode="wait">
          <motion.div key={view.kind === "home" ? "home" : `${view.kind}:${view.id}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
            {body}
          </motion.div>
        </AnimatePresence>
        {catalog.plugins.length === 0 && (
          <div className="mx-auto mt-16 max-w-[34rem] text-center">
            <PackageSearch className="mx-auto size-14 text-ink-3" />
            <p className="mt-4 text-[1.2rem] text-ink-2">Todavía no hay plugins en la tienda.</p>
          </div>
        )}
      </div>
      <AnimatePresence>
        {asking && (
          <PermissionSheet
            entry={asking}
            updating={!!data.installed[asking.id]}
            onClose={() => setAsking(null)}
            onDone={(ok) => done(asking, ok)}
          />
        )}
      </AnimatePresence>
      {!allowed && view.kind === "home" && (
        <p className="mx-[var(--gutter)] mt-12 text-center text-[0.98rem] text-ink-3">
          La tienda aún no firma sus paquetes: de momento solo instala con el modo desarrollador (Ajustes → Plugins).
        </p>
      )}
    </div>
  );
}
