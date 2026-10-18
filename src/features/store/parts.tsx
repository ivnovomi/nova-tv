import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BadgeCheck, Check, Download, Globe, LoaderCircle, Play, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Modal } from "../../components/Modal";
import { permissionLines } from "../PluginsSettings";
import type { StoreEntry } from "../../lib/types";
import { bannerArt, iconArt } from "./art";
import { categoryLabel, formatSize, install, newer, rgb, useInstall } from "./model";

export const iconOf = (e: StoreEntry) => e.icon ?? iconArt(e.accent, e.name.slice(0, 1).toUpperCase());
export const bannerOf = (e: StoreEntry) => e.banner ?? bannerArt(e.accent, e.name.slice(0, 1).toUpperCase(), e.id);
/** CSS variable `--a` with the plugin's colour, for the aurora and accents. */
export const accentStyle = (accent?: string | null, extra?: CSSProperties) => ({ "--a": rgb(accent), ...extra }) as CSSProperties;

export function PluginIcon({ entry, className = "size-16", glow = false }: { entry: StoreEntry; className?: string; glow?: boolean }) {
  return (
    <span className={`relative block shrink-0 ${className}`} style={accentStyle(entry.accent)}>
      {glow && <span className="absolute -inset-[30%] rounded-full bg-[radial-gradient(closest-side,rgb(var(--a)/0.55),transparent)] blur-xl" />}
      <img src={iconOf(entry)} alt="" draggable={false} className="relative size-full rounded-[22%] object-cover shadow-[0_0.8rem_2rem_-0.6rem_rgb(0_0_0/0.8)]" />
    </span>
  );
}

/** The page's coloured light, crossfading when the plugin in front changes. */
export function Aurora({ accent }: { accent?: string | null }) {
  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={accent ?? "nova"}
        className="store-aurora"
        style={accentStyle(accent)}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.85 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 1.2, ease: "easeInOut" }}
      >
        <i />
        <i />
        <i />
      </motion.div>
    </AnimatePresence>
  );
}

export function Verified({ className = "size-5" }: { className?: string }) {
  return <BadgeCheck className={`${className} shrink-0 text-cyan`} aria-label="Verificado por NOVA" />;
}

export function Chip({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "accent" | "ok" }) {
  const look = tone === "accent" ? "bg-[rgb(var(--a)/0.18)] text-ink-1 ring-1 ring-[rgb(var(--a)/0.4)]" : tone === "ok" ? "bg-ok/15 text-ok" : "bg-white/8 text-ink-2";
  return <span className={`inline-flex h-[2.1rem] items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[0.95rem] font-semibold ${look}`}>{children}</span>;
}

// ───────────────────────── Cards ─────────────────────────

interface CardProps {
  entry: StoreEntry;
  installed?: string;
  onOpen: () => void;
  onFocus?: () => void;
}

function InstalledMark({ entry, installed }: { entry: StoreEntry; installed?: string }) {
  if (!installed) return null;
  const update = newer(entry.version, installed);
  return (
    <span className={`absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8rem] font-bold uppercase tracking-wider backdrop-blur ${update ? "bg-warn/90 text-black" : "bg-black/55 text-ok"}`}>
      {update ? <RefreshCw className="size-3.5" /> : <Check className="size-3.5" />} {update ? "Actualizar" : "Instalado"}
    </span>
  );
}

/** Banner on top, icon over its edge, name and tagline. */
export function PluginCard({ entry, installed, onOpen, onFocus }: CardProps) {
  return (
    <button
      data-nav
      data-store-id={entry.id}
      onClick={onOpen}
      onFocus={onFocus}
      style={accentStyle(entry.accent)}
      className="focus-lift group w-[22rem] shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface-1 text-left"
    >
      <span className="relative block aspect-[16/8] overflow-hidden">
        <img src={bannerOf(entry)} alt="" draggable={false} className="size-full object-cover transition-transform duration-700 group-focus:scale-110" />
        <span className="absolute inset-0 bg-gradient-to-t from-surface-1 via-transparent to-transparent" />
        <InstalledMark entry={entry} installed={installed} />
      </span>
      <span className="relative block px-5 pb-5">
        <PluginIcon entry={entry} className="-mt-9 size-[4.4rem]" />
        <span className="mt-3 flex items-center gap-2 text-[1.3rem] font-semibold">
          <span className="truncate">{entry.name}</span>
          {entry.author.verified && <Verified className="size-[1.1rem]" />}
        </span>
        <span className="mt-0.5 line-clamp-2 block h-[2.8em] text-[0.98rem] leading-snug text-ink-3">{entry.tagline}</span>
        <span className="mt-3 block text-[0.85rem] font-semibold uppercase tracking-[0.14em] text-[rgb(var(--a))]">{categoryLabel(entry.category)}</span>
      </span>
    </button>
  );
}

