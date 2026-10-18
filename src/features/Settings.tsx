import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { Activity, ArrowDownToLine, Info, Puzzle, LoaderCircle, Monitor, Palette, Power, RadioTower, RefreshCw, Shield, Smartphone, Users, type LucideProps } from "lucide-react";
import { SourcesStatus } from "./SourcesStatus";
import { UpdatesSettings } from "./Updates";
import { PluginsSettings } from "./PluginsSettings";
import { SCREENSAVER_CHOICES, screensaverMinutes, setScreensaverMinutes } from "../app/power";
import { isUnlocked, useActiveProfile, useProfiles } from "../app/profiles";
import { KidsLock, ProfilesSettings, UnlockedBanner } from "./ProfilesSettings";
import { ambient, useAmbient, useClearAmbient } from "../app/ambient";
import { BOOT_SOUND_PREF, bootSoundOn, createBootSound } from "../app/bootSound";
import { useNova } from "../app/context";
import { useToast } from "../components/Toasts";
import { api, inTauri } from "../lib/api";
import { sfx } from "./gaming/sfx";
import { trailerPref } from "./gaming/prefs";
import { liveTv, useLiveTv } from "./livetv/store";
import { RemoteCard } from "./RemoteCard";
import { SystemPanel } from "./System";

export const FULLSCREEN_PREF = "nova.fullscreenOnStart";
/** "on" = NOVA starts on live TV (default), "off" = on Home. */
export const START_TV_PREF = "nova.startOnTv";

export function startsOnTv() {
  return readPref(START_TV_PREF, true);
}

type SectionId = "profiles" | "appearance" | "startup" | "remote" | "tv" | "sources" | "privacy" | "system" | "plugins" | "updates" | "about";

const SECTIONS: { id: SectionId; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: "profiles", label: "Perfiles y control parental", icon: Users },
  { id: "appearance", label: "Apariencia", icon: Palette },
  { id: "startup", label: "Inicio y energía", icon: Power },
  { id: "remote", label: "Mando del móvil", icon: Smartphone },
  { id: "tv", label: "TV en directo", icon: RadioTower },
  { id: "sources", label: "Estado de las fuentes", icon: Activity },
  { id: "privacy", label: "Privacidad y datos", icon: Shield },
  { id: "system", label: "Este equipo", icon: Monitor },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "updates", label: "Actualizaciones", icon: ArrowDownToLine },
  { id: "about", label: "Acerca de NOVA", icon: Info },
];

function readPref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v ? v === "on" : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {}
}

function Toggle({ title, description, value, onChange, busy }: { title: string; description: string; value: boolean; onChange: () => void; busy?: boolean }) {
  return (
    <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
      <div className="min-w-0 flex-1">
        <p className="text-[1.25rem] font-semibold">{title}</p>
        <p className="mt-1 text-[1rem] leading-relaxed text-ink-3">{description}</p>
      </div>
      <button
        data-nav
        role="switch"
        aria-checked={value}
        aria-label={title}
        disabled={busy}
        onClick={onChange}
        className={`focus-ring relative h-[2.4rem] w-[4.4rem] shrink-0 rounded-full transition-colors ${value ? "bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)]" : "bg-white/15"}`}
      >
        <motion.span className="absolute top-[0.3rem] size-[1.8rem] rounded-full bg-white shadow" animate={{ left: value ? "2.3rem" : "0.3rem" }} transition={{ type: "spring", stiffness: 500, damping: 32 }} />
      </button>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <motion.div key={title} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
      <h2 className="text-[2.2rem] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-[1.1rem] text-ink-2">{description}</p>}
      <div className="mt-6 space-y-3">{children}</div>
    </motion.div>
  );
}

function Appearance() {
  const { enabled } = useAmbient();
  const [sounds, setSounds] = useState(sfx.enabled);
  const [trailers, setTrailers] = useState(trailerPref.get());
  return (
    <Section title="Apariencia" description="Cómo se ve y se oye NOVA.">
      <Toggle
        title="Color ambiente"
        description="El fondo de NOVA adopta la imagen y los colores de lo que tienes enfocado: un vídeo, un juego, el programa en directo."
        value={enabled}
        onChange={() => ambient.setEnabled(!enabled)}
      />
      <Toggle
        title="Tráileres de fondo"
        description="En NOVA PLAY, el juego enfocado reproduce su tráiler en silencio tras un momento."
        value={trailers}
        onChange={() => {
          trailerPref.set(!trailers);
          setTrailers(!trailers);
        }}
      />
      <Toggle
        title="Sonidos de la interfaz"
        description="Sonidos de consola al moverte y seleccionar en NOVA PLAY."
        value={sounds}
        onChange={() => {
          sfx.setEnabled(!sounds);
          setSounds(!sounds);
        }}
      />
    </Section>
  );
}

