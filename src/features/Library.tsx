import { useEffect, useState, type ReactNode } from "react";
import { Check, Pencil, Plus } from "lucide-react";
import { PageHeader } from "../components/Chrome";
import { AddTile, AppTile } from "../components/Tiles";
import { tileBackground } from "../components/art";
import { ambient } from "../app/ambient";
import { byRecent, useNova } from "../app/context";
import { useBackHandler } from "../hooks/backStack";
import type { Shortcut } from "../lib/types";

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-10 px-[var(--gutter)]">
      <h2 className="mb-4 flex items-baseline gap-3 text-[1.5rem] font-semibold">
        {title}
        {count !== undefined && <span className="text-[1.1rem] font-normal text-ink-3">{count}</span>}
      </h2>
      <div className="flex flex-wrap gap-5">{children}</div>
    </section>
  );
}

function useEditMode() {
  const [editing, setEditing] = useState(false);
  useBackHandler(() => setEditing(false), editing);
  return [editing, setEditing] as const;
}

function EditToggle({ editing, onToggle, disabled }: { editing: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <button data-nav disabled={disabled} onClick={onToggle} className={`focus-lift btn ${editing ? "btn-danger" : "btn-ghost"}`}>
      {editing ? <Check className="size-5" /> : <Pencil className="size-5" />}
      {editing ? "Terminar" : "Editar"}
    </button>
  );
}

export function AppsScreen() {
  const nova = useNova();
  const [editing, setEditing] = useEditMode();
  const apps = nova.library ? byRecent(nova.library.apps, nova.library.recent) : [];
  const detected = apps.filter((a) => a.source === "detected");
  const mine = apps.filter((a) => a.source === "user");
  useEffect(() => () => ambient.set(null), []);
  // Each app's colour tints the screen while it's focused.
  const tint = (a: Shortcut) => () => ambient.set({ key: `app:${a.id}`, images: [], fallback: tileBackground(a.id, a.name) });

  const activate = (item: Shortcut) => {
    if (!editing) return nova.launch(item);
    if (item.source === "user") nova.openDialog({ type: "confirm-remove", item });
  };

  return (
    <div className="pb-14">
      <PageHeader
        eyebrow="Aplicaciones"
        title="Tus aplicaciones"
        description="Programas detectados en las rutas habituales de este PC y los que añadas tú."
      >
        <EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} disabled={mine.length === 0} />
        <button data-nav data-autofocus onClick={() => nova.openDialog({ type: "add-exe", kind: "app" })} className="focus-lift btn btn-primary">
          <Plus className="size-5" /> Añadir aplicación
        </button>
      </PageHeader>

      <Section title="Añadidas por ti" count={mine.length}>
        {mine.map((a) => (
          <div key={a.id} onFocus={tint(a)}>
            <AppTile item={a} editing={editing} busy={nova.launching === a.id} onActivate={activate} />
          </div>
        ))}
        {!editing && <AddTile title="Añadir aplicación" subtitle="Cualquier .exe instalado" onClick={() => nova.openDialog({ type: "add-exe", kind: "app" })} />}
      </Section>

      <Section title="Detectadas en este PC" count={detected.length}>
        {detected.map((a) => (
          <div key={a.id} onFocus={tint(a)}>
            <AppTile item={a} editing={editing} busy={nova.launching === a.id} onActivate={activate} />
          </div>
        ))}
        {detected.length === 0 && <p className="text-[1.1rem] text-ink-3">No se encontraron aplicaciones conocidas en las rutas estándar.</p>}
      </Section>
    </div>
  );
}
