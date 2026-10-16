import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import type { PowerAction, PowerInfo } from "../lib/types";

/**
 * The power button: menu, countdowns before turning off, and the screensaver
 * ("Suspender"). Rust does the actual work (power.rs); the interface always
 * asks first, with a countdown anyone at the TV can cancel.
 */
export type Leaving = Exclude<PowerAction, "display-off">;

export interface Countdown {
  action: Leaving;
  seconds: number;
  /** Who asked: the TV, the phone or the sleep timer (changes the wording). */
  from: "tv" | "phone" | "timer";
}

interface State {
  menu: boolean;
  countdown: Countdown | null;
  /** Counting finished: the goodbye screen while the PC turns off. */
  leaving: Leaving | null;
  screensaver: boolean;
  info: PowerInfo;
  error: string | null;
}

let state: State = { menu: false, countdown: null, leaving: null, screensaver: false, info: { os: "Windows", timerUntil: null }, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function usePower(): State {
  return useSyncExternalStore(power.subscribe, () => state);
}

/** Seconds to wait: short when you chose it at the TV, longer from the phone, a full minute for the sleep timer. */
const WAIT = { tv: 5, phone: 10, timer: 60 } as const;

let started = false;

export const power = {
  start() {
    if (!inTauri || started) return;
    started = true;
    api.powerInfo().then((info) => set({ info }), () => {});
    void listen<PowerInfo>("power-changed", ({ payload }) => set({ info: payload }));
    void listen("power-timer-due", () => power.ask("shutdown", "timer"));
    void listen<string>("remote-power", ({ payload }) => {
      if (payload === "menu") power.openMenu();
      else if (payload === "screensaver") power.screensaver(true);
      else if (payload === "cancel") power.cancel();
      else if (payload === "shutdown" || payload === "restart" || payload === "exit" || payload === "restart-nova") power.ask(payload, "phone");
    });
  },

  openMenu: () => set({ menu: true, screensaver: false, error: null }),
  closeMenu: () => set({ menu: false }),

  ask(action: Leaving, from: Countdown["from"] = "tv") {
    set({ menu: false, screensaver: false, countdown: { action, seconds: WAIT[from], from }, error: null });
  },
  cancel: () => set({ countdown: null }),

  /** The countdown ended (or "now" was pressed). */
  async go() {
    const action = state.countdown?.action;
    if (!action) return;
    set({ countdown: null, leaving: action });
    try {
      // Let the goodbye screen fade in first.
      await new Promise((r) => window.setTimeout(r, 900));
      await api.powerAction(action);
    } catch (e) {
      set({ leaving: null, error: e instanceof Error ? e.message : String(e), menu: true });
    }
  },

  screensaver: (on: boolean) => set({ screensaver: on, menu: false }),
  isSaving: () => state.screensaver,
  /** The menu, a countdown or the goodbye screen is in front of everything. */
  isBusy: () => state.menu || !!state.countdown || !!state.leaving,
  isLeaving: () => !!state.leaving,
  /** For code outside React (e.g. waiting for the power menu to close). */
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },

  async displayOff() {
    set({ menu: false });
    try {
      await api.powerAction("display-off");
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), menu: true });
    }
  },

  async setTimer(minutes: number | null) {
    try {
      set({ info: await api.powerTimer(minutes), error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
};

// ───────────────────────── Screensaver after a while ─────────────────────────

export const SCREENSAVER_PREF = "nova.screensaverMinutes";
export const SCREENSAVER_CHOICES = [0, 5, 10, 15, 30] as const;

export function screensaverMinutes(): number {
  try {
    const saved = localStorage.getItem(SCREENSAVER_PREF);
    const v = Number(saved);
    return saved !== null && (SCREENSAVER_CHOICES as readonly number[]).includes(v) ? v : 10;
  } catch {
    return 10;
  }
}

export function setScreensaverMinutes(m: number) {
  try {
    localStorage.setItem(SCREENSAVER_PREF, String(m));
  } catch {}
}

/**
 * Starts the screensaver after some minutes without touching anything, only
 * while NOVA's own menus are in front (never over the TV, a game or an app).
 */
export function useAutoScreensaver(allowed: boolean) {
  useEffect(() => {
    if (!allowed) return;
    let last = Date.now();
    const touch = () => (last = Date.now());
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const timer = window.setInterval(() => {
      const minutes = screensaverMinutes();
      if (!minutes || state.screensaver || state.menu || state.countdown || state.leaving) return;
      if (!document.hasFocus()) {
        last = Date.now(); // an app or a game is in front: start counting when NOVA is back
        return;
      }
      if (Date.now() - last >= minutes * 60_000) power.screensaver(true);
    }, 10_000);
    return () => {
      window.clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
    };
  }, [allowed]);
}
