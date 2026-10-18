import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { Baby, Code, FileWarning, Globe, Image as ImageIcon, KeyRound, LayoutList, ListVideo, LoaderCircle, LogIn, LogOut, MapPin, Bell, PackagePlus, Puzzle, RefreshCw, RotateCcw, ScrollText, Search, Trash2, TriangleAlert, Tv, UserRound } from "lucide-react";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toasts";
import { api, inTauri, pickPluginPackage } from "../lib/api";
import type { PackageInfo, PluginAccountUser, PluginInfo, PluginLogLine, PluginPermissions, PluginSetting, PluginSignIn, PluginsInfo } from "../lib/types";

type ToggleComponent = (p: { title: string; description: string; value: boolean; onChange: () => void; busy?: boolean }) => ReactNode;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a plugin asks for, in plain words. */
function permissionLines(p: PluginPermissions): { icon: typeof Globe; text: string }[] {
  const lines: { icon: typeof Globe; text: string }[] = [];
  if (p.network?.length) lines.push({ icon: Globe, text: `Conectarse a ${p.network.join(", ")}` });
  if (p.channels) lines.push({ icon: Tv, text: "Añadir canales a la TV en directo" });
  if (p.guide) lines.push({ icon: ListVideo, text: "Añadir programación a la guía" });
  if (p.rows) lines.push({ icon: LayoutList, text: "Mostrar filas en «Para ti»" });
  if (p.search) lines.push({ icon: Search, text: "Aparecer en la búsqueda" });
  if (p.screensaver) lines.push({ icon: ImageIcon, text: "Poner fondos en el salvapantallas" });
  if (p.notify) lines.push({ icon: Bell, text: "Mostrar avisos" });
  if (p.location) lines.push({ icon: MapPin, text: "Saber tu ciudad (aproximada)" });
  if (p.account) lines.push({ icon: KeyRound, text: "Iniciar sesión en tu cuenta del servicio (la sesión se guarda cifrada en este equipo)" });
  return lines;
}

function Permissions({ permissions }: { permissions: PluginPermissions }) {
  const lines = permissionLines(permissions);
  if (!lines.length) return <p className="text-[1rem] text-ink-3">No pide ningún permiso.</p>;
  return (
    <ul className="space-y-2">
      {lines.map(({ icon: Icon, text }) => (
        <li key={text} className="flex items-start gap-3 text-[1.05rem] text-ink-2">
          <Icon className="mt-0.5 size-5 shrink-0 text-cyan" /> <span className="min-w-0 break-words">{text}</span>
        </li>
      ))}
    </ul>
  );
}

function PluginIcon({ icon, className = "size-14" }: { icon: string | null; className?: string }) {
  return icon ? (
    <img src={icon} alt="" className={`${className} shrink-0 rounded-2xl object-cover`} />
  ) : (
    <span className={`${className} grid shrink-0 place-items-center rounded-2xl bg-[linear-gradient(135deg,rgb(110_108_255/0.35),rgb(63_213_242/0.2))]`}>
      <Puzzle className="size-1/2 text-white/80" />
    </span>
  );
}

