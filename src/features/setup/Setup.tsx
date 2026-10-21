import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { Cable, Check, ChevronRight, Home, Lock, LoaderCircle, MapPin, RadioTower, RefreshCw, ShieldAlert, Smartphone, Wifi, WifiOff } from "lucide-react";
import { TvKeyboard } from "../../components/TvKeyboard";
import { AVATARS, COLORS, profiles } from "../../app/profiles";
import { useBackHandler } from "../../hooks/backStack";
import { api, inTauri } from "../../lib/api";
import { focusFirst } from "../../lib/spatialNav";
import type { NetStatus, Place, Profile, RemoteInfo, WifiNetwork } from "../../lib/types";
import { PREVIEW } from "./preview";

const START_TV_PREF = "nova.startOnTv";

type Step = "welcome" | "internet" | "you" | "place" | "phone" | "start" | "done";
const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Hola" },
  { id: "internet", label: "Internet" },
  { id: "you", label: "Tú" },
  { id: "place", label: "Dónde estás" },
  { id: "phone", label: "Mando del móvil" },
  { id: "start", label: "Cómo empieza" },
  { id: "done", label: "Listo" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Outside Tauri (development): sample data, so every step can be looked at. */
const preview = !inTauri && import.meta.env.DEV;

/**
 * NOVA's first run, TV style: everything with the controller (B goes back),
 * one question per screen. Shown once on a new NOVA; Ajustes can repeat it.
 */
export function Setup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [name, setName] = useState("");
  const index = STEPS.findIndex((s) => s.id === step);
  const go = useCallback((s: Step) => setStep(s), []);
  const next = useCallback(() => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)].id), [index]);

  useBackHandler(() => {
    if (index > 0) setStep(STEPS[index - 1].id);
  });

  // Each screen (and each change inside one: a network chosen, a search done)
  // keeps the focus on a control: one that disappears never strands the remote.
  useEffect(() => {
    const keep = window.setInterval(() => {
      const el = document.getElementById("setup-step");
      if (el && !el.contains(document.activeElement)) focusFirst(el);
    }, 250);
    return () => window.clearInterval(keep);
  }, []);

  const finish = async () => {
    try {
      if (inTauri) await api.setupFinish();
    } catch {
      // Not saved: it will simply show again next time.
    }
    onDone();
  };

  return (
    <motion.div className="fixed inset-0 z-[90] overflow-hidden bg-[#03050c] text-white" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.6 } }}>
      {/* Light orbs, like the boot animation. */}
      <motion.div className="absolute -left-[12vw] -top-[18vh] size-[60vw] rounded-full bg-[#6e6cff] opacity-40 blur-[120px]" animate={{ x: [0, 40, 0], y: [0, 30, 0] }} transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }} />
      <motion.div className="absolute -bottom-[20vh] -right-[10vw] size-[50vw] rounded-full bg-[#3fd5f2] opacity-25 blur-[120px]" animate={{ x: [0, -30, 0], y: [0, -40, 0] }} transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }} />

      <div className="relative grid h-full grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)] gap-[clamp(2rem,5vw,6rem)] px-[clamp(2rem,6vw,7rem)] py-[clamp(2rem,6vh,5rem)]">
        {/* Where we are. */}
        <nav aria-label="Pasos" className="hidden flex-col justify-center lg:flex">
          <Logo className="mb-10 h-12" />
          <ol className="space-y-1">
            {STEPS.map((s, i) => (
              <li key={s.id} className={`flex items-center gap-4 rounded-xl px-3 py-2.5 text-[1.15rem] transition-colors ${i === index ? "bg-white/8 font-semibold" : i < index ? "text-ink-2" : "text-ink-3"}`}>
                <span className={`grid size-8 shrink-0 place-items-center rounded-full text-[0.95rem] ${i < index ? "bg-[#3ddc97]/20 text-[#3ddc97]" : i === index ? "bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)] text-[#050713]" : "bg-white/8"}`}>
                  {i < index ? <Check className="size-4" /> : i + 1}
                </span>
                {s.label}
              </li>
            ))}
          </ol>
        </nav>

        <div className="flex min-h-0 items-center">
          <AnimatePresence mode="wait">
            <motion.section
              key={step}
              id="setup-step"
              className="w-full max-w-[56rem]"
              initial={{ opacity: 0, x: 60 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -60 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              {step === "welcome" && <Welcome onNext={next} />}
              {step === "internet" && <Internet onNext={next} />}
              {step === "you" && <You onNext={(n) => (setName(n), next())} />}
              {step === "place" && <PlaceStep onNext={next} />}
              {step === "phone" && <Phone onNext={next} />}
              {step === "start" && <Start onNext={next} />}
              {step === "done" && <Done name={name} onFinish={() => void finish()} onBack={() => go("start")} />}
            </motion.section>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

// ───────────────────────── Pieces ─────────────────────────

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 176 40" className={className} aria-label="NOVA">
      <defs>
        <linearGradient id="setup-w" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#6e6cff" />
          <stop offset="1" stopColor="#3fd5f2" />
        </linearGradient>
      </defs>
      <g fill="none" strokeWidth="4.6" strokeLinecap="square">
        <path d="M3 37V3l28 34V3" stroke="#f4f6ff" />
        <circle cx="66" cy="20" r="17" stroke="#f4f6ff" />
        <path d="M96 3l17 34 17-34" stroke="#f4f6ff" />
        <path d="M140 37l17-34 17 34" stroke="url(#setup-w)" />
      </g>
    </svg>
  );
}

