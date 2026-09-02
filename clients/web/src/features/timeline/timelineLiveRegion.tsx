import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type TimelineLive = {
  announce: (text: string) => void;
  hasRegion: boolean;
};

const TimelineLiveContext = createContext<TimelineLive>({
  announce: () => undefined,
  hasRegion: false,
});

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

export function useTimelineLive(): TimelineLive {
  return useContext(TimelineLiveContext);
}
