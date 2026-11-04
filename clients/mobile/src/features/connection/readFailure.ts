import type {ConnectionCause, ConnectionView} from '@momo/core/features/connection/model';
import {causeOfFailure, causeOfUnknownFailure} from '@momo/core/features/connection/failure';
import {shellSpeaksFor} from '@momo/core/features/connection/shellStrip';
import {useCallback} from 'react';
import {useOnline} from '../inbox/useOnline';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 읽기가 실패한 자리가 무엇을 말하나 (#5285, 검증 5a 수리 ⑤, #5201 S-C 규칙의 폰판).
//
// 홈·받은함·에이전트 목록이 서버에 닿지 못하면 같은 원인이 세 곳에서 되풀이됐다: 위의 셸 띠(`ShellConnectionStrip`), 목록 자리의 오류 상자, 카드의 오류 줄.
// 감사 문서 §4 원칙 3: **지속 신호는 한 곳, 실패한 곳은 행동과 짧은 이유**다. 띠가 이미 원인(오프라인 / 서버에 닿지 못함)을 말하면 실패한 자리는 결과(무엇을
// 불러오지 못했나)와 행동(다시 시도)만 말한다 - 받은함의 「마지막 동기화」 줄이 #5222 에서 이미 그렇게 한다. 띠가 침묵이면(서버가 직접 답한 오류 · 알 수
// 없는 원인) 이 자리가 짧은 이유를 말한다.
//
// 원인은 실패한 **그 자리의** 실패 객체로 정한다(`causeOfFailure`: 서버 원문·상태 코드는 어떤 문장에도 들어가지 않는다). 읽기가 **멈춘** 채(기기가 꺼져 react-query 가
// 요청을 보내지 않았다, 오류 객체가 없다)면 기기가 아는 사실 하나만 안다: 꺼져 있으면 오프라인, 아니면 모른다.
//
// 이 파일은 순수한 판정(`readFailureOf`)과 그것을 화면에 묶는 훅 하나다. 문장은 코어 `copyForCause` 와 사전에 있다.
// =============================================================================

export interface ReadFailure {
  /** 이 실패가 말하는 원인. 연결 쪽 원인이 아니면(서버가 직접 답한 오류 · 알 수 없음) null. */
  readonly cause: ConnectionCause | null;
  /**
   * 셸 띠가 **같은 원인**을 이미 말하고 있다. 참이면 실패한 자리는 원인 문장을 되풀이하지 않는다. 다른 원인이거나(띠는 서버에 닿지 못함인데 이 실패는 서버가
   * 직접 답한 오류) 띠가 침묵이면 거짓이다.
   */
  readonly spoken: boolean;
}

/**
 * `error`(실패한 읽기의 오류 객체. 읽기가 멈춰 오류가 없으면 `null`)가 말하는 원인과, 지금 띠가 그것을 말하고 있는가.
 * `view` 는 연결 상태 모델의 모습이다 - 모델이 서 있지 않은 곳(격리 하네스·시험)은 `null` 이라 띠가 말한 적이 없다.
 */
export function readFailureOf(
  error: unknown,
  deviceOnline: boolean | null,
  view: ConnectionView | null,
): ReadFailure {
  const cause =
    error === null || error === undefined
      ? causeOfUnknownFailure(deviceOnline)
      : causeOfFailure(error, deviceOnline);
  // 「띠가 말하는 원인」은 코어 `shellSpeaksFor` 한 곳이 정한다(기기 오프라인·서버에 닿지 못함만). 규칙을 여기서 다시 적지 않는다.
  const spoken =
    cause !== null && view !== null && shellSpeaksFor(view) && view.cause === cause;
  return {cause, spoken};
}

/**
 * 화면이 읽기 실패 하나(오류 객체 또는 멈춘 읽기의 `null`)를 `ReadFailure` 로 바꾸는 함수. 기기 온라인은 NetInfo 로 읽고(연결 모델의 입력과 같은 원천), 띠가
 * 말하는지는 연결 공급자의 모습으로 읽는다. 같은 화면이 읽기 여럿(채널·명부·사용량…)을 각자 판정하므로 함수로 돌려준다.
 */
export function useReadFailureOf(): (error: unknown) => ReadFailure {
  const online = useOnline();
  const view = useConnection()?.view ?? null;
  return useCallback(
    (error: unknown) => readFailureOf(error, online, view),
    [online, view],
  );
}