function Title({ eyebrow, children, sub }: { eyebrow: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="mb-8">
      <p className="eyebrow text-cyan">{eyebrow}</p>
      <h1 className="mt-2 text-[clamp(2.4rem,4vw,3.6rem)] font-bold leading-[1.05] tracking-tight">{children}</h1>
      {sub && <p className="mt-3 max-w-[44rem] text-[1.25rem] leading-relaxed text-ink-2">{sub}</p>}
    </header>
  );
}

function Primary({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button data-nav data-autofocus disabled={disabled} onClick={onClick} className="focus-lift btn btn-primary px-8 text-[1.2rem]">
      {children} <ChevronRight className="size-5" />
    </button>
  );
}

function Ghost({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button data-nav onClick={onClick} className="focus-lift btn btn-ghost text-[1.1rem]">
      {children}
    </button>
  );
}

// ───────────────────────── 1. Hola ─────────────────────────

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <motion.svg viewBox="0 0 100 92" className="mb-10 h-28 w-[7.6rem] overflow-visible drop-shadow-[0_0_30px_rgb(63_213_242/0.6)]" aria-hidden>
        <defs>
          <linearGradient id="setup-m" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#6e6cff" />
            <stop offset="1" stopColor="#3fd5f2" />
          </linearGradient>
        </defs>
        <motion.path
          d="M8 86 L50 6 L92 86"
          fill="none"
          stroke="url(#setup-m)"
          strokeWidth="12"
          strokeLinecap="square"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
        />
      </motion.svg>
      <Title eyebrow="Bienvenido" sub="Vamos a dejar esta tele lista en un minuto: internet, quién eres, dónde estás y cómo quieres que empiece. Todo se puede cambiar después en Ajustes.">
        Hola. Soy NOVA.
      </Title>
      <Primary onClick={onNext}>Empezar</Primary>
      <p className="mt-8 text-[1.05rem] text-ink-3">Usa el mando, un teclado o el ratón. Con el mando, B vuelve atrás.</p>
    </div>
  );
}

// ───────────────────────── 2. Internet ─────────────────────────

function Bars({ signal }: { signal: number }) {
  return (
    <span className="flex h-5 items-end gap-[3px]" aria-label={`Señal ${signal}%`}>
      {[25, 50, 75, 100].map((t, i) => (
        <span key={t} className={`w-[5px] rounded-sm ${signal >= t - 12 ? "bg-white" : "bg-white/20"}`} style={{ height: `${(i + 1) * 25}%` }} />
      ))}
    </span>
  );
}

