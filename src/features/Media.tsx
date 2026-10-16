import { useState } from "react";
import { Check, Clapperboard, FolderOpen, ImageIcon, Music, Pencil, Play } from "lucide-react";
import { PageHeader } from "../components/Chrome";
import { NowPlayingCard } from "../components/NowPlayingCard";
import { MediaTile } from "../components/Tiles";
import { useNova } from "../app/context";
import { useBackHandler } from "../hooks/backStack";
import type { RecentMedia } from "../lib/types";

const FORMATS = [
  { icon: Clapperboard, label: "Vídeo", exts: "MP4 · MKV · AVI · MOV · WEBM · WMV" },
  { icon: Music, label: "Audio", exts: "MP3 · FLAC · WAV · AAC · OGG · M4A" },
  { icon: ImageIcon, label: "Imagen", exts: "JPG · PNG · GIF · WEBP · BMP" },
];

export function MediaScreen() {
  const nova = useNova();
  const [editing, setEditing] = useState(false);
  useBackHandler(() => setEditing(false), editing);
  const last = nova.recentMedia[0] ?? null;

  const activate = (m: RecentMedia) => (editing ? nova.forgetMedia(m.path) : nova.openMedia(m.path));

  return (
    <div className="pb-14">
      <PageHeader
        eyebrow="Multimedia"
        title="Vídeos, música y fotos"
        description="Abre archivos de este PC con su aplicación predeterminada de Windows. Los servicios de streaming con DRM se usan desde sus propias apps."
      >
        <button
          data-nav
          disabled={nova.recentMedia.length === 0}
          onClick={() => setEditing((e) => !e)}
          className={`focus-lift btn ${editing ? "btn-danger" : "btn-ghost"}`}
        >
          {editing ? <Check className="size-5" /> : <Pencil className="size-5" />}
          {editing ? "Terminar" : "Editar recientes"}
        </button>
      </PageHeader>
      <NowPlayingCard />

      <div className="mt-8 grid grid-cols-[1.35fr_1fr] gap-6 px-[var(--gutter)]">
        <button
          data-nav
          data-autofocus
          onClick={nova.pickAndOpenMedia}
          className="focus-lift relative flex min-h-[15rem] flex-col justify-end overflow-hidden rounded-[var(--radius-card)] border border-line p-9 text-left"
          style={{
            background:
              "radial-gradient(80% 120% at 100% 0%, rgb(255 79 154 / 0.35), transparent 60%), radial-gradient(70% 100% at 0% 100%, rgb(110 108 255 / 0.35), transparent 60%), linear-gradient(140deg, #1a0f2e, #090b1c)",
          }}
        >
          <span className="absolute right-9 top-9 grid size-[5rem] place-items-center rounded-full bg-white/12 ring-1 ring-white/20">
            <FolderOpen className="size-9" />
          </span>
          <span className="eyebrow text-[#ffb3d1]">Archivo local</span>
          <span className="mt-2 text-[2.3rem] font-semibold leading-tight">Abrir archivo multimedia</span>
          <span className="mt-2 text-[1.15rem] text-ink-2">Elige un vídeo, una canción o una imagen.</span>
        </button>

        <div className="surface flex flex-col justify-between rounded-[var(--radius-card)] p-8">
          <div>
            <p className="eyebrow">Último archivo abierto</p>
            {last ? (
              <>
                <p className="mt-3 line-clamp-2 break-all text-[1.5rem] font-semibold leading-snug">{last.name}</p>
                <p className="mt-1 truncate text-[0.95rem] text-ink-3">{last.path}</p>
              </>
            ) : (
              <p className="mt-3 text-[1.2rem] text-ink-3">Todavía no has abierto ningún archivo.</p>
            )}
          </div>
          {last && (
            <button data-nav onClick={() => nova.openMedia(last.path)} className="focus-lift btn btn-primary mt-5 self-start">
              <Play className="size-5" fill="currentColor" /> Abrir de nuevo
            </button>
          )}
          <ul className="mt-6 space-y-2.5">
            {FORMATS.map(({ icon: Icon, label, exts }) => (
              <li key={label} className="flex items-center gap-3 text-[0.95rem] text-ink-3">
                <Icon className="size-5 text-ink-2" />
                <span className="w-16 font-semibold text-ink-2">{label}</span> {exts}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <section className="mt-10 px-[var(--gutter)]">
        <h2 className="mb-4 text-[1.5rem] font-semibold">Recientes</h2>
        {nova.recentMedia.length === 0 ? (
          <p className="text-[1.1rem] text-ink-3">Los archivos que abras aparecerán aquí.</p>
        ) : (
          <div className="flex flex-wrap gap-5">
            {nova.recentMedia.map((m) => (
              <MediaTile key={m.path} item={m} editing={editing} onActivate={activate} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
