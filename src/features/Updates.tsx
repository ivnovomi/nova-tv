import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownToLine, CircleCheck, Clock, LoaderCircle, RefreshCw, Sparkles, TriangleAlert, Undo2 } from "lucide-react";
import { offered, updates, useUpdates } from "../app/updates";
import { isUnlocked, useActiveProfile, useProfiles } from "../app/profiles";
import { useBackHandler, useHomeHandler } from "../hooks/backStack";
import { focusFirst, restoreFocus } from "../lib/spatialNav";
import { timeAgo } from "../lib/api";
import { useToast } from "../components/Toasts";

const EASE = [0.22, 1, 0.36, 1] as const;

function mb(bytes: number) {
  return `${(bytes / 1024 ** 2).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function published(date: string | null) {
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? `publicada ${timeAgo(date)}` : null;
}

/** Children's profile without a parent's unlock: can see, not install. */
function useCanInstall() {
  const info = useProfiles();
  const profile = useActiveProfile();
  return !profile?.kids || isUnlocked(info);
}

/** NOVA's "A", drawn in, with a halo; `busy` keeps an orbit spinning around it. */
function Mark({ busy, done }: { busy?: boolean; done?: boolean }) {
  return (
    <div className="relative grid size-[7.5rem] shrink-0 place-items-center">
      <motion.span
        aria-hidden
        className="absolute inset-[-1.2rem] rounded-full bg-[radial-gradient(circle,rgb(110_108_255/0.45),transparent_68%)] blur-md"
        animate={{ opacity: [0.55, 1, 0.55], scale: [0.94, 1.04, 0.94] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      />
      <svg viewBox="0 0 192 192" className="relative size-full" aria-hidden>
        <defs>
          <linearGradient id="upd-g" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#6e6cff" />
            <stop offset="1" stopColor="#3fd5f2" />
          </linearGradient>
          <radialGradient id="upd-bg" cx="0.3" cy="0.2" r="1">
            <stop offset="0" stopColor="#1c2150" />
            <stop offset="0.6" stopColor="#090c1d" />
            <stop offset="1" stopColor="#05070f" />
          </radialGradient>
        </defs>
        <rect width="192" height="192" rx="44" fill="url(#upd-bg)" />
        <rect x="1" y="1" width="190" height="190" rx="43" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="2" />
        <motion.path
          d="M50 142 L96 52 L142 142"
          fill="none"
          stroke="url(#upd-g)"
          strokeWidth="17"
          strokeLinecap="square"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.15 }}
        />
      </svg>
      {busy && (
        <motion.svg viewBox="0 0 100 100" className="absolute inset-[-0.7rem] size-[calc(100%+1.4rem)]" animate={{ rotate: 360 }} transition={{ duration: 2.4, repeat: Infinity, ease: "linear" }} aria-hidden>
          <circle cx="50" cy="50" r="48" fill="none" stroke="url(#upd-g)" strokeWidth="1.6" strokeDasharray="60 242" strokeLinecap="round" />
        </motion.svg>
      )}
      {done && (
        <motion.span
          className="absolute -bottom-1 -right-1 grid size-10 place-items-center rounded-full bg-ok text-black ring-4 ring-surface-1"
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.7 }}
        >
          <CircleCheck className="size-6" />
        </motion.span>
      )}
    </div>
  );
}

/** Release notes: the bits of Markdown a release usually has (titles, lists, bold). */
function Notes({ text }: { text: string | null }) {
  if (!text) return <p className="text-[1.1rem] text-ink-3">Mejoras y correcciones.</p>;
  const inline = (line: string) =>
    line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") ? (
        <strong key={i} className="font-semibold text-ink-1">
          {part.slice(2, -2)}
        </strong>
      ) : part.startsWith("`") ? (
        <code key={i} className="rounded bg-white/10 px-1.5 text-[0.95em]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    const items = list;
    blocks.push(
      <ul key={blocks.length} className="space-y-2.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-3.5">
            <span aria-hidden className="mt-[0.6rem] size-2 shrink-0 rounded-full bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)]" />
            <span>{inline(item)}</span>
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      list.push(line.replace(/^[-*•]\s+/, ""));
      continue;
    }
    flush();
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.*)/);
    blocks.push(
      heading ? (
        <p key={blocks.length} className="eyebrow pt-2 text-cyan">
          {heading[1]}
        </p>
      ) : (
        <p key={blocks.length}>{inline(line)}</p>
      ),
    );
  }
  flush();
  return <div className="space-y-4 text-[1.15rem] leading-relaxed text-ink-2">{blocks}</div>;
}