function Internet({ onNext }: { onNext: () => void }) {
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [chosen, setChosen] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setStatus(null);
    const s = preview ? PREVIEW.net : await api.netStatus();
    setStatus(s);
    return s;
  }, []);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setNetworks(preview ? PREVIEW.networks : await api.wifiNetworks());
    } catch (e) {
      setError(message(e));
      setNetworks([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void check().then((s) => {
      if (!s.internet && s.wifi) void scan();
    });
  }, [check, scan]);

  const connect = async (network: WifiNetwork, pass?: string) => {
    setConnecting(true);
    setError(null);
    try {
      if (preview) {
        // Sample: connected, on a "public" network (to see that warning too).
        setStatus({ internet: true, kind: "wifi", ssid: network.ssid, network: network.ssid, private: false, wifi: true });
      } else {
        await api.wifiConnect(network.ssid, pass);
      }
      // Only once it worked: a wrong password keeps the keyboard and its message.
      setChosen(null);
      setPassword("");
      if (!preview) await check();
    } catch (e) {
      setError(message(e));
    } finally {
      setConnecting(false);
    }
  };

  const pick = (n: WifiNetwork) => {
    if (n.secured && !n.saved && !n.connected) {
      setChosen(n);
      setPassword("");
      setError(null);
    } else void connect(n);
  };

  // Typing the password.
  if (chosen) {
    return (
      <div>
        <Title eyebrow="Internet" sub={connecting ? undefined : "Escribe la contraseña de la Wi-Fi."}>
          {chosen.ssid}
        </Title>
        {connecting ? (
          <p className="flex items-center gap-3 text-[1.4rem]">
            <LoaderCircle className="size-7 spin text-cyan" /> Conectando…
          </p>
        ) : (
          <>
            <TvKeyboard label="Contraseña" secret value={password} onChange={setPassword} onDone={() => void connect(chosen, password)} doneLabel="Conectar" canFinish={password.length >= 8} />
            {error && <p className="mt-4 text-[1.1rem] text-[#ff8fa8]">{error}</p>}
            <div className="mt-5">
              <Ghost onClick={() => setChosen(null)}>Elegir otra red</Ghost>
            </div>
          </>
        )}
      </div>
    );
  }

  if (!status) {
    return (
      <div>
        <Title eyebrow="Internet">Comprobando la conexión…</Title>
        <LoaderCircle className="size-10 spin text-cyan" />
      </div>
    );
  }

  if (status.internet) {
    return (
      <div>
        <Title eyebrow="Internet" sub={status.kind === "wifi" ? `Conectada a la Wi-Fi «${status.ssid}».` : "Conectada por cable."}>
          Ya tienes internet
        </Title>
        <div className="mb-8 flex items-center gap-4 rounded-2xl bg-[#3ddc97]/12 px-6 py-5 text-[1.2rem] text-[#9ff5cb]">
          {status.kind === "wifi" ? <Wifi className="size-7" /> : <Cable className="size-7" />} {status.network ?? status.ssid ?? "Red de casa"}
          <Check className="ml-auto size-7" />
        </div>
        {status.private === false && (
          <div className="mb-8 flex items-start gap-4 rounded-2xl bg-[#ffb547]/12 px-6 py-5">
            <ShieldAlert className="mt-1 size-7 shrink-0 text-[#ffb547]" />
            <div>
              <p className="text-[1.2rem] font-semibold text-[#ffd894]">Windows tiene esta red como «Pública»</p>
              <p className="mt-1 text-[1.05rem] text-ink-2">
                Así, el mando del móvil y los juegos desde tu PC no podrán encontrar esta tele. En la configuración de red de Windows, ponla como «Privada» (solo hace falta una vez).
              </p>
              <div className="mt-4">
                <Ghost onClick={() => void api.openSettings("network").catch(() => {})}>Abrir la configuración de red</Ghost>
              </div>
            </div>
          </div>
        )}
        <Primary onClick={onNext}>Continuar</Primary>
      </div>
    );
  }

  return (
    <div>
      <Title eyebrow="Internet" sub={status.wifi ? "Elige tu Wi-Fi. Si tienes cable de red, conéctalo: se verá solo." : "Este equipo no tiene Wi-Fi: conéctalo con un cable de red."}>
        Conéctate a internet
      </Title>
      {status.wifi && (
        <div className="mb-6 grid max-h-[46vh] gap-2 overflow-y-auto pr-2">
          {scanning && !networks && (
            <p className="flex items-center gap-3 text-[1.2rem] text-ink-2">
              <LoaderCircle className="size-6 spin text-cyan" /> Buscando redes…
            </p>
          )}
          {networks?.map((n) => (
            <button key={n.ssid} data-nav onClick={() => pick(n)} disabled={connecting} className="focus-lift flex items-center gap-4 rounded-2xl bg-white/6 px-6 py-4 text-left text-[1.25rem]">
              <Bars signal={n.signal} />
              <span className="min-w-0 flex-1 truncate font-semibold">{n.ssid}</span>
              {n.saved && <span className="badge bg-white/10 text-ink-2">Guardada</span>}
              {n.secured && <Lock className="size-5 text-ink-3" />}
            </button>
          ))}
          {networks?.length === 0 && !scanning && <p className="text-[1.1rem] text-ink-3">No se ve ninguna red.</p>}
        </div>
      )}
      {connecting && (
        <p className="mb-5 flex items-center gap-3 text-[1.2rem]">
          <LoaderCircle className="size-6 spin text-cyan" /> Conectando…
        </p>
      )}
      {error && <p className="mb-5 text-[1.1rem] text-[#ff8fa8]">{error}</p>}
      <div className="flex flex-wrap gap-3">
        {status.wifi ? (
          <Ghost onClick={() => void scan()}>
            <RefreshCw className="size-5" /> Buscar otra vez
          </Ghost>
        ) : (
          <Ghost onClick={() => void check()}>
            <RefreshCw className="size-5" /> Comprobar otra vez
          </Ghost>
        )}
        <Ghost onClick={onNext}>
          <WifiOff className="size-5" /> Seguir sin internet
        </Ghost>
      </div>
    </div>
  );
}

