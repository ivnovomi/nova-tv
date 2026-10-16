import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Baby, Check, KeyRound, LockKeyhole, Pencil, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Modal } from "../components/Modal";
import { PinPad } from "../components/PinPad";
import { Avatar } from "../components/ProfilePicker";
import { useToast } from "../components/Toasts";
import { AVATARS, COLORS, isUnlocked, profiles, useActiveProfile, useProfiles } from "../app/profiles";
import { api } from "../lib/api";
import type { Profile, ProfileInput, Shortcut } from "../lib/types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One PIN entry at a time; `ask` resolves with the PIN, or null if the parent cancels. */
type PinStep = { title: string; subtitle?: string; submit: (pin: string) => Promise<void> | void };

function usePinFlow() {
  const [step, setStep] = useState<PinStep | null>(null);
  const cancel = useRef<() => void>(() => setStep(null));
  const ask = (title: string, subtitle?: string, check?: (pin: string) => Promise<void> | void) =>
    new Promise<string | null>((resolve) => {
      setStep({
        title,
        subtitle,
        submit: async (pin) => {
          await check?.(pin); // throws → the pad shows the error and stays open
          setStep(null);
          resolve(pin);
        },
      });
      // Cancel resolves null.
      cancel.current = () => {
        setStep(null);
        resolve(null);
      };
    });
  const pad = (
    <AnimatePresence>
      {step && <PinPad key={step.title} title={step.title} subtitle={step.subtitle} onSubmit={step.submit} onClose={() => cancel.current()} />}
    </AnimatePresence>
  );
  /** Asks for a new PIN twice. */
  const newPin = async () => {
    const first = await ask("Nuevo PIN parental", "De 4 a 6 números. Lo pedirá NOVA para salir de un perfil infantil.");
    if (!first) return null;
    const again = await ask("Repite el PIN", undefined, (pin) => {
      if (pin !== first) throw new Error("No coincide. Inténtalo otra vez.");
    });
    return again;
  };
  return { ask, newPin, pad };
}

/** What a children's profile restricts — said plainly, nothing promised that isn't enforced. */
const KIDS_RULES = [
  "TV en directo: solo canales infantiles (TDT infantil y dibujos de Pluto TV; anime y canales del mundo, si los activas).",
  "Apps, juegos y streaming: solo los que elijas aquí.",
  "Sin búsqueda en YouTube ni en los archivos del PC, y sin «Multimedia».",
  "Sin Ajustes: hace falta el PIN para abrirlos o para cambiar a otro perfil.",
  "Lo mismo vale para el mando del móvil: NOVA lo comprueba en el propio programa, no solo en la pantalla.",
];

