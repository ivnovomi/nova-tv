/** Controller button glyphs (generic face-button colours) and keyboard keycaps. */

const FACE: Record<string, string> = {
  A: "bg-[#5cff8f] text-[#04120a]",
  B: "bg-[#ff5c7a] text-[#2a0710]",
  X: "bg-[#4fa8ff] text-[#04142a]",
  Y: "bg-[#ffd34f] text-[#2a2004]",
};

export function Glyph({ label }: { label: string }) {
  const face = FACE[label];
  if (face) {
    return (
      <span className={`inline-grid size-[1.9rem] place-items-center rounded-full text-[0.95rem] font-bold ${face}`}>{label}</span>
    );
  }
  return (
    <kbd className="inline-grid h-[1.9rem] min-w-[1.9rem] place-items-center rounded-md border border-white/25 bg-white/10 px-2 font-sans text-[0.85rem] font-semibold text-white">
      {label}
    </kbd>
  );
}

export function HintBar({ controller }: { controller: boolean }) {
  const hints: [string, string][] = controller
    ? [
        ["A", "Seleccionar"],
        ["B", "Guía"],
        ["☰", "Guía"],
      ]
    : [
        ["Enter", "Seleccionar"],
        ["Esc", "Guía"],
        ["Inicio", "Guía"],
      ];
  return (
    <div className="flex items-center gap-8 text-[1rem] text-white/70">
      {hints.map(([g, label]) => (
        <span key={g} className="flex items-center gap-2.5">
          <Glyph label={g} /> {label}
        </span>
      ))}
    </div>
  );
}
