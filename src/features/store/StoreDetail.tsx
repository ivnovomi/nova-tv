import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Calendar, Fingerprint, Globe, HardDrive, Languages, Lock, Maximize2, Settings2, ShieldCheck, Tag, TriangleAlert, User, Users, X } from "lucide-react";
import { useNova } from "../../app/context";
import { useBackHandler } from "../../hooks/backStack";
import { focusFirst, restoreFocus } from "../../lib/spatialNav";
import type { StoreEntry } from "../../lib/types";
import { permissionLines } from "../PluginsSettings";
import { categoryIcon, categoryLabel, features, formatDay, formatSize, languageName, newer, useInstall, type StoreData } from "./model";
import { accentStyle, bannerOf, Chip, InstallButton, PluginCard, PluginIcon, Verified } from "./parts";

// ───────────────────────── Screenshot viewer ─────────────────────────

/** Full screen, with a filmstrip: moving along it changes the picture. */
function Lightbox({ entry, start, onClose }: { entry: StoreEntry; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const panel = useRef<HTMLDivElement>(null);
  useBackHandler(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const t = window.setTimeout(() => focusFirst(panel.current), 30);
    return () => {
      window.clearTimeout(t);
      restoreFocus(previous, node);
    };
  }, []);
  const shot = entry.screenshots[index];
  return createPortal(
    <motion.div
      ref={panel}
      data-nav-scope
      role="dialog"
      aria-modal="true"
      aria-label={`Capturas de ${entry.name}`}
      style={accentStyle(entry.accent)}
      className="fixed inset-0 z-50 flex flex-col bg-[rgb(2_3_8/0.94)] backdrop-blur-xl"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="flex items-center justify-between px-[var(--gutter)] pt-8">
        <div className="flex items-center gap-4">
          <PluginIcon entry={entry} className="size-12" />
          <div>
            <p className="text-[1.3rem] font-semibold">{entry.name}</p>
            <p className="text-[0.95rem] text-ink-3">
              Captura {index + 1} de {entry.screenshots.length}
            </p>
          </div>
        </div>
        <button data-nav onClick={onClose} aria-label="Cerrar" className="focus-ring grid size-14 place-items-center rounded-full bg-white/10">
          <X className="size-7" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-[var(--gutter)] py-6">
        <AnimatePresence mode="wait">
          <motion.figure key={shot.url} className="flex max-h-full flex-col items-center" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.01 }} transition={{ duration: 0.3 }}>
            <img src={shot.url} alt={shot.caption ?? ""} draggable={false} className="max-h-[70vh] rounded-[1.4rem] border border-white/10 object-contain shadow-[0_3rem_8rem_-2rem_rgb(var(--a)/0.5)]" />
            {shot.caption && <figcaption className="mt-5 text-[1.3rem] text-ink-2">{shot.caption}</figcaption>}
          </motion.figure>
        </AnimatePresence>
      </div>
      <div className="row-scroller justify-center pb-10">
        {entry.screenshots.map((s, i) => (
          <button
            key={s.url}
            data-nav
            data-autofocus={i === start || undefined}
            aria-label={s.caption ?? `Captura ${i + 1}`}
            onFocus={() => setIndex(i)}
            onClick={() => setIndex(i)}
            className={`focus-lift aspect-video w-[11rem] shrink-0 overflow-hidden rounded-xl border-2 ${i === index ? "border-[rgb(var(--a))]" : "border-transparent opacity-60"}`}
          >
            <img src={s.url} alt="" draggable={false} className="size-full object-cover" />
          </button>
        ))}
      </div>
    </motion.div>,
    document.body,
  );
}

