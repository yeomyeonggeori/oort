import { useCallback, useEffect, useState } from "react";
import { sessionListFits } from "@momo/core/features/workbench/workTab";
import { setSidebarCollapsed, useSidebarCollapsed } from "@/app/sidebarCollapseStore";

// 세션 목록을 펴 둘지(#2856, 제안서 §3.3 → #3280). 「내 작업」의 세션 목록은 이제 목록 열이고,
// 접힘은 모든 탭이 공유하는 상태 한 벌이다(`sidebarCollapseStore`, 기기별로 기억한다).
// 제목줄의 접기 단추와 ⌘B가 그것을 토글하고, 이 목록에는 접기·펴기 단추가 없다.
//
// - 접혀 있으면(사람이 접었다) 닫힌다.
// - 접힌 적이 없으면 창 폭으로 정한다: 목록(268)을 편 채로 지금 배치가 칸 최소 폭(240)을
//   못 지키면 이번엔 접어 둔다(1280 창 4×2). 이것은 저장하지 않는다.
// - 사람이 이번 실행에 직접 편 목록(제목줄 단추·⌘B·⌘J)은 폭이 모자라도 접지 않는다.
//   「펴기」는 이번 실행에만 기억한다: 좁은 창에서 편 선택이 다음에 연 더 좁은 창에서
//   격자를 몰래 한 칸으로 접지 않게 한다(design-review M3).

function windowWidth(): number {
  return typeof window === "undefined" ? 0 : window.innerWidth;
}

export function useSessionListOpen(minGridWidth: number): {
  open: boolean;
  /** 사람의 선택. 접기는 기억하고(공유 상태), 펴기는 이번 실행에만 기억한다. */
  setOpen: (open: boolean) => void;
} {
  const collapsed = useSidebarCollapsed();
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [width, setWidth] = useState(windowWidth);

  useEffect(() => {
    const onResize = () => setWidth(windowWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 접힘 상태가 펴짐으로 바뀌면(제목줄 단추·⌘B) 사람이 편 것이다.
  const [wasCollapsed, setWasCollapsed] = useState(collapsed);
  if (wasCollapsed !== collapsed) {
    setWasCollapsed(collapsed);
    setPinnedOpen(!collapsed);
  }

  const setOpen = useCallback((open: boolean) => {
    setPinnedOpen(open);
    setSidebarCollapsed(!open);
  }, []);

  const open = collapsed ? false : pinnedOpen || sessionListFits(width, minGridWidth);
  return { open, setOpen };
}