function Startup() {
  const toast = useToast();
  const [auto, setAuto] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(readPref(FULLSCREEN_PREF, false));
  const [startTv, setStartTv] = useState(startsOnTv());
  const [bootSound, setBootSound] = useState(bootSoundOn());
  const [saver, setSaver] = useState(screensaverMinutes());

  useEffect(() => {
    if (!inTauri) return;
    autostartEnabled().then(setAuto, () => setAuto(false));
  }, []);

  const toggleAuto = async () => {
    setBusy(true);
    try {
      if (auto) await disableAutostart();
      else await enableAutostart();
      const now = await autostartEnabled();
      setAuto(now);
      toast.show("success", now ? "NOVA arrancará con Windows" : "NOVA ya no arrancará con Windows");
    } catch (e) {
      toast.show("error", "No se pudo cambiar el arranque", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Inicio y energía" description="Cómo se abre NOVA y cuándo descansa. Apagar, reiniciar y suspender: botón de encendido de la barra superior.">
      <Toggle
        title="Encender en TV en directo"
        description="Como una tele de verdad: tras la animación de inicio, NOVA abre tu último canal. Pulsa Inicio para ir a «Para ti». Si lo desactivas, NOVA arranca en «Para ti»."
        value={startTv}
        onChange={() => {
          writePref(START_TV_PREF, !startTv);
          setStartTv(!startTv);
        }}
      />
      <Toggle
        title="Sonido de inicio"
        description="La firma sonora de NOVA al encenderse, sintetizada en directo y sincronizada con la animación. Al activarlo la oirás ahora."
        value={bootSound}
        onChange={() => {
          writePref(BOOT_SOUND_PREF, !bootSound);
          setBootSound(!bootSound);
          if (!bootSound)
            void createBootSound().then((s) => {
              s?.play();
              s?.dispose();
            });
        }}
      />
      <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
        <div className="min-w-0 flex-1">
          <p className="text-[1.25rem] font-semibold">Salvapantallas</p>
          <p className="mt-1 text-[1rem] leading-relaxed text-ink-3">
            Tras un rato sin tocar nada en los menús de NOVA (nunca mientras ves la TV o juegas). También desde el botón de encendido → Suspender.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {SCREENSAVER_CHOICES.map((m) => (
            <button
              key={m}
              data-nav
              aria-pressed={saver === m}
              onClick={() => {
                setScreensaverMinutes(m);
                setSaver(m);
              }}
              className={`focus-ring h-[2.6rem] rounded-full px-4 text-[1rem] font-semibold ${saver === m ? "bg-white text-black" : "bg-white/8 text-ink-2 focus:bg-white/16 focus:text-ink-1"}`}
            >
              {m === 0 ? "No" : `${m} min`}
            </button>
          ))}
        </div>
      </div>
      <Toggle
        title="Arrancar con Windows"
        description="Abre NOVA automáticamente al iniciar sesión, como una tele que se enciende. Desactivado por defecto; puedes quitarlo cuando quieras."
        value={!!auto}
        busy={busy || auto === null}
        onChange={toggleAuto}
      />
      <Toggle
        title="Abrir a pantalla completa"
        description="Al abrir NOVA, ocupa toda la pantalla sin bordes de ventana (F11 para alternar)."
        value={fullscreen}
        onChange={() => {
          writePref(FULLSCREEN_PREF, !fullscreen);
          setFullscreen(!fullscreen);
        }}
      />
    </Section>
  );
}

function TvSettings() {
  const { data, progress, hideUnavailable } = useLiveTv();
  const toast = useToast();
  useEffect(() => void liveTv.load(), []);
  const total = data?.channels.length ?? 0;
  const checked = progress ? progress.ok + progress.dead + progress.blocked : 0;
  return (
    <Section title="TV en directo" description="Canales, fuentes y comprobación de señal.">
      <div className="surface grid grid-cols-4 gap-3 rounded-2xl p-5">
        {[
          [total, "Canales", "text-ink-1"],
          [progress?.ok ?? 0, "Con señal", "text-ok"],
          [progress?.dead ?? 0, "Sin señal", "text-danger"],
          [progress?.blocked ?? 0, "Bloqueados", "text-warn"],
        ].map(([v, label, tone]) => (
          <div key={label as string}>
            <p className={`text-[2rem] font-semibold tabular-nums ${tone}`}>{(v as number).toLocaleString("es-ES")}</p>
            <p className="text-[0.95rem] text-ink-3">{label}</p>
          </div>
        ))}
        {progress?.running ? (
          <p className="col-span-4 flex items-center gap-3 text-[1rem] text-ink-2">
            <LoaderCircle className="size-5 spin" /> Comprobando {progress.done.toLocaleString("es-ES")} de {progress.total.toLocaleString("es-ES")}…
          </p>
        ) : (
          <p className="col-span-4 text-[0.95rem] text-ink-3">{(total - checked > 0 ? total - checked : 0).toLocaleString("es-ES")} sin comprobar todavía.</p>
        )}
      </div>
      <Toggle
        title="Ocultar canales sin señal"
        description="Los canales caídos o bloqueados (VPN, región) no aparecen en la lista ni al hacer zapping."
        value={hideUnavailable}
        onChange={() => liveTv.setHideUnavailable(!hideUnavailable)}
      />
      <Toggle
        title="Catálogo mundial (iptv-org)"
        description="Miles de canales públicos y gratuitos de todo el mundo, por país y temática."
        value={!!data?.worldEnabled}
        onChange={async () => {
          await api.livetvSetWorld(!data?.worldEnabled);
          await liveTv.load(true);
        }}
      />
      <Toggle
        title="Pluto TV"
        description={data?.fastError ?? "Canales gratis y legales con anuncios: Bob Esponja, Dragon Ball, MTV, cine, series… con guía. Del 3001 en adelante."}
        value={!!data?.fastEnabled}
        onChange={async () => {
          await api.livetvSetFast(!data?.fastEnabled);
          await liveTv.load(true);
        }}
      />
      <Toggle
        title="Twitch en directo"
        description={data?.twitchError ?? "Directos en español aptos para todos (sin etiquetas de contenido adulto), como canales del 4001 en adelante, con el reproductor oficial de Twitch."}
        value={!!data?.twitchEnabled}
        onChange={async () => {
          await api.livetvSetTwitch(!data?.twitchEnabled);
          await liveTv.load(true);
        }}
      />
      <div className="flex gap-3 pt-2">
        <button
          data-nav
          disabled={progress?.running}
          onClick={() => liveTv.checkNow().then(() => toast.show("info", "Comprobando todos los canales"))}
          className="focus-lift btn btn-ghost"
        >
          <RefreshCw className="size-5" /> Comprobar ahora
        </button>
        <button data-nav onClick={() => void liveTv.open()} className="focus-lift btn btn-primary">
          <RadioTower className="size-5" /> Encender la TV
        </button>
      </div>
      <p className="text-[0.95rem] text-ink-3">Tus listas M3U se gestionan desde la propia TV: tecla M o botón View → Menú de TV.</p>
    </Section>
  );
}

function Privacy() {
  const nova = useNova();
  const toast = useToast();
  return (
    <Section title="Privacidad y datos" description="Todo lo que NOVA recuerda se guarda solo en este PC. No hay cuentas ni servidores de NOVA.">
      <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
        <div className="flex-1">
          <p className="text-[1.25rem] font-semibold">Historial de YouTube</p>
          <p className="text-[1rem] text-ink-3">{nova.history.length} vídeos en «Seguir viendo» y «Visto recientemente».</p>
        </div>
        <button data-nav disabled={!nova.history.length} onClick={() => nova.openDialog({ type: "confirm-clear-history" })} className="focus-lift btn btn-danger">
          Borrar
        </button>
      </div>
      <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
        <div className="flex-1">
          <p className="text-[1.25rem] font-semibold">Multimedia reciente</p>
          <p className="text-[1rem] text-ink-3">{nova.recentMedia.length} archivos abiertos recientemente.</p>
        </div>
        <button
          data-nav
          disabled={!nova.recentMedia.length}
          onClick={() => {
            nova.recentMedia.forEach((m) => nova.forgetMedia(m.path));
            toast.show("success", "Multimedia reciente olvidada");
          }}
          className="focus-lift btn btn-danger"
        >
          Olvidar
        </button>
      </div>
      <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
        <div className="flex-1">
          <p className="text-[1.25rem] font-semibold">Búsquedas recientes</p>
          <p className="text-[1rem] text-ink-3">Las sugerencias que aparecen al abrir la búsqueda.</p>
        </div>
        <button
          data-nav
          onClick={() => {
            try {
              localStorage.removeItem("nova.searches");
            } catch {}
            toast.show("success", "Búsquedas recientes borradas");
          }}
          className="focus-lift btn btn-danger"
        >
          Borrar
        </button>
      </div>
    </Section>
  );
}

function About() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    api.systemInfo().then((i) => setVersion(i.appVersion), () => {});
  }, []);
  const sources = [
    ["TV en directo", "TDTChannels (emisiones oficiales de España) e iptv-org (canales públicos del mundo)"],
    ["Juegos", "Tienda pública de Steam y catálogo de Microsoft Store"],
    ["YouTube", "Interfaz de TV de YouTube, datos públicos (oEmbed, RSS, búsqueda)"],
    ["Streaming", "Cada servicio en su app oficial o en Microsoft Edge"],
  ];
  return (
    <Section title="Acerca de NOVA" description="Tu PC, como una Smart TV.">
      <div className="surface rounded-2xl px-6 py-5">
        <p className="text-[1.6rem] font-semibold">NOVA TV {version ? `v${version}` : ""}</p>
        <p className="mt-1 text-[1rem] text-ink-3">Tauri 2 · Rust · React. Sin cuentas, sin anuncios, sin servidores propios.</p>
      </div>
      <div className="surface rounded-2xl px-6 py-3">
        {sources.map(([k, v]) => (
          <div key={k} className="flex gap-6 border-b border-line py-3 last:border-0">
            <span className="w-40 shrink-0 text-[1rem] font-semibold">{k}</span>
            <span className="text-[1rem] text-ink-2">{v}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** NOVA's own settings, TV-style: sections on the left, content on the right. */
export function SettingsScreen() {
  const [section, setSection] = useState<SectionId>("profiles");
  useClearAmbient();
  const info = useProfiles();
  const profile = useActiveProfile();
  // Children's profile: settings stay locked until a parent enters the PIN.
  if (profile?.kids && !isUnlocked(info)) return <KidsLock />;
  return (
    <div className="grid h-full grid-cols-[22rem_minmax(0,1fr)] gap-10 px-[var(--gutter)] pb-8 pt-2">
      <nav aria-label="Ajustes">
        <p className="eyebrow mb-2 px-4 text-cyan">NOVA</p>
        <h1 className="mb-6 px-4 text-[2.6rem] font-semibold tracking-tight">Ajustes</h1>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            data-nav
            data-autofocus={id === "profiles" || undefined}
            onFocus={() => setSection(id)}
            onClick={() => setSection(id)}
            className={`focus-ring mb-1 flex w-full items-center gap-4 rounded-2xl px-4 py-3.5 text-left text-[1.2rem] ${
              id === section ? "bg-white/12 font-semibold text-ink-1" : "text-ink-2"
            }`}
          >
            <Icon className="size-6 shrink-0" strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </nav>
      <div className="page-scroll min-h-0 overflow-y-auto pb-10 pr-2 pt-4">
        <UnlockedBanner />
        <AnimatePresence mode="wait">
          {section === "profiles" && (
            <Section key="pr" title="Perfiles y control parental" description="Cada persona con sus canales favoritos y su historial. Los perfiles infantiles, con límites que NOVA hace cumplir.">
              <ProfilesSettings />
            </Section>
          )}
          {section === "appearance" && <Appearance key="a" />}
          {section === "startup" && <Startup key="s" />}
          {section === "remote" && (
            <Section key="r" title="Mando del móvil" description="Controla NOVA desde el navegador de tu teléfono, sin instalar nada.">
              <RemoteCard />
            </Section>
          )}
          {section === "tv" && <TvSettings key="t" />}
          {section === "sources" && (
            <Section key="src" title="Estado de las fuentes" description="De dónde vienen los canales, la guía y los datos, y si funcionan ahora mismo.">
              <SourcesStatus />
            </Section>
          )}
          {section === "privacy" && <Privacy key="p" />}
          {section === "system" && (
            <Section key="y" title="Este equipo" description="Datos reales de Windows, volumen y accesos a su configuración.">
              <SystemPanel />
            </Section>
          )}
          {section === "plugins" && (
            <Section key="pl" title="Plugins" description="Canales, filas y más, creados con el SDK de NOVA. Cada uno solo puede hacer lo que tú apruebes.">
              <PluginsSettings Toggle={Toggle} />
            </Section>
          )}
          {section === "updates" && (
            <Section key="u" title="Actualizaciones" description="Versiones nuevas de NOVA, con sus novedades. Se instalan solo cuando tú lo pides.">
              <UpdatesSettings Toggle={Toggle} />
            </Section>
          )}
          {section === "about" && <About key="b" />}
        </AnimatePresence>
      </div>
    </div>
  );
}
