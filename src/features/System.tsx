import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  Bluetooth,
  Download,
  Maximize,
  Monitor,
  Palette,
  Power,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
  Wifi,
  Minus,
  Plus,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";
import { useToast } from "../components/Toasts";
import { api, formatBytes, inTauri } from "../lib/api";
import type { SettingsPage, SystemInfo, SystemStats, VolumeState } from "../lib/types";

const SETTINGS: { page: SettingsPage; label: string; icon: ComponentType<LucideProps> }[] = [
  { page: "display", label: "Pantalla", icon: Monitor },
  { page: "sound", label: "Sonido", icon: Volume2 },
  { page: "bluetooth", label: "Bluetooth", icon: Bluetooth },
  { page: "network", label: "Red e Internet", icon: Wifi },
  { page: "apps", label: "Aplicaciones", icon: AppWindow },
  { page: "personalization", label: "Personalización", icon: Palette },
  { page: "update", label: "Windows Update", icon: Download },
  { page: "power", label: "Inicio/apagado", icon: Power },
];

const UNAVAILABLE = "No disponible";

function formatUptime(secs: number) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return [d && `${d} d`, (d || h) && `${h} h`, `${m} min`].filter(Boolean).join(" ");
}

function Meter({ label, value, detail }: { label: string; value: number | null; detail: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[1.05rem] text-ink-2">{label}</span>
        <span className="text-[1.6rem] font-semibold tabular-nums">{value === null ? "—" : `${Math.round(value)}%`}</span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)] transition-[width] duration-700"
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      <p className="mt-1.5 text-[0.9rem] text-ink-3">{detail}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line py-3 last:border-0">
      <dt className="shrink-0 text-[1rem] text-ink-3">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[1.05rem] font-medium">{value || UNAVAILABLE}</dd>
    </div>
  );
}

function VolumeCard() {
  const toast = useToast();
  const [vol, setVol] = useState<VolumeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    api.getVolume().then(setVol, (e: Error) => setError(e.message));
  }, []);

  const apply = (p: Promise<VolumeState>) =>
    p.then(
      (v) => {
        setVol(v);
        setError(null);
      },
      (e: Error) => toast.show("error", "No se pudo cambiar el volumen", e.message),
    );

  const setLevel = (level: number) => {
    const next = Math.max(0, Math.min(100, Math.round(level / 2) * 2));
    setVol((v) => (v ? { ...v, level: next } : v));
    window.clearTimeout(pending.current ?? undefined);
    pending.current = window.setTimeout(() => apply(api.setVolume(next)), 40);
  };

  const onSliderKey = (e: KeyboardEvent) => {
    if (!vol) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setLevel(vol.level + (e.key === "ArrowRight" ? 4 : -4));
    }
  };

  const Icon = !vol || vol.muted || vol.level === 0 ? VolumeX : vol.level < 50 ? Volume1 : Volume2;

  return (
    <div className="surface rounded-[var(--radius-card)] p-8">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Volumen del sistema</p>
        {vol && <span className="text-[1.6rem] font-semibold tabular-nums">{vol.muted ? "Silencio" : `${vol.level}%`}</span>}
      </div>
      {error ? (
        <p className="mt-4 text-[1.05rem] text-ink-3">{UNAVAILABLE}: {error}</p>
      ) : (
        <>
          <div className="mt-5 flex items-center gap-4">
            <button data-nav aria-label="Bajar volumen" disabled={!vol} onClick={() => vol && setLevel(vol.level - 10)} className="focus-lift grid size-[3.4rem] shrink-0 place-items-center rounded-full bg-white/8">
              <Minus className="size-6" />
            </button>
            <button
              data-nav
              role="slider"
              aria-label="Volumen"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={vol?.level ?? 0}
              disabled={!vol}
              onKeyDown={onSliderKey}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                if (e.clientX > 0) setLevel(((e.clientX - r.left) / r.width) * 100);
              }}
              className="focus-ring relative h-[3.4rem] flex-1 rounded-full bg-white/6 px-5"
            >
              <span className="absolute inset-x-5 top-1/2 h-2.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
                <span
                  className={`block h-full rounded-full transition-[width] duration-150 ${vol?.muted ? "bg-ink-3" : "bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)]"}`}
                  style={{ width: `${vol?.level ?? 0}%` }}
                />
              </span>
            </button>
            <button data-nav aria-label="Subir volumen" disabled={!vol} onClick={() => vol && setLevel(vol.level + 10)} className="focus-lift grid size-[3.4rem] shrink-0 place-items-center rounded-full bg-white/8">
              <Plus className="size-6" />
            </button>
            <button
              data-nav
              disabled={!vol}
              aria-pressed={vol?.muted}
              onClick={() => vol && apply(api.setMute(!vol.muted))}
              className={`focus-lift btn shrink-0 ${vol?.muted ? "btn-danger" : "btn-ghost"}`}
            >
              <Icon className="size-5" /> {vol?.muted ? "Activar sonido" : "Silenciar"}
            </button>
          </div>
          <p className="mt-3 text-[0.9rem] text-ink-3">Con la barra seleccionada, usa ← → para ajustar.</p>
        </>
      )}
    </div>
  );
}