function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="relative h-3 overflow-hidden rounded-full bg-white/10">
      {value === null ? (
        <motion.span
          className="absolute inset-y-0 w-1/3 rounded-full bg-[linear-gradient(90deg,transparent,#6e6cff,#3fd5f2,transparent)]"
          animate={{ left: ["-35%", "100%"] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : (
        <motion.span
          className="absolute inset-y-0 left-0 overflow-hidden rounded-full bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)] shadow-[0_0_1.2rem_rgb(63_213_242/0.6)]"
          animate={{ width: `${Math.max(2, value * 100)}%` }}
          transition={{ duration: 0.25, ease: "linear" }}
        >
          <motion.span
            className="absolute inset-y-0 w-24 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.45),transparent)]"
            animate={{ left: ["-6rem", "110%"] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        </motion.span>
      )}
    </div>
  );
}

/** NOVA's own window: full-screen dim, glows, a card that rises in. */
function NovaWindow({ label, onBack, children }: { label: string; onBack?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useBackHandler(() => onBack?.());
  // Home closes it like Back (and never reaches what's behind).
  useHomeHandler(() => onBack?.());
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const t = window.setTimeout(() => focusFirst(panel.current), 60);
    return () => {
      window.clearTimeout(t);
      restoreFocus(previous, node);
    };
  }, []);
  return createPortal(
    <motion.div
      className="fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-[#03050c]/80 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(55rem_32rem_at_30%_0%,rgb(110_108_255/0.28),transparent_70%),radial-gradient(45rem_30rem_at_85%_105%,rgb(63_213_242/0.16),transparent_70%)]" />
      <motion.div
        ref={panel}
        data-nav-scope
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-[min(60rem,calc(100vw-4rem))] overflow-hidden rounded-[var(--radius-hero)] border border-line-strong bg-[linear-gradient(160deg,rgb(24_34_77/0.92),rgb(11_17_36/0.96)_45%)] shadow-[0_3rem_8rem_-1rem_rgb(0_0_0/0.85)]"
        initial={{ opacity: 0, y: 40, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.98 }}
        transition={{ duration: 0.45, ease: EASE }}
      >
        <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#6e6cff,#3fd5f2,transparent)]" />
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function Header({ eyebrow, title, detail, mark }: { eyebrow: string; title: string; detail?: string | null; mark: ReactNode }) {
  return (
    <div className="flex items-center gap-8 px-12 pt-12">
      {mark}
      <div className="min-w-0">
        <motion.p className="eyebrow text-cyan" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 }}>
          {eyebrow}
        </motion.p>
        <motion.h2 className="mt-1 text-[2.6rem] font-semibold leading-tight tracking-tight" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28, ease: EASE }}>
          {title}
        </motion.h2>
        {detail && (
          <motion.p className="mt-1 text-[1.1rem] text-ink-3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.36 }}>
            {detail}
          </motion.p>
        )}
      </div>
    </div>
  );
}

