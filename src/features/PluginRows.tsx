import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { Puzzle } from "lucide-react";
import { Row } from "../components/Tiles";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { useNova } from "../app/context";
import { api, inTauri } from "../lib/api";
import type { PluginAction, PluginItem, PluginRow, PluginRows } from "../lib/types";

/** Plugins decide their own refresh (NOVA enforces the minimum); this just asks again now and then. */
const ASK_EVERY_MS = 10 * 60_000;

function usePluginRows(): PluginRows[] {
  const [rows, setRows] = useState<PluginRows[]>([]);
  useEffect(() => {
    if (!inTauri) return;
    const load = () => api.pluginsRows().then(setRows, () => {});
    load();
    const timer = window.setInterval(load, ASK_EVERY_MS);
    // Each profile sees its own plugins; installing, enabling… a plugin shows right away.
    const offs = [listen("profile-changed", load), listen("plugins-changed", load)];
    return () => {
      window.clearInterval(timer);
      offs.forEach((off) => void off.then((f) => f()));
    };
  }, []);
  return rows;
}

const SIZE: Record<PluginRow["style"], string> = {
  landscape: "h-[12.5rem] w-[22rem]",
  poster: "h-[16.5rem] w-[11rem]",
  square: "h-[12.5rem] w-[12.5rem]",
};

function PluginTile({ item, style, onActivate }: { item: PluginItem; style: PluginRow["style"]; onActivate: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      data-nav
      onClick={onActivate}
      aria-label={[item.title, item.subtitle].filter(Boolean).join(", ")}
      className={`focus-lift relative flex shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border border-white/10 bg-[linear-gradient(140deg,#18224d,#0b1124)] text-left shadow-[var(--shadow-tile)] ${SIZE[style]}`}
    >
      {item.image && !failed ? (
        <img src={item.image} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      ) : (
        <Puzzle className="absolute right-4 top-4 size-8 text-white/15" />
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      {item.badge && <span className="badge absolute left-3 top-3 bg-white/90 text-black">{item.badge}</span>}
      <span className="relative px-4 pb-3">
        <span className="line-clamp-2 block text-[1.1rem] font-semibold leading-snug">{item.title}</span>
        {item.subtitle && <span className="block truncate text-[0.9rem] text-white/70">{item.subtitle}</span>}
      </span>
    </button>
  );
}

/** What a plugin's item does, within what NOVA allows. */
function useRunAction() {
  const nova = useNova();
  const toast = useToast();
  const [detail, setDetail] = useState<Extract<PluginAction, { type: "detail" }> & { fallback: string } | null>(null);
  const run = (item: PluginItem) => {
    const a = item.action;
    if (a.type === "detail") setDetail({ ...a, fallback: item.title });
    else if (a.type === "play" && a.stream.type === "twitch") void nova.playTwitch(a.stream.channel, a.title ?? item.title);
    else if (a.type === "play" && a.stream.type === "youtube" && "video" in a.stream) void nova.playVideo(a.stream.video);
    else toast.show("info", "Todavía no disponible", "Reproducir directos HLS, sintonizar canales y abrir apps de plugins llegará en las próximas versiones.");
  };
  const modal = (
    <AnimatePresence>
      {detail && (
        <Modal key="detail" title={detail.title ?? detail.fallback} onClose={() => setDetail(null)} width="44rem">
          {detail.image && <img src={detail.image} alt="" className="mb-5 max-h-[18rem] w-full rounded-xl object-cover" />}
          <p className="whitespace-pre-line text-[1.15rem] leading-relaxed text-ink-2">{detail.text}</p>
          <div className="mt-7 flex justify-end">
            <button data-nav data-autofocus onClick={() => setDetail(null)} className="focus-lift btn btn-ghost">
              Cerrar
            </button>
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
  return { run, modal };
}

/** "Para ti": the rows that plugins add. */
export function PluginRowsSection() {
  const rows = usePluginRows();
  const { run, modal } = useRunAction();
  return (
    <>
      {rows.flatMap((p) =>
        p.rows.map((row, i) => (
          <Row key={`${p.plugin}-${i}`} title={row.title}>
            {row.items.map((item) => (
              <PluginTile key={item.id} item={item} style={row.style} onActivate={() => run(item)} />
            ))}
          </Row>
        )),
      )}
      {modal}
    </>
  );
}
