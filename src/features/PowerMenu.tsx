import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { LockKeyhole, LogOut, MonitorOff, Moon, Power, RefreshCw, RotateCcw, Timer, TriangleAlert, type LucideProps } from "lucide-react";
import { power, usePower, type Countdown, type Leaving } from "../app/power";
import { isUnlocked, useActiveProfile, useProfiles } from "../app/profiles";
import { useBackHandler } from "../hooks/backStack";
import { focusFirst } from "../lib/spatialNav";
import { formatTime, useClock } from "../hooks/useClock";

const EASE = [0.22, 1, 0.36, 1] as const;
const TIMER_CHOICES = [null, 15, 30, 60, 90, 120] as const;

function words(action: Leaving, os: string) {
  switch (action) {
    case "shutdown":
      return { title: "Apagando el equipo", now: "Apagar ya", bye: "Hasta luego" };
    case "restart":
      return { title: "Reiniciando el equipo", now: "Reiniciar ya", bye: "Reiniciando…" };
    case "exit":
      return { title: `Saliendo a ${os}`, now: "Salir ya", bye: `Volviendo a ${os}…` };
    case "restart-nova":
      return { title: "Reiniciando NOVA TV", now: "Reiniciar ya", bye: "Reiniciando NOVA…" };
  }
}