function UpdateBody() {
  const { status, phase, downloaded, total, speed, installError } = useUpdates();
  const canInstall = useCanInstall();
  // The buttons go away while downloading: the progress keeps the focus so it never drops behind the window.
  const holdFocus = useCallback((el: HTMLDivElement | null) => el?.focus({ preventScroll: true }), []);
  // And when they come back (e.g. after a failed download), they get it again.
  const regainFocus = useCallback((el: HTMLDivElement | null) => {
    if (el && (!document.activeElement || document.activeElement === document.body)) focusFirst(el);
  }, []);
  const update = status?.available;
  if (!status || !update) return null;
  const busy = phase === "downloading" || phase === "installing";
  const share = total ? Math.min(1, downloaded / total) : null;
  const left = total && speed > 0 ? Math.max(0, Math.round((total - downloaded) / speed)) : null;

  return (
    <>
      <Header
        eyebrow={phase === "installing" ? "Instalando" : phase === "downloading" ? "Descargando" : "Nueva versión"}
        title={`NOVA TV ${update.version}`}
        detail={[`Tienes la ${status.current}`, published(update.date)].filter(Boolean).join(" · ")}
        mark={<Mark busy={busy} />}
      />
      <div className="page-scroll mx-12 mt-8 max-h-[38vh] overflow-y-auto rounded-2xl border border-line bg-black/20 px-7 py-6">
        <p className="eyebrow mb-4 text-ink-3">Novedades</p>
        <Notes text={update.notes} />
      </div>

      <div className="px-12 pb-11 pt-8">
        <AnimatePresence mode="wait" initial={false}>
          {busy ? (
            <motion.div key="busy" ref={holdFocus} tabIndex={-1} className="outline-none" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} aria-live="polite">
              <ProgressBar value={phase === "installing" ? null : share} />
              <div className="mt-4 flex items-baseline justify-between gap-6 text-[1.05rem] tabular-nums">
                {phase === "installing" ? (
                  <p className="font-semibold">Abriendo el instalador… NOVA se cerrará un momento y volverá ya actualizado.</p>
                ) : (
                  <>
                    <p className="font-semibold">
                      {share !== null ? `${Math.round(share * 100)} %` : "Descargando…"}
                      <span className="ml-3 font-normal text-ink-3">
                        {mb(downloaded)}
                        {total ? ` de ${mb(total)}` : ""}
                      </span>
                    </p>
                    <p className="text-ink-3">
                      {speed > 0 && `${mb(speed)}/s`}
                      {left !== null && left > 0 && ` · ${left < 60 ? `${left} s` : `${Math.ceil(left / 60)} min`}`}
                    </p>
                  </>
                )}
              </div>
            </motion.div>
          ) : canInstall ? (
            <motion.div key="actions" ref={regainFocus} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {installError && (
                <p role="alert" className="mb-5 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-5 py-3.5 text-[1.05rem] text-[#ffc2cf]">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0" /> {installError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <button data-nav data-autofocus onClick={() => void updates.install()} className="focus-lift btn btn-primary">
                  <ArrowDownToLine className="size-5" /> {installError ? "Reintentar" : "Actualizar ahora"}
                </button>
                <button data-nav onClick={updates.later} className="focus-lift btn btn-ghost">
                  <Clock className="size-5" /> Más tarde
                </button>
                <button data-nav onClick={() => void updates.skip()} className="focus-lift btn btn-ghost text-ink-3">
                  Omitir esta versión
                </button>
              </div>
              <p className="mt-5 text-[0.98rem] text-ink-3">La descarga está firmada y se comprueba antes de instalar. Tus perfiles, canales y ajustes se quedan como están.</p>
            </motion.div>
          ) : (
            <motion.div key="kids" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-between gap-6">
              <p className="text-[1.15rem] text-ink-2">Pide a un adulto que actualice NOVA desde Ajustes.</p>
              <button data-nav data-autofocus onClick={updates.later} className="focus-lift btn btn-ghost">
                Entendido
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function WhatsNewBody() {
  const { whatsNew } = useUpdates();
  if (!whatsNew) return null;
  return (
    <>
      <Header eyebrow="Actualizado" title={`Ya tienes NOVA TV ${whatsNew.version}`} detail="Esto es lo nuevo." mark={<Mark done />} />
      <div className="page-scroll mx-12 mt-8 max-h-[44vh] overflow-y-auto rounded-2xl border border-line bg-black/20 px-7 py-6">
        <Notes text={whatsNew.notes} />
      </div>
      <div className="px-12 pb-11 pt-8">
        <button data-nav data-autofocus onClick={updates.close} className="focus-lift btn btn-primary">
          <Sparkles className="size-5" /> Genial
        </button>
      </div>
    </>
  );
}

/** The update window and the "what's new" one, wherever NOVA is. */
export function UpdateWindows() {
  const { window: open, status, whatsNew } = useUpdates();
  return (
    <AnimatePresence>
      {open === "update" && status?.available && (
        <NovaWindow key="update" label={`Actualización de NOVA TV ${status.available.version}`} onBack={updates.close}>
          <UpdateBody />
        </NovaWindow>
      )}
      {open === "whatsnew" && whatsNew && (
        <NovaWindow key="whatsnew" label="Novedades de NOVA TV" onBack={updates.close}>
          <WhatsNewBody />
        </NovaWindow>
      )}
    </AnimatePresence>
  );
}

/** Top bar: there's a new version. */
export function UpdateChip() {
  const s = useUpdates();
  const update = offered(s);
  const canInstall = useCanInstall();
  if (!update || !canInstall) return null;
  const busy = s.phase === "downloading" || s.phase === "installing";
  return (
    <motion.button
      data-nav
      onClick={updates.open}
      aria-label={`Nueva versión de NOVA: ${update.version}`}
      className="focus-ring relative flex h-[3.4rem] items-center gap-2.5 overflow-hidden rounded-full bg-[linear-gradient(135deg,rgb(110_108_255/0.35),rgb(63_213_242/0.25))] pl-3 pr-5 text-[1rem] font-semibold ring-1 ring-white/15 focus:ring-white/40"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
    >
      <span className="relative grid size-[2.3rem] place-items-center rounded-full bg-white/15">
        {busy ? <LoaderCircle className="size-5 spin" /> : <ArrowDownToLine className="size-5" />}
        {!busy && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-cyan shadow-[0_0_0.6rem_#3fd5f2]" />}
      </span>
      {busy ? (s.phase === "installing" ? "Instalando…" : s.total ? `${Math.round((s.downloaded / s.total) * 100)} %` : "Descargando…") : `Actualizar a ${update.version}`}
    </motion.button>
  );
}

/**
 * A new version was found: a card slides in for a few seconds (it doesn't take
 * the focus, so it never interrupts). The chip in the top bar stays.
 */
export function UpdateNotice({ hidden }: { hidden: boolean }) {
  const s = useUpdates();
  const update = offered(s);
  const canInstall = useCanInstall();
  const [shown, setShown] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!update || !canInstall || hidden || shown === update.version || s.window) return;
    setShown(update.version);
    setVisible(true);
    const t = window.setTimeout(() => setVisible(false), 9000);
    return () => window.clearTimeout(t);
  }, [update, canInstall, hidden, shown, s.window]);

  useEffect(() => {
    if (hidden || s.window) setVisible(false);
  }, [hidden, s.window]);

  return createPortal(
    <AnimatePresence>
      {visible && update && (
        <motion.div
          key="notice"
          role="status"
          className="pointer-events-none fixed bottom-24 right-[var(--gutter)] z-50 flex w-[32rem] items-center gap-5 overflow-hidden rounded-[var(--radius-card)] border border-line-strong bg-[linear-gradient(150deg,rgb(24_34_77/0.95),rgb(11_17_36/0.97))] p-5 shadow-[0_2rem_5rem_-1rem_rgb(0_0_0/0.8)] backdrop-blur"
          initial={{ opacity: 0, x: 60 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#6e6cff,#3fd5f2,transparent)]" />
          <div className="scale-[0.62] -m-6">
            <Mark />
          </div>
          <div className="min-w-0">
            <p className="eyebrow text-cyan">Nueva versión</p>
            <p className="mt-0.5 text-[1.3rem] font-semibold leading-snug">NOVA TV {update.version} está lista</p>
            <p className="mt-1 text-[0.98rem] text-ink-3">Ábrela desde «Actualizar» en la barra de arriba.</p>
          </div>
          <motion.span
            aria-hidden
            className="absolute bottom-0 left-0 h-[3px] bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)]"
            initial={{ width: "100%" }}
            animate={{ width: "0%" }}
            transition={{ duration: 9, ease: "linear" }}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Ajustes → Actualizaciones. */
export function UpdatesSettings({ Toggle }: { Toggle: (p: { title: string; description: string; value: boolean; onChange: () => void; busy?: boolean }) => ReactNode }) {
  const s = useUpdates();
  const toast = useToast();
  const status = s.status;
  const update = status?.available;
  const busy = s.phase === "downloading" || s.phase === "installing";

  const check = async () => {
    try {
      const next = await updates.check();
      if (next?.error) toast.show("error", "No se pudo comprobar", next.error);
      else if (!next?.available) toast.show("success", "NOVA está al día", `Tienes la última versión (${next?.current}).`);
    } catch (e) {
      toast.show("error", "No se pudo comprobar", e instanceof Error ? e.message : String(e));
    }
  };

  if (!status) return <p className="text-[1.05rem] text-ink-3">Las actualizaciones funcionan en la aplicación de escritorio.</p>;

  return (
    <>
      <div className="surface relative flex items-center gap-7 overflow-hidden rounded-2xl px-7 py-6">
        <div className="-m-3 scale-[0.75]">
          <Mark busy={status.checking || busy} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[1.6rem] font-semibold">NOVA TV {status.current}</p>
          {update ? (
            <p className="mt-1 flex items-center gap-2 text-[1.05rem] text-cyan">
              <ArrowDownToLine className="size-5" /> Nueva versión disponible: {update.version}
              {status.skipped === update.version && <span className="text-ink-3">(omitida)</span>}
            </p>
          ) : status.error ? (
            <p className="mt-1 flex items-center gap-2 text-[1.05rem] text-warn">
              <TriangleAlert className="size-5 shrink-0" /> {status.error}
            </p>
          ) : (
            <p className="mt-1 flex items-center gap-2 text-[1.05rem] text-ok">
              <CircleCheck className="size-5" /> {status.checkedAt ? "Está al día" : "Aún no se ha comprobado"}
            </p>
          )}
          <p className="mt-1 text-[0.95rem] text-ink-3">
            {status.checking ? "Comprobando…" : status.checkedAt ? `Comprobado ${timeAgo(status.checkedAt)}` : "Se comprueba al poco de abrir NOVA y cada 6 horas."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        {update && (
          <button data-nav onClick={updates.open} className="focus-lift btn btn-primary">
            <Sparkles className="size-5" /> Ver la actualización
          </button>
        )}
        <button data-nav disabled={status.checking || busy} onClick={() => void check()} className="focus-lift btn btn-ghost">
          <RefreshCw className={`size-5 ${status.checking ? "spin" : ""}`} /> Buscar actualizaciones
        </button>
        {status.skipped && (
          <button data-nav onClick={() => void updates.unskip()} className="focus-lift btn btn-ghost">
            <Undo2 className="size-5" /> Volver a avisar de la {status.skipped}
          </button>
        )}
      </div>
      <Toggle
        title="Buscar actualizaciones automáticamente"
        description="NOVA mira si hay una versión nueva al poco de abrirse y cada 6 horas, y te avisa. Nunca instala nada sin que lo pidas."
        value={status.autoCheck}
        onChange={() =>
          void updates.setAuto(!status.autoCheck).catch((e: Error) => toast.show("error", "No se pudo cambiar", e.message))
        }
      />
      <p className="text-[0.95rem] text-ink-3">Las versiones se publican en GitHub, firmadas: NOVA solo instala una si su firma coincide con la de NOVA TV.</p>
    </>
  );
}
