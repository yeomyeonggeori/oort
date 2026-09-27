import { useCallback, useEffect, useState } from "react";
import { sessionListFits } from "@momo/core/features/workbench/workTab";

// 세션 목록을 펴 둘지(#2856, 제안서 §3.3). 사람이 목록 접기·펴기를 누르면 그 선택을
// 이 기기에 기억한다. 누른 적이 없으면 창 폭으로 정한다: 목록(268)을 편 채로
// 지금 배치가 칸 최소 폭(240)을 못 지키면 접는다(1280 창 4×2).

const OPEN_KEY = "momo.web.workbench.sessionList.open.v1";

type Choice = "open" | "closed" | null;

function loadChoice(): Choice {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw === "open" || raw === "closed" ? raw : null;
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
      localStorage.setItem(OPEN_KEY, next);
    } catch {
      /* 이번 실행에만 기억한다 */
    }
  }, []);

  const open = choice === null ? sessionListFits(width, minGridWidth) : choice === "open";
  return { open, setOpen };
}
