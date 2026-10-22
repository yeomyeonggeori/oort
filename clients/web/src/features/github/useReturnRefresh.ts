import { useEffect, useRef } from "react";

// 이 사이에 다시 온 포커스·보임은 하나로 센다. 창이 앞으로 올 때 `focus` 와 `visibilitychange` 가
// 잇따라 와서 같은 요청을 두 번 쏘지 않게 한다.
const RETURN_THROTTLE_MS = 750;

/**
 * 시스템 브라우저에 일을 맡기고 온 데스크탑 창이 다시 앞으로 오면 `onReturn` 을 부른다 (#4220).
 *
 * 데스크탑 셸은 GitHub 앱 만들기·설치를 시스템 브라우저에서 한다. 그 일이 끝나도 앱은 알 길이
 * 없으므로(콜백은 서버가 받는다), 창이 포커스를 되찾는 순간 상태를 다시 읽어 「등록됨」으로 바꾼다.
 * `DesktopNotificationGroup` 이 시스템 설정을 다녀온 뒤 권한을 다시 읽는 것과 같은 손잡이다
 * (`focus` + `visibilitychange`). 앱의 질의 기본값이 `refetchOnWindowFocus: false` 라 직접 건다.
 *
 * `active` 가 거짓이면 리스너가 없다: 웹 브라우저 탭은 이 훅을 켜지 않아 지금 동작 그대로다.
 */
export function useReturnRefresh(active: boolean, onReturn: () => void): void {
  const latest = useRef(onReturn);
  useEffect(() => {
    latest.current = onReturn;
  });

  useEffect(() => {
    if (!active) return;
    let lastAt = 0;
    function fire() {
      const now = Date.now();
      if (now - lastAt < RETURN_THROTTLE_MS) return;
      lastAt = now;
      latest.current();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") fire();
    }
    window.addEventListener("focus", fire);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", fire);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
