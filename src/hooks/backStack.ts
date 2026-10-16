import { useEffect, useRef } from "react";

/**
 * A single "Back" action shared by Escape, Backspace and the gamepad B button.
 * The most recently registered active handler wins (e.g. an open modal before the page).
 */
const stack: Array<{ current: () => void }> = [];

export function runBack() {
  stack[stack.length - 1]?.current();
}

export function useBackHandler(handler: () => void, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/**
 * "Home" can be taken over by a full-screen mode (e.g. Gaming Mode opens its
 * Guide instead of leaving). Returns true when an override handled it.
 */
const homeStack: Array<{ current: () => void }> = [];

export function runHomeOverride(): boolean {
  const top = homeStack[homeStack.length - 1];
  if (!top) return false;
  top.current();
  return true;
}

export function useHomeHandler(handler: () => void, active = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => ref.current() };
    homeStack.push(entry);
    return () => {
      const i = homeStack.indexOf(entry);
      if (i >= 0) homeStack.splice(i, 1);
    };
  }, [active]);
}
