import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../../lib/api";
import type { PadInfo } from "../../lib/types";

export interface Pad extends PadInfo {
  source: "xinput" | "web";
}

function cleanName(id: string) {
  return id.replace(/\s*\(.*\)\s*/g, " ").replace(/\s+/g, " ").trim() || "Mando";
}

/**
 * Connected controllers. XInput (from Rust) sees Xbox-compatible pads instantly,
 * without a button press; the web Gamepad API adds others (e.g. PlayStation)
 * once a button has been pressed.
 */
export function useGamepads(): Pad[] {
  const [native, setNative] = useState<PadInfo[]>([]);
  const [web, setWeb] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const offs: Array<() => void> = [];
    if (inTauri) {
      api.listGamepads().then((p) => alive && setNative(p), () => {});
      const off = listen<PadInfo[]>("gamepads-changed", (e) => setNative(e.payload));
      offs.push(() => void off.then((f) => f()));
    }
    const scan = () => {
      const pads = Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);
      setWeb((prev) => {
        const next = pads.map((p) => p.id);
        return prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next;
      });
    };
    scan();
    window.addEventListener("gamepadconnected", scan);
    window.addEventListener("gamepaddisconnected", scan);
    const timer = window.setInterval(scan, 1000);
    return () => {
      alive = false;
      offs.forEach((f) => f());
      window.removeEventListener("gamepadconnected", scan);
      window.removeEventListener("gamepaddisconnected", scan);
      window.clearInterval(timer);
    };
  }, []);

  const fromXInput: Pad[] = native.map((p) => ({ ...p, source: "xinput" }));
  // Web pads that XInput already covers (Xbox/XInput devices) are not repeated.
  const extra: Pad[] = web
    .filter((id) => native.length === 0 || !/xinput|xbox|045e/i.test(id))
    .map((id, i) => ({ id: 1000 + i, name: cleanName(id), battery: null, charging: false, wired: false, source: "web" }));
  return [...fromXInput, ...extra];
}