function Option({
  icon: Icon,
  title,
  detail,
  onClick,
  tone = "normal",
  locked,
  autoFocus,
}: {
  icon: ComponentType<LucideProps>;
  title: string;
  detail: string;
  onClick: () => void;
  tone?: "normal" | "danger";
  locked?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      disabled={locked}
      onClick={onClick}
      className="focus-ring group flex w-full items-center gap-5 rounded-2xl px-4 py-3.5 text-left transition-colors focus:bg-white/10 disabled:opacity-45"
    >
      <span
        className={`grid size-[3.4rem] shrink-0 place-items-center rounded-full transition-colors ${
          tone === "danger" ? "bg-danger/15 text-danger group-focus:bg-danger group-focus:text-white" : "bg-white/8 text-ink-1 group-focus:bg-white group-focus:text-black"
        }`}
      >
        {locked ? <LockKeyhole className="size-5" /> : <Icon className="size-6" strokeWidth={1.9} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[1.25rem] font-semibold leading-tight">{title}</span>
        <span className="mt-0.5 block text-[0.98rem] leading-snug text-ink-3">{detail}</span>
      </span>
    </button>
  );
}

function SleepTimer() {
  const { info } = usePower();
  const now = useClock();
  const until = info.timerUntil ? new Date(info.timerUntil * 1000) : null;
  const left = until ? Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 60_000)) : null;
  return (
    <div className="rounded-2xl px-4 py-3.5">
      <div className="flex items-center gap-5">
        <span className="grid size-[3.4rem] shrink-0 place-items-center rounded-full bg-white/8">
          <Timer className="size-6" strokeWidth={1.9} />
        </span>
        <span className="min-w-0">
          <span className="block text-[1.25rem] font-semibold leading-tight">Temporizador de apagado</span>
          <span className={`mt-0.5 block text-[0.98rem] leading-snug ${until ? "text-cyan" : "text-ink-3"}`}>
            {until ? `Se apagará a las ${formatTime(until)} (en ${left} min)` : "Apaga el equipo solo, como una tele."}
          </span>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-[4.65rem]">
        {TIMER_CHOICES.map((m) => {
          const active = m === null ? !until : false;
          return (
            <button
              key={m ?? "off"}
              data-nav
              onClick={() => void power.setTimer(m)}
              className={`focus-ring h-[2.6rem] rounded-full px-4 text-[1rem] font-semibold transition-colors ${
                active ? "bg-white text-black" : "bg-white/8 text-ink-2 focus:bg-white/16 focus:text-ink-1"
              }`}
            >
              {m === null ? "No" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ""}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The power menu: a panel that slides in from the right, over anything. */
function Menu() {
  const { info, error } = usePower();
  const info2 = useProfiles();
  const profile = useActiveProfile();
  const kidsLocked = !!profile?.kids && !isUnlocked(info2);
  const panel = useRef<HTMLDivElement>(null);
  const now = useClock();
  useBackHandler(power.closeMenu);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => focusFirst(panel.current), 80);
    return () => {
      window.clearTimeout(t);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <motion.div className="fixed inset-0 z-[90] flex justify-end" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }}>
      <button aria-label="Cerrar" tabIndex={-1} onClick={power.closeMenu} className="absolute inset-0 cursor-default bg-[#03050c]/65 backdrop-blur-sm" />
      <motion.div
        ref={panel}
        data-nav-scope
        role="dialog"
        aria-modal="true"
        aria-label="Encendido"
        className="relative flex h-full w-[min(36rem,100vw)] flex-col overflow-hidden border-l border-line-strong bg-[linear-gradient(170deg,rgb(24_34_77/0.97),rgb(8_12_28/0.98)_50%)] shadow-[-2rem_0_6rem_-1rem_rgb(0_0_0/0.8)]"
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ duration: 0.42, ease: EASE }}
      >
        <span aria-hidden className="pointer-events-none absolute -top-40 right-[-10rem] size-[30rem] rounded-full bg-[radial-gradient(circle,rgb(110_108_255/0.32),transparent_65%)]" />
        <div className="relative px-9 pb-5 pt-10">
          <p className="eyebrow text-cyan">Encendido</p>
          <p className="mt-1 text-[3.4rem] font-semibold leading-none tracking-tight tabular-nums">{formatTime(now)}</p>
          <p className="mt-2 text-[1.05rem] text-ink-3">Este equipo · {info.os}</p>
        </div>
        {error && (
          <p role="alert" className="relative mx-9 mb-3 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-[1rem] text-[#ffc2cf]">
            <TriangleAlert className="mt-0.5 size-5 shrink-0" /> {error}
          </p>
        )}
        <div className="page-scroll relative min-h-0 flex-1 space-y-1 overflow-y-auto px-5 pb-8">
          <Option icon={Power} title="Apagar equipo" detail="Cierra NOVA y apaga el PC." tone="danger" autoFocus onClick={() => power.ask("shutdown")} />
          <Option icon={RefreshCw} title="Reiniciar equipo" detail="Apaga el PC y lo vuelve a encender." onClick={() => power.ask("restart")} />
          <Option icon={Moon} title="Suspender" detail="Salvapantallas con reloj. Cualquier botón lo despierta." onClick={() => power.screensaver(true)} />
          <Option icon={MonitorOff} title="Apagar pantalla" detail="La imagen se apaga y NOVA sigue. Pulsa cualquier botón para volver." onClick={() => void power.displayOff()} />
          <div className="mx-4 my-2 h-px bg-line" />
          <SleepTimer />
          <div className="mx-4 my-2 h-px bg-line" />
          <Option icon={RotateCcw} title="Reiniciar NOVA TV" detail="Cierra NOVA y lo abre de nuevo." onClick={() => power.ask("restart-nova")} />
          <Option
            icon={LogOut}
            title={`Salir a ${info.os}`}
            detail={kidsLocked ? "En un perfil infantil hace falta un adulto." : "Cierra NOVA y vuelve al escritorio."}
            locked={kidsLocked}
            onClick={() => power.ask("exit")}
          />
        </div>
      </motion.div>
    </motion.div>
  );
}

