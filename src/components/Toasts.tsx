import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";

export type ToastKind = "info" | "success" | "error" | "loading";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}
interface ToastApi {
  show: (kind: ToastKind, title: string, detail?: string) => number;
  update: (id: number, kind: ToastKind, title: string, detail?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ToastProvider missing");
  return ctx;
}

const ICONS = {
  info: <Info className="size-6 text-cyan" />,
  success: <CircleCheck className="size-6 text-ok" />,
  error: <TriangleAlert className="size-6 text-danger" />,
  loading: <LoaderCircle className="size-6 text-focus spin" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const schedule = useCallback((id: number, kind: ToastKind) => {
    window.clearTimeout(timers.current.get(id));
    if (kind === "loading") return;
    const ms = kind === "error" ? 7000 : 3800;
    timers.current.set(
      id,
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms),
    );
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show(kind, title, detail) {
        const id = nextId.current++;
        setToasts((t) => [...t.slice(-3), { id, kind, title, detail }]);
        schedule(id, kind);
        return id;
      },
      update(id, kind, title, detail) {
        setToasts((t) => {
          const exists = t.some((x) => x.id === id);
          return exists ? t.map((x) => (x.id === id ? { id, kind, title, detail } : x)) : [...t, { id, kind, title, detail }];
        });
        schedule(id, kind);
      },
    }),
    [schedule],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-[var(--gutter)] top-28 z-[75] flex w-[30rem] flex-col gap-3" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 40, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className={`flex items-start gap-4 rounded-2xl border bg-surface-1/95 px-5 py-4 shadow-2xl backdrop-blur ${
                t.kind === "error" ? "border-danger/40" : "border-line-strong"
              }`}
              role={t.kind === "error" ? "alert" : "status"}
            >
              <span className="mt-0.5 shrink-0">{ICONS[t.kind]}</span>
              <div className="min-w-0">
                <p className="text-[1.1rem] font-semibold leading-snug">{t.title}</p>
                {t.detail && <p className="mt-1 break-words text-[0.95rem] leading-snug text-ink-2">{t.detail}</p>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
