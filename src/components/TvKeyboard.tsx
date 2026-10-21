import { useEffect, useRef, useState } from "react";
import { ArrowBigUp, Check, Delete, Eye, EyeOff, Space } from "lucide-react";
import { focusFirst } from "../lib/spatialNav";

/** Spanish layout, then symbols; both 10 keys a row so the D-pad moves straight. */
const LETTERS = ["1234567890", "qwertyuiop", "asdfghjklñ", "zxcvbnm@.-"];
const SYMBOLS = ["!\"#$%&/()=", "?¿¡'+*[]{}", "_:;,<>|\\~^", "€·çáéíóúü"];

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** "Listo" (and Enter). */
  onDone: () => void;
  label: string;
  placeholder?: string;
  /** Passwords: dots, with a key to show them. */
  secret?: boolean;
  maxLength?: number;
  doneLabel?: string;
  /** Disable "Listo" (e.g. too short). */
  canFinish?: boolean;
}

/**
 * An on-screen keyboard for the TV: every key is reachable with the D-pad /
 * controller (A types; X deletes; Y is a space). A real keyboard or the phone
 * remote can type into it too.
 */
export function TvKeyboard({ value, onChange, onDone, label, placeholder, secret, maxLength = 64, doneLabel = "Listo", canFinish = true }: Props) {
  const [shift, setShift] = useState(false);
  const [symbols, setSymbols] = useState(false);
  const [reveal, setReveal] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const type = (text: string) => {
    const next = (valueRef.current + text).slice(0, maxLength);
    onChange(next);
    if (shift) setShift(false);
  };
  const erase = () => onChange(valueRef.current.slice(0, -1));

  // Start on the keys (not on the "show password" eye).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const first = root.current?.querySelector<HTMLElement>("[data-key]");
      if (first) first.focus({ preventScroll: true });
      else focusFirst(root.current);
    }, 40);
    return () => window.clearTimeout(t);
  }, []);

  // A real keyboard (or the phone remote) types here; the controller's X/Y help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (e.key === "GamepadX" || e.key === "Backspace") {
        e.preventDefault();
        erase();
      } else if (e.key === "GamepadY") {
        e.preventDefault();
        type(" ");
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        type(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const rows = symbols ? SYMBOLS : LETTERS;
  const shown = secret && !reveal ? "•".repeat(value.length) : value;

  return (
    <div ref={root} className="w-full max-w-[52rem]">
      <p className="eyebrow mb-2">{label}</p>
      <div className="flex min-h-[4.2rem] items-center gap-3 rounded-2xl border border-white/15 bg-white/6 px-6 text-[1.8rem] font-medium">
        <span className={`min-w-0 flex-1 truncate ${value ? "" : "text-ink-3"}`}>
          {value ? shown : placeholder}
          <span className="ml-0.5 inline-block h-[1.9rem] w-[2px] translate-y-[0.3rem] animate-pulse bg-cyan" aria-hidden />
        </span>
        {secret && (
          <button data-nav type="button" onClick={() => setReveal((r) => !r)} aria-label={reveal ? "Ocultar" : "Mostrar"} className="focus-ring grid size-12 place-items-center rounded-xl text-ink-2">
            {reveal ? <EyeOff className="size-6" /> : <Eye className="size-6" />}
          </button>
        )}
      </div>

      <div className="mt-5 grid gap-2">
        {rows.map((row) => (
          <div key={row} className="grid grid-cols-10 gap-2">
            {[...row].map((ch) => {
              const out = shift ? ch.toUpperCase() : ch;
              return (
                <button key={ch} data-nav data-key type="button" onClick={() => type(out)} className="focus-key h-[3.6rem] rounded-xl bg-white/8 text-[1.45rem] font-semibold">
                  {out}
                </button>
              );
            })}
          </div>
        ))}
        <div className="grid grid-cols-10 gap-2">
          <button data-nav type="button" aria-pressed={shift} onClick={() => setShift((s) => !s)} className={`focus-key col-span-1 grid h-[3.6rem] place-items-center rounded-xl ${shift ? "bg-cyan/30 text-cyan" : "bg-white/8"}`} aria-label="Mayúsculas">
            <ArrowBigUp className="size-7" />
          </button>
          <button data-nav type="button" onClick={() => setSymbols((s) => !s)} className="focus-key col-span-2 h-[3.6rem] rounded-xl bg-white/8 text-[1.15rem] font-semibold">
            {symbols ? "abc" : "#+="}
          </button>
          <button data-nav type="button" onClick={() => type(" ")} className="focus-key col-span-3 grid h-[3.6rem] place-items-center rounded-xl bg-white/8" aria-label="Espacio">
            <Space className="size-7" />
          </button>
          <button data-nav type="button" onClick={erase} className="focus-key col-span-2 grid h-[3.6rem] place-items-center rounded-xl bg-white/8" aria-label="Borrar">
            <Delete className="size-7" />
          </button>
          <button data-nav type="button" disabled={!canFinish} onClick={onDone} className="focus-key col-span-2 flex h-[3.6rem] items-center justify-center gap-2 rounded-xl bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)] text-[1.15rem] font-semibold text-[#050713] disabled:opacity-40">
            <Check className="size-6" /> {doneLabel}
          </button>
        </div>
      </div>
      <p className="mt-3 text-[0.95rem] text-ink-3">Con el mando: X borra · Y espacio. También puedes escribir con un teclado o con el mando del móvil.</p>
    </div>
  );
}
