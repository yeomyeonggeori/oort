import { createContext, useContext } from "react";

export type TimelineLive = {
  announce: (text: string) => void;
  hasRegion: boolean;
};

export const TimelineLiveContext = createContext<TimelineLive>({
  announce: () => undefined,
  hasRegion: false,
});

export function useTimelineLive(): TimelineLive {
  return useContext(TimelineLiveContext);
}
