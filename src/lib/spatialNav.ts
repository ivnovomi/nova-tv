/**
 * Geometric spatial navigation for TV-style arrow/D-pad control.
 * Any element with `data-nav` is a focus target. The topmost open
 * `[data-nav-scope]` (e.g. a modal) traps navigation inside itself.
 */

export type Direction = "up" | "down" | "left" | "right";

const SELECTOR = "[data-nav]:not([disabled]):not([aria-hidden='true'])";

function scopeRoot(): ParentNode {
  const scopes = document.querySelectorAll<HTMLElement>("[data-nav-scope]");
  return scopes.length ? scopes[scopes.length - 1] : document;
}

function candidates(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
}

function reduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function focusElement(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
}

/** Focuses the preferred element inside a container (data-autofocus first). */
export function focusFirst(container?: ParentNode | null): boolean {
  const root = container ?? scopeRoot();
  const preferred = root.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
  const target = preferred ?? candidates(root)[0];
  if (target) {
    focusElement(target);
    return true;
  }
  return false;
}

/**
 * Gives the focus back to `previous` when a dialog closes, but only if it's
 * still in the closing dialog (or nowhere): something opened on top keeps it.
 */
export function restoreFocus(previous: HTMLElement | null, closing: HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body && !closing?.contains(active)) return;
  if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
}

export function moveFocus(dir: Direction): boolean {
  const root = scopeRoot();
  const items = candidates(root);
  const current = document.activeElement as HTMLElement | null;
  if (!current || !items.includes(current)) {
    return focusFirst(root);
  }

  const a = current.getBoundingClientRect();
  const acx = a.left + a.width / 2;
  const acy = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const el of items) {
    if (el === current) continue;
    const b = el.getBoundingClientRect();
    const bcx = b.left + b.width / 2;
    const bcy = b.top + b.height / 2;
    let primary: number;
    let secondary: number;

    if (dir === "right" || dir === "left") {
      primary = dir === "right" ? b.left - a.right : a.left - b.right;
      const centerAhead = dir === "right" ? bcx > acx + 1 : bcx < acx - 1;
      if (primary < -a.width / 2 || !centerAhead) continue;
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      secondary = overlap > 0 ? 0 : Math.abs(bcy - acy);
    } else {
      primary = dir === "down" ? b.top - a.bottom : a.top - b.bottom;
      const centerAhead = dir === "down" ? bcy > acy + 1 : bcy < acy - 1;
      if (primary < -a.height / 2 || !centerAhead) continue;
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      secondary = overlap > 0 ? Math.abs(b.left - a.left) * 0.25 : Math.abs(bcx - acx);
    }

    const score = Math.max(primary, 0) + secondary * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    focusElement(best);
    return true;
  }
  return false;
}
