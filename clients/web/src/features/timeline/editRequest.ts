import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

// =============================================================================
// 밖에서 「이 메시지를 고쳐 줘」라고 부르는 길 (이슈 #5191).
//
// 고치는 중인지는 행(`MessageRow`)이 자기 상태로 쥔다: 편집기는 그 행 **안**에서 열리고, 저장·취소·실패 문구도 그 행의
// 것이다. 입력칸의 ↑ 키는 그 행의 바깥에 있다. 상태를 위로 끌어올리면 모든 행이 다시 그려지는 값이 생기고, 그 값은 한
// 줄을 위한 것이다. 그래서 위에서 **요청 하나**를 내려 보내고, 해당 행이 마운트돼 있으면(가상 목록이라 아닐 수 있다)
// 그 행이 받아 자기 편집기를 연다. 받은 행은 요청을 비운다(`consume`).
//
// 요청은 오래 살지 않는다. 대상 행이 끝내 마운트되지 않으면(스크롤이 모자랐다) 몇 초 뒤 스스로 사라져야, 한참 뒤 사용자가
// 그 줄을 스크롤해 지나갈 때 편집기가 불쑥 열리지 않는다.
// =============================================================================

export interface EditRequest {
  /** 고칠 메시지의 id. 대소문자는 비교하는 쪽이 접는다. */
  messageId: string;
  /** 같은 메시지를 두 번 불러도 두 번째가 다시 열리게 하는 값. */
  nonce: number;
}

export interface EditRequestChannel {
  request: EditRequest | null;
  /** 행이 요청을 받았다(열었든, 더는 열 수 없어 거절했든). 같은 요청이 다시 열리지 않게 비운다. */
  consume: (nonce: number) => void;
  /** 요청으로 열린 편집기가 끝났다(저장이든 취소든). 부른 쪽이 초점을 돌려받는다. */
  finished: (nonce: number) => void;
}

export const EditRequestContext = createContext<EditRequestChannel | null>(null);

/** 요청이 대상 행을 기다리는 시간. 가상 목록이 그 행을 마운트하는 데 걸리는 몇 프레임보다 넉넉하다. */
export const EDIT_REQUEST_TTL_MS = 3000;

/**
 * 요청 채널 하나. 호출하는 쪽(입력칸을 가진 화면)이 `requestEdit(id)` 로 부르고, `channel` 을 `EditRequestContext.Provider` 로
 * 내려 보낸다. `onFinished` 는 요청으로 열린 편집기가 끝났을 때 한 번 불린다(보통 입력칸 초점 복귀).
 */
export function useEditRequestChannel(onFinished: (nonce: number) => void): {
  channel: EditRequestChannel;
  requestEdit: (messageId: string) => number;
} {
  const [request, setRequest] = useState<EditRequest | null>(null);
  const nonceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const consume = useCallback(
    (nonce: number) => {
      setRequest((current) => (current !== null && current.nonce === nonce ? null : current));
      // 타이머는 **살아 있는 요청의 것일 때만** 치운다. 낡은 nonce 의 consume(이미 갈린 요청을 뒤늦게 비우는 행)이 새 요청의
      // TTL 을 같이 지우면, 새 요청은 끝내 받는 행이 없을 때 사라지지 않고 남아 한참 뒤 스크롤에 편집기를 불쑥 연다.
      if (nonce === nonceRef.current) clearTimer();
    },
    [clearTimer]
  );

  const requestEdit = useCallback(
    (messageId: string) => {
      nonceRef.current += 1;
      const nonce = nonceRef.current;
      setRequest({ messageId, nonce });
      clearTimer();
      timerRef.current = setTimeout(() => consume(nonce), EDIT_REQUEST_TTL_MS);
      return nonce;
    },
    [clearTimer, consume]
  );

  const finished = useCallback((nonce: number) => finishedRef.current(nonce), []);

  useEffect(() => clearTimer, [clearTimer]);

  const channel = useMemo(() => ({ request, consume, finished }), [request, consume, finished]);
  return { channel, requestEdit };
}
