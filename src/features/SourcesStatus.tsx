import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleX, LoaderCircle, PauseCircle, RefreshCw } from "lucide-react";
import { api, inTauri, timeAgo } from "../lib/api";
import type { SourceProbe, SourceStatus } from "../lib/types";

/** YouTube and Steam aren't channel lists; they only appear in the live check. */
const EXTRA = [
  { key: "youtube", name: "YouTube", role: "YouTube TV, búsqueda y «Seguir viendo»" },
  { key: "steam", name: "Tienda de Steam", role: "Portadas y datos de tus juegos" },
];

function stateOf(s: SourceStatus | null, probe?: SourceProbe) {
  if (s && !s.enabled) return { tone: "off" as const, label: "Desactivada" };
  if (probe) return probe.ok ? { tone: "ok" as const, label: "Funciona" } : { tone: "bad" as const, label: "No responde" };
  if (s?.error) return { tone: "warn" as const, label: "Con problemas" };
  return { tone: "unknown" as const, label: s?.updatedAt ? "Al día" : "Sin comprobar" };
}

const TONE = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-danger",
  off: "text-ink-3",
  unknown: "text-ink-2",
};

/**
 * Ajustes → Estado de las fuentes. Real data only: channels and their signal,
 * when each list was last downloaded and its last error; "Comprobar ahora"
 * asks every server live and shows how long it took.
 */
export function SourcesStatus() {
  const [status, setStatus] = useState<SourceStatus[] | null>(null);
  const [probes, setProbes] = useState<Record<string, SourceProbe>>({});
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(() => {
    if (inTauri) api.sourcesStatus().then(setStatus, () => setStatus([]));
  }, []);
  useEffect(load, [load]);

  const check = async () => {
    setChecking(true);
    try {
      const list = await api.sourcesProbe();
      setProbes(Object.fromEntries(list.map((p) => [p.key, p])));
      setCheckedAt(Date.now() / 1000);
      load();
    } finally {
      setChecking(false);
    }
  };

  const rows = [...(status ?? []).map((s) => ({ key: s.key, name: s.name, role: s.role, s })), ...EXTRA.map((e) => ({ ...e, s: null as SourceStatus | null }))];
  const failing = Object.values(probes).filter((p) => !p.ok).length;

  return (
    <>
      <div className="surface flex items-center gap-5 rounded-2xl px-6 py-5">
        <div className="min-w-0 flex-1">
          <p className="text-[1.25rem] font-semibold">
            {checkedAt == null ? "Comprueba si todo funciona" : failing ? `${failing} ${failing === 1 ? "fuente no responde" : "fuentes no responden"}` : "Todas las fuentes responden"}
          </p>
          <p className="mt-1 text-[1rem] text-ink-3">
            {checkedAt == null ? "NOVA pregunta a cada servidor si responde y cuánto tarda. No cambia nada." : `Comprobado ${timeAgo(checkedAt)}.`}
          </p>
        </div>
        <button data-nav data-autofocus disabled={checking || !inTauri} onClick={() => void check()} className="focus-lift btn btn-primary">
          {checking ? <LoaderCircle className="size-5 spin" /> : <RefreshCw className="size-5" />} {checking ? "Comprobando…" : "Comprobar ahora"}
        </button>
      </div>

      {!inTauri && <p className="text-[1rem] text-ink-3">Disponible en la aplicación de escritorio.</p>}

      {rows.map(({ key, name, role, s }) => {
        const probe = probes[key];
        const st = stateOf(s, probe);
        const Icon = st.tone === "ok" ? CircleCheck : st.tone === "bad" || st.tone === "warn" ? CircleX : PauseCircle;
        return (
          <div key={key} className="surface flex items-start gap-5 rounded-2xl px-6 py-5">
            <Icon className={`mt-0.5 size-7 shrink-0 ${TONE[st.tone]}`} strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-3 text-[1.2rem] font-semibold">
                {name}
                <span className={`text-[0.95rem] font-medium ${TONE[st.tone]}`}>{st.label}</span>
                {probe && <span className="text-[0.9rem] font-normal tabular-nums text-ink-3">{probe.ms} ms</span>}
              </p>
              <p className="text-[0.98rem] text-ink-3">{role}</p>
              {s?.enabled && s.channels != null && s.channels > 0 && (
                <p className="mt-2 text-[0.98rem] tabular-nums text-ink-2">
                  {s.channels.toLocaleString("es-ES")} canales · <span className="text-ok">{s.ok.toLocaleString("es-ES")} con señal</span>
                  {s.dead > 0 && <> · <span className="text-danger">{s.dead.toLocaleString("es-ES")} sin señal</span></>}
                  {s.blocked > 0 && <> · <span className="text-warn">{s.blocked.toLocaleString("es-ES")} bloqueados</span></>}
                </p>
              )}
              {s?.updatedAt != null && <p className="mt-1 text-[0.9rem] text-ink-3">Lista descargada {timeAgo(s.updatedAt)}</p>}
              {probe && !probe.ok && <p className="mt-2 text-[0.95rem] text-danger">{probe.detail}</p>}
              {!probe && s?.error && <p className="mt-2 text-[0.95rem] text-warn">{s.error}</p>}
            </div>
          </div>
        );
      })}
    </>
  );
}
