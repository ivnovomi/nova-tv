import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import type { UpdateInfo, UpdateStatus } from "../lib/types";

/**
 * New versions of NOVA. Rust looks for them (updates.rs) and does the
 * download and install; this store mirrors it for the interface: the top-bar
 * chip, the announcement, the update window and Ajustes → Actualizaciones.
 */
export type UpdatePhase = "idle" | "downloading" | "installing" | "error";

interface State {
  status: UpdateStatus | null;
  phase: UpdatePhase;
  downloaded: number;
  total: number | null;
  /** Bytes per second, measured over the last few seconds. */
  speed: number;
  installError: string | null;
  /** The update window ("update") or, after installing, the "what's new" one. */
  window: "update" | "whatsnew" | null;
  /** "Más tarde": not announced again until NOVA is reopened. */
  later: string | null;
  whatsNew: UpdateInfo | null;
}

let state: State = { status: null, phase: "idle", downloaded: 0, total: null, speed: 0, installError: null, window: null, later: null, whatsNew: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUpdates(): State {
  return useSyncExternalStore(subscribe, () => state);
}

/** An update that should be offered: not skipped, not postponed. */
export function offered(s: State = state): UpdateInfo | null {
  const a = s.status?.available;
  if (!a || s.status?.skipped === a.version || s.later === a.version) return null;
  return a;
}

/** Notes of the version being installed, shown once by the new one. */
const NOTES_KEY = "nova.update.notes";

let samples: { t: number; bytes: number }[] = [];
let started = false;

export const updates = {
  /** Once, at start-up. */
  start() {
    if (!inTauri || started) return;
    started = true;
    api.updatesStatus().then((status) => set({ status }), () => {});
    void listen<UpdateStatus>("update-status", ({ payload }) => set({ status: payload }));
    void listen<{ downloaded: number; total: number | null }>("update-progress", ({ payload }) => {
      const now = performance.now();
      samples = [...samples.filter((s) => now - s.t < 3000), { t: now, bytes: payload.downloaded }];
      const first = samples[0];
      const speed = samples.length > 1 ? ((payload.downloaded - first.bytes) * 1000) / (now - first.t) : 0;
      set({ phase: "downloading", downloaded: payload.downloaded, total: payload.total, speed });
    });
    void listen("update-installing", () => set({ phase: "installing" }));

    // Just updated: say what's new, once.
    try {
      const saved = localStorage.getItem(NOTES_KEY);
      if (saved) {
        const info = JSON.parse(saved) as UpdateInfo;
        api.systemInfo().then((i) => {
          // Only the version it describes shows it (an install that didn't finish leaves the old one).
          if (i.appVersion !== info.version) return;
          set({ whatsNew: info, window: "whatsnew" });
          try {
            localStorage.removeItem(NOTES_KEY);
          } catch {}
        }, () => {});
      }
    } catch {}
  },

  open: () => set({ window: "update", installError: null, phase: state.phase === "error" ? "idle" : state.phase }),
  close() {
    if (state.phase === "downloading" || state.phase === "installing") return;
    set({ window: null });
  },
  later() {
    set({ later: state.status?.available?.version ?? null, window: null });
  },
  async skip() {
    const v = state.status?.available?.version ?? null;
    set({ status: await api.updatesSkip(v), window: null });
  },
  async unskip() {
    set({ status: await api.updatesSkip(null) });
  },
  async check() {
    if (state.status) set({ status: { ...state.status, checking: true } });
    set({ status: await api.updatesCheck() });
    return state.status;
  },
  async setAuto(enabled: boolean) {
    set({ status: await api.updatesSetAuto(enabled) });
  },
  async install() {
    const a = state.status?.available;
    if (!a) return;
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(a));
    } catch {}
    samples = [];
    set({ phase: "downloading", downloaded: 0, total: null, speed: 0, installError: null });
    try {
      // On success the installer closes NOVA: this never returns.
      await api.updatesInstall();
    } catch (e) {
      set({ phase: "error", installError: e instanceof Error ? e.message : String(e) });
    }
  },
};
