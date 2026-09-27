import { useCallback, useEffect, useState } from "react";
import { sessionListFits } from "@momo/core/features/workbench/workTab";

// 세션 목록을 펴 둘지(#2856, 제안서 §3.3). 누른 적이 없으면 창 폭으로 정한다: 목록
// (268)을 편 채로 지금 배치가 칸 최소 폭(240)을 못 지키면 접는다(1280 창 4×2).
// 사람이 「접기」를 누르면 이 기기에 기억한다. 「펴기」는 이번 실행에만 기억한다:
// 좁은 창에서 편 선택이 다음에 연 더 좁은 창에서 격자를 몰래 한 칸으로 접지 않게
// 한다(design-review M3).

const OPEN_KEY = "momo.web.workbench.sessionList.open.v1";

type Choice = "open" | "closed" | null;

function loadChoice(): Choice {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw === "closed" ? raw : null;
  } catch {
    return null;
  }
}

function windowWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function useSessionListOpen(minGridWidth: number): {
  open: boolean;
  /** 사람의 선택(기억한다). */
  setOpen: (open: boolean) => void;
} {
  const [choice, setChoice] = useState<Choice>(loadChoice);
  const [width, setWidth] = useState(windowWidth);

  useEffect(() => {
    const onResize = () => setWidth(windowWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const setOpen = useCallback((open: boolean) => {
    const next: Choice = open ? "open" : "closed";
    setChoice(next);
    try {
      if (open) localStorage.removeItem(OPEN_KEY);
      else localStorage.setItem(OPEN_KEY, next);
    } catch {
      /* 이번 실행에만 기억한다 */
    }
  }, []);

  const open = choice === null ? sessionListFits(width, minGridWidth) : choice === "open";
  return { open, setOpen };
}
