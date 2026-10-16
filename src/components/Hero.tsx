import { useEffect, useRef, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { LucideProps } from "lucide-react";
import { HeroArt, type ArtVariant } from "./HeroArt";

export interface HeroAction {
  label: string;
  icon?: ComponentType<LucideProps>;
  onClick: () => void;
}

export interface HeroSlide {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  art: ArtVariant;
  /** Real artwork (e.g. video thumbnails), tried in order; falls back to `art`. */
  images?: string[];
  primary: HeroAction;
  secondary?: HeroAction;
}

const ROTATE_MS = 10_000;

function HeroImage({ sources, fallback }: { sources: string[]; fallback: ArtVariant }) {
  const [index, setIndex] = useState(0);
  if (index >= sources.length) return <HeroArt variant={fallback} />;
  return (
    <img
      key={sources[index]}
      src={sources[index]}
      alt=""
      draggable={false}
      onError={() => setIndex((i) => i + 1)}
      onLoad={(e) => {
        // YouTube serves a 120px grey placeholder instead of a 404 for missing sizes.
        if (e.currentTarget.naturalWidth <= 120) setIndex((i) => i + 1);
      }}
      className="kenburns absolute inset-0 size-full object-cover"
    />
  );
}

export function Hero({ slides }: { slides: HeroSlide[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const root = useRef<HTMLElement>(null);
  const slide = slides[Math.min(index, slides.length - 1)];

  // Never rotate content out from under a focused button.
  useEffect(() => {
    if (paused || slides.length < 2) return;
    const t = window.setTimeout(() => setIndex((i) => (i + 1) % slides.length), ROTATE_MS);
    return () => window.clearTimeout(t);
  }, [index, paused, slides.length]);

  if (!slide) return null;
  const Primary = slide.primary.icon;
  const Secondary = slide.secondary?.icon;

  return (
    <section
      ref={root}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) setPaused(false);
      }}
      className="relative mx-[var(--gutter)] h-[clamp(18rem,40vh,26rem)] overflow-hidden rounded-[var(--radius-hero)] border border-line bg-surface-1 shadow-[0_2rem_5rem_-2rem_rgb(0_0_0/0.8)]"
      aria-roledescription="carrusel"
      aria-label="Destacado"
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={slide.id}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeInOut" }}
        >
          {slide.images?.length ? <HeroImage sources={slide.images} fallback={slide.art} /> : <HeroArt variant={slide.art} />}
        </motion.div>
      </AnimatePresence>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(4_6_14/0.96)_0%,rgb(4_6_14/0.82)_32%,rgb(4_6_14/0.15)_62%,transparent_80%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-bg-0/70 to-transparent" />

      <div className="relative flex h-full max-w-[46rem] flex-col justify-center px-[3.6rem]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={slide.id}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="eyebrow flex items-center gap-3 text-cyan">
              <span className="h-4 w-[3px] rounded bg-cyan" />
              {slide.eyebrow}
            </p>
            <h1 className="mt-3 line-clamp-2 text-[clamp(2.6rem,4.2vw,4.4rem)] font-semibold leading-[1.02] tracking-[-0.02em]">
              {slide.title}
            </h1>
            <p className="mt-4 line-clamp-2 max-w-[36rem] text-[1.25rem] leading-relaxed text-ink-2">{slide.description}</p>
          </motion.div>
        </AnimatePresence>

        <div className="mt-7 flex items-center gap-4">
          <button data-nav onClick={slide.primary.onClick} className="focus-lift btn btn-primary">
            {Primary && <Primary className="size-5" fill="currentColor" strokeWidth={1.5} />}
            {slide.primary.label}
          </button>
          {slide.secondary && (
            <button data-nav onClick={slide.secondary.onClick} className="focus-lift btn btn-ghost">
              {Secondary && <Secondary className="size-5" />}
              {slide.secondary.label}
            </button>
          )}
        </div>

        {slides.length > 1 && (
          <div className="mt-7 flex items-center gap-1" role="tablist" aria-label="Destacados">
            {slides.map((s, i) => (
              <button
                key={s.id}
                data-nav
                role="tab"
                aria-selected={i === index}
                aria-label={s.eyebrow}
                onClick={() => setIndex(i)}
                onFocus={() => setIndex(i)}
                className="focus-ring grid h-7 place-items-center rounded-full px-1.5"
              >
                <span
                  className={`block h-2 rounded-full transition-all duration-300 ${
                    i === index ? "w-8 bg-white" : "w-2 bg-white/35"
                  }`}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