/** "Apagando el equipo en 5…": a ring that empties; Cancelar has the focus. */
function CountdownView({ countdown, os }: { countdown: Countdown; os: string }) {
  const [left, setLeft] = useState(countdown.seconds);
  const root = useRef<HTMLDivElement>(null);
  const w = words(countdown.action, os);
  useBackHandler(power.cancel);

  useEffect(() => {
    const started = Date.now();
    const t = window.setInterval(() => {
      const rest = countdown.seconds - Math.floor((Date.now() - started) / 1000);
      setLeft(Math.max(0, rest));
      if (rest <= 0) {
        window.clearInterval(t);
        void power.go();
      }
    }, 200);
    const f = window.setTimeout(() => focusFirst(root.current), 60);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(f);
    };
  }, [countdown]);

  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <motion.div
      ref={root}
      data-nav-scope
      role="alertdialog"
      aria-label={`${w.title} en ${left} segundos`}
      className="fixed inset-0 z-[96] grid place-items-center bg-[#03050c]/88 backdrop-blur-md"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_28rem_at_50%_42%,rgb(110_108_255/0.18),transparent_70%)]" />
      <motion.div className="relative flex flex-col items-center text-center" initial={{ y: 20, scale: 0.97 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 0.4, ease: EASE }}>
        <div className="relative size-[12rem]">
          <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-hidden>
            <defs>
              <linearGradient id="pw-g" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0" stopColor="#6e6cff" />
                <stop offset="1" stopColor="#3fd5f2" />
              </linearGradient>
            </defs>
            <circle cx="60" cy="60" r={R} fill="none" stroke="rgb(255 255 255 / 0.1)" strokeWidth="5" />
            <motion.circle
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke="url(#pw-g)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={C}
              initial={{ strokeDashoffset: 0 }}
              animate={{ strokeDashoffset: C }}
              transition={{ duration: countdown.seconds, ease: "linear" }}
            />
          </svg>
          <span className="absolute inset-0 grid place-items-center">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={left}
                className="text-[4.6rem] font-semibold tabular-nums"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -14 }}
                transition={{ duration: 0.25 }}
              >
                {left}
              </motion.span>
            </AnimatePresence>
          </span>
        </div>
        <h2 className="mt-8 text-[2.6rem] font-semibold tracking-tight">{w.title}</h2>
        <p className="mt-2 text-[1.15rem] text-ink-2">
          {countdown.from === "timer"
            ? "El temporizador de apagado ha terminado."
            : countdown.from === "phone"
              ? "Pedido desde el mando del móvil."
              : "Pulsa Cancelar si no querías hacerlo."}
        </p>
        <div className="mt-9 flex gap-3">
          <button data-nav data-autofocus onClick={power.cancel} className="focus-lift btn btn-primary min-w-[11rem] justify-center">
            Cancelar
          </button>
          <button data-nav onClick={() => void power.go()} className="focus-lift btn btn-ghost">
            {w.now}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The last screen: the NOVA mark fades out with the picture, like a TV turning off. */
function Goodbye({ action, os }: { action: Leaving; os: string }) {
  return (
    <motion.div className="fixed inset-0 z-[99] grid place-items-center bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
      <motion.div
        className="flex flex-col items-center"
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: [0, 1, 1, 0.85], scale: [0.96, 1, 1, 0.99] }}
        transition={{ duration: 2.4, times: [0, 0.3, 0.8, 1] }}
      >
        <svg viewBox="0 0 192 192" className="size-[6rem]" aria-hidden>
          <defs>
            <linearGradient id="bye-g" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#6e6cff" />
              <stop offset="1" stopColor="#3fd5f2" />
            </linearGradient>
          </defs>
          <path d="M50 142 L96 52 L142 142" fill="none" stroke="url(#bye-g)" strokeWidth="17" strokeLinecap="square" />
        </svg>
        <p className="mt-6 text-[1.4rem] font-semibold tracking-[0.04em] text-ink-2">{words(action, os).bye}</p>
      </motion.div>
    </motion.div>
  );
}

/** Everything of the power button that goes over the screen. */
export function PowerLayer() {
  const { menu, countdown, leaving, info } = usePower();
  return createPortal(
    <>
      <AnimatePresence>{menu && <Menu key="menu" />}</AnimatePresence>
      <AnimatePresence>{countdown && <CountdownView key={`${countdown.action}-${countdown.from}`} countdown={countdown} os={info.os} />}</AnimatePresence>
      {leaving && <Goodbye action={leaving} os={info.os} />}
    </>,
    document.body,
  );
}
