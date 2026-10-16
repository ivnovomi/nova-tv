import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { focusFirst, moveFocus, type Direction } from "../lib/spatialNav";
import { inTauri } from "../lib/api";
import { runBack } from "./backStack";
import { power } from "../app/power";

const KEY_DIR: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button", "range"].includes(el.type);
}

async function toggleFullscreen() {
  if (!inTauri) return;
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

/** Keyboard + gamepad remote. Returns the connected gamepad's name, if any. */
export function useRemoteInput(onHome: () => void): string | null {
  const homeRef = useRef(onHome);
  homeRef.current = onHome;
  const [gamepad, setGamepad] = useState<string | null>(null);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      const text = isTextField(active);
      const dir = KEY_DIR[e.key];
      if (dir) {
        if (text && (dir === "left" || dir === "right")) return;
        e.preventDefault();
        moveFocus(dir);
        return;
      }
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          if (text) (active as HTMLElement).blur();
          runBack();
          break;
        case "Backspace":
        case "BrowserBack":
          if (text) return;
          e.preventDefault();
          runBack();
          break;
        case "Home":
        case "BrowserHome":
          if (text) return;
          e.preventDefault();
          homeRef.current();
          break;
        case "F11":
          e.preventDefault();
          void toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pointer: moving the mouse over a target focuses it, so hover and focus never disagree.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-nav]");
      if (el && el !== document.activeElement && !isTextField(document.activeElement)) {
        el.focus({ preventScroll: true });
      }
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Gamepad (standard mapping). Ignored while another window has focus.
  useEffect(() => {
    if (!("getGamepads" in navigator)) return;
    let raf = 0;
    const held: Record<string, number> = {};
    const FIRST_REPEAT = 380;
    const REPEAT = 130;

    const dispatchDir = (dir: Direction) => {
      const key = Object.keys(KEY_DIR).find((k) => KEY_DIR[k] === dir)!;
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const pads = navigator.getGamepads?.() ?? [];
      const pad = pads.find((p) => p && p.connected);
      if (!pad || !document.hasFocus()) return;
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const state: Record<string, boolean> = {
        up: b(12) || ay < -0.55,
        down: b(13) || ay > 0.55,
        left: b(14) || ax < -0.55,
        right: b(15) || ax > 0.55,
        select: b(0),
        back: b(1),
        x: b(2),
        y: b(3),
        view: b(8),
        home: b(16) || b(9),
      };
      if (power.isSaving()) {
        // The screensaver is up: a new press only wakes it and does nothing else
        // (held until released, so it doesn't act on the screen that comes back).
        let pressedNew = false;
        for (const [action, pressed] of Object.entries(state)) {
          if (!pressed) delete held[action];
          else if (held[action] === undefined) {
            held[action] = Infinity;
            pressedNew = true;
          }
        }
        if (pressedNew) power.screensaver(false);
        return;
      }
      for (const [action, pressed] of Object.entries(state)) {
        if (!pressed) {
          delete held[action];
          continue;
        }
        const isDir = action in { up: 1, down: 1, left: 1, right: 1 };
        const next = held[action];
        if (next === undefined) {
          held[action] = t + FIRST_REPEAT;
        } else if (isDir && t >= next) {
          held[action] = t + REPEAT;
        } else {
          continue;
        }
        if (isDir) dispatchDir(action as Direction);
        else if (action === "select") {
          const el = document.activeElement as HTMLElement | null;
          if (el && el !== document.body) el.click();
          else focusFirst();
        } else if (action === "back") runBack();
        else if (action === "home") homeRef.current();
        else if (action === "x" || action === "y" || action === "view") {
          // Named keys only screens that care (e.g. live TV) react to.
          const key = action === "x" ? "GamepadX" : action === "y" ? "GamepadY" : "GamepadView";
          const target = (document.activeElement as HTMLElement | null) ?? document.body;
          target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        }
      }
    };

    const refresh = () => {
      const pad = (navigator.getGamepads?.() ?? []).find((p) => p && p.connected);
      setGamepad(pad ? pad.id.replace(/\s*\(.*\)\s*/g, "").trim() || "Mando" : null);
    };
    window.addEventListener("gamepadconnected", refresh);
    window.addEventListener("gamepaddisconnected", refresh);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("gamepadconnected", refresh);
      window.removeEventListener("gamepaddisconnected", refresh);
    };
  }, []);

  return gamepad;
}
