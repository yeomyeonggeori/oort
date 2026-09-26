import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalHarnessId,
  LocalHarnessProbe,
} from "@momo/core/features/hostedAgents/detect";
import {
  harnessPill,
  loginPollNext,
  type HarnessPill,
} from "@momo/core/features/onboarding/aiConnect";
import { detectLocalHarnesses } from "@/lib/tauri";

interface Watch {
  polling: boolean;
  expired: boolean;
}

const IDLE: Watch = { polling: false, expired: false };

/**
 * 이 맥의 `claude`·`codex` 감지 + 「터미널에서 로그인」 뒤 재확인 (#2814).
 *
 * - 켜지면 한 번 묻는다. 셸은 상태 명령 두 개를 종료 코드로만 돌린다(#2813).
 * - `startLoginWatch(id)`: 그 줄을 「확인 중…」으로 두고, 확인이 **끝난 뒤** 2초마다
 *   다시 묻는다(한 번에 최대 6초 걸리는 명령이라 간격으로 재면 겹친다). 로그인됨이
 *   오면 멈추고, 120초가 지나면 멈춘 뒤 「다시 확인」으로 둔다.
 * - `recheck(id)`: 한 번 묻고 창을 되돌린다.
 * - 언마운트하면 모든 대기를 끊는다.
 *
 * `fixture`가 있으면(design 캡처) 셸을 부르지 않고 그 값을 쓴다.
 */
export function useLocalHarnessWatch({
  enabled,
  fixture,
}: {
  enabled: boolean;
  fixture?: {
    probes: LocalHarnessProbe[] | null;
    watch?: Partial<Record<LocalHarnessId, Watch>>;
  } | null;
}): {
  probes: LocalHarnessProbe[] | null;
  pill: (id: LocalHarnessId) => HarnessPill;
  startLoginWatch: (id: LocalHarnessId) => void;
  recheck: (id: LocalHarnessId) => void;
} {
  const [probes, setProbes] = useState<LocalHarnessProbe[] | null>(
    fixture ? fixture.probes : null
  );
  const [watch, setWatch] = useState<Partial<Record<LocalHarnessId, Watch>>>(
    fixture?.watch ?? {}
  );
  const alive = useRef(true);
  const timers = useRef<Partial<Record<LocalHarnessId, number>>>({});
  const generation = useRef<Partial<Record<LocalHarnessId, number>>>({});

  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      for (const timer of Object.values(pending)) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!enabled || fixture) return;
    let cancelled = false;
    void detectLocalHarnesses().then((next) => {
      if (!cancelled) setProbes(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, fixture]);

  const stop = useCallback((id: LocalHarnessId) => {
    window.clearTimeout(timers.current[id]);
    delete timers.current[id];
    generation.current[id] = (generation.current[id] ?? 0) + 1;
  }, []);

  const startLoginWatch = useCallback(
    (id: LocalHarnessId) => {
      if (fixture) return;
      stop(id);
      const mine = generation.current[id] ?? 0;
      const startedAt = Date.now();
      setWatch((prev) => ({ ...prev, [id]: { polling: true, expired: false } }));

      const tick = async () => {
        const next = await detectLocalHarnesses();
        if (!alive.current || generation.current[id] !== mine) return;
        setProbes(next);
        if (next.find((row) => row.id === id)?.auth === "logged_in") {
          setWatch((prev) => ({ ...prev, [id]: IDLE }));
          return;
        }
        const wait = loginPollNext(Date.now() - startedAt);
        if (wait === "stop") {
          setWatch((prev) => ({ ...prev, [id]: { polling: false, expired: true } }));
          return;
        }
        timers.current[id] = window.setTimeout(() => {
          void tick();
        }, wait);
      };
      void tick();
    },
    [fixture, stop]
  );

  const recheck = useCallback(
    (id: LocalHarnessId) => {
      if (fixture) return;
      stop(id);
      const mine = generation.current[id] ?? 0;
      setWatch((prev) => ({ ...prev, [id]: { polling: true, expired: false } }));
      void detectLocalHarnesses().then((next) => {
        if (!alive.current || generation.current[id] !== mine) return;
        setProbes(next);
        setWatch((prev) => ({ ...prev, [id]: IDLE }));
      });
    },
    [fixture, stop]
  );

  const pill = useCallback(
    (id: LocalHarnessId): HarnessPill =>
      harnessPill(probes?.find((row) => row.id === id) ?? null, watch[id] ?? IDLE),
    [probes, watch]
  );

  return { probes, pill, startLoginWatch, recheck };
}
