import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Gamepad2, TriangleAlert } from "lucide-react";
import { initials, posterBackground } from "../../components/art";
import { formatPlaytime, usePlaytime } from "../../hooks/useLiveData";
import { useBackHandler } from "../../hooks/backStack";
import type { GameMeta, Shortcut } from "../../lib/types";
import { platformLabel, useGameMeta } from "./useGameMeta";

/** Where a game launch is (from `api.launch` and the backend's `game-launch` events). */
export type LaunchStage = "launching" | "connecting" | "waking" | "starting" | "streaming" | "unwatched" | "running" | "error";

export type GameLaunchState = {
  item: Shortcut;
  stage: LaunchStage;
  /** The PC's name for a PC's game; the message when it failed. */
  detail?: string;
} | null;

/** Development only (`?launch-preview`): a PC game going through every stage, with real Steam art. */
export const PREVIEW_LAUNCH = {
  item: {
    id: "pc:preview:steam:1091500",
    name: "Cyberpunk 2077",
    description: "En TORRE · Steam",
    kind: "game",
    target: { type: "pc", pc: "preview", game: "steam:1091500" },
    source: "pc",
  } satisfies Shortcut,
  meta: {
    steamAppId: 1091500,
    title: "Cyberpunk 2077",
    kind: "game",
    description: null,
    genres: [],
    developer: null,
    year: null,
    metacritic: null,
    hero: "https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/library_hero.jpg",
    logo: "https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/logo.png",
    portrait: "https://cdn.cloudflare.steamstatic.com/steam/apps/1091500/library_600x900_2x.jpg",
    header: null,
    source: "steam",
    trailer: null,
    fetchedAt: 0,
  } satisfies GameMeta,
  stages: [
    ["launching", 0],
    ["connecting", 1800],
    ["waking", 3600],
    ["starting", 6500],
    // ("streaming" would end it on the preview tab's blur, as it does with Moonlight.)
    ["running", 9500],
  ] as [LaunchStage, number][],
};

/** Steps of a game from another PC, in order (for the little progress dots). */
const PC_STEPS: LaunchStage[] = ["connecting", "starting", "streaming", "running"];

function stageText({ item, stage, detail }: NonNullable<GameLaunchState>): string {
  const pc = detail ?? "tu PC";
  switch (stage) {
    case "connecting":
      return `Conectando con ${pc}…`;
    case "waking":
      return `Despertando ${pc}…`;
    case "starting":
      return `Abriendo el juego en ${pc}…`;
    case "streaming":
      return "Recibiendo la imagen…";
    case "running":
      return "¡A jugar!";
    case "unwatched":
      return "Ya casi está…";
    case "error":
      return detail ?? "No se pudo abrir";
    default:
      switch (item.target.type) {
        case "steam":
          return "Steam está preparando el juego…";
        case "uri":
          return `${platformLabel(item)} está abriendo el juego…`;
        case "pc":
          return "Preparando…";
        default:
          return "Iniciando el juego…";
      }
  }
}

/**
 * Console-style loading screen while a game starts: its artwork flies in,
 * the scene breathes slowly, the status follows the real launch, and it
 * dissolves into the game. B hides it (the game keeps starting).
 */
