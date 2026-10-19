import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Gamepad2, Link2, LoaderCircle, MonitorPlay, Moon, Search, Trash2, TriangleAlert } from "lucide-react";
import { useToast } from "../components/Toasts";
import { api, inTauri } from "../lib/api";
import type { FoundPc, PcInfo, PcsInfo } from "../lib/types";

/** What the user has to do on the PC right now. */
type Pairing = { name: string; stage: "accept" } | { name: string; stage: "pin"; pin: string };

function newPin() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 10000).padStart(4, "0");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ajustes → Juegos desde tu PC: find NovaBridge, pair it and Moonlight. */
export function PcGamesCard() {
  const toast = useToast();
  const [info, setInfo] = useState<PcsInfo | null>(null);
  const [found, setFound] = useState<FoundPc[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);

  const refresh = useCallback(() => {
    api.pcList().then(setInfo, () => {});
  }, []);

  useEffect(() => {
    if (!inTauri) return;
    refresh();
    const off = listen("pcs-changed", refresh);
    return () => void off.then((f) => f());
  }, [refresh]);

  const search = async () => {
    setSearching(true);
    try {
      setFound(await api.pcDiscover());
    } catch (e) {
      toast.show("error", "No se pudo buscar", message(e));
    } finally {
      setSearching(false);
    }
  };

  const linkMoonlight = async (pc: { id: string; name: string }) => {
    const pin = newPin();
    setPairing({ name: pc.name, stage: "pin", pin });
    try {
      await api.pcLinkMoonlight(pc.id, pin);
      toast.show("success", `Listo: ya puedes jugar desde ${pc.name}`, "Sus juegos aparecen en NOVA PLAY.");
    } catch (e) {
      toast.show("error", "Moonlight no se pudo emparejar", message(e));
    } finally {
      setPairing(null);
      refresh();
    }
  };

  const pair = async (pc: FoundPc) => {
    setPairing({ name: pc.name, stage: "accept" });
    let id: string;
    try {
      id = await api.pcPair(pc.host);
    } catch (e) {
      setPairing(null);
      return toast.show("error", `No se pudo emparejar con ${pc.name}`, message(e));
    }
    setFound((list) => list?.map((f) => (f.id === id ? { ...f, paired: true } : f)) ?? null);
    if (info?.moonlight) {
      await linkMoonlight({ id, name: pc.name });
    } else {
      setPairing(null);
      toast.show("info", `${pc.name} emparejado`, "Instala Moonlight en esta tele para jugar.");
      refresh();
    }
  };

  const forget = (pc: PcInfo) =>
    api.pcForget(pc.id).then(
      () => toast.show("success", `${pc.name} olvidado`),
      (e: Error) => toast.show("error", "No se pudo olvidar", e.message),
    );

  const fresh = found?.filter((f) => !f.paired) ?? [];

  return (
    <div className="space-y-3">
      {info && !info.moonlight && (
        <div className="surface flex items-start gap-4 rounded-2xl px-6 py-5">
          <TriangleAlert className="mt-1 size-6 shrink-0 text-warn" />
          <p className="text-[1.05rem] text-ink-2">
            Falta <b className="text-ink-1">Moonlight</b> en esta tele: es lo que recibe la imagen del PC. Instálalo desde moonlight-stream.org y vuelve aquí.
          </p>
        </div>
      )}

      {pairing && (
        <div className="surface rounded-2xl border border-cyan/30 px-6 py-6" role="status">
          {pairing.stage === "accept" ? (
            <p className="flex items-center gap-3 text-[1.25rem] font-semibold">
              <LoaderCircle className="size-6 spin text-cyan" /> Ve a {pairing.name} y pulsa «Sí» en la pregunta de NovaBridge
            </p>
          ) : (
            <>
              <p className="flex items-center gap-3 text-[1.25rem] font-semibold">
                <LoaderCircle className="size-6 spin text-cyan" /> En {pairing.name} se ha abierto Sunshine: escribe este PIN
              </p>
              <p className="mt-4 flex gap-2" aria-label={`PIN ${pairing.pin}`}>
                {pairing.pin.split("").map((d, i) => (
                  <span key={i} className="grid h-[4.2rem] w-[3.3rem] place-items-center rounded-xl bg-white/8 text-[2.4rem] font-semibold tabular-nums">
                    {d}
                  </span>
                ))}
              </p>
            </>
          )}
        </div>
      )}

      {info?.pcs.map((pc) => (
        <div key={pc.id} className="surface flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-6 py-5">
          <MonitorPlay className="size-8 shrink-0 text-cyan" />
          <div className="min-w-[14rem] flex-1">
            <p className="flex flex-wrap items-center gap-2 text-[1.25rem] font-semibold">
              {pc.name}
              {pc.online ? <span className="badge bg-ok/15 text-ok">Encendido</span> : <span className="badge bg-white/10 text-ink-3"><Moon className="size-3.5" /> Dormido o apagado</span>}
              {pc.online && !pc.sunshineRunning && <span className="badge bg-warn/15 text-warn">{pc.sunshine ? "Sunshine parado" : "Sin Sunshine"}</span>}
            </p>
            <p className="mt-1 text-[1rem] text-ink-3">
              {pc.host} · {pc.moonlight ? `${pc.games} ${pc.games === 1 ? "juego" : "juegos"} en NOVA PLAY` : "Falta emparejar Moonlight"}
              {!pc.online && " · NOVA lo despierta al jugar, si su tarjeta de red lo permite"}
            </p>
          </div>
          {!pc.moonlight && info.moonlight && (
            <button data-nav disabled={!!pairing || !pc.online} onClick={() => void linkMoonlight(pc)} className="focus-lift btn btn-primary">
              <Link2 className="size-5" /> Emparejar Moonlight
            </button>
          )}
          <button data-nav disabled={!!pairing} onClick={() => void forget(pc)} className="focus-lift btn btn-danger" aria-label={`Olvidar ${pc.name}`}>
            <Trash2 className="size-5" /> Olvidar
          </button>
        </div>
      ))}

      <div className="surface rounded-2xl px-6 py-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-[16rem] flex-1">
            <p className="flex items-center gap-3 text-[1.25rem] font-semibold">
              <Gamepad2 className="size-6 text-cyan" /> Añadir un PC
            </p>
            <ol className="mt-2 space-y-1 text-[1rem] text-ink-3">
              <li>1. En el PC de juegos, instala Sunshine (es lo que emite la imagen).</li>
              <li>2. Abre NovaBridge en ese PC: se queda junto al reloj.</li>
              <li>3. Los dos en la misma red; mejor por cable. Busca aquí.</li>
            </ol>
          </div>
          <button data-nav disabled={searching || !!pairing} onClick={() => void search()} className="focus-lift btn btn-ghost">
            {searching ? <LoaderCircle className="size-5 spin" /> : <Search className="size-5" />} Buscar PCs
          </button>
        </div>
        {found && (
          <div className="mt-4 flex flex-wrap gap-2">
            {fresh.length === 0 && <p className="text-[1rem] text-ink-3">{found.length ? "Los PCs encontrados ya están emparejados." : "No aparece ninguno. ¿Está NovaBridge abierto y el PC en esta red?"}</p>}
            {fresh.map((pc) => (
              <button key={pc.id} data-nav disabled={!!pairing} onClick={() => void pair(pc)} className="focus-lift btn btn-ghost">
                <MonitorPlay className="size-5" /> {pc.name} <span className="text-ink-3">{pc.host}{pc.sunshine ? "" : " · sin Sunshine"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
