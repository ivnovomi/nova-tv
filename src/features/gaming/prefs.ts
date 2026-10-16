/** NOVA PLAY preferences kept in this browser profile (per-device conveniences). */

const TRAILERS = "nova.trailers";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Background trailers: on by default, off when the system asks for less motion. */
export const trailerPref = {
  get(): boolean {
    const v = read(TRAILERS);
    return v ? v === "on" : !reducedMotion();
  },
  set(on: boolean) {
    write(TRAILERS, on ? "on" : "off");
  },
};
