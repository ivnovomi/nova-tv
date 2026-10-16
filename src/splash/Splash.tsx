import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, Check, Clock, LoaderCircle, Minus, TriangleAlert } from "lucide-react";
import { api, inTauri } from "../lib/api";
import type { UpdateInfo, UpdateStatus } from "../lib/types";

const EASE = [0.22, 1, 0.36, 1] as const;
/** Read once by NOVA's update store (app/updates.ts). */
export const LATER_KEY = "nova.update.later";

type StepId = "update" | "profiles" | "channels" | "library";
type StepState = { status: "waiting" | "running" | "done" | "skipped" | "failed"; detail?: string };

const STEPS: { id: StepId; label: string }[] = [
  { id: "update", label: "Actualizaciones" },
  { id: "profiles", label: "Perfiles" },
  { id: "channels", label: "Canales" },
  { id: "library", label: "Biblioteca" },
];

const RUNNING: Record<StepId, string> = {
  update: "Buscando actualizaciones…",
  profiles: "Cargando perfiles…",
  channels: "Sintonizando canales…",
  library: "Preparando tu biblioteca…",
};

/** A promise that gives up after `ms` (the step then continues without it). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => window.setTimeout(() => r("timeout"), ms))]);
}

function mb(bytes: number) {
  return `${(bytes / 1024 ** 2).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** The first few bullet points of the release notes, as plain text. */