/** The permissions screen: what the package is and asks for, before installing. */
function InstallDialog({ path, pkg, onClose, onInstalled }: { path: string; pkg: PackageInfo; onClose: () => void; onInstalled: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = async () => {
    setBusy(true);
    try {
      await api.pluginsInstall(path);
      toast.show("success", pkg.installed ? `${pkg.name} actualizado a ${pkg.version}` : `${pkg.name} instalado`);
      onInstalled();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const update = pkg.installed && pkg.installed !== pkg.version;
  return (
    <Modal title={update ? `Actualizar ${pkg.name}` : `Instalar ${pkg.name}`} subtitle={`Versión ${pkg.version} · de ${pkg.author}`} onClose={onClose} width="42rem">
      <p className="text-[1.05rem] text-ink-2">{pkg.description}</p>
      {update && <p className="mt-3 text-[1rem] text-ink-3">Tienes la {pkg.installed}. Tus datos y opciones se conservan.</p>}
      {pkg.permissionsChanged && (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[1rem] text-[#ffe7b0]">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" /> Esta versión pide permisos distintos de la que tienes.
        </p>
      )}
      <p className="eyebrow mb-3 mt-6 text-ink-3">Este plugin quiere</p>
      <Permissions permissions={pkg.permissions} />
      <p className="mt-6 flex items-start gap-2 text-[0.95rem] text-ink-3">
        <FileWarning className="mt-0.5 size-4 shrink-0" />
        Paquete sin revisar por la tienda (modo desarrollador). {pkg.audience === "adults" ? "Solo para adultos." : "Apto para todos."} {pkg.files} archivos,{" "}
        {(pkg.size / 1024).toLocaleString("es-ES", { maximumFractionDigits: 0 })} KB.
      </p>
      {error && <p role="alert" className="mt-4 text-[1rem] text-danger">{error}</p>}
      <div className="mt-7 flex justify-end gap-3">
        <button data-nav onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
        <button data-nav data-autofocus disabled={busy} onClick={() => void install()} className="focus-lift btn btn-primary">
          <PackagePlus className="size-5" /> {update ? "Actualizar" : "Instalar"}
        </button>
      </div>
    </Modal>
  );
}

function UninstallDialog({ plugin, onClose, onDone }: { plugin: PluginInfo; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [deleteData, setDeleteData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const uninstall = async () => {
    try {
      await api.pluginsUninstall(plugin.id, deleteData);
      toast.show("success", `${plugin.name} desinstalado`, deleteData ? "Sin dejar nada en el equipo." : "Sus datos se han guardado por si lo vuelves a instalar.");
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal title={`¿Desinstalar ${plugin.name}?`} subtitle="Desaparecen sus canales, filas y todo lo que aporta." onClose={onClose} width="38rem">
      <label className="flex items-center gap-4 rounded-2xl bg-white/5 px-5 py-4">
        <input data-nav type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} className="size-6 accent-[#6e6cff]" />
        <span>
          <span className="block text-[1.1rem] font-semibold">Borrar también sus datos</span>
          <span className="block text-[0.95rem] text-ink-3">Sus opciones y lo que haya guardado. Si no, se conservan por si lo reinstalas.</span>
        </span>
      </label>
      {error && <p role="alert" className="mt-4 text-[1rem] text-danger">{error}</p>}
      <div className="mt-7 flex justify-end gap-3">
        <button data-nav data-autofocus onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
        <button data-nav onClick={() => void uninstall()} className="focus-lift btn btn-danger">
          <Trash2 className="size-5" /> Desinstalar
        </button>
      </div>
    </Modal>
  );
}

function LogDialog({ plugin, onClose }: { plugin: PluginInfo; onClose: () => void }) {
  const [lines, setLines] = useState<PluginLogLine[] | null>(null);
  useEffect(() => {
    api.pluginsLog(plugin.id).then(setLines, () => setLines([]));
  }, [plugin.id]);
  const tone = { info: "text-ink-2", warn: "text-warn", error: "text-danger" };
  return (
    <Modal title={`Registro de ${plugin.name}`} subtitle="Lo que el plugin ha escrito con log desde que arrancó." onClose={onClose} width="56rem">
      <div className="page-scroll max-h-[50vh] overflow-y-auto rounded-xl bg-black/30 p-4 font-mono text-[0.9rem] leading-relaxed">
        {lines === null ? (
          <p className="text-ink-3">Cargando…</p>
        ) : lines.length === 0 ? (
          <p className="text-ink-3">Nada todavía. El plugin arranca cuando NOVA lo necesita (por ejemplo, al mostrar «Para ti»).</p>
        ) : (
          lines.map((l, i) => (
            <p key={i} className={`break-words ${tone[l.level] ?? "text-ink-2"}`}>
              <span className="text-ink-3">{new Date(l.at * 1000).toLocaleTimeString("es-ES")} </span>
              {l.message}
            </p>
          ))
        )}
      </div>
      <div className="mt-6 flex justify-end">
        <button data-nav data-autofocus onClick={onClose} className="focus-lift btn btn-ghost">
          Cerrar
        </button>
      </div>
    </Modal>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * "Ve a twitch.tv/activate y escribe ABCD-1234", with a QR, while NOVA asks
 * the plugin every few seconds whether the code has been typed.
 */
function SignInDialog({ plugin, onClose, onDone }: { plugin: PluginInfo; onClose: () => void; onDone: (user: PluginAccountUser | null) => void }) {
  const [code, setCode] = useState<PluginSignIn | null>(null);
  const [left, setLeft] = useState(0);
  const [ended, setEnded] = useState<"denied" | "expired" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    let alive = true;
    let poll: number | undefined;
    let tick: number | undefined;
    setCode(null);
    setEnded(null);
    setError(null);
    api.pluginsAccountStart(plugin.id).then(
      (c) => {
        if (!alive) return;
        setCode(c);
        const until = Date.now() + c.expiresIn * 1000;
        setLeft(c.expiresIn);
        tick = window.setInterval(() => setLeft(Math.max(0, Math.round((until - Date.now()) / 1000))), 1000);
        const ask = () => {
          api.pluginsAccountPoll(plugin.id).then(
            (r) => {
              if (!alive) return;
              if (r.status === "done") return done.current(r.user);
              if (r.status === "denied" || r.status === "expired" || Date.now() > until) {
                window.clearInterval(tick);
                return setEnded(r.status === "denied" ? "denied" : "expired");
              }
              poll = window.setTimeout(ask, c.interval * 1000);
            },
            (e) => alive && setError(errorText(e)),
          );
        };
        poll = window.setTimeout(ask, c.interval * 1000);
      },
      (e) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
      window.clearTimeout(poll);
      window.clearInterval(tick);
    };
  }, [plugin.id, attempt]);

  return (
    <Modal title={`Iniciar sesión en ${plugin.name}`} subtitle="Con tu móvil u ordenador: sin escribir contraseñas en la tele." onClose={onClose} width="56rem">
      {error ? (
        <p role="alert" className="text-[1.05rem] text-danger">{error}</p>
      ) : !code ? (
        <p className="flex items-center gap-3 text-[1.05rem] text-ink-3">
          <LoaderCircle className="size-5 animate-spin" /> Pidiendo un código…
        </p>
      ) : ended ? (
        <div className="rounded-2xl bg-white/5 px-6 py-5">
          <p className="text-[1.2rem] font-semibold">{ended === "denied" ? "Se ha rechazado el acceso" : "El código ha caducado"}</p>
          <p className="mt-1 text-[1rem] text-ink-3">{ended === "denied" ? "Si fue sin querer, pide otro código y acéptalo." : "Pide otro y escríbelo antes de que pase el tiempo."}</p>
        </div>
      ) : (
        <div className="grid items-center gap-8 sm:grid-cols-[auto_1fr]">
          {code.qrSvg && (
            <div className="grid size-[14rem] place-items-center overflow-hidden rounded-2xl bg-white p-3 shadow-[0_1rem_3rem_-1rem_rgb(110_108_255/0.6)]">
              <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: code.qrSvg }} />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-[1.05rem] text-ink-2">
              {code.qrSvg ? "Escanea el código QR con el móvil, o abre" : "Abre"} <span className="font-semibold text-ink">{code.url}</span> y escribe:
            </p>
            <p className="my-4 break-all font-mono text-[clamp(2rem,4vw,3.2rem)] font-bold tracking-[0.18em] text-ink" aria-label={`Código: ${code.code.split("").join(" ")}`}>
              {code.code}
            </p>
            <p className="flex items-center gap-3 text-[0.98rem] text-ink-3">
              <LoaderCircle className="size-4 animate-spin" /> Esperando a que lo escribas · caduca en {mmss(left)}
            </p>
          </div>
        </div>
      )}
      <div className="mt-7 flex justify-end gap-3">
        {(ended || error) && (
          <button data-nav onClick={() => setAttempt((n) => n + 1)} className="focus-lift btn btn-primary">
            <RefreshCw className="size-5" /> Pedir otro código
          </button>
        )}
        <button data-nav data-autofocus onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
      </div>
    </Modal>
  );
}

/** The plugin's account for the profile watching: who is signed in, or a way to sign in. */
function AccountRow({ plugin }: { plugin: PluginInfo }) {
  const toast = useToast();
  const [user, setUser] = useState<PluginAccountUser | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const usable = plugin.enabled && !plugin.needsApproval;

  const load = useCallback(() => {
    if (!usable) return setUser(null);
    api.pluginsAccount(plugin.id).then(setUser, () => setUser(null));
  }, [plugin.id, usable]);
  useEffect(load, [load]);

  const signOut = () =>
    api.pluginsAccountSignOut(plugin.id).then(
      () => {
        setUser(null);
        toast.show("success", `Sesión cerrada en ${plugin.name}`);
      },
      (e) => toast.show("error", "No se pudo cerrar la sesión", errorText(e)),
    );

  return (
    <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-line pt-4">
      {user?.avatar ? (
        <img src={user.avatar} alt="" className="size-12 shrink-0 rounded-full object-cover" />
      ) : (
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white/8 text-ink-3">
          <UserRound className="size-6" />
        </span>
      )}
      <span className="min-w-[12rem] flex-1">
        {user ? (
          <>
            <span className="block text-[1.05rem] font-semibold">Conectado como {user.name}</span>
            <span className="block text-[0.95rem] text-ink-3">Solo en este perfil. La sesión se guarda cifrada en este equipo.</span>
          </>
        ) : (
          <>
            <span className="block text-[1.05rem] font-semibold">Tu cuenta</span>
            <span className="block text-[0.95rem] text-ink-3">{usable ? "Inicia sesión para ver tu contenido. Cada perfil usa su propia cuenta." : "Activa el plugin para iniciar sesión."}</span>
          </>
        )}
      </span>
      {usable && user !== undefined && (
        <button data-nav onClick={() => (user ? void signOut() : setSigningIn(true))} className={`focus-lift btn ${user ? "btn-ghost" : "btn-primary"}`}>
          {user ? <LogOut className="size-5" /> : <LogIn className="size-5" />} {user ? "Cerrar sesión" : "Iniciar sesión"}
        </button>
      )}
      <AnimatePresence>
        {signingIn && (
          <SignInDialog
            plugin={plugin}
            onClose={() => setSigningIn(false)}
            onDone={(u) => {
              setSigningIn(false);
              setUser(u);
              toast.show("success", u ? `Conectado como ${u.name}` : "Sesión iniciada", plugin.name);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** One of the plugin's options, saved as soon as it changes. */
function SettingField({ plugin, setting, onSaved }: { plugin: PluginInfo; setting: PluginSetting; onSaved: () => void }) {
  const toast = useToast();
  const value = plugin.values[setting.key] ?? setting.default;
  const [draft, setDraft] = useState(String(value ?? ""));
  const save = (next: unknown) =>
    api.pluginsSetSetting(plugin.id, setting.key, next).then(onSaved, (e) => toast.show("error", "No se pudo guardar", errorText(e)));

  const label = (
    <span className="min-w-[12rem] flex-1">
      <span className="block text-[1.05rem] font-semibold">{setting.label}</span>
      {setting.help && <span className="block text-[0.95rem] text-ink-3">{setting.help}</span>}
    </span>
  );
  if (setting.type === "toggle") {
    return (
      <div className="flex items-center gap-4">
        {label}
        <button data-nav role="switch" aria-checked={!!value} onClick={() => void save(!value)} className={`focus-lift btn ${value ? "btn-primary" : "btn-ghost"}`}>
          {value ? "Sí" : "No"}
        </button>
      </div>
    );
  }
  if (setting.type === "choice") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {label}
        {(setting.options ?? []).map((o) => (
          <button key={o.value} data-nav aria-pressed={value === o.value} onClick={() => void save(o.value)} className={`focus-ring h-[2.6rem] rounded-full px-4 font-semibold ${value === o.value ? "bg-white text-black" : "bg-white/8 text-ink-2"}`}>
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  const commit = () => {
    const next = setting.type === "number" ? Number(draft) : draft;
    if (setting.type === "number" && !Number.isFinite(next)) return;
    if (next !== value) void save(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {label}
      {/* .field is width:100% (unlayered CSS beats utilities): its box sets the width. */}
      <span className="block w-full max-w-[22rem] sm:w-[22rem]">
        <input
          data-nav
          className="field"
        inputMode={setting.type === "number" ? "decimal" : "text"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          maxLength={500}
        />
      </span>
    </div>
  );
}

function PluginCard({ plugin, onChanged, onLog, onUninstall }: { plugin: PluginInfo; onChanged: () => void; onLog: () => void; onUninstall: () => void }) {
  const toast = useToast();
  const run = (p: Promise<void>, ok?: string) =>
    p.then(
      () => {
        if (ok) toast.show("success", ok);
        onChanged();
      },
      (e) => toast.show("error", "No se pudo completar", errorText(e)),
    );
  return (
    <div className="surface rounded-2xl px-6 py-5">
      <div className="flex items-start gap-5">
        <PluginIcon icon={plugin.icon} />
        <div className="min-w-0 flex-1">
          <p className="text-[1.3rem] font-semibold">
            {plugin.name} <span className="text-[0.95rem] font-normal text-ink-3">{plugin.version}</span>
            {plugin.dev && (
              <span className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-0.5 align-middle text-[0.85rem] font-semibold text-accent">
                <Code className="size-3.5" /> En desarrollo
              </span>
            )}
          </p>
          <p className="text-[0.95rem] text-ink-3">
            de {plugin.author} · {plugin.audience === "adults" ? "Solo adultos" : "Para todos"}
          </p>
          <p className="mt-1 text-[1rem] text-ink-2">{plugin.description}</p>
          {plugin.needsApproval && (
            <p className="mt-2 flex items-center gap-2 text-[0.95rem] text-warn">
              <TriangleAlert className="size-4 shrink-0" /> Pide permisos que no has aprobado: vuelve a instalarlo para revisarlos. Mientras, no funciona.
            </p>
          )}
          {plugin.error && (
            <p className="mt-2 flex items-start gap-2 text-[0.95rem] text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> <span className="min-w-0 break-words">{plugin.error}</span>
            </p>
          )}
        </div>
        <button
          data-nav
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`${plugin.name}: ${plugin.enabled ? "activado" : "desactivado"}`}
          onClick={() => void run(api.pluginsSetEnabled(plugin.id, !plugin.enabled))}
          className={`focus-lift btn shrink-0 ${plugin.enabled ? "btn-primary" : "btn-ghost"}`}
        >
          {plugin.enabled ? "Activado" : "Desactivado"}
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <Permissions permissions={plugin.permissions} />
      </div>

      {plugin.permissions.account && <AccountRow plugin={plugin} />}

      {plugin.settings.length > 0 && (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {plugin.settings.map((s) => (
            <SettingField key={s.key} plugin={plugin} setting={s} onSaved={onChanged} />
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3 border-t border-line pt-4">
        {plugin.audience === "everyone" && (
          <button
            data-nav
            aria-pressed={plugin.kidsAllowed}
            onClick={() => void run(api.pluginsSetKids(plugin.id, !plugin.kidsAllowed))}
            className={`focus-lift btn ${plugin.kidsAllowed ? "btn-primary" : "btn-ghost"}`}
          >
            <Baby className="size-5" /> {plugin.kidsAllowed ? "Visible en perfiles infantiles" : "Oculto en perfiles infantiles"}
          </button>
        )}
        <button data-nav onClick={onLog} className="focus-lift btn btn-ghost">
          <ScrollText className="size-5" /> Registro
        </button>
        {plugin.previous && (
          <button data-nav onClick={() => void run(api.pluginsRollback(plugin.id), `${plugin.name}: vuelto a la ${plugin.previous}`)} className="focus-lift btn btn-ghost">
            <RotateCcw className="size-5" /> Volver a la {plugin.previous}
          </button>
        )}
        {plugin.dev ? (
          <span className="ml-auto self-center text-[0.95rem] text-ink-3">Lo ejecuta nova dev desde tu carpeta: al cerrarlo, NOVA vuelve a como estaba.</span>
        ) : (
          <button data-nav onClick={onUninstall} className="focus-lift btn btn-danger ml-auto">
            <Trash2 className="size-5" /> Desinstalar
          </button>
        )}
      </div>
    </div>
  );
}

/** Ajustes → Plugins. */
export function PluginsSettings({ Toggle }: { Toggle: ToggleComponent }) {
  const toast = useToast();
  const [info, setInfo] = useState<PluginsInfo | null>(null);
  const [installing, setInstalling] = useState<{ path: string; pkg: PackageInfo } | null>(null);
  const [log, setLog] = useState<PluginInfo | null>(null);
  const [removing, setRemoving] = useState<PluginInfo | null>(null);

  const reload = useCallback(() => {
    api.pluginsList().then(setInfo, (e) => toast.show("error", "No se pudieron cargar los plugins", errorText(e)));
  }, [toast]);
  useEffect(reload, [reload]);
  // `nova dev` loads, reloads and removes plugins from outside this screen.
  useEffect(() => {
    if (!inTauri) return;
    const off = listen("plugins-changed", reload);
    return () => void off.then((f) => f());
  }, [reload]);

  const pick = async () => {
    try {
      const path = await pickPluginPackage();
      if (!path) return;
      setInstalling({ path, pkg: await api.pluginsInspect(path) });
    } catch (e) {
      toast.show("error", "Ese paquete no se puede instalar", errorText(e));
    }
  };

  if (!inTauri) return <p className="text-[1.05rem] text-ink-3">Los plugins funcionan en la aplicación de escritorio.</p>;
  if (!info) return <p className="text-[1.05rem] text-ink-3">Cargando…</p>;

  return (
    <>
      <Toggle
        title="Modo desarrollador"
        description="Permite instalar paquetes .novapkg que la tienda de NOVA no ha revisado, para probar tus propios plugins. Úsalo solo con paquetes en los que confíes."
        value={info.developerMode}
        onChange={() => void api.pluginsSetDeveloper(!info.developerMode).then(reload, (e) => toast.show("error", "No se pudo cambiar", errorText(e)))}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button data-nav disabled={!info.developerMode} onClick={() => void pick()} className="focus-lift btn btn-primary">
          <PackagePlus className="size-5" /> Instalar .novapkg
        </button>
        {!info.developerMode && <span className="text-[0.95rem] text-ink-3">Activa el modo desarrollador para instalar paquetes.</span>}
      </div>

      {info.plugins.length === 0 ? (
        <div className="surface flex items-center gap-5 rounded-2xl px-6 py-6">
          <PluginIcon icon={null} />
          <p className="text-[1.05rem] text-ink-2">
            No hay plugins instalados. Pronto podrás añadirlos desde la tienda de NOVA; mientras tanto, crea el tuyo con <span className="font-mono">@novatv/sdk</span> e instálalo aquí.
          </p>
        </div>
      ) : (
        info.plugins.map((p) => <PluginCard key={p.id} plugin={p} onChanged={reload} onLog={() => setLog(p)} onUninstall={() => setRemoving(p)} />)
      )}

      <AnimatePresence>
        {installing && (
          <InstallDialog
            key="install"
            path={installing.path}
            pkg={installing.pkg}
            onClose={() => setInstalling(null)}
            onInstalled={() => {
              setInstalling(null);
              reload();
            }}
          />
        )}
        {log && <LogDialog key="log" plugin={log} onClose={() => setLog(null)} />}
        {removing && (
          <UninstallDialog
            key="uninstall"
            plugin={removing}
            onClose={() => setRemoving(null)}
            onDone={() => {
              setRemoving(null);
              reload();
            }}
          />
        )}
      </AnimatePresence>
    </>
  );
}
