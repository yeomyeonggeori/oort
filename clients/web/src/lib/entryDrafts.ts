import { useEffect, useState } from "react";
import { useHoldOnEntry } from "./useDismissOnEntry";

// =============================================================================
// 알림 클릭이 닫아 버린 대화상자의 입력 (#5058). 폰의 `clients/mobile/src/lib/entryDrafts.ts` 와 같은 규칙이다.
//
// 알림 클릭은 열려 있던 대화상자를 모두 걷는다(`design/ui/dialog.tsx`, #4667). 데스크탑은 어느 배너가 눌렸는지 모르고 「창이 앞에
// 왔다」를 클릭으로 어림하므로(`DesktopNotifications.tsx`) 사람이 대화상자에 글을 쓰다 다른 창에 갔다 돌아온 것만으로도 걷힐 수 있다.
// 그때 쓰던 입력까지 사라지면 안 된다.
//
// 규칙은 넷이다.
//   1. **방송이 올 때만** 맡긴다(`useHoldDraftOnEntry`). 사람이 취소·Esc 로 닫은 대화상자는 평소처럼 비어서 다시 선다.
//   2. 같은 대화상자가 다시 서면 **한 번** 돌려준다 — 열릴 때 마운트되는 대화상자는 `useRestoredEntryDraft`, 마운트된 채 열림만
//      바뀌는 대화상자는 열리는 순간 `takeEntryDraft`. 돌려주면 지운다.
//   3. **이 페이지의 메모리에만** 둔다. 디스크에 쓰지 않는다 — 사람이 쓴 글이고 보내기 전에는 서버도 본 적이 없다.
//   4. **로그아웃이 비운다**(`clearEntryDrafts`, `app/session.tsx` 의 `signOut`·만료). 한 페이지 안에서 같은 워크스페이스로 다른 사람이
//      이어 들어와도 앞 사람의 입력이 보이지 않는다. 키가 워크스페이스로 묶이는 것은 다른 워크스페이스를 막는다.
//
// 이미 입력을 스스로 지키는 대화상자는 이 모듈을 쓰지 않는다: 채널 만들기는 셸의 provider 가 초안을 쥐고 있어(`CreateChannelProvider`)
// 어떻게 닫혀도 남는다. 이 모듈은 그런 자리가 없는 대화상자의 몫이다.
// =============================================================================

const held = new Map<string, unknown>();

function peek<T>(key: string | undefined): T | undefined {
  return key === undefined ? undefined : (held.get(key) as T | undefined);
}

/**
 * 열릴 때 마운트되는 대화상자가 **첫 렌더에** 읽는다(한 프레임 뒤에 채우면 입력이 깜빡인다). 읽은 뒤(마운트 뒤의 효과에서) 비운다 —
 * 초기화 함수는 두 번 불릴 수 있어 거기서 지우면 두 번째 부름이 빈손이 된다.
 */
export function useRestoredEntryDraft<T>(key: string | undefined): T | undefined {
  const [restored] = useState(() => peek<T>(key));
  useEffect(() => {
    if (key !== undefined) held.delete(key);
  }, [key]);
  return restored;
}

/**
 * 맡겨 둔 입력을 꺼내고 비운다. 마운트된 채 열림만 바뀌는 대화상자가 **열리는 순간** 입력을 채울 때 쓴다 — 맡겨 둔 것이 없으면
 * `undefined` 라 평소의 시작값으로 선다.
 */
export function takeEntryDraft<T>(key: string | undefined): T | undefined {
  const draft = peek<T>(key);
  if (key !== undefined) held.delete(key);
  return draft;
}

/**
 * 알림 클릭이 이 대화상자를 닫을 때 쓰던 입력을 맡긴다. `read` 가 `undefined` 를 주면 맡길 것이 없다(저장 중이거나 바뀐 것이 없다).
 * `key` 가 없으면 아무것도 하지 않는다 — 어느 입력인지 모르는 대화상자가 남의 자리에 쓰지 않는다. 호출은 닫기보다 먼저다(코어의 약속).
 */
export function useHoldDraftOnEntry<T>(key: string | undefined, read: () => T | undefined): void {
  useHoldOnEntry(() => {
    if (key === undefined) return;
    const draft = read();
    if (draft !== undefined) held.set(key, draft);
  });
}

/** 맡겨 둔 입력의 자리 — 워크스페이스로 묶는다. */
export const newDmDraftKey = (workspaceId: string): string => `${workspaceId}:new-dm`;
export const statusDraftKey = (workspaceId: string): string => `${workspaceId}:set-status`;

/** 맡겨 둔 입력을 모두 비운다. 로그아웃과 로그인 만료에서 부른다(`app/session.tsx`). */
export function clearEntryDrafts(): void {
  held.clear();
}

/** 시험 이음매: 맡겨 둔 것을 읽는다(지우지 않는다). */
export function __peekEntryDraft<T>(key: string): T | undefined {
  return peek<T>(key);
}

/** 시험 이음매. 운영 코드는 `clearEntryDrafts` 를 쓴다. */
export function __resetEntryDrafts(): void {
  clearEntryDrafts();
}