// ───────────────────────── The page ─────────────────────────

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-[1.6rem] font-semibold tracking-tight">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function StoreDetail({ entry, data, related, onBack, onOpen, onInstall, onOpenPlugin, onAccent }: {
  entry: StoreEntry;
  data: StoreData;
  related: StoreEntry[];
  onBack: () => void;
  onOpen: (id: string) => void;
  onInstall: () => void;
  onOpenPlugin: () => void;
  onAccent: (accent: string | null | undefined) => void;
}) {
  const nova = useNova();
  const job = useInstall(entry.id);
  const [viewing, setViewing] = useState<number | null>(null);
  const installed = data.installed[entry.id];
  const allowed = data.signed || data.developerMode;
  const what = features(entry.permissions);
  const CategoryIcon = categoryIcon(entry.category);
  const lines = permissionLines(entry.permissions).filter((l) => l.icon !== Globe);

  useEffect(() => onAccent(entry.accent), [entry, onAccent]);

  return (
    <div style={accentStyle(entry.accent)}>
      {/* The banner, with the page's head over its lower edge. */}
      <section className="relative mx-[var(--gutter)] h-[clamp(19rem,36vh,25rem)] overflow-hidden rounded-[var(--radius-hero)] border border-line">
        <img src={bannerOf(entry)} alt="" draggable={false} className="kenburns absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgb(3_5_12/0.1)_0%,rgb(3_5_12/0.35)_45%,rgb(3_5_12/0.97)_100%)]" />
        <button data-nav onClick={onBack} className="focus-lift btn btn-ghost absolute left-8 top-8">
          <ArrowLeft className="size-5" /> Tienda
        </button>
      </section>

      <div className="relative -mt-[8.5rem] px-[calc(var(--gutter)+clamp(1.5rem,3vw,3rem))]">
        <div className="flex flex-wrap items-end gap-x-9 gap-y-5">
          <motion.div initial={{ scale: 0.7, opacity: 0, rotate: -8 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 160, damping: 16 }}>
            <PluginIcon entry={entry} className="size-[clamp(8rem,11vw,11.5rem)]" glow />
          </motion.div>
          <div className="min-w-0 flex-1 pb-2">
            <p className="eyebrow flex items-center gap-2 text-[rgb(var(--a))]">
              <CategoryIcon className="size-4" /> {categoryLabel(entry.category)}
            </p>
            <h1 className="mt-1 text-[clamp(2.8rem,4.6vw,4.8rem)] font-semibold leading-[1] tracking-[-0.03em]">{entry.name}</h1>
            <p className="mt-2 flex items-center gap-2 text-[1.15rem] text-ink-2">
              {entry.author.name} {entry.author.verified && <Verified />}
              {entry.author.verified && <span className="text-ink-3">· Desarrollador verificado</span>}
            </p>
          </div>
        </div>

        <p className="mt-7 max-w-[60rem] text-[clamp(1.3rem,1.7vw,1.7rem)] leading-snug">{entry.tagline}</p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <InstallButton entry={entry} installed={installed} allowed={allowed} onInstall={onInstall} onOpenPlugin={onOpenPlugin} big autoFocus />
          {installed && (
            <button data-nav onClick={() => nova.navigate("settings")} className="focus-lift btn btn-ghost">
              <Settings2 className="size-5" /> Opciones y desinstalar
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <Chip>v{entry.version}</Chip>
            <Chip>{formatSize(entry.package.size)}</Chip>
            <Chip>{entry.audience === "adults" ? "+18" : "Para todos"}</Chip>
            {installed && <Chip tone="ok">{newer(entry.version, installed) ? `Tienes la ${installed}` : "Instalado"}</Chip>}
          </div>
        </div>
        {job.phase === "error" && (
          <p role="alert" className="mt-4 flex max-w-[60rem] items-start gap-3 text-[1.05rem] text-danger">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" /> {job.error}
          </p>
        )}
        {!allowed && !installed && (
          <p className="mt-4 text-[1rem] text-ink-3">La tienda aún no firma sus paquetes: de momento solo instala con el modo desarrollador (Ajustes → Plugins).</p>
        )}

        {/* Why it's safe, in three lines. */}
        <div className="mt-10 grid max-w-[80rem] gap-4 sm:grid-cols-3">
          {[
            { icon: ShieldCheck, title: "Revisado por NOVA", text: entry.reviewedAt ? `Esta versión, el ${formatDay(entry.reviewedAt)}.` : "Cada versión, antes de publicarse." },
            { icon: Fingerprint, title: data.signed ? "Firmado digitalmente" : "Huella comprobada", text: data.signed ? "NOVA comprueba la firma de la tienda al instalar." : "NOVA comprueba que el paquete no se ha alterado." },
            { icon: Lock, title: "Aislado", text: "No puede ver tus archivos ni otras apps, ni conectarse a otros sitios." },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex items-start gap-4 rounded-[var(--radius-card)] border border-line bg-white/[0.035] px-5 py-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[rgb(var(--a)/0.16)] text-[rgb(var(--a))]">
                <Icon className="size-5" />
              </span>
              <span>
                <span className="block text-[1.08rem] font-semibold">{title}</span>
                <span className="block text-[0.95rem] text-ink-3">{text}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {entry.screenshots.length > 0 && (
        <section className="mt-14">
          <h2 className="px-[calc(var(--gutter)+clamp(1.5rem,3vw,3rem))] text-[1.6rem] font-semibold tracking-tight">Capturas</h2>
          <div className="row-scroller mt-2 pl-[calc(var(--gutter)+clamp(1.5rem,3vw,3rem))]">
            {entry.screenshots.map((s, i) => (
              <button key={s.url} data-nav onClick={() => setViewing(i)} aria-label={s.caption ?? `Captura ${i + 1}`} className="focus-lift group relative w-[clamp(26rem,36vw,40rem)] shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line text-left">
                <img src={s.url} alt="" draggable={false} className="aspect-video w-full object-cover transition-transform duration-700 group-focus:scale-105" />
                <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 bg-gradient-to-t from-black/85 to-transparent px-5 pb-4 pt-12">
                  <span className="text-[1.05rem] font-semibold">{s.caption}</span>
                  <Maximize2 className="size-5 shrink-0 opacity-0 transition-opacity group-focus:opacity-100" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-x-16 px-[calc(var(--gutter)+clamp(1.5rem,3vw,3rem))] lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div>
          {what.length > 0 && (
            <Section title="Qué añade a NOVA">
              <div className="grid gap-4 sm:grid-cols-2">
                {what.map(({ icon: Icon, title, text }) => (
                  <div key={title} className="relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-[linear-gradient(135deg,rgb(var(--a)/0.14),rgb(255_255_255/0.02))] px-6 py-5">
                    <Icon className="size-8 text-[rgb(var(--a))]" />
                    <p className="mt-3 text-[1.2rem] font-semibold">{title}</p>
                    <p className="mt-1 text-[1rem] text-ink-3">{text}</p>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {entry.description && (
            <Section title={`Sobre ${entry.name}`}>
              <div className="max-w-[56rem] space-y-4 text-[1.15rem] leading-relaxed text-ink-2">
                {entry.description.split(/\n{2,}/).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </Section>
          )}

          {entry.changelog.length > 0 && (
            <Section title="Novedades">
              <ol className="relative space-y-7 border-l-2 border-line pl-8">
                {entry.changelog.map((c, i) => (
                  <li key={c.version} className="relative">
                    <span className={`absolute -left-[2.55rem] top-1.5 size-4 rounded-full ring-4 ring-bg-0 ${i === 0 ? "bg-[rgb(var(--a))]" : "bg-white/25"}`} />
                    <p className="flex items-baseline gap-3">
                      <span className="text-[1.25rem] font-semibold">Versión {c.version}</span>
                      <span className="text-[0.95rem] text-ink-3">{formatDay(c.date)}</span>
                    </p>
                    <ul className="mt-2 space-y-1.5 text-[1.05rem] text-ink-2">
                      {c.notes.map((n) => (
                        <li key={n} className="flex gap-3">
                          <span className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-ink-3" /> {n}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </Section>
          )}
        </div>

        <aside>
          <Section title="Permisos">
            <ul className="space-y-3">
              {lines.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-4 text-[1.05rem] text-ink-2">
                  <Icon className="size-5 shrink-0 text-[rgb(var(--a))]" /> {text}
                </li>
              ))}
            </ul>
            {(entry.permissions.network ?? []).length > 0 && (
              <div className="mt-5">
                <p className="eyebrow">Solo se conecta a</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(entry.permissions.network ?? []).map((d) => (
                    <span key={d} className="rounded-lg bg-white/6 px-3 py-1.5 font-mono text-[0.92rem] text-ink-2">
                      {d}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Section>

          <Section title="Información">
            <dl className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-white/[0.03]">
              {[
                { icon: User, label: "Desarrollador", value: entry.author.name },
                { icon: Tag, label: "Versión", value: entry.version },
                { icon: Calendar, label: "Actualizado", value: formatDay(entry.updatedAt) },
                { icon: HardDrive, label: "Tamaño", value: formatSize(entry.package.size) },
                { icon: Users, label: "Público", value: entry.audience === "adults" ? "Solo adultos" : "Para todos" },
                { icon: Languages, label: "Idiomas", value: entry.languages.length ? entry.languages.map(languageName).join(", ") : "—" },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-center gap-4 px-5 py-3.5">
                  <Icon className="size-5 shrink-0 text-ink-3" />
                  <dt className="flex-1 text-[1rem] text-ink-3">{label}</dt>
                  <dd className="text-right text-[1.05rem] font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </aside>
      </div>

      {related.length > 0 && (
        <section className="mt-14">
          <h2 className="px-[var(--gutter)] text-[1.6rem] font-semibold tracking-tight">También te puede gustar</h2>
          <div className="row-scroller mt-2">
            {related.map((e) => (
              <PluginCard key={e.id} entry={e} installed={data.installed[e.id]} onOpen={() => onOpen(e.id)} onFocus={() => onAccent(e.accent)} />
            ))}
          </div>
        </section>
      )}

      <AnimatePresence>{viewing !== null && <Lightbox entry={entry} start={viewing} onClose={() => setViewing(null)} />}</AnimatePresence>
    </div>
  );
}
