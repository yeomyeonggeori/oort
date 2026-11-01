import { useEffect, useRef } from "react";
import { onEntryDismiss } from "@momo/core/features/notifications/entryDismiss";

/**
 * 알림이 새 입구로 들어올 때(`dismissTemporarySurfaces()`, #4667) 이 표면을 **자기 닫는 길로** 닫는다.
 *
 * 대화상자·서랍·팔레트처럼 라우트를 덮는 표면은 자기가 열려 있는 동안 이 훅을 한 번 건다. 알림 입구
 * (`DesktopNotifications` 의 `landOnNotification`)는 그 표면들의 닫는 함수를 알지 못한다 — 상태가 연
 * 컴포넌트마다 지역이다. 그래서 입구는 방송 하나만 하고 닫는 일은 표면이 한다. 넘기는 `onDismiss` 는 그
 * 표면이 평소 Esc·취소로 부르는 바로 그 닫는 길이어야 한다(입구가 닫는 길을 하나 더 만들지 않는다).
 *
 * 최신 `onDismiss` 를 ref 로 읽어서 부모가 렌더마다 새 화살표를 줘도 구독이 다시 서지 않는다(폰의 같은 이름의
 * 훅과 같은 규칙, `clients/mobile/src/lib/useDismissOnEntry.ts`).
 */
export function useDismissOnEntry(onDismiss: () => void): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => onEntryDismiss(() => latest.current()), []);
}
