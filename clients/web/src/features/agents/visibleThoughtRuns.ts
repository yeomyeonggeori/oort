import { useEffect, useSyncExternalStore } from "react";

const counts = new Map<string, number>();
let visible: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const snapshot = () => visible;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function emit() { visible = new Set(counts.keys()); for (const listener of listeners) listener(); }

/** 같은 run의 생각 줄이 두 표면에 서도 마지막 줄이 내려갈 때만 레일로 돌려줘요. */
export function useVisibleThoughtRun(runId: string) {
  useEffect(() => {
    const key = runId.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    emit();
    return () => {
      const remaining = (counts.get(key) ?? 1) - 1;
      if (remaining > 0) counts.set(key, remaining); else counts.delete(key);
      emit();
    };
  }, [runId]);
}

export function useVisibleThoughtRuns(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
