import { useEffect, useState } from "react";

function reduceMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}

/**
 * `prefers-reduced-motion: reduce`, live.
 *
 * Anything drawn in a stylesheet guards itself with the media query (see the
 * caret in tokens.css). This hook exists for the case CSS cannot reach: motion
 * that swaps the CONTENT of an element on a timer. There is no declaration that
 * turns "show a different line every 2.2 seconds" off, so the decision has to
 * happen in the component that owns the timer.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => reduceMotionQuery()?.matches ?? false
  );
  useEffect(() => {
    const query = reduceMotionQuery();
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