export function GameLaunch({ state, onHide, preview }: { state: NonNullable<GameLaunchState>; onHide: () => void; preview?: GameMeta }) {
  const meta = useGameMeta()[state.item.id] ?? preview;
  const stats = usePlaytime()[state.item.id];
  const [slow, setSlow] = useState(false);
  const title = meta?.title ?? state.item.name;
  const hero = meta?.hero ?? meta?.header ?? null;
  const cover = meta?.portrait ?? null;
  const running = state.stage === "running";
  const failed = state.stage === "error";
  const played = stats?.totalSeconds ? formatPlaytime(stats.totalSeconds) : null;
  const pcStep = PC_STEPS.indexOf(state.stage === "waking" ? "connecting" : state.stage);

  useBackHandler(onHide);

  // Some launchers take their time: say so instead of looking stuck.
  useEffect(() => {
    if (running || failed) return;
    const t = window.setTimeout(() => setSlow(true), 40_000);
    return () => window.clearTimeout(t);
  }, [running, failed, state.stage]);

  return (
    <motion.div
      className="fixed inset-0 z-[80] overflow-hidden bg-[#03050c] text-white"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.06, transition: { duration: 0.7, ease: [0.4, 0, 0.2, 1] } }}
      transition={{ duration: 0.35 }}
      role="status"
      aria-live="polite"
      aria-label={`${title}: ${stageText(state)}`}
    >
      {/* The scene: the game's art, slowly breathing (or its colours when it has none). */}
      <motion.div
        className="absolute inset-0"
        initial={{ scale: 1.16, opacity: 0, filter: "blur(24px)" }}
        animate={{ scale: 1.02, opacity: 0.62, filter: "blur(0px)" }}
        transition={{ scale: { duration: 26, ease: "linear" }, opacity: { duration: 1.1 }, filter: { duration: 1.1 } }}
        style={hero ? undefined : { background: posterBackground(state.item.id, state.item.name) }}
      >
        {hero && <img src={hero} alt="" className="size-full object-cover" draggable={false} />}
      </motion.div>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#03050c_0%,rgb(3_5_12/0.88)_34%,rgb(3_5_12/0.25)_72%,rgb(3_5_12/0.55)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-[45%] bg-[linear-gradient(0deg,#03050c,transparent)]" />
      <motion.div
        className="absolute -left-[10vw] top-1/2 size-[60vw] -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgb(110_108_255/0.28),transparent_62%)]"
        animate={{ opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />

      <div className="relative grid h-full grid-cols-[auto_minmax(0,1fr)] items-center gap-[clamp(2.5rem,5vw,6rem)] px-[clamp(3rem,8vw,9rem)]">
        {/* The cover flies in, turns towards you and catches the light. */}
        <motion.div
          className="relative [perspective:1400px]"
          initial={{ opacity: 0, scale: 0.55, y: 80 }}
          animate={running ? { opacity: 0, scale: 1.35, y: 0 } : { opacity: 1, scale: 1, y: 0 }}
          transition={running ? { duration: 0.9, ease: [0.4, 0, 0.2, 1] } : { type: "spring", stiffness: 120, damping: 18, mass: 0.9 }}
        >
          <motion.div
            className="relative aspect-[2/3] w-[clamp(13rem,19vw,22rem)] overflow-hidden rounded-[1.4rem] shadow-[0_3rem_8rem_-1.5rem_rgb(0_0_0/0.95),0_0_0_1px_rgb(255_255_255/0.08),0_0_6rem_-1rem_rgb(110_108_255/0.55)]"
            initial={{ rotateY: -32, rotateX: 10 }}
            animate={{ rotateY: [-32, -9, -6], rotateX: [10, 2, 3] }}
            transition={{ duration: 1.6, ease: [0.22, 1, 0.36, 1] }}
            style={cover ? undefined : { background: posterBackground(state.item.id, state.item.name) }}
          >
            {cover ? (
              <img src={cover} alt="" className="size-full object-cover" draggable={false} />
            ) : (
              <div className="grid size-full place-items-center text-[4.5rem] font-bold tracking-tight text-white/90">{initials(state.item.name)}</div>
            )}
            <motion.div
              className="pointer-events-none absolute inset-y-0 w-[60%] bg-[linear-gradient(100deg,transparent,rgb(255_255_255/0.32),transparent)]"
              initial={{ x: "-120%" }}
              animate={{ x: "260%" }}
              transition={{ duration: 1.3, delay: 0.7, ease: "easeInOut" }}
            />
          </motion.div>
          {/* Reflection on the floor. */}
          <div className="absolute inset-x-[8%] -bottom-[3.2rem] h-[3rem] rounded-[50%] bg-[radial-gradient(ellipse,rgb(110_108_255/0.45),transparent_70%)] blur-xl" />
        </motion.div>

        <div className="min-w-0">
          <motion.div initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.7, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}>
            <p className="flex items-center gap-3 text-[1.05rem] font-semibold uppercase tracking-[0.28em] text-white/60">
              <Gamepad2 className="size-5 text-[#5cff8f]" /> {platformLabel(state.item)}
            </p>
            {meta?.logo ? (
              <img src={meta.logo} alt={title} className="mt-5 max-h-[clamp(6rem,13vw,11rem)] max-w-[min(38rem,90%)] object-contain object-left drop-shadow-[0_0.6rem_2rem_rgb(0_0_0/0.7)]" draggable={false} />
            ) : (
              <h1 className="mt-4 max-w-[40rem] text-[clamp(3rem,5.5vw,5.5rem)] font-bold leading-[0.95] tracking-tight drop-shadow-[0_0.5rem_2rem_rgb(0_0_0/0.7)]">{title}</h1>
            )}
            {played && <p className="mt-5 text-[1.15rem] text-white/65">Has jugado {played}</p>}
          </motion.div>

          <motion.div className="mt-12 max-w-[34rem]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
            <AnimatePresence mode="wait">
              <motion.p
                key={`${state.stage}-${state.detail ?? ""}`}
                className={`flex items-center gap-3 text-[1.45rem] font-semibold ${failed ? "text-[#ff8fa8]" : running ? "text-[#5cff8f]" : "text-white"}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3 }}
              >
                {failed && <TriangleAlert className="size-6 shrink-0" />}
                {stageText(state)}
              </motion.p>
            </AnimatePresence>

            {!failed && (
              <div className="relative mt-5 h-[0.4rem] overflow-hidden rounded-full bg-white/12">
                {running ? (
                  <motion.div className="h-full rounded-full bg-[linear-gradient(90deg,#7c7aff,#5cff8f)]" initial={{ width: "40%" }} animate={{ width: "100%" }} transition={{ duration: 0.5 }} />
                ) : (
                  <motion.div
                    className="absolute inset-y-0 w-[38%] rounded-full bg-[linear-gradient(90deg,transparent,#7c7aff,#3fd5f2,transparent)]"
                    initial={{ x: "-110%" }}
                    animate={{ x: "280%" }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  />
                )}
              </div>
            )}

            {state.item.target.type === "pc" && !failed && (
              <div className="mt-5 flex gap-2" aria-hidden>
                {PC_STEPS.map((s, i) => (
                  <motion.span
                    key={s}
                    className="h-[0.35rem] w-[2.4rem] rounded-full"
                    animate={{ backgroundColor: i <= pcStep ? "#5cff8f" : "rgba(255,255,255,0.15)" }}
                    transition={{ duration: 0.4 }}
                  />
                ))}
              </div>
            )}

            {slow && !running && !failed && <p className="mt-5 text-[1.05rem] text-white/60">Está tardando más de lo normal. Puedes pulsar B: el juego seguirá abriéndose.</p>}
            {failed && (
              <button data-nav data-autofocus onClick={onHide} className="focus-lift btn btn-primary mt-8">
                Volver
              </button>
            )}
          </motion.div>
        </div>
      </div>

      {!failed && (
        <motion.p
          className="absolute inset-x-0 bottom-[clamp(1.5rem,4vh,3rem)] text-center text-[1.05rem] text-white/50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2 }}
        >
          En el juego, el botón Guía del mando te devuelve a NOVA · B oculta esta pantalla
        </motion.p>
      )}

      {/* Into the game: a soft flash. */}
      <AnimatePresence>
        {running && (
          <motion.div
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgb(255_255_255/0.85),rgb(160_255_200/0.35)_40%,transparent_75%)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 0.9, times: [0, 0.25, 1] }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