function ProfileEditor({ initial, onClose, onSaved }: { initial: Profile | null; onClose: () => void; onSaved: (p: ProfileInput) => Promise<void> }) {
  const [draft, setDraft] = useState<ProfileInput>(
    initial
      ? { id: initial.id, name: initial.name, avatar: initial.avatar, color: initial.color, kids: initial.kids, allowed: initial.allowed, allowAnime: initial.allowAnime, allowWorld: initial.allowWorld }
      : { name: "", avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)], color: COLORS[0], kids: false, allowed: ["stream:youtubekids"], allowAnime: true, allowWorld: false },
  );
  const [catalog, setCatalog] = useState<Shortcut[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<ProfileInput>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => {
    if (draft.kids && !catalog) api.parentalCatalog().then(setCatalog, (e) => setError(message(e)));
  }, [draft.kids, catalog]);

  const groups = useMemo(() => {
    const list = catalog ?? [];
    const seen = new Set<string>();
    const unique = list.filter((s) => !seen.has(s.id) && seen.add(s.id));
    return [
      ["Streaming", unique.filter((s) => s.kind === "stream")],
      ["Juegos", unique.filter((s) => s.kind === "game")],
      ["Apps", unique.filter((s) => s.kind === "app")],
    ] as const;
  }, [catalog]);

  const toggleAllowed = (id: string) => patch({ allowed: draft.allowed.includes(id) ? draft.allowed.filter((a) => a !== id) : [...draft.allowed, id] });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSaved(draft);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? `Editar ${initial.name}` : "Nuevo perfil"} subtitle="Cada perfil tiene sus favoritos, su último canal y su historial." onClose={onClose} width="52rem">
      <div className="flex items-center gap-6">
        <Avatar profile={draft} className="size-[6rem] text-[3rem]" />
        <label className="block flex-1">
          <span className="mb-2 block text-[1rem] font-semibold text-ink-2">Nombre</span>
          <input data-nav className="field" value={draft.name} maxLength={24} onChange={(e) => patch({ name: e.target.value })} placeholder="Ej.: Lucía" />
        </label>
      </div>

      <p className="mb-2 mt-6 text-[1rem] font-semibold text-ink-2">Avatar</p>
      <div className="flex flex-wrap gap-2">
        {AVATARS.map((a) => (
          <button
            key={a}
            data-nav
            aria-label={`Avatar ${a}`}
            aria-pressed={draft.avatar === a}
            onClick={() => patch({ avatar: a })}
            className={`focus-lift grid size-[3.4rem] place-items-center rounded-full text-[1.7rem] ${draft.avatar === a ? "bg-white/25 ring-2 ring-white" : "bg-white/6"}`}
          >
            {a}
          </button>
        ))}
      </div>
      <p className="mb-2 mt-5 text-[1rem] font-semibold text-ink-2">Color</p>
      <div className="flex flex-wrap gap-3">
        {COLORS.map((c) => (
          <button
            key={c}
            data-nav
            aria-label={`Color ${c}`}
            aria-pressed={draft.color === c}
            onClick={() => patch({ color: c })}
            className="focus-lift grid size-[2.8rem] place-items-center rounded-full"
            style={{ background: c }}
          >
            {draft.color === c && <Check className="size-5 text-white drop-shadow" />}
          </button>
        ))}
      </div>

      <button
        data-nav
        role="switch"
        aria-checked={draft.kids}
        onClick={() => patch({ kids: !draft.kids })}
        className={`focus-ring mt-7 flex w-full items-center gap-4 rounded-2xl px-5 py-4 text-left ${draft.kids ? "bg-[#ffb547]/15 ring-1 ring-[#ffb547]/50" : "bg-white/5"}`}
      >
        <Baby className={`size-8 shrink-0 ${draft.kids ? "text-[#ffd48a]" : "text-ink-3"}`} />
        <span className="flex-1">
          <span className="block text-[1.2rem] font-semibold">Perfil infantil</span>
          <span className="block text-[0.95rem] text-ink-3">Con control parental. Para salir de él hará falta el PIN.</span>
        </span>
        <span className={`badge ${draft.kids ? "bg-[#ffb547] text-black" : "bg-white/10 text-ink-2"}`}>{draft.kids ? "Activado" : "No"}</span>
      </button>

      {draft.kids && (
        <div className="mt-4 space-y-4">
          <ul className="space-y-1.5 rounded-2xl bg-white/4 px-5 py-4 text-[0.95rem] text-ink-2">
            {KIDS_RULES.map((r) => (
              <li key={r} className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" /> {r}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3">
            {[
              ["allowAnime", "Anime de Pluto TV", "Dragon Ball, One Piece, Detective Conan…"],
              ["allowWorld", "Canales infantiles del mundo", "De iptv-org: nadie los revisa uno a uno."],
            ].map(([key, title, desc]) => {
              const on = draft[key as "allowAnime" | "allowWorld"];
              return (
                <button key={key} data-nav role="switch" aria-checked={on} onClick={() => patch({ [key]: !on })} className={`focus-ring rounded-2xl px-5 py-4 text-left ${on ? "bg-white/12" : "bg-white/4"}`}>
                  <span className="flex items-center justify-between text-[1.05rem] font-semibold">
                    {title} <span className={`size-3 rounded-full ${on ? "bg-ok" : "bg-white/20"}`} />
                  </span>
                  <span className="mt-1 block text-[0.9rem] text-ink-3">{desc}</span>
                </button>
              );
            })}
          </div>
          <div>
            <p className="text-[1.05rem] font-semibold">Qué puede abrir</p>
            <p className="text-[0.9rem] text-ink-3">YouTube Kids está marcado por defecto. YouTube normal no es para niños: márcalo solo si quieres.</p>
            {!catalog && !error && <p className="mt-3 text-ink-3">Cargando…</p>}
            {groups.map(([label, items]) =>
              items.length ? (
                <div key={label} className="mt-3">
                  <p className="eyebrow mb-2">{label}</p>
                  <div className="flex flex-wrap gap-2">
                    {items.map((s) => {
                      const on = draft.allowed.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          data-nav
                          aria-pressed={on}
                          onClick={() => toggleAllowed(s.id)}
                          className={`focus-lift flex items-center gap-2 rounded-full px-4 py-2 text-[0.95rem] ${on ? "bg-white text-black" : "bg-white/7 text-ink-2"}`}
                        >
                          {on && <Check className="size-4" />} {s.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-5 rounded-xl bg-danger/15 px-4 py-3 text-[1rem] text-[#ffc2cd]">
          {error}
        </p>
      )}
      <div className="mt-7 flex justify-end gap-3">
        <button data-nav onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
        <button data-nav disabled={busy || !draft.name.trim()} onClick={() => void save()} className="focus-lift btn btn-primary">
          {initial ? "Guardar" : "Crear perfil"}
        </button>
      </div>
    </Modal>
  );
}

export function ProfilesSettings() {
  const info = useProfiles();
  const toast = useToast();
  const pins = usePinFlow();
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  useEffect(() => void profiles.load(), []);
  if (!info) return null;

  const createPin = async () => {
    const pin = await pins.newPin();
    if (!pin) return false;
    await profiles.setPin(pin);
    toast.show("success", "PIN parental creado", "Guárdalo bien: NOVA no puede recuperarlo.");
    return true;
  };

  const changePin = async () => {
    const current = await pins.ask("PIN actual");
    if (!current) return;
    const pin = await pins.newPin();
    if (!pin) return;
    try {
      await profiles.setPin(pin, current);
      toast.show("success", "PIN parental cambiado");
    } catch (e) {
      toast.show("error", "No se pudo cambiar el PIN", message(e));
    }
  };

  const removePin = async () => {
    const current = await pins.ask("Quitar el PIN", "Introduce el PIN actual.", (pin) => profiles.removePin(pin).then(() => {}));
    if (current) toast.show("success", "PIN parental eliminado");
  };

  const save = async (input: ProfileInput) => {
    // A children's profile needs a parental PIN first (NOVA enforces it too).
    if (input.kids && !info.hasPin && !(await createPin())) return;
    await profiles.save(input);
    setEditing(null);
    toast.show("success", input.id ? "Perfil guardado" : `Perfil «${input.name}» creado`, input.kids ? "Con control parental." : undefined);
  };

  const remove = async (p: Profile) => {
    try {
      await profiles.remove(p.id);
      toast.show("success", `Perfil «${p.name}» borrado`);
    } catch (e) {
      toast.show("error", "No se pudo borrar", message(e));
    }
  };

  return (
    <>
      <div className="surface rounded-2xl p-3">
        {info.profiles.map((p) => (
          <div key={p.id} className="flex items-center gap-5 rounded-xl px-3 py-3">
            <Avatar profile={p} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[1.25rem] font-semibold">
                {p.name}
                {p.kids && <span className="badge bg-[#ffb547]/20 text-[#ffd48a]">Infantil</span>}
                {p.id === info.active && <span className="badge bg-white/12 text-ink-2">En uso</span>}
              </p>
              <p className="text-[0.95rem] text-ink-3">
                {p.favorites.length} canales favoritos{p.kids ? ` · ${p.allowed.length} apps permitidas` : ""}
              </p>
            </div>
            <button data-nav aria-label={`Editar ${p.name}`} onClick={() => setEditing(p)} className="focus-lift btn btn-ghost">
              <Pencil className="size-5" /> Editar
            </button>
            <button data-nav aria-label={`Borrar ${p.name}`} disabled={p.id === info.active} onClick={() => void remove(p)} className="focus-lift btn btn-ghost">
              <Trash2 className="size-5" />
            </button>
          </div>
        ))}
        <button data-nav disabled={info.profiles.length >= 8} onClick={() => setEditing("new")} className="focus-ring mt-1 flex w-full items-center gap-5 rounded-xl px-3 py-3 text-left text-ink-2">
          <span className="grid size-[3.4rem] place-items-center rounded-full border-2 border-dashed border-white/25">
            <Plus className="size-6" />
          </span>
          <span className="text-[1.15rem] font-semibold">Añadir perfil</span>
        </button>
      </div>

      <div className="surface flex items-center gap-6 rounded-2xl px-6 py-5">
        <KeyRound className="size-8 shrink-0 text-cyan" />
        <div className="min-w-0 flex-1">
          <p className="text-[1.25rem] font-semibold">PIN parental</p>
          <p className="mt-1 text-[1rem] text-ink-3">
            {info.hasPin
              ? "Activado. Se pide para salir de un perfil infantil y para abrir los Ajustes desde él. Tras 5 fallos, se bloquea 1 minuto."
              : "Sin PIN. Hace falta para crear perfiles infantiles."}
          </p>
        </div>
        {info.hasPin ? (
          <>
            <button data-nav onClick={() => void changePin()} className="focus-lift btn btn-ghost">
              Cambiar
            </button>
            <button data-nav disabled={info.profiles.some((p) => p.kids)} onClick={() => void removePin()} className="focus-lift btn btn-ghost">
              Quitar
            </button>
          </>
        ) : (
          <button data-nav onClick={() => void createPin().catch((e) => toast.show("error", "No se pudo crear el PIN", message(e)))} className="focus-lift btn btn-primary">
            Crear PIN
          </button>
        )}
      </div>

      <p className="text-[0.95rem] leading-relaxed text-ink-3">
        El control parental de NOVA filtra lo que NOVA muestra y abre. No controla el resto de Windows: para eso, usa también una cuenta infantil de Windows (Microsoft Family Safety).
      </p>

      <AnimatePresence>
        {editing && <ProfileEditor key="editor" initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={save} />}
      </AnimatePresence>
      {pins.pad}
    </>
  );
}

/** Settings from a children's profile: locked until a parent enters the PIN. */
export function KidsLock() {
  const profile = useActiveProfile();
  const [asking, setAsking] = useState(false);
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-[40rem] text-center">
        <span className="mx-auto grid size-24 place-items-center rounded-full bg-white/8">
          <LockKeyhole className="size-11 text-[#ffd48a]" />
        </span>
        <h1 className="mt-6 text-[2.4rem] font-semibold">Ajustes bloqueados</h1>
        <p className="mt-3 text-[1.2rem] text-ink-2">
          {profile?.name ? `${profile.name} está en un perfil infantil.` : "Este es un perfil infantil."} Un adulto puede abrirlos con el PIN parental durante 10 minutos.
        </p>
        <button data-nav data-autofocus onClick={() => setAsking(true)} className="focus-lift btn btn-primary mt-8">
          <UserRound className="size-5" /> Soy un adulto
        </button>
      </div>
      <AnimatePresence>
        {asking && (
          <PinPad
            key="unlock"
            title="Abrir los Ajustes"
            subtitle="Introduce el PIN parental."
            onSubmit={async (pin) => {
              await profiles.unlock(pin);
              setAsking(false);
            }}
            onClose={() => setAsking(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Banner while a parent has settings open from a children's profile. */
export function UnlockedBanner() {
  const info = useProfiles();
  const profile = useActiveProfile();
  if (!profile?.kids || !isUnlocked(info)) return null;
  const minutes = Math.max(1, Math.round(((info?.unlockedUntil ?? 0) * 1000 - Date.now()) / 60000));
  return (
    <div className="mb-5 flex items-center gap-4 rounded-2xl bg-[#ffb547]/15 px-5 py-3 text-[1rem] text-[#ffe2b0]">
      <LockKeyhole className="size-5 shrink-0" />
      <span className="flex-1">Ajustes abiertos por un adulto · se vuelven a bloquear en {minutes} min.</span>
      <button data-nav onClick={() => void profiles.lock()} className="focus-lift btn btn-ghost">
        Bloquear ya
      </button>
    </div>
  );
}