/** This PC: real info, live CPU/RAM, volume and Windows Settings shortcuts (inside Ajustes). */
export function SystemPanel() {
  const toast = useToast();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    api.systemInfo().then(setInfo, (e: Error) => setInfoError(e.message));
    let alive = true;
    const poll = () =>
      api.systemStats().then(
        (s) => alive && setStats(s),
        () => alive && setStats(null),
      );
    poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const openSettings = (page: SettingsPage, label: string) =>
    api.openSettings(page).then(
      () => toast.show("success", `Abriendo Configuración · ${label}`),
      (e: Error) => toast.show("error", "No se pudo abrir Configuración", e.message),
    );

  const toggleFullscreen = async () => {
    if (!inTauri) return;
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  };

  const memPct = stats && stats.totalMemory > 0 ? (stats.usedMemory / stats.totalMemory) * 100 : null;

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <button data-nav onClick={toggleFullscreen} className="focus-lift btn btn-ghost">
          <Maximize className="size-5" /> Pantalla completa
        </button>
        <button data-nav onClick={() => openSettings("home", "Inicio")} className="focus-lift btn btn-ghost">
          <Settings className="size-5" /> Configuración de Windows
        </button>
      </div>

      <div className="mt-6 grid grid-cols-[1fr_1.25fr] gap-6">
        <div className="surface rounded-[var(--radius-card)] p-8">
          <p className="eyebrow">Información</p>
          {infoError ? (
            <p className="mt-4 text-[1.05rem] text-ink-3">{UNAVAILABLE}: {infoError}</p>
          ) : (
            <dl className="mt-3">
              <InfoRow label="Sistema" value={info?.longOsVersion ?? info?.osName} />
              <InfoRow label="Compilación" value={info?.kernelVersion} />
              <InfoRow label="Equipo" value={info?.hostName} />
              <InfoRow label="Procesador" value={info?.cpuBrand} />
              <InfoRow
                label="Núcleos"
                value={info ? `${info.physicalCores ?? "?"} físicos · ${info.logicalCores} lógicos` : null}
              />
              <InfoRow label="Memoria" value={info && info.totalMemory > 0 ? formatBytes(info.totalMemory) : null} />
              <InfoRow label="Arquitectura" value={info?.arch} />
              <InfoRow label="Encendido desde hace" value={info ? formatUptime(info.uptimeSecs) : null} />
              <InfoRow label="NOVA TV" value={info ? `v${info.appVersion}` : null} />
            </dl>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="surface grid grid-cols-2 gap-8 rounded-[var(--radius-card)] p-8">
            <Meter
              label="Uso de CPU"
              value={stats?.cpuUsage ?? null}
              detail={stats ? (stats.cpuUsage === null ? "Midiendo…" : "Medición en vivo") : UNAVAILABLE}
            />
            <Meter
              label="Memoria en uso"
              value={memPct}
              detail={stats ? `${formatBytes(stats.usedMemory)} de ${formatBytes(stats.totalMemory)}` : UNAVAILABLE}
            />
          </div>
          <VolumeCard />
        </div>
      </div>

      <section className="mt-10">
        <h2 className="mb-4 text-[1.5rem] font-semibold">Configuración de Windows</h2>
        <div className="grid grid-cols-4 gap-5">
          {SETTINGS.map(({ page, label, icon: Icon }) => (
            <button
              key={page}
              data-nav
              onClick={() => openSettings(page, label)}
              className="focus-lift surface flex h-[6.4rem] items-center gap-5 rounded-[var(--radius-tile)] px-6 text-left"
            >
              <span className="grid size-[3.4rem] place-items-center rounded-xl bg-white/8">
                <Icon className="size-7 text-focus" strokeWidth={1.8} />
              </span>
              <span className="text-[1.2rem] font-medium">{label}</span>
            </button>
          ))}
        </div>
        <p className="mt-5 text-[0.95rem] text-ink-3">
          Apagar, reiniciar y suspender se hacen desde Windows; NOVA TV no ejecuta acciones de energía.
        </p>
      </section>
    </div>
  );
}
