import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { motion, useIsPresent } from "motion/react";
import { Star } from "lucide-react";
import { useBackHandler } from "../../hooks/backStack";
import { useToast } from "../../components/Toasts";
import type { Channel, Program } from "../../lib/types";
import { buildTabs, type Tab } from "./catalog";
import { groupLabel, hhmm, liveTv, recentChannels, useLiveTv } from "./store";

/** 2½ hours on screen, in half-hour columns, starting at the current half hour. */
const SPAN = 2.5 * 3600;
const STEP = 30 * 60;
const MEMORY_KEY = "nova.tv.guide";
const DIGIT_MS = 1200;

interface Memory {
  tab?: string;
  subs?: Record<string, string>;
}

function readMemory(): Memory {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}") as Memory;
  } catch {
    return {};
  }
}

function saveMemory(m: Memory) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(m));
  } catch {}
}

function Logo({ channel, className }: { channel: Channel; className: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden rounded-xl bg-white/92 ${className}`}>
      {channel.logo && !failed ? (
        <img src={channel.logo} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-contain p-1.5" />
      ) : (
        <span className="px-1 text-center text-[0.75rem] font-bold leading-tight text-black">{channel.name.slice(0, 8)}</span>
      )}
    </span>
  );
}

interface Props {
  channels: Channel[];
  currentId?: string | null;
  onClose: () => void;
}

/**
 * NOVA's guide, Pluto-style: the picture stays on top with what's focused,
 * and below, a grid of channels × time. Tabs like a streaming app instead of
 * hundreds of groups; it remembers where you were. Thousands of channels stay
 * fast: only the rows on screen are drawn.
 *
 * Keys: ↑↓ channel · ←→ programme · ↑ from the first row: categories ·
 * OK watch · F favourite · digits jump to a channel number.
 */
export function ChannelGuide({ channels, currentId, onClose }: Props) {
  const { data, epg } = useLiveTv();
  const toast = useToast();
  const favorites = data?.favorites ?? [];
  const [recent] = useState(recentChannels);
  const tabs = useMemo(() => buildTabs(channels, favorites, recent), [channels, favorites, recent]);
  useBackHandler(onClose);

  // ── Where we are (remembered between openings) ──
  const [memory, setMemory] = useState<Memory>(readMemory);
  const initialTab = (tabs.find((t) => t.key === memory.tab) ?? tabs[0])?.key;
  const [tabKey, setTabKey] = useState(initialTab);
  const tab: Tab | undefined = tabs.find((t) => t.key === tabKey) ?? tabs[0];
  const subKey = tab ? (tab.subs.find((s) => s.key === memory.subs?.[tab.key]) ?? tab.subs[0])?.key : undefined;
  const sub = tab?.subs.find((s) => s.key === subKey) ?? tab?.subs[0];
  const list = sub?.channels ?? [];

  const [row, setRow] = useState(() => Math.max(0, list.findIndex((c) => c.id === currentId)));
  const [focusTime, setFocusTime] = useState(() => Date.now() / 1000);
  const [gridFocused, setGridFocused] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [digits, setDigits] = useState("");
  const digitTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(digitTimer.current); // a number half-typed goes with the guide
    };
  }, []);
  // Closing (or the TV shrinking) starts the fade-out: drop it already then.
  const present = useIsPresent();
  useEffect(() => {
    if (!present) window.clearTimeout(digitTimer.current);
  }, [present]);

  const choose = (nextTab: string, nextSub?: string) => {
    const m: Memory = { tab: nextTab, subs: { ...memory.subs, ...(nextSub ? { [nextTab]: nextSub } : {}) } };
    setMemory(m);
    saveMemory(m);
    setTabKey(nextTab);
    const t = tabs.find((x) => x.key === nextTab);
    const s = t?.subs.find((x) => x.key === (nextSub ?? m.subs?.[nextTab])) ?? t?.subs[0];
    setRow(Math.max(0, s?.channels.findIndex((c) => c.id === currentId) ?? 0));
    setFocusTime(Date.now() / 1000);
  };

  const safeRow = Math.min(row, Math.max(0, list.length - 1));
  const channel = list[safeRow];
  const windowStart = Math.floor(now / STEP) * STEP;
  const windowEnd = windowStart + SPAN;
  const slots = useMemo(() => Array.from({ length: SPAN / STEP }, (_, i) => windowStart + i * STEP), [windowStart]);
  // Programmes on screen (one ending in the first 5 minutes would only be a sliver).
  const programsOf = (c: Channel): Program[] => (c.epgId ? epg[c.epgId] ?? [] : []).filter((p) => p.end > windowStart + 300 && p.start < windowEnd);
  const rowPrograms = channel ? programsOf(channel) : [];
  const col = Math.max(0, rowPrograms.findIndex((p) => p.start <= focusTime && p.end > focusTime));
  const program = rowPrograms[col] as Program | undefined;
  const live = program && program.start <= now && program.end > now;
  const next = channel?.epgId ? (epg[channel.epgId] ?? []).find((p) => program && p.start >= program.end) : undefined;

  // ── Grid geometry: only the rows on screen are drawn ──
  const grid = useRef<HTMLDivElement>(null);
  const sample = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState(80);
  const [gridH, setGridH] = useState(600);
  useLayoutEffect(() => {
    if (sample.current) setRowH(sample.current.offsetHeight || 80);
    if (grid.current) setGridH(grid.current.clientHeight);
  });
  const visible = Math.max(1, Math.floor(gridH / rowH));
  const top = Math.max(0, Math.min(safeRow - Math.floor(visible / 3), list.length - visible));
  const rows = list.slice(top, top + visible + 1);

  useEffect(() => {
    const t = window.setTimeout(() => grid.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(t);
  }, []);

  const tune = (c: Channel) => {
    liveTv.play(c.id);
    onClose();
  };

  const favorite = async (c: Channel) => {
    const fav = await liveTv.toggleFavorite(c.id);
    toast.show("success", fav ? `${c.name} añadido a favoritos` : `${c.name} quitado de favoritos`);
  };

  const moveRow = (delta: number) => setRow(Math.max(0, Math.min(list.length - 1, safeRow + delta)));

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const k = e.key;
    if (k === "ArrowUp" && safeRow === 0) return; // on to the categories
    if (k === "ArrowDown") moveRow(1);
    else if (k === "ArrowUp") moveRow(-1);
    else if (k === "PageDown" || k === "ChannelDown") moveRow(visible - 1);
    else if (k === "PageUp" || k === "ChannelUp") moveRow(-(visible - 1));
    else if (k === "ArrowRight") {
      const p = rowPrograms[col + 1];
      if (p) setFocusTime(Math.max(p.start, windowStart));
    } else if (k === "ArrowLeft") {
      const p = rowPrograms[col - 1];
      if (p) setFocusTime(Math.max(p.start, windowStart));
    } else if (k === "Enter") {
      if (channel) tune(channel);
    } else if (k === "f" || k === "F" || k === "GamepadX") {
      if (channel) void favorite(channel);
    } else if (/^[0-9]$/.test(k)) {
      const typed = (digits + k).slice(-5);
      setDigits(typed);
      window.clearTimeout(digitTimer.current);
      digitTimer.current = window.setTimeout(() => {
        if (!liveTv.isOpen()) return;
        const n = Number(typed);
        const i = list.findIndex((c) => c.number === n);
        if (i >= 0) setRow(i);
        else if (!liveTv.tuneNumber(n)) toast.show("info", `No hay canal ${typed}`);
        else onClose();
        setDigits("");
      }, DIGIT_MS);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onWheel = (e: WheelEvent) => moveRow(e.deltaY > 0 ? 1 : -1);
  const pct = (t: number) => ((Math.min(Math.max(t, windowStart), windowEnd) - windowStart) / SPAN) * 100;

  return createPortal(
    <motion.div
      data-nav-scope
      role="dialog"
      aria-label="Guía de TV"
      className="fixed inset-0 z-[55] flex flex-col text-white"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      {/* ── The picture stays visible; what's focused, on the left ── */}
      <div className="relative h-[40vh] shrink-0 bg-[linear-gradient(90deg,#05070f_0%,rgb(5_7_15/0.9)_36%,rgb(5_7_15/0.25)_68%,transparent_85%),linear-gradient(0deg,#05070f_0%,transparent_30%)]">
        {channel && (
          <motion.div key={`${channel.id}:${program?.start ?? 0}`} className="absolute bottom-6 left-[var(--gutter)] flex max-w-[58rem] items-end gap-7" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            {program?.image && <img src={program.image} alt="" className="hidden aspect-video w-[19rem] shrink-0 rounded-2xl object-cover shadow-[0_1rem_3rem_-1rem_rgb(0_0_0/0.9)] xl:block" />}
            <div className="min-w-0">
              <div className="flex items-center gap-3 text-[1.05rem] text-ink-2">
                <Logo channel={channel} className="size-11 rounded-lg" />
                <span className="font-semibold tabular-nums text-white">{channel.number}</span>
                <span className="truncate">
                  {channel.name} · {groupLabel(channel)}
                </span>
                {channel.id === currentId && <span className="badge bg-[#ff3b5c] text-white">VIENDO</span>}
              </div>
              <h2 className="mt-3 line-clamp-2 text-[clamp(2rem,3vw,3rem)] font-bold leading-[1.05] tracking-tight [text-shadow:0_3px_24px_rgb(0_0_0/0.7)]">{program?.title ?? channel.name}</h2>
              {program ? (
                <div className="mt-3 flex items-center gap-4 text-[1.05rem] tabular-nums text-ink-2">
                  <span>
                    {hhmm(program.start)} – {hhmm(program.end)}
                    {program.genre ? ` · ${program.genre}` : ""}
                  </span>
                  {live && (
                    <span className="relative h-1.5 w-40 overflow-hidden rounded-full bg-white/20">
                      <span className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${((now - program.start) / (program.end - program.start)) * 100}%` }} />
                    </span>
                  )}
                  {!live && program.start > now && <span className="badge bg-white/12 text-ink-1">Más tarde</span>}
                </div>
              ) : (
                <p className="mt-3 text-[1.05rem] text-ink-3">Este canal no publica su programación.</p>
              )}
              {program?.description && <p className="mt-2 line-clamp-2 max-w-[46rem] text-[1.05rem] leading-relaxed text-white/75">{program.description}</p>}
              {next && <p className="mt-2 truncate text-[0.95rem] text-ink-3">Después · {hhmm(next.start)} {next.title}</p>}
            </div>
          </motion.div>
        )}
        <p className="absolute bottom-6 right-[var(--gutter)] hidden text-right text-[0.95rem] leading-relaxed text-white/60 [text-shadow:0_1px_8px_rgb(0_0_0/0.9)] lg:block">
          OK Ver · F Favorito
          <br />↑ Categorías · 0-9 Ir al número
        </p>
      </div>

      {/* ── Categories, the time ruler and the grid ── */}
      <div className="flex min-h-0 flex-1 flex-col bg-[#05070f]/96 backdrop-blur-xl">
        <nav className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto px-[var(--gutter)] py-2" aria-label="Categorías">
          {tabs.map((t) => (
            <button
              key={t.key}
              data-nav
              aria-current={t.key === tab?.key ? "true" : undefined}
              onFocus={() => t.key !== tab?.key && choose(t.key)}
              onClick={() => choose(t.key)}
              className={`focus-ring shrink-0 rounded-full px-5 py-2 text-[1.1rem] font-semibold transition-colors ${t.key === tab?.key ? "bg-white text-black" : "text-ink-2 hover:text-white"}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {tab && tab.subs.length > 1 && (
          <nav className="no-scrollbar flex shrink-0 gap-2 overflow-x-auto px-[var(--gutter)] py-1.5" aria-label="Subcategorías">
            {tab.subs.map((s) => (
              <button
                key={s.key}
                data-nav
                aria-current={s.key === sub?.key ? "true" : undefined}
                onFocus={() => s.key !== sub?.key && choose(tab.key, s.key)}
                onClick={() => choose(tab.key, s.key)}
                className={`focus-ring shrink-0 rounded-full border px-4 py-1.5 text-[0.95rem] transition-colors ${
                  s.key === sub?.key ? "border-white/60 bg-white/12 text-white" : "border-white/10 text-ink-3 hover:text-white"
                }`}
              >
                {s.label} <span className="ml-1 tabular-nums text-ink-3">{s.channels.length}</span>
              </button>
            ))}
          </nav>
        )}

        {/* Time ruler */}
        <div className="mt-3 flex shrink-0 px-[var(--gutter)] text-[0.95rem] tabular-nums text-ink-3">
          <div className="w-[21rem] shrink-0 font-semibold text-ink-2">Hoy · {hhmm(now)}</div>
          <div className="relative h-7 flex-1">
            {slots.map((s) => (
              <span key={s} className="absolute top-0 border-l border-white/15 pl-2" style={{ left: `${pct(s)}%` }}>
                {hhmm(s)}
              </span>
            ))}
          </div>
        </div>

        <div
          ref={grid}
          data-nav
          tabIndex={0}
          role="grid"
          aria-label={`${sub?.label ?? ""}: ${list.length} canales`}
          onKeyDown={onKeyDown}
          onFocus={() => setGridFocused(true)}
          onBlur={() => setGridFocused(false)}
          onWheel={onWheel}
          className="relative min-h-0 flex-1 overflow-hidden px-[var(--gutter)] outline-none"
        >
          {rows.map((c, i) => {
            const index = top + i;
            const focused = index === safeRow;
            const programs = focused ? rowPrograms : programsOf(c);
            const isFav = favorites.includes(c.id);
            return (
              <div
                key={c.id}
                ref={i === 0 ? sample : undefined}
                role="row"
                aria-selected={focused}
                onClick={() => (focused ? tune(c) : setRow(index))}
                className={`relative flex h-[4.9rem] cursor-pointer border-b border-white/[0.06] ${focused && gridFocused ? "bg-white/[0.07]" : ""}`}
              >
                {c.id === currentId && <span aria-hidden className="absolute inset-y-2 -left-3 w-1 rounded-full bg-[#ff3b5c]" />}
                <div className={`flex w-[21rem] shrink-0 items-center gap-3 pr-4 ${focused && gridFocused ? "text-white" : "text-ink-2"}`}>
                  <span className="w-14 shrink-0 text-right text-[1.15rem] font-semibold tabular-nums">{c.number}</span>
                  <Logo channel={c} className="size-12" />
                  <span className="min-w-0 flex-1 truncate text-[1.1rem] font-medium">{c.name}</span>
                  {isFav && <Star className="size-4 shrink-0 text-warn" fill="currentColor" />}
                </div>
                <div className="relative flex-1 py-1.5">
                  {programs.length ? (
                    programs.map((p, j) => {
                      const onNow = p.start <= now && p.end > now;
                      const selected = focused && gridFocused && j === col;
                      const progress = onNow ? ((now - p.start) / (p.end - p.start)) * 100 : 0;
                      return (
                        <div
                          key={p.start}
                          className={`absolute inset-y-1.5 overflow-hidden rounded-xl px-4 py-2 transition-colors ${
                            selected ? "bg-white text-black shadow-[0_0_0_3px_rgb(255_255_255/0.25)]" : onNow ? "bg-white/[0.11]" : p.end <= now ? "bg-white/[0.03] text-ink-3" : "bg-white/[0.06]"
                          }`}
                          style={{ left: `calc(${pct(p.start)}% + 2px)`, width: `calc(${pct(p.end) - pct(p.start)}% - 4px)` }}
                        >
                          {onNow && !selected && <span aria-hidden className="absolute inset-y-0 left-0 bg-[linear-gradient(90deg,rgb(110_108_255/0.28),rgb(63_213_242/0.18))]" style={{ width: `${progress}%` }} />}
                          <span className="relative block truncate text-[1.02rem] font-semibold">{p.title}</span>
                          <span className={`relative block truncate text-[0.85rem] tabular-nums ${selected ? "text-black/60" : "text-ink-3"}`}>
                            {hhmm(p.start)} – {hhmm(p.end)}
                          </span>
                        </div>
                      );
                    })
                  ) : (
                    <div className={`absolute inset-1.5 flex items-center rounded-xl px-4 text-[0.98rem] ${focused && gridFocused ? "bg-white text-black" : "bg-white/[0.04] text-ink-3"}`}>
                      <span className="truncate">
                        {groupLabel(c)} · <span className="opacity-70">sin guía de programación</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {!list.length && <p className="px-2 py-10 text-[1.1rem] text-ink-3">{tab?.key === "parati" ? "Marca canales como favoritos (tecla F) y aparecerán aquí." : "No hay canales con señal en esta categoría."}</p>}
          {/* "Now" line */}
          {list.length > 0 && (
            <span aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-[2px] bg-[#ff4d6d] shadow-[0_0_12px_#ff4d6d]" style={{ left: `calc(var(--gutter) + 21rem + (100% - 2 * var(--gutter) - 21rem) * ${pct(now) / 100})` }}>
              <span className="absolute -left-[5px] -top-1 size-3 rounded-full bg-[#ff4d6d]" />
            </span>
          )}
        </div>
        {digits && <div className="pointer-events-none fixed right-[var(--gutter)] top-10 rounded-2xl bg-black/75 px-7 py-3 text-[3.5rem] font-bold tabular-nums">{digits}</div>}
      </div>
    </motion.div>,
    document.body,
  );
}
