import {
  onEntryDismiss,
  onEntryHold,
} from '@momo/core/features/notifications/entryDismiss';
import {useEffect, useRef} from 'react';

/**
 * 알림이 새 입구로 들어올 때(`dismissTemporarySurfaces()`, #4667) 이 표면을 **자기 닫는 길로** 닫는다.
 *
 * 임시 표면 — 시트·뷰어·메뉴·대화 안의 서랍 — 은 자기가 열려 있는 동안 이 훅을 한 번 건다. 입구는 그 표면들의 닫는
 * 함수를 알지 못한다(상태가 연 컴포넌트마다 지역이다). 그래서 입구는 방송 하나만 하고, 닫는 일은 표면이 한다. 이 훅이
 * 넘기는 `onDismiss` 는 그 표면이 평소 부모에게 「닫아 달라」고 하는 바로 그 함수여야 한다(`onClose`·`onDone`) — 입구가
 * 닫는 길을 하나 더 만들지 않는다.
 *
 * 방송은 표면이 **열려 있는 동안에만** 받는다(마운트 ~ 언마운트). 최신 `onDismiss` 를 ref 로 읽어서, 부모가 렌더마다 새
 * 화살표를 줘도 구독이 다시 서지 않는다 — 방송 도중에 구독이 갈리면 그 표면이 방송을 놓친다.
 *
 * 입력이 든 표면은 같은 방송으로 **초안을 맡긴다**(`useHoldOnEntry`, `lib/entryDrafts.ts`): 닫는 길이 곧 폐기인 표면의
 * 글이 입구 때문에 사라지지 않게. 맡기기는 어느 닫기보다 먼저 불린다(코어의 약속) — 닫는 길이 시트를 걷은 뒤에는 글을
 * 읽을 수 없다.
 */
export function useDismissOnEntry(onDismiss: () => void): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => onEntryDismiss(() => latest.current()), []);
}

/** 알림 입구가 표면을 닫기 **전에** 불린다 — 쓰던 글을 맡기는 자리. 위 훅과 같은 ref 규칙이다. */
export function useHoldOnEntry(onHold: () => void): void {
  const latest = useRef(onHold);
  latest.current = onHold;
  useEffect(() => onEntryHold(() => latest.current()), []);
}
