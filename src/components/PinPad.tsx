import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useAnimationControls } from "motion/react";
import { Check, Delete, LockKeyhole } from "lucide-react";
import { focusFirst, restoreFocus } from "../lib/spatialNav";
import { useBackHandler, useHomeHandler } from "../hooks/backStack";

interface Props {
  title: string;
  subtitle?: string;
  /** Throws (with a message) when the PIN is wrong. */
  onSubmit: (pin: string) => Promise<void> | void;
  onClose: () => void;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "del", "0", "ok"] as const;

/**
 * Parental PIN entry, made for a TV: an on-screen keypad you drive with the
 * arrows / controller / phone remote, or just type the digits. 4–6 numbers.
 */
export function PinPad({ title, subtitle, onSubmit, onClose }: Props) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const shake = useAnimationControls();
  useBackHandler(onClose);
  useHomeHandler(onClose);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const t = window.setTimeout(() => focusFirst(panel.current), 30);
    return () => {
      window.clearTimeout(t);
      restoreFocus(previous, node);
    };
  }, []);

  const submit = async (value = pin) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    try {
      await onSubmit(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPin("");
      void shake.start({ x: [0, -14, 12, -8, 6, 0], transition: { duration: 0.4 } });
    } finally {
      setBusy(false);
    }
  };

  const press = (key: (typeof KEYS)[number]) => {
    setError(null);
    if (key === "del") setPin((p) => p.slice(0, -1));
    else if (key === "ok") void submit();
    else setPin((p) => (p.length < 6 ? p + key : p));
  };

  // Typing digits works anywhere in the dialog (keyboard or the phone's keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        setError(null);
        setPin((p) => (p.length < 6 ? p + e.key : p));
      } else if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        setPin((p) => p.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <motion.div className="fixed inset-0 z-[95] grid place-items-center bg-black/75 backdrop-blur-md" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        ref={panel}
        data-nav-scope
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[min(30rem,calc(100vw-4rem))] rounded-[1.8rem] border border-white/10 bg-[#0b1124] p-9 text-center shadow-[0_2rem_6rem_-1rem_rgb(0_0_0/0.9)]"
        initial={{ y: 20, scale: 0.97 }}
        animate={{ y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      >
        <LockKeyhole className="mx-auto size-10 text-cyan" />
        <h2 className="mt-4 text-[1.7rem] font-semibold">{title}</h2>
        {subtitle && <p className="mt-2 text-[1.05rem] text-ink-2">{subtitle}</p>}

        <motion.div animate={shake} className="mt-7 flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} números`}>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
            <span key={i} className={`size-4 rounded-full transition-colors ${i < pin.length ? "bg-white" : "bg-white/15"}`} />
          ))}
        </motion.div>
        <p className="mt-3 min-h-[1.5rem] text-[1rem] text-danger" role="alert">
          {error}
        </p>

        <div className="mt-3 grid grid-cols-3 gap-3">
          {KEYS.map((k) => (
            <button
              key={k}
              data-nav
              disabled={busy || (k === "ok" && pin.length < 4)}
              aria-label={k === "del" ? "Borrar" : k === "ok" ? "Aceptar" : k}
              onClick={() => press(k)}
              className={`focus-lift grid h-[4.2rem] place-items-center rounded-2xl text-[1.7rem] font-semibold disabled:opacity-35 ${
                k === "ok" ? "bg-white text-black" : "bg-white/8 hover:bg-white/14"
              }`}
            >
              {k === "del" ? <Delete className="size-7" /> : k === "ok" ? <Check className="size-7" /> : k}
            </button>
          ))}
        </div>
        <button data-nav onClick={onClose} className="focus-lift btn btn-ghost mt-5 w-full">
          Cancelar
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