// ───────────────────────── 3. Tú ─────────────────────────

function You({ onNext }: { onNext: (name: string) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [part, setPart] = useState<"name" | "look">("name");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = preview ? Promise.resolve(PREVIEW.profiles) : api.profilesGet();
    void load.then((info) => {
      const p = info.profiles.find((x) => x.id === info.active) ?? info.profiles[0] ?? null;
      setProfile(p);
      if (p) {
        // "Principal" is NOVA's placeholder: start empty so the person writes theirs.
        setName(p.name === "Principal" ? "" : p.name);
        setAvatar(p.avatar);
        setColor(p.color);
      }
    });
  }, []);

  const save = async () => {
    setError(null);
    try {
      if (!preview && profile) {
        await profiles.save({ id: profile.id, name: name.trim(), avatar, color, kids: false, allowed: profile.allowed, allowWorld: profile.allowWorld });
      }
      onNext(name.trim());
    } catch (e) {
      setError(message(e));
    }
  };

  if (part === "name") {
    return (
      <div>
        <Title eyebrow="Tú" sub="Es el nombre de tu perfil: tus canales favoritos, tu historial y tus juegos. Luego podrás añadir más personas, también perfiles infantiles.">
          ¿Cómo te llamas?
        </Title>
        <TvKeyboard label="Tu nombre" placeholder="Escribe tu nombre" value={name} maxLength={24} onChange={setName} onDone={() => setPart("look")} doneLabel="Siguiente" canFinish={name.trim().length > 0} />
      </div>
    );
  }

  return (
    <div>
      <Title eyebrow="Tú" sub="Elige cómo te verás al cambiar de perfil.">
        Hola, {name.trim()}
      </Title>
      <div className="flex items-start gap-10">
        <motion.div
          key={`${avatar}${color}`}
          initial={{ scale: 0.85, opacity: 0.6 }}
          animate={{ scale: 1, opacity: 1 }}
          className="grid size-[9rem] shrink-0 place-items-center rounded-[2rem] text-[4.5rem] shadow-[0_1.5rem_4rem_-1rem_rgb(0_0_0/0.8)]"
          style={{ background: color }}
        >
          {avatar}
        </motion.div>
        <div className="min-w-0">
          <div className="grid grid-cols-9 gap-2">
            {AVATARS.map((a) => (
              <button key={a} data-nav onClick={() => setAvatar(a)} aria-pressed={a === avatar} className={`focus-key grid size-[3.6rem] place-items-center rounded-xl text-[2rem] ${a === avatar ? "bg-white/20" : "bg-white/6"}`}>
                {a}
              </button>
            ))}
          </div>
          <div className="mt-4 flex gap-3">
            {COLORS.map((c) => (
              <button key={c} data-nav onClick={() => setColor(c)} aria-label={`Color ${c}`} aria-pressed={c === color} className={`focus-ring size-[3rem] rounded-full ${c === color ? "ring-4 ring-white" : ""}`} style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
      {error && <p className="mt-5 text-[1.1rem] text-[#ff8fa8]">{error}</p>}
      <div className="mt-8 flex gap-3">
        <Primary onClick={() => void save()}>Continuar</Primary>
        <Ghost onClick={() => setPart("name")}>Cambiar el nombre</Ghost>
      </div>
    </div>
  );
}

// ───────────────────────── 4. Dónde estás ─────────────────────────

function PlaceStep({ onNext }: { onNext: () => void }) {
  const [place, setPlace] = useState<Place | null | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (preview) return setPlace(PREVIEW.place);
    void api
      .locationGet()
      .then((info) => info.place ?? api.locationDetect())
      .then(setPlace, () => setPlace(null));
  }, []);

  const where = (p: Place) => [p.city, p.region, p.country].filter(Boolean).join(", ");

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setResults(preview ? [PREVIEW.place] : await api.locationSearch(query));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (p: Place) => {
    try {
      if (!preview) await api.locationSet(p);
      onNext();
    } catch (e) {
      setError(message(e));
    }
  };

  if (searching) {
    return (
      <div>
        <Title eyebrow="Dónde estás">{results ? "¿Cuál es?" : "Escribe tu ciudad"}</Title>
        {results ? (
          <div className="grid gap-2">
            {results.length === 0 && <p className="text-[1.15rem] text-ink-3">No se ha encontrado ninguna ciudad con ese nombre.</p>}
            {results.map((r) => (
              <button key={`${r.latitude},${r.longitude}`} data-nav onClick={() => void choose(r)} className="focus-lift flex items-center gap-4 rounded-2xl bg-white/6 px-6 py-4 text-left text-[1.25rem]">
                <MapPin className="size-6 text-cyan" /> {where(r)}
              </button>
            ))}
            <div className="mt-4">
              <Ghost onClick={() => setResults(null)}>Buscar otra</Ghost>
            </div>
          </div>
        ) : (
          <TvKeyboard label="Ciudad" placeholder="Por ejemplo, Sevilla" value={query} maxLength={60} onChange={setQuery} onDone={() => void search()} doneLabel={busy ? "Buscando…" : "Buscar"} canFinish={query.trim().length >= 2 && !busy} />
        )}
        {error && <p className="mt-4 text-[1.1rem] text-[#ff8fa8]">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <Title eyebrow="Dónde estás" sub="Para el tiempo, los canales de tu zona y que los plugins se configuren solos. NOVA nunca usa GPS: lo saca de tu conexión.">
        {place === undefined ? "Buscando dónde estás…" : place ? `¿Estás en ${place.city}?` : "¿Dónde estás?"}
      </Title>
      {place === undefined ? (
        <LoaderCircle className="size-10 spin text-cyan" />
      ) : (
        <div className="flex flex-wrap gap-3">
          {place && <Primary onClick={() => void choose(place)}>Sí, {where(place)}</Primary>}
          <Ghost onClick={() => setSearching(true)}>
            <MapPin className="size-5" /> {place ? "No, elegir otra" : "Elegir mi ciudad"}
          </Ghost>
          <Ghost onClick={onNext}>Saltar</Ghost>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 5. Mando del móvil ─────────────────────────

function Phone({ onNext }: { onNext: () => void }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  useEffect(() => {
    if (preview) return setInfo(PREVIEW.remote);
    const load = () => api.remoteInfo().then(setInfo, () => {});
    void load();
    // Pairing stays open while the code is on screen (each call opens it for a while).
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div>
      <Title eyebrow="Mando del móvil" sub="Tu teléfono como mando y teclado: escanea el código con la cámara, sin instalar nada. Conecta el móvil a la misma Wi-Fi.">
        Usa tu móvil como mando
      </Title>
      <div className="flex items-center gap-10">
        <div className="grid size-[15rem] shrink-0 place-items-center overflow-hidden rounded-2xl bg-white p-3">
          {info?.running && info.qrSvg ? <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: info.qrSvg }} /> : <Smartphone className="size-14 text-[#7c84ab]" />}
        </div>
        <div className="min-w-0">
          {info?.running ? (
            <>
              <p className="eyebrow">O abre en el móvil</p>
              <p className="mt-1 truncate font-mono text-[1.5rem] font-semibold">{info.urls[0] ?? "Sin red local"}</p>
              <p className="eyebrow mt-5">PIN</p>
              <p className="mt-1 font-mono text-[2rem] font-semibold tracking-[0.3em]">{info.pin}</p>
            </>
          ) : (
            <p className="text-[1.15rem] text-ink-3">{info?.error ?? "El mando del móvil está apagado: puedes activarlo en Ajustes → Mando del móvil."}</p>
          )}
        </div>
      </div>
      <div className="mt-8 flex gap-3">
        <Primary onClick={onNext}>{info?.devices.length ? "Ya está" : "Continuar"}</Primary>
        <Ghost onClick={onNext}>Ahora no</Ghost>
      </div>
    </div>
  );
}

// ───────────────────────── 6. Cómo empieza ─────────────────────────

function Start({ onNext }: { onNext: () => void }) {
  const [tv, setTv] = useState(() => {
    try {
      return localStorage.getItem(START_TV_PREF) !== "off";
    } catch {
      return true;
    }
  });
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    if (preview) return setAutostart(false);
    autostartEnabled().then(setAutostart, () => setAutostart(null));
  }, []);

  const chooseTv = (on: boolean) => {
    setTv(on);
    try {
      localStorage.setItem(START_TV_PREF, on ? "on" : "off");
    } catch {}
  };
  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      if (!preview) await (next ? enableAutostart() : disableAutostart());
      setAutostart(next);
    } catch {}
  };

  const choice = (on: boolean, icon: ReactNode, title: string, text: string) => (
    <button data-nav aria-pressed={tv === on} onClick={() => chooseTv(on)} className={`focus-lift flex min-h-[11rem] flex-col items-start rounded-[1.6rem] p-6 text-left ${tv === on ? "bg-[linear-gradient(135deg,rgb(124_122_255/0.35),rgb(63_213_242/0.18))] ring-2 ring-white/40" : "bg-white/6"}`}>
      {icon}
      <span className="mt-4 text-[1.35rem] font-semibold">{title}</span>
      <span className="mt-1 text-[1.02rem] text-ink-2">{text}</span>
    </button>
  );

  return (
    <div>
      <Title eyebrow="Cómo empieza" sub="Al encenderla, ¿qué quieres ver primero?">
        Tu forma de empezar
      </Title>
      <div className="grid max-w-[46rem] grid-cols-2 gap-4">
        {choice(true, <RadioTower className="size-9 text-[#ff6b9a]" />, "La tele", "En el último canal que viste, como una tele de siempre.")}
        {choice(false, <Home className="size-9 text-cyan" />, "Inicio", "Tus apps, juegos y lo que estabas viendo.")}
      </div>
      {autostart !== null && (
        <button data-nav role="switch" aria-checked={autostart} onClick={() => void toggleAutostart()} className="focus-lift mt-6 flex w-full max-w-[46rem] items-center gap-5 rounded-2xl bg-white/6 px-6 py-5 text-left">
          <span className="min-w-0 flex-1">
            <span className="block text-[1.2rem] font-semibold">Abrir NOVA al encender el equipo</span>
            <span className="block text-[1rem] text-ink-3">Para que funcione como una tele: enciendes y está aquí.</span>
          </span>
          <span className={`relative h-[2.2rem] w-[4rem] shrink-0 rounded-full transition-colors ${autostart ? "bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)]" : "bg-white/15"}`}>
            <motion.span className="absolute top-[0.3rem] size-[1.6rem] rounded-full bg-white" animate={{ left: autostart ? "2.1rem" : "0.3rem" }} transition={{ type: "spring", stiffness: 500, damping: 32 }} />
          </span>
        </button>
      )}
      <div className="mt-8">
        <Primary onClick={onNext}>Continuar</Primary>
      </div>
    </div>
  );
}

// ───────────────────────── 7. Listo ─────────────────────────

function Done({ name, onFinish, onBack }: { name: string; onFinish: () => void; onBack: () => void }) {
  return (
    <div>
      <motion.div
        className="mb-8 grid size-24 place-items-center rounded-full bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)] text-[#050713] shadow-[0_0_4rem_rgb(63_213_242/0.6)]"
        initial={{ scale: 0, rotate: -40 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 14 }}
      >
        <Check className="size-12" strokeWidth={3} />
      </motion.div>
      <Title eyebrow="Listo" sub="Todo lo que has elegido está en Ajustes, por si quieres cambiarlo. Pulsa el botón Guía del mando en cualquier momento para volver al Inicio.">
        {name ? `¡Todo listo, ${name}!` : "¡Todo listo!"}
      </Title>
      <div className="flex gap-3">
        <Primary onClick={onFinish}>Empezar a usar NOVA</Primary>
        <Ghost onClick={onBack}>Atrás</Ghost>
      </div>
    </div>
  );
}
