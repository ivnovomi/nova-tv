import { useState } from "react";
import { Play, Trash2 } from "lucide-react";
import type { FeedItem, WatchEntry } from "../lib/types";
import { remaining, timeAgo } from "../lib/api";

/** Thumbnail with an offline-safe gradient fallback. */
function Thumb({ src, alt }: { src?: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="absolute inset-0 bg-[radial-gradient(90%_120%_at_80%_0%,rgb(255_0_51/0.45),transparent_60%),linear-gradient(135deg,#2a0008,#07070d)]">
      {src && !failed && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}

function YouTubeBadge() {
  return (
    <span className="badge absolute left-3 top-3 bg-black/60 text-white backdrop-blur">
      <span className="grid h-3 w-4 place-items-center rounded-[3px] bg-[#ff0033]">
        <Play className="size-2" fill="white" strokeWidth={0} />
      </span>
      YouTube
    </span>
  );
}

const TILE =
  "focus-lift relative flex h-[13.5rem] w-[20.5rem] shrink-0 flex-col overflow-hidden rounded-[var(--radius-tile)] border border-line text-left shadow-[var(--shadow-tile)] bg-surface-1";

/** "Seguir viendo": real progress from the player, resumes at that second. */
export function ContinueTile({
  entry,
  editing,
  onActivate,
}: {
  entry: WatchEntry;
  editing?: boolean;
  onActivate: (e: WatchEntry) => void;
}) {
  const pct = entry.duration > 0 ? Math.min(100, (entry.position / entry.duration) * 100) : 0;
  return (
    <button
      data-nav
      onClick={() => onActivate(entry)}
      aria-label={`${editing ? "Quitar del historial" : "Seguir viendo"} ${entry.title}`}
      className={TILE}
    >
      <span className="relative block h-[11.5rem] w-full shrink-0 overflow-hidden">
        <Thumb src={entry.thumbnail} alt="" />
        <span className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
        <YouTubeBadge />
        <span className="absolute inset-x-4 bottom-3">
          <span className="line-clamp-2 text-[1.1rem] font-semibold leading-snug [text-shadow:0_1px_8px_rgb(0_0_0/0.8)]">
            {entry.title}
          </span>
          <span className="mt-0.5 block truncate text-[0.85rem] text-white/70">
            {entry.finished ? "Visto" : remaining(entry.position, entry.duration)}
            {entry.channel ? ` · ${entry.channel}` : ""}
          </span>
        </span>
      </span>
      <span className="relative block h-[0.35rem] w-full bg-white/10">
        <span
          className={`absolute inset-y-0 left-0 ${entry.finished ? "bg-white/40" : "bg-[#ff0033]"}`}
          style={{ width: `${entry.finished ? 100 : pct}%` }}
        />
      </span>
      <span className="flex flex-1 items-center px-4 text-[0.85rem] text-ink-3">{timeAgo(entry.updatedAt)}</span>
      {editing && (
        <span className="absolute inset-0 grid place-items-center bg-danger/30 font-semibold">
          <span className="flex items-center gap-2">
            <Trash2 className="size-5" /> Quitar
          </span>
        </span>
      )}
    </button>
  );
}

/** Latest uploads from channels you watch (public RSS). */
export function FeedTile({ item, onActivate }: { item: FeedItem; onActivate: (i: FeedItem) => void }) {
  return (
    <button data-nav onClick={() => onActivate(item)} aria-label={`Ver ${item.title}`} className={TILE}>
      <span className="relative block h-[11.5rem] w-full shrink-0 overflow-hidden">
        <Thumb src={item.thumbnail} alt="" />
        <span className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
        <YouTubeBadge />
        <span className="badge absolute right-3 top-3 bg-[#ff0033] text-white">Nuevo</span>
        <span className="absolute inset-x-4 bottom-3 line-clamp-2 text-[1.1rem] font-semibold leading-snug [text-shadow:0_1px_8px_rgb(0_0_0/0.8)]">
          {item.title}
        </span>
      </span>
      <span className="flex flex-1 items-center gap-2 truncate px-4 text-[0.85rem] text-ink-3">
        <span className="truncate font-medium text-ink-2">{item.channel}</span>· {timeAgo(item.published)}
      </span>
    </button>
  );
}
