import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAmbient } from "../app/ambient";

function Picture({ images, fallback }: { images: string[]; fallback?: string }) {
  const [i, setI] = useState(0);
  const src = images[i];
  return (
    <>
      {fallback && <span className="absolute inset-0" style={{ background: fallback }} />}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          onError={() => setI((n) => n + 1)}
          onLoad={(e) => {
            // YouTube answers missing sizes with a tiny grey placeholder.
            if (e.currentTarget.naturalWidth <= 120) setI((n) => n + 1);
          }}
          className="absolute inset-0 size-full object-cover object-[50%_25%]"
        />
      )}
    </>
  );
}

/**
 * Full-bleed backdrop behind the shell (top bar included): the focused
 * content's artwork at the top right, plus a blurred copy that tints the
 * whole app with its colours.
 */
export function AmbientBackdrop() {
  const { value, enabled } = useAmbient();
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <AnimatePresence initial={false}>
        {enabled && value && (
          <motion.div
            key={value.key}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.7, ease: "easeInOut" }}
          >
            {/* Colour wash for the whole screen */}
            <span className="absolute inset-[-15%] scale-110 opacity-45 blur-[90px] saturate-150">
              <Picture images={value.images} fallback={value.fallback} />
            </span>
            {/* Key art, top right, fading into the UI */}
            <span className="absolute right-0 top-0 h-[78vh] w-[72vw] [mask-image:linear-gradient(90deg,transparent,black_38%),linear-gradient(0deg,transparent,black_42%)] [mask-composite:intersect]">
              <Picture images={value.images} fallback={value.fallback} />
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      <span className="absolute inset-0 bg-[linear-gradient(180deg,rgb(3_5_12/0.15)_0%,rgb(3_5_12/0.55)_55%,rgb(3_5_12/0.92)_100%)]" />
    </div>
  );
}
