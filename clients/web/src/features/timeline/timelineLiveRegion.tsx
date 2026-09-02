import { useCallback, useMemo, useState, type ReactNode } from "react";
import { TimelineLiveContext } from "./timelineLiveContext";

/**
 * One polite live region for the timeline (N-4). Rows announce into this
 * instead of mounting their own `aria-live` span.
 */
export function TimelineLiveRegionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [text, setText] = useState("");
  const announce = useCallback((next: string) => {
    setText(next);
  }, []);
  const value = useMemo(() => ({ announce, hasRegion: true }), [announce]);
  return (
    <TimelineLiveContext.Provider value={value}>
      {children}
      <span
        className="sr-only"
        aria-live="polite"
        data-testid="message-row-live"
      >
        {text}
      </span>
    </TimelineLiveContext.Provider>
  );
}
