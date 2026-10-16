import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { focusFirst, restoreFocus } from "../lib/spatialNav";
import { useBackHandler, useHomeHandler } from "../hooks/backStack";

interface Props {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}

/** Focus-trapping dialog. Render it inside <AnimatePresence> for exit animation. */
export function Modal({ title, subtitle, onClose, children, width = "44rem" }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useBackHandler(onClose);
  useHomeHandler(onClose);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = panel.current;
    const t = window.setTimeout(() => focusFirst(panel.current), 30);
    return () => {
      window.clearTimeout(t);
      restoreFocus(previous, node);
    };
  }, []);

  return createPortal(
    <motion.div
      className="fixed inset-0 z-40 grid place-items-center bg-bg-0/70 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        ref={panel}
        data-nav-scope
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${width}, calc(100vw - 4rem))` }}
        className="surface max-h-[calc(100vh-4rem)] overflow-y-auto rounded-[var(--radius-card)] bg-surface-1 p-10 shadow-[0_2rem_6rem_-1rem_rgb(0_0_0/0.8)]"
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.98 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      >
        <h2 className="text-[2rem] font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-2 text-[1.1rem] text-ink-2">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