/** A big banner card with the name over it. */
export function WideCard({ entry, installed, onOpen, onFocus }: CardProps) {
  return (
    <button
      data-nav
      data-store-id={entry.id}
      onClick={onOpen}
      onFocus={onFocus}
      style={accentStyle(entry.accent)}
      className="focus-lift group relative aspect-[16/8] w-[38rem] shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line text-left"
    >
      <img src={bannerOf(entry)} alt="" draggable={false} className="absolute inset-0 size-full object-cover transition-transform duration-700 group-focus:scale-105" />
      <span className="absolute inset-0 bg-[linear-gradient(90deg,rgb(4_6_14/0.9),rgb(4_6_14/0.2)_70%)]" />
      <InstalledMark entry={entry} installed={installed} />
      <span className="absolute inset-x-7 bottom-7 flex items-end gap-5">
        <PluginIcon entry={entry} className="size-[5.4rem]" glow />
        <span className="min-w-0">
          <span className="eyebrow block text-[rgb(var(--a))]">{categoryLabel(entry.category)}</span>
          <span className="mt-1 block truncate text-[2rem] font-semibold leading-tight">{entry.name}</span>
          <span className="block truncate text-[1.05rem] text-ink-2">{entry.tagline}</span>
        </span>
      </span>
    </button>
  );
}

/** "Lo más instalado": a giant outlined number and the plugin beside it. */
export function RankedCard({ rank, entry, installed, onOpen, onFocus }: CardProps & { rank: number }) {
  return (
    <button data-nav data-store-id={entry.id} onClick={onOpen} onFocus={onFocus} style={accentStyle(entry.accent)} className="focus-lift group flex shrink-0 items-end rounded-[var(--radius-card)] pr-2 text-left">
      <span className="store-rank -mr-6 select-none" aria-hidden>
        {rank}
      </span>
      <span className="relative block w-[15rem] overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface-1">
        <span className="relative block aspect-[3/4] overflow-hidden">
          <img src={bannerOf(entry)} alt="" draggable={false} className="absolute inset-0 size-full object-cover object-[70%_50%] transition-transform duration-700 group-focus:scale-110" />
          <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
          <InstalledMark entry={entry} installed={installed} />
          <span className="absolute inset-x-4 bottom-4">
            <PluginIcon entry={entry} className="size-[3.6rem]" />
            <span className="mt-2 block truncate text-[1.25rem] font-semibold">{entry.name}</span>
            <span className="block truncate text-[0.9rem] text-ink-3">{categoryLabel(entry.category)}</span>
          </span>
        </span>
      </span>
    </button>
  );
}

// ───────────────────────── Installing ─────────────────────────

export interface InstallProps {
  entry: StoreEntry;
  installed?: string;
  /** False: the store can't install yet (unsigned store, no developer mode). */
  allowed: boolean;
  onInstall: () => void;
  onOpenPlugin: () => void;
  big?: boolean;
  autoFocus?: boolean;
}

