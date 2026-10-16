import { useEffect, useMemo, useState } from "react";
import { Row } from "../../components/Tiles";
import { ChannelLogo } from "./TvMode";
import { GROUP_ORDER, isAvailable, liveTv, onAir, useLiveTv } from "./store";

/** Home row: favourites (or the main channels), with what's on now. */
export function LiveTvRow({ onSeeAll }: { onSeeAll: () => void }) {
  const { data, epg, health } = useLiveTv();
  const [now, setNow] = useState(() => Date.now() / 1000);

  useEffect(() => {
    void liveTv.load();
    const t = window.setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const channels = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.channels.map((c) => [c.id, c]));
    const picked = [data.lastChannel, ...data.favorites].map((id) => (id ? byId.get(id) : undefined)).filter((c): c is NonNullable<typeof c> => !!c);
    const main = data.channels.filter((c) => c.group === GROUP_ORDER[0]);
    return [...new Map([...picked, ...main].map((c) => [c.id, c])).values()].filter((c) => isAvailable(c, health, true)).slice(0, 12);
  }, [data, health]);

  if (!channels.length) return null;

  return (
    <Row title="TV en directo" action={{ label: "Encender la TV", onClick: onSeeAll }}>
      {channels.map((c) => {
        const air = onAir(epg, c, now);
        return (
          <button
            key={c.id}
            data-nav
            onClick={() => liveTv.play(c.id)}
            aria-label={`${c.name}: ${air.current?.title ?? "en directo"}`}
            className="focus-lift surface relative flex h-[9.5rem] w-[20.5rem] shrink-0 flex-col justify-between overflow-hidden rounded-[var(--radius-tile)] p-4 text-left"
          >
            {air.current?.image && (
              <img src={air.current.image} alt="" aria-hidden loading="lazy" className="absolute inset-0 size-full object-cover opacity-30" />
            )}
            <span className="absolute inset-0 bg-gradient-to-t from-black/85 to-black/20" />
            <span className="relative flex items-center gap-3">
              <ChannelLogo channel={c} className="size-11" />
              <span className="min-w-0">
                <span className="block truncate text-[1.05rem] font-semibold">{c.name}</span>
                <span className="block text-[0.8rem] text-ink-3">{c.number}</span>
              </span>
              <span className="badge ml-auto bg-[#ff3b5c] text-white">● DIRECTO</span>
            </span>
            <span className="relative">
              <span className="block truncate text-[1.1rem] font-medium">{air.current?.title ?? "En directo"}</span>
              {air.progress != null && (
                <span className="mt-2 block h-1 overflow-hidden rounded-full bg-white/15">
                  <span className="block h-full rounded-full bg-white" style={{ width: `${air.progress * 100}%` }} />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </Row>
  );
}
