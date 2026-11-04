import { useEffect } from "react";
import { isDesktop, setDockBadge } from "@/lib/tauri";
import { useDockBadgeCount } from "./useDockBadgeCount";

/**
 * 독 배지를 그린다 (#3339). 아무것도 렌더하지 않는다. 데스크탑 밖에서는 효과도 없다.
 * 수는 `useDockBadgeCount` 하나에서 온다(레일·인박스 배지, 메뉴 막대 아이콘의 점과 같은 값).
 */
export function DockBadge() {
  const count = useDockBadgeCount();

  useEffect(() => {
    if (!isDesktop()) return;
    void setDockBadge(count);
  }, [count]);

  // 앱이 내려갈 때 남은 배지가 거짓이 되지 않게 한다.
  useEffect(
    () => () => {
      if (isDesktop()) void setDockBadge(0);
    },
    []
  );
  return null;
}
