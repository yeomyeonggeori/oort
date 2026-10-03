import { useEffect } from "react";
import { useNeedsMeCount } from "@/features/inbox/useNeedsMe";
import { isDesktop } from "@/lib/tauri";

/** 「(3) oort」: 탭 제목 앞에 나에게 필요한 일의 수를 붙인다. */
export function tabTitle(base: string, needsMe: number): string {
  return needsMe > 0 ? `(${needsMe > 99 ? "99+" : needsMe}) ${base}` : base;
}

/**
 * 브라우저 탭 제목에 나에게 필요한 일의 수를 단다(#3340). 수는 독 배지·레일·인박스와
 * 같은 `useNeedsMeCount` 하나다. 앱 안 표시이고 알림이 아니므로 권한이 필요 없다.
 * 데스크탑은 창 제목이 없는 대신 독 배지가 있다. 아무것도 렌더하지 않는다.
 */
export function TabTitleCount() {
  const needsMe = useNeedsMeCount();
  useEffect(() => {
    if (isDesktop()) return;
    const base = document.title.replace(/^\(\d+\+?\)\s*/, "");
    document.title = tabTitle(base, needsMe);
    return () => {
      document.title = base;
    };
  }, [needsMe]);
  return null;
}
