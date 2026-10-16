import { useState, type FormEvent, type ReactNode } from "react";
import { FolderOpen, LoaderCircle, TriangleAlert } from "lucide-react";
import { Modal } from "../components/Modal";
import { api, fileNameFromPath, pickExecutable, splitArgs } from "../lib/api";
import type { Shortcut, ShortcutKind } from "../lib/types";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[1rem] font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[0.9rem] text-ink-3">{hint}</span>}
    </label>
  );
}

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-6 flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-[1rem] text-[#ffd3dc]">
      <TriangleAlert className="mt-0.5 size-5 shrink-0" /> {message}
    </p>
  );
}

function Actions({ busy, submitLabel, onCancel }: { busy: boolean; submitLabel: string; onCancel: () => void }) {
  return (
    <div className="mt-8 flex justify-end gap-3">
      <button type="button" data-nav onClick={onCancel} className="focus-lift btn btn-ghost">
        Cancelar
      </button>
      <button type="submit" data-nav disabled={busy} className="focus-lift btn btn-primary">
        {busy && <LoaderCircle className="size-5 spin" />}
        {submitLabel}
      </button>
    </div>
  );
}

export function AddExecutableDialog({
  kind,
  suggestedName,
  onClose,
  onSaved,
}: {
  kind: ShortcutKind;
  suggestedName?: string;
  onClose: () => void;
  onSaved: (s: Shortcut) => void;
}) {
  const [name, setName] = useState(suggestedName ?? "");
  const [description, setDescription] = useState("");
  const [path, setPath] = useState("");
  const [args, setArgs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noun = kind === "game" ? "juego" : "aplicación";

  const browse = async () => {
    try {
      const picked = await pickExecutable();
      if (!picked) return;
      setPath(picked);
      if (!name.trim()) setName(fileNameFromPath(picked).replace(/\.exe$/i, ""));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await api.addExecutable({ name, description, kind, path, args: splitArgs(args) });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === "game" ? "Añadir juego" : "Añadir aplicación"}
      subtitle={`Registra un ${noun} instalado en este PC. NOVA TV comprobará que el ejecutable existe.`}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Ruta del ejecutable (.exe)">
          <div className="flex gap-3">
            <input
              data-nav
              className="field"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Program Files\…\programa.exe"
              spellCheck={false}
            />
            <button type="button" data-nav data-autofocus onClick={browse} className="focus-lift btn btn-ghost shrink-0">
              <FolderOpen className="size-5" /> Examinar
            </button>
          </div>
        </Field>
        <Field label="Nombre">
          <input data-nav className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Descripción (opcional)">
          <input data-nav className="field" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Argumentos (opcional)" hint='Se pasan directamente al programa, sin consola. Usa comillas para valores con espacios: --perfil "Sala de estar"'>
          <input data-nav className="field" value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} />
        </Field>
        <ErrorBox message={error} />
        <Actions busy={busy} submitLabel="Guardar" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function AddSteamDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: Shortcut) => void }) {
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = Number(appId.trim());
    if (!/^\d{1,10}$/.test(appId.trim()) || !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) {
      setError("El App ID debe ser un número, por ejemplo 1245620.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.addSteamGame(name, id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Añadir juego de Steam"
      subtitle="Se abrirá a través de Steam con steam://rungameid. Encontrarás el App ID en la URL de la tienda del juego."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Nombre">
          <input data-nav data-autofocus className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="App ID de Steam">
          <input data-nav className="field" inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} />
        </Field>
        <ErrorBox message={error} />
        <Actions busy={busy} submitLabel="Guardar" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function ConfirmRemoveDialog({ item, onClose, onRemoved }: { item: Shortcut; onClose: () => void; onRemoved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api.removeShortcut(item.id);
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={`¿Quitar «${item.name}»?`} subtitle="Solo se elimina el acceso de NOVA TV. El programa sigue instalado." onClose={onClose} width="36rem">
      <ErrorBox message={error} />
      <div className="mt-2 flex justify-end gap-3">
        <button data-nav data-autofocus onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
        <button data-nav disabled={busy} onClick={remove} className="focus-lift btn btn-danger">
          {busy && <LoaderCircle className="size-5 spin" />} Quitar
        </button>
      </div>
    </Modal>
  );
}

export function AddWebDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (s: Shortcut) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.addWebApp(name, url));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Añadir servicio web"
      subtitle="Se abrirá a pantalla completa como una app, con tu sesión guardada en el perfil de NOVA TV."
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-5">
        <Field label="Nombre">
          <input data-nav data-autofocus className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Filmin" />
        </Field>
        <Field label="Dirección" hint="Solo direcciones seguras https://">
          <input data-nav className="field" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} inputMode="url" />
        </Field>
        <ErrorBox message={error} />
        <Actions busy={busy} submitLabel="Guardar" onCancel={onClose} />
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  subtitle,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  subtitle?: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} width="36rem">
      <ErrorBox message={error} />
      <div className="mt-2 flex justify-end gap-3">
        <button data-nav data-autofocus onClick={onClose} className="focus-lift btn btn-ghost">
          Cancelar
        </button>
        <button data-nav disabled={busy} onClick={run} className="focus-lift btn btn-danger">
          {busy && <LoaderCircle className="size-5 spin" />} {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