/** One button for the whole life of a plugin: install, progress, open, update, retry. */
export function InstallButton({ entry, installed, allowed, onInstall, onOpenPlugin, big, autoFocus }: InstallProps) {
  const job = useInstall(entry.id);
  const busy = job.phase === "download" || job.phase === "verify" || job.phase === "install";
  const update = !!installed && newer(entry.version, installed);
  const size = big ? "h-[4.4rem] min-w-[17rem] px-9 text-[1.3rem]" : "";

  if (busy) {
    const label = job.phase === "download" ? `Descargando ${Math.round(job.progress * 100)} %` : job.phase === "verify" ? "Comprobando la firma…" : "Instalando…";
    return (
      <div role="status" aria-live="polite" className={`btn relative overflow-hidden bg-white/10 text-ink-1 ${size}`}>
        <motion.span className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,rgb(var(--a)/0.55),rgb(var(--a)/0.9))]" animate={{ width: `${(job.phase === "download" ? job.progress : 1) * 100}%` }} transition={{ ease: "easeOut", duration: 0.3 }} />
        <span className="store-shine" />
        <span className="relative flex items-center gap-3">
          {job.phase === "verify" ? <ShieldCheck className="size-6" /> : <LoaderCircle className="size-6 animate-spin" />}
          {label}
        </span>
      </div>
    );
  }
  if (installed && !update) {
    return (
      <button data-nav data-autofocus={autoFocus || undefined} onClick={onOpenPlugin} className={`focus-lift btn bg-white text-black ${size}`}>
        <Play className="size-6" fill="currentColor" /> Abrir
      </button>
    );
  }
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      disabled={!allowed}
      onClick={onInstall}
      className={`focus-lift btn text-white shadow-[0_0.8rem_2.4rem_-0.6rem_rgb(var(--a)/0.8)] ${size}`}
      style={{ background: "linear-gradient(135deg, rgb(var(--a)), rgb(var(--a) / 0.7))" }}
    >
      {job.phase === "error" ? <RefreshCw className="size-6" /> : update ? <RefreshCw className="size-6" /> : <Download className="size-6" />}
      {job.phase === "error" ? "Reintentar" : update ? `Actualizar a la ${entry.version}` : "Instalar"}
    </button>
  );
}

/** What the plugin will be able to do, before installing it. The user's yes is what NOVA grants. */
export function PermissionSheet({ entry, updating, onClose, onDone }: { entry: StoreEntry; updating: boolean; onClose: () => void; onDone: (ok: boolean) => void }) {
  const lines = permissionLines(entry.permissions).filter((l) => l.icon !== Globe);
  const domains = entry.permissions.network ?? [];
  const go = () => {
    onClose();
    void install(entry).then(onDone);
  };
  return (
    <Modal title={`${updating ? "Actualizar" : "Instalar"} ${entry.name}`} subtitle={`${entry.author.name} · ${formatSize(entry.package.size)}`} onClose={onClose} width="46rem">
      <div style={accentStyle(entry.accent)}>
        <p className="eyebrow">Podrá</p>
        <ul className="mt-3 space-y-2.5">
          {lines.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-4 text-[1.1rem]">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--a)/0.18)] text-[rgb(var(--a))]">
                <Icon className="size-5" />
              </span>
              {text}
            </li>
          ))}
        </ul>
        {domains.length > 0 && (
          <>
            <p className="eyebrow mt-6">Solo se conecta a</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {domains.map((d) => (
                <span key={d} className="rounded-lg bg-white/6 px-3 py-1.5 font-mono text-[0.95rem] text-ink-2">
                  {d}
                </span>
              ))}
            </div>
          </>
        )}
        <p className="mt-6 flex items-start gap-3 rounded-2xl bg-white/5 px-5 py-4 text-[0.98rem] text-ink-2">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" />
          Funciona aislado: no puede ver tus archivos ni otras apps, ni conectarse a otros sitios. Puedes quitarlo cuando quieras, sin dejar rastro.
        </p>
        {entry.audience === "adults" && (
          <p className="mt-3 flex items-center gap-3 text-[0.98rem] text-warn">
            <TriangleAlert className="size-5" /> Solo para adultos: nunca sale en perfiles infantiles.
          </p>
        )}
        <div className="mt-8 flex justify-end gap-3">
          <button data-nav onClick={onClose} className="focus-lift btn btn-ghost">
            Cancelar
          </button>
          <button data-nav data-autofocus onClick={go} className="focus-lift btn text-white" style={{ background: "linear-gradient(135deg, rgb(var(--a)), rgb(var(--a) / 0.7))" }}>
            <Download className="size-5" /> {updating ? "Actualizar" : "Instalar"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