function highlights(notes: string | null): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*•]\s+/.test(l))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/\*\*|`/g, ""))
    .slice(0, 3);
}

function Mark({ busy }: { busy: boolean }) {
  return (
    <div className="relative grid size-[5.6rem] place-items-center">
      <motion.span
        aria-hidden
        className="absolute inset-[-1rem] rounded-full bg-[radial-gradient(circle,rgb(110_108_255/0.5),transparent_68%)] blur-md"
        animate={{ opacity: [0.5, 1, 0.5], scale: [0.94, 1.05, 0.94] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />
      <svg viewBox="0 0 192 192" className="relative size-full" aria-hidden>
        <defs>
          <linearGradient id="sp-g" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#6e6cff" />
            <stop offset="1" stopColor="#3fd5f2" />
          </linearGradient>
          <radialGradient id="sp-bg" cx="0.3" cy="0.2" r="1">
            <stop offset="0" stopColor="#1c2150" />
            <stop offset="0.6" stopColor="#090c1d" />
            <stop offset="1" stopColor="#05070f" />
          </radialGradient>
        </defs>
        <rect width="192" height="192" rx="44" fill="url(#sp-bg)" />
        <rect x="1" y="1" width="190" height="190" rx="43" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="2" />
        <motion.path
          d="M50 142 L96 52 L142 142"
          fill="none"
          stroke="url(#sp-g)"
          strokeWidth="17"
          strokeLinecap="square"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: EASE, delay: 0.1 }}
        />
      </svg>
      {busy && (
        <motion.svg viewBox="0 0 100 100" className="absolute inset-[-0.6rem] size-[calc(100%+1.2rem)]" animate={{ rotate: 360 }} transition={{ duration: 2.2, repeat: Infinity, ease: "linear" }} aria-hidden>
          <circle cx="50" cy="50" r="48" fill="none" stroke="url(#sp-g)" strokeWidth="1.8" strokeDasharray="56 246" strokeLinecap="round" />
        </motion.svg>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state.status === "running") return <LoaderCircle className="size-4 spin text-cyan" />;
  if (state.status === "done") return <Check className="size-4 text-ok" strokeWidth={3} />;
  if (state.status === "failed") return <TriangleAlert className="size-4 text-warn" />;
  if (state.status === "skipped") return <Minus className="size-4 text-ink-3" />;
  return <span className="size-1.5 rounded-full bg-ink-3/60" />;
}

/** Arrow keys, Enter and a controller's D-pad / A move between and press the buttons. */
function useButtonNav(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const buttons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const move = (step: number) => {
      const list = buttons();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + step + list.length) % list.length]?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    let raf = 0;
    const was: Record<string, boolean> = {};
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const pad = (navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
      if (!pad) return;
      const ax = pad.axes[0] ?? 0;
      const now = {
        a: !!pad.buttons[0]?.pressed,
        next: !!pad.buttons[15]?.pressed || !!pad.buttons[13]?.pressed || ax > 0.6,
        prev: !!pad.buttons[14]?.pressed || !!pad.buttons[12]?.pressed || ax < -0.6,
      };
      if (now.a && !was.a) (document.activeElement as HTMLElement | null)?.click();
      if (now.next && !was.next) move(1);
      if (now.prev && !was.prev) move(-1);
      Object.assign(was, now);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    };
  }, [root]);
}

type Phase = "steps" | "prompt" | "downloading" | "installing" | "ready" | "error";

/** NOVA's start-up window. */
export function Splash() {
  const [steps, setSteps] = useState<Record<StepId, StepState>>({
    update: { status: "waiting" },
    profiles: { status: "waiting" },
    channels: { status: "waiting" },
    library: { status: "waiting" },
  });
  const [current, setCurrent] = useState<StepId | null>(null);
  const [phase, setPhase] = useState<Phase>("steps");
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [message, setMessage] = useState<string | null>(null);
  const choice = useRef<((c: "install" | "later" | "skip") => void) | null>(null);
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  useButtonNav(root);

  const mark = (id: StepId, state: StepState) => setSteps((s) => ({ ...s, [id]: state }));

  useEffect(() => {
    if (!inTauri) return;
    const offs = [
      listen<{ downloaded: number; total: number | null }>("update-progress", ({ payload }) => setProgress(payload)),
      listen("update-installing", () => setPhase("installing")),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice in development
    started.current = true;

    const run = async () => {
      // 1. Updates: offered here, before NOVA opens.
      setCurrent("update");
      mark("update", { status: "running" });
      let status: UpdateStatus | null = null;
      try {
        status = await api.updatesStatus();
        setVersion(status.current);
        if (status.autoCheck) {
          const checked = await withTimeout(api.updatesCheck(), 10_000);
          if (checked !== "timeout") status = checked;
        }
      } catch {}
      const offer = status?.available && status.skipped !== status.available.version ? status.available : null;
      if (!status?.autoCheck) mark("update", { status: "skipped", detail: "Búsqueda automática desactivada" });
      else if (offer) {
        mark("update", { status: "done", detail: `Nueva versión ${offer.version}` });
        setUpdate(offer);
        setPhase("prompt");
        const picked = await new Promise<"install" | "later" | "skip">((resolve) => (choice.current = resolve));
        if (picked === "install") return; // the installer closes NOVA and opens the new version
        if (picked === "skip") await api.updatesSkip(offer.version).catch(() => {});
        // "Más tarde": NOVA doesn't announce it again as soon as it opens.
        if (picked === "later")
          try {
            localStorage.setItem(LATER_KEY, offer.version);
          } catch {}
        setPhase("steps");
      } else if (status?.error) mark("update", { status: "failed", detail: status.error });
      else mark("update", { status: "done", detail: "NOVA está al día" });

      // 2–4. Profiles, channels, library.
      for (const id of ["profiles", "channels", "library"] as const) {
        setCurrent(id);
        mark(id, { status: "running" });
        try {
          mark(id, { status: "done", detail: await api.splashStep(id) });
        } catch (e) {
          mark(id, { status: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }

      setCurrent(null);
      setPhase("ready");
      await new Promise((r) => window.setTimeout(r, 450));
      try {
        await api.splashDone();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    };
    if (inTauri) void run();
  }, []);

  const install = async () => {
    setMessage(null);
    setPhase("downloading");
    setProgress({ downloaded: 0, total: null });
    try {
      // Remembered so the new version can say what's new.
      if (update) localStorage.setItem("nova.update.notes", JSON.stringify(update));
    } catch {}
    try {
      await api.updatesInstall();
      choice.current?.("install");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setPhase("prompt");
    }
  };

  // Focus the main button of each screen.
  useEffect(() => {
    const t = window.setTimeout(() => root.current?.querySelector<HTMLButtonElement>("[data-autofocus]")?.focus(), 80);
    return () => window.clearTimeout(t);
  }, [phase]);

  const busy = phase === "steps" || phase === "downloading" || phase === "installing" || phase === "ready";
  const share = progress.total ? Math.min(1, progress.downloaded / progress.total) : null;

  return (
    <div ref={root} data-tauri-drag-region className="relative flex h-screen select-none flex-col overflow-hidden bg-[#05070f] text-ink-1">
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(30rem_18rem_at_20%_0%,rgb(110_108_255/0.3),transparent_70%),radial-gradient(26rem_18rem_at_100%_100%,rgb(63_213_242/0.16),transparent_70%)]" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#6e6cff,#3fd5f2,transparent)]" />

      <div data-tauri-drag-region className="relative flex items-center gap-6 px-9 pt-9">
        <Mark busy={busy} />
        <div data-tauri-drag-region className="min-w-0">
          <p className="text-[1.9rem] font-semibold leading-none tracking-tight">
            NOVA <span className="text-[1rem] font-semibold tracking-[0.2em] text-ink-2">TV</span>
          </p>
          <AnimatePresence mode="wait">
            <motion.p
              key={phase === "steps" ? current : phase}
              className="mt-2 truncate text-[1rem] text-ink-2"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
            >
              {phase === "prompt"
                ? "Hay una versión nueva"
                : phase === "downloading"
                  ? "Descargando la actualización…"
                  : phase === "installing"
                    ? "Instalando… NOVA se abrirá ya actualizado"
                    : phase === "ready"
                      ? "Todo listo"
                      : phase === "error"
                        ? "No se pudo abrir NOVA"
                        : current
                          ? RUNNING[current]
                          : "Arrancando…"}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      <div data-tauri-drag-region className="relative flex min-h-0 flex-1 flex-col justify-center px-9">
        <AnimatePresence mode="wait" initial={false}>
          {phase === "prompt" || phase === "downloading" || phase === "installing" ? (
            <motion.div key="update" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }}>
              <div className="rounded-2xl border border-line-strong bg-white/[0.04] px-5 py-4">
                <p className="eyebrow text-cyan">Nueva versión</p>
                <p className="mt-0.5 text-[1.35rem] font-semibold">
                  NOVA TV {update?.version}
                  {version && <span className="ml-2 text-[0.9rem] font-normal text-ink-3">tienes la {version}</span>}
                </p>
                {highlights(update?.notes ?? null).length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {highlights(update?.notes ?? null).map((h) => (
                      <li key={h} className="flex gap-2.5 text-[0.92rem] leading-snug text-ink-2">
                        <span aria-hidden className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)]" />
                        <span className="line-clamp-2">{h}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {phase === "prompt" ? (
                <>
                  {message && (
                    <p role="alert" className="mt-3 flex items-start gap-2 text-[0.92rem] text-[#ffc2cf]">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {message}
                    </p>
                  )}
                  <div className="mt-4 flex gap-2">
                    <button data-autofocus onClick={() => void install()} className="focus-lift btn btn-primary">
                      <ArrowDownToLine className="size-5" /> {message ? "Reintentar" : "Actualizar ahora"}
                    </button>
                    <button onClick={() => choice.current?.("later")} className="focus-lift btn btn-ghost">
                      <Clock className="size-5" /> Más tarde
                    </button>
                    <button onClick={() => choice.current?.("skip")} className="focus-lift btn btn-ghost text-ink-3">
                      Omitir
                    </button>
                  </div>
                </>
              ) : (
                <div className="mt-5" aria-live="polite">
                  <div className="relative h-2.5 overflow-hidden rounded-full bg-white/10">
                    {phase === "installing" || share === null ? (
                      <motion.span
                        className="absolute inset-y-0 w-1/3 rounded-full bg-[linear-gradient(90deg,transparent,#6e6cff,#3fd5f2,transparent)]"
                        animate={{ left: ["-35%", "100%"] }}
                        transition={{ duration: 1.3, repeat: Infinity, ease: "easeInOut" }}
                      />
                    ) : (
                      <motion.span className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)] shadow-[0_0_1rem_rgb(63_213_242/0.6)]" animate={{ width: `${Math.max(2, share * 100)}%` }} transition={{ duration: 0.25, ease: "linear" }} />
                    )}
                  </div>
                  <p className="mt-2.5 text-[0.95rem] tabular-nums text-ink-2">
                    {phase === "installing"
                      ? "Abriendo el instalador…"
                      : `${share !== null ? `${Math.round(share * 100)} % · ` : ""}${mb(progress.downloaded)}${progress.total ? ` de ${mb(progress.total)}` : ""}`}
                  </p>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.ul key="steps" className="space-y-3.5" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {STEPS.map(({ id, label }) => {
                const s = steps[id];
                return (
                  <li key={id} className={`flex items-center gap-3.5 text-[1rem] transition-opacity ${s.status === "waiting" ? "opacity-45" : ""}`}>
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.06]">
                      <StepIcon state={s} />
                    </span>
                    <span className="w-28 shrink-0 font-semibold">{label}</span>
                    <span className={`min-w-0 truncate ${s.status === "failed" ? "text-warn" : "text-ink-3"}`}>{s.detail}</span>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </AnimatePresence>
        {phase === "error" && (
          <div className="mt-4 flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-[0.92rem] text-[#ffc2cf]">{message}</p>
            <button data-autofocus onClick={() => void api.splashDone().catch((e: Error) => setMessage(e.message))} className="focus-lift btn btn-primary">
              Reintentar
            </button>
          </div>
        )}
      </div>

      <p data-tauri-drag-region className="relative px-9 pb-6 text-[0.8rem] text-ink-3">{version ? `Versión ${version}` : " "}</p>
    </div>
  );
}
