import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../lib/api";
import type { TwitchLive } from "../lib/types";

const REFRESH_MS = 5 * 60_000;

/** Spanish live streams for everyone (filtered in Rust), refreshed every few minutes. */
export function useTwitchLive(): TwitchLive[] {
  const [list, setList] = useState<TwitchLive[]>([]);
  useEffect(() => {
    if (!inTauri) return;
    const load = () => api.twitchLive().then(setList, () => {});
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const off = listen("profile-changed", load); // a children's profile may not get Twitch
    return () => {
      window.clearInterval(timer);
      void off.then((f) => f());
    };
  }, []);
  return list;
}

/** "11,4 mil" */
export function viewers(n: number) {
  return n >= 1000 ? `${(n / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 })} mil` : String(n);
}

/** The live thumbnail, refreshed each time the list is (Twitch updates it every few minutes). */
export function preview(s: TwitchLive) {
  return s.preview ? `${s.preview}?t=${Math.floor(Date.now() / REFRESH_MS)}` : "";
}

export const TWITCH_BG = "radial-gradient(90% 120% at 85% 0%, rgb(145 70 255 / 0.55), transparent 60%), linear-gradient(140deg,#160b2b,#07060f)";

/** A live stream card: the live picture, who, what and how many are watching. */
export function TwitchTile({ s, onFocus, onPlay }: { s: TwitchLive; onFocus: () => void; onPlay: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      data-nav
      onFocus={onFocus}
      onClick={onPlay}
      aria-label={`Twitch en directo: ${s.name}, ${s.title}`}
      className="focus-lift relative flex h-[12.5rem] w-[22rem] shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border border-white/10 text-left shadow-[var(--shadow-tile)]"
      style={{ background: TWITCH_BG }}
    >
      {s.preview && !failed && <img src={preview(s)} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-transparent" />
      <span className="absolute left-3 top-3 flex items-center gap-2">
        <span className="badge bg-[#ff3b5c] text-white">● DIRECTO</span>
        <span className="badge bg-black/60 text-white">{viewers(s.viewers)}</span>
      </span>
      <span className="relative flex items-end gap-3 px-4 pb-3">
        {s.avatar && <img src={s.avatar} alt="" loading="lazy" className="size-10 shrink-0 rounded-full ring-2 ring-[#9146ff]" />}
        <span className="min-w-0">
          <span className="block truncate text-[0.8rem] font-semibold uppercase tracking-[0.1em] text-white/70">
            {s.name}
            {s.game ? ` · ${s.game}` : ""}
          </span>
          <span className="mt-0.5 line-clamp-2 text-[1.05rem] font-semibold leading-snug [text-shadow:0_1px_8px_rgb(0_0_0/0.8)]">{s.title}</span>
        </span>
      </span>
    </button>
  );
}
