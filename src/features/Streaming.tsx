import { useState } from "react";
import { Check, Globe, History, Pencil, Plus, TriangleAlert } from "lucide-react";
import { ContinueTile, FeedTile } from "../components/VideoTiles";
import type { WatchEntry } from "../lib/types";
import { PageHeader } from "../components/Chrome";
import { AddTile, StreamTile } from "../components/Tiles";
import { useNova } from "../app/context";
import { useBackHandler } from "../hooks/backStack";
import type { Shortcut } from "../lib/types";

export function StreamingScreen() {
  const nova = useNova();
  const [editing, setEditing] = useState(false);
  useBackHandler(() => setEditing(false), editing);
  const services = nova.library?.streaming ?? [];
  const builtin = services.filter((s) => s.source === "builtin");
  const mine = services.filter((s) => s.source === "user");
  const store = services.filter((s) => s.source === "store");
  const noBrowser = nova.library && !nova.library.browserAvailable;
  const inProgress = nova.history.filter((e) => !e.finished && e.position > 15);
  const watched = nova.history.filter((e) => e.finished || e.position <= 15);
  const activateEntry = (e: WatchEntry) => (editing ? nova.removeHistory(e.key) : nova.playVideo(e.itemId, e.finished ? 0 : e.position));

  const activate = (item: Shortcut) => {
    if (!editing) return nova.launch(item);
    if (item.source === "user") nova.openDialog({ type: "confirm-remove", item });
  };

  return (
    <div className="pb-14">
      <PageHeader
        eyebrow="Streaming"
        title="Series, películas y directos"
        description="Cada servicio se abre a pantalla completa, sin barras de navegador. Inicia sesión una vez y NOVA TV lo recordará."
      >
        <button
          data-nav
          disabled={mine.length === 0 && nova.history.length === 0}
          onClick={() => setEditing((e) => !e)}
          className={`focus-lift btn ${editing ? "btn-danger" : "btn-ghost"}`}
        >
          {editing ? <Check className="size-5" /> : <Pencil className="size-5" />}
          {editing ? "Terminar" : "Editar"}
        </button>
        <button data-nav onClick={() => nova.openDialog({ type: "add-web" })} className="focus-lift btn btn-primary">
          <Plus className="size-5" /> Añadir servicio
        </button>
      </PageHeader>

      {noBrowser && (
        <p role="alert" className="mx-[var(--gutter)] mt-6 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-5 py-3 text-[1.05rem] text-[#ffe7b0]">
          <TriangleAlert className="size-5 shrink-0" /> No se encontró Microsoft Edge ni Google Chrome. Son necesarios para abrir los servicios de streaming.
        </p>
      )}

      {inProgress.length > 0 && (
        <section className="mt-8 px-[var(--gutter)]">
          <h2 className="mb-4 text-[1.5rem] font-semibold">Seguir viendo</h2>
          <div className="flex flex-wrap gap-5">
            {inProgress.map((e) => (
              <ContinueTile key={e.key} entry={e} editing={editing} onActivate={activateEntry} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-8 px-[var(--gutter)]">
        {(inProgress.length > 0 || watched.length > 0) && <h2 className="mb-4 text-[1.5rem] font-semibold">Servicios</h2>}
        <div className="flex flex-wrap gap-5">
          {builtin.map((s, i) => (
            <StreamTile key={s.id} item={s} autoFocus={i === 0} editing={editing} busy={nova.launching === s.id} onActivate={activate} />
          ))}
        </div>
      </section>

      {store.length > 0 && (
        <section className="mt-10 px-[var(--gutter)]">
          <h2 className="mb-1 text-[1.5rem] font-semibold">Apps instaladas de Microsoft Store</h2>
          <p className="mb-4 text-[1rem] text-ink-3">Apps oficiales con su propia protección de contenido. Pueden ofrecer más calidad que la web.</p>
          <div className="flex flex-wrap gap-5">
            {store.map((s) => (
              <StreamTile key={s.id} item={s} editing={editing} busy={nova.launching === s.id} onActivate={activate} />
            ))}
          </div>
        </section>
      )}

      {nova.feed.length > 0 && (
        <section className="mt-10 px-[var(--gutter)]">
          <h2 className="mb-1 text-[1.5rem] font-semibold">Nuevo de tus canales</h2>
          <p className="mb-4 text-[1rem] text-ink-3">Lo último de los canales que ves en NOVA TV.</p>
          <div className="flex flex-wrap gap-5">
            {nova.feed.map((f) => (
              <FeedTile key={f.videoId} item={f} onActivate={(x) => nova.playVideo(x.videoId)} />
            ))}
          </div>
        </section>
      )}

      {watched.length > 0 && (
        <section className="mt-10 px-[var(--gutter)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-3 text-[1.5rem] font-semibold">
              <History className="size-6 text-ink-2" /> Visto recientemente
            </h2>
            <button data-nav onClick={() => nova.openDialog({ type: "confirm-clear-history" })} className="focus-lift btn btn-ghost">
              Borrar historial
            </button>
          </div>
          <div className="flex flex-wrap gap-5">
            {watched.slice(0, 24).map((e) => (
              <ContinueTile key={e.key} entry={e} editing={editing} onActivate={activateEntry} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10 px-[var(--gutter)]">
        <h2 className="mb-4 text-[1.5rem] font-semibold">Tus servicios</h2>
        <div className="flex flex-wrap gap-5">
          {mine.map((s) => (
            <StreamTile key={s.id} item={s} editing={editing} busy={nova.launching === s.id} onActivate={activate} />
          ))}
          {!editing && (
            <AddTile wide icon={Globe} title="Añadir servicio web" subtitle="Cualquier web https://, a pantalla completa" onClick={() => nova.openDialog({ type: "add-web" })} />
          )}
        </div>
      </section>

      <div className="mx-[var(--gutter)] mt-10 grid grid-cols-3 gap-5 text-[1rem] text-ink-2">
        <p className="surface rounded-[var(--radius-tile)] p-6">
          <span className="mb-1 block font-semibold text-ink-1">YouTube en modo TV</span>
          Se abre dentro de NOVA con la interfaz de televisión de YouTube. Mando: cruceta, A para aceptar, B para volver, X para pausar.
        </p>
        <p className="surface rounded-[var(--radius-tile)] p-6">
          <span className="mb-1 block font-semibold text-ink-1">Volver a NOVA TV</span>
          Pulsa <kbd className="rounded bg-white/10 px-1.5">View</kbd> + <kbd className="rounded bg-white/10 px-1.5">Menu</kbd> en el mando o la tecla <kbd className="rounded bg-white/10 px-1.5">Inicio</kbd>. Si cierras el servicio, NOVA TV vuelve solo.
        </p>
        <p className="surface rounded-[var(--radius-tile)] p-6">
          <span className="mb-1 block font-semibold text-ink-1">Calidad de vídeo</span>
          La resolución máxima la decide cada servicio según el navegador (Edge suele ofrecer la mejor en Windows).
        </p>
      </div>
    </div>
  );
}
