import { useEffect, useState } from "react";

const QUERY = "(hover: none)";

/** Pointer vs finger. Same axis as MessageActions (`touch-only` / `(hover: none)` JS). */
export function useHoverNone(): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(QUERY).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(QUERY);
    const sync = () => setMatches(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return matches;
}
