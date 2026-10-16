import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Smartphone, Trash2, Wifi, WifiOff } from "lucide-react";
import { useToast } from "../components/Toasts";
import { api, inTauri } from "../lib/api";
import type { RemoteInfo } from "../lib/types";

/** Pairing card for the phone remote: QR, URL, PIN and paired devices. */
export function RemoteCard() {
  const toast = useToast();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.remoteInfo().then(
      (i) => {
        setInfo(i);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  useEffect(() => {
    refresh();
    if (!inTauri) return;
    const off = listen("remote-changed", refresh);
    return () => {
      void off.then((f) => f());
    };
  }, [refresh]);

  const run = (p: Promise<void>, ok?: string) =>
    p.then(
      () => {
        if (ok) toast.show("success", ok);
        refresh();
      },
      (e: Error) => toast.show("error", "No se pudo completar", e.message),
    );

  const problem = error ?? info?.error ?? null;

  return (
    <section>
      <h2 className="mb-4 flex items-center gap-3 text-[1.5rem] font-semibold">
        <Smartphone className="size-7 text-cyan" /> Mando desde el móvil
      </h2>
      <div className="surface grid grid-cols-[auto_1fr_1fr] gap-10 rounded-[var(--radius-card)] p-8">
        <div className="grid size-[15rem] place-items-center overflow-hidden rounded-2xl bg-white p-3 shadow-[0_1rem_3rem_-1rem_rgb(110_108_255/0.6)]">
          {info?.running && info.qrSvg ? (
            <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
          ) : (
            <WifiOff className="size-14 text-[#7c84ab]" />
          )}
        </div>

        <div className="min-w-0">
          {problem ? (
            <p className="text-[1.1rem] text-danger">{problem}</p>
          ) : info && !info.enabled ? (
            <p className="text-[1.15rem] text-ink-2">
              El mando móvil está desactivado. Actívalo para controlar NOVA TV desde tu teléfono.
            </p>
          ) : info?.running ? (
            <>
              <ol className="space-y-2 text-[1.1rem] text-ink-2">
                <li>1. Conecta el móvil a la misma red Wi-Fi que este PC.</li>
                <li>2. Escanea el código con la cámara del móvil.</li>
                <li>3. Para tenerlo a mano: «Añadir a pantalla de inicio».</li>
              </ol>
              <p className="eyebrow mt-6">O abre en el navegador del móvil</p>
              <p className="mt-1 truncate font-mono text-[1.5rem] font-semibold">{info.urls[0] ?? "Sin red local"}</p>
              {info.urls.length > 1 && (
                <p className="mt-1 truncate text-[0.95rem] text-ink-3">También: {info.urls.slice(1).join(" · ")}</p>
              )}
              <p className="eyebrow mt-5">PIN de emparejamiento</p>
              <p className="mt-1 flex gap-2" aria-label={`PIN ${info.pin}`}>
                {info.pin.split("").map((d, i) => (
                  <span
                    key={i}
                    className="grid h-[3.4rem] w-[2.7rem] place-items-center rounded-xl bg-white/8 text-[1.9rem] font-semibold tabular-nums"
                  >
                    {d}
                  </span>
                ))}
              </p>
              {info.locked && (
                <p className="mt-2 text-[0.95rem] text-warn">Demasiados intentos fallidos: emparejamiento bloqueado un minuto.</p>
              )}
            </>
          ) : (
            <p className="text-[1.1rem] text-ink-3">Cargando…</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <p className="eyebrow">Dispositivos emparejados</p>
          <div className="mt-3 flex-1 space-y-2">
            {info?.devices.length ? (
              info.devices.map((d) => (
                <div key={d.id} className="flex items-center gap-3 rounded-xl bg-white/5 py-2 pl-4 pr-2">
                  <Smartphone className="size-5 shrink-0 text-ink-2" />
                  <span className="min-w-0 flex-1 truncate text-[1.05rem]">{d.name}</span>
                  <button
                    data-nav
                    aria-label={`Quitar ${d.name}`}
                    onClick={() => run(api.remoteRevoke(d.id), `${d.name} ya no puede controlar NOVA TV`)}
                    className="focus-ring grid size-10 place-items-center rounded-lg text-ink-3 focus:bg-danger/20 focus:text-danger"
                  >
                    <Trash2 className="size-5" />
                  </button>
                </div>
              ))
            ) : (
              <p className="text-[1rem] text-ink-3">Ninguno todavía.</p>
            )}
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            {info?.running && (
              <button data-nav onClick={() => run(api.remoteNewPin())} className="focus-lift btn btn-ghost">
                <RefreshCw className="size-5" /> Nuevo PIN
              </button>
            )}
            {info && (
              <button
                data-nav
                onClick={() =>
                  run(api.remoteSetEnabled(!info.enabled), info.enabled ? "Mando móvil desactivado" : "Mando móvil activado")
                }
                className={`focus-lift btn ${info.enabled ? "btn-danger" : "btn-primary"}`}
              >
                {info.enabled ? <WifiOff className="size-5" /> : <Wifi className="size-5" />}
                {info.enabled ? "Desactivar" : "Activar"}
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-4 text-[0.95rem] text-ink-3">
        Solo responde a teléfonos emparejados de tu red local. Puede mover, seleccionar, ajustar el volumen y escribir; nunca
        abrir programas.
      </p>
    </section>
  );
}
