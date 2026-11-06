import { CONNECTION_KEYS as K, type ConnectionPlainKey } from "./copyKeys";
import type { ConnectionView } from "./model";

// =============================================================================
// 연결 카드(웹 사이드바)와 위쪽 띠가 **같이** 읽는 「무엇을 어떻게 그리나」 (#5220, #5201 S-B).
//
// 모델이 말할 것(문장 키·행동)을 정하고, 이 함수는 화면의 몫 하나만 더한다: 곁에 서는 표시가 무엇인가.
// 카드와 띠가 각자 이 판정을 하면 한쪽만 고쳐지는 순간이 온다(감사 문서 §4 원칙 3: 말은 한 곳에서, 모습은 한 벌).
//
//   moving  다시 붙는 중이다. 오르트 로더가 돈다(연결 중, 실시간만 끊김, 서버에 닿지 못함: 자동으로 다시
//           시도하는 동안).
//   still   **지금 진행 중인 것이 없다.** 같은 마크를 세워 둔다(기기 오프라인: 기기가 망이 없다고 했고
//           다시 연결 단추도 없다). 문장이 멈췄다고 말하는데 마크가 도는 것은 거짓이다(#3961).
//   check   방금 정상으로 돌아왔다(「끊김」이 보였던 경우의 2초).
// =============================================================================

export const CONNECTION_MARK = { moving: "moving", still: "still", check: "check" } as const;
export type ConnectionMark = (typeof CONNECTION_MARK)[keyof typeof CONNECTION_MARK];

export const CONNECTION_TONE = {
  connecting: "connecting",
  down: "down",
  offline: "offline",
  unreachable: "unreachable",
  recovered: "recovered",
} as const;
export type ConnectionTone = (typeof CONNECTION_TONE)[keyof typeof CONNECTION_TONE];

export interface ConnectionPresentation {
  readonly tone: ConnectionTone;
  readonly title: ConnectionPlainKey;
  readonly detail: ConnectionPlainKey | null;
  readonly mark: ConnectionMark;
  /** 「지금 다시 연결」 단추가 서나. 모델의 `action`이 있을 때만이다(연결 중·오프라인에는 없다). */
  readonly canReconnect: boolean;
}

export function presentConnection(view: ConnectionView, recovered: boolean): ConnectionPresentation | null {
  if (view.phase === "connecting" && view.copy !== null) {
    return {
      tone: CONNECTION_TONE.connecting,
      title: view.copy.title,
      detail: null,
      mark: CONNECTION_MARK.moving,
      canReconnect: false,
    };
  }
  if (view.phase === "down" && view.copy !== null) {
    const tone =
      view.cause === "deviceOffline"
        ? CONNECTION_TONE.offline
        : view.cause === "serverUnreachable"
          ? CONNECTION_TONE.unreachable
          : CONNECTION_TONE.down;
    return {
      tone,
      title: view.copy.title,
      detail: view.copy.detail,
      mark: tone === CONNECTION_TONE.offline ? CONNECTION_MARK.still : CONNECTION_MARK.moving,
      canReconnect: view.action?.kind === "reconnectNow",
    };
  }
  // 로그인 만료(`expired`)는 여기서 말하지 않는다: 앱이 곧바로 로그인 화면으로 돌아가고 그 화면의 안내는
  // 따로 선다(S-C).
  if (recovered && (view.phase === "ok" || view.phase === "quiet")) {
    return {
      tone: CONNECTION_TONE.recovered,
      title: K.recovered,
      detail: null,
      mark: CONNECTION_MARK.check,
      canReconnect: false,
    };
  }
  return null;
}

// ---- 대화 띠가 「끊김」을 실제로 그린 적이 있나 (#5403) ------------------------------------------------------
// 코어 모델의 「끊김이 보였다」(`sawDown`)는 **모델이 끊김으로 읽은 것**이지 어느 화면이 그린 것이 아니다. 폰의 대화 띠는 대화를 열어
// 둔 동안에만 있고(홈은 실시간만 끊긴 것을 말하지 않는다), 앱이 뒤에 가 있으면 아무도 보지 않는다. 그래서 띠는 **자기가 끊김을
// 그린 적이 있을 때만** 「다시 연결됐어요」를 말한다 - 대화를 막 열었을 때(띠가 새로 선 곳)의 재연결은 아무것도 보이지 않는다.
// 셸 띠의 `nextShellStood`/`presentShellStrip` 과 같은 문법이다(셸은 말하는 원인이 둘뿐이라 따로 있다).

/**
 * 「띠가 끊김을 그린 적이 있다」의 다음 값. 끊김이 **앞에서** 그려지면 서고(`foreground`: 앱이 앞에 있다 - 뒤에 있는 동안 그려진 띠는 아무도
 * 보지 않았다), 틈이 완전히 가라앉으면(정상이고 복구 표시도 없다) 잊는다. 「연결 중」과 복구 표시 2초는 그대로 둔다(눌러서 다시
 * 연결해도, 붙은 뒤의 확인이 끝날 때까지 기억이 간다).
 */
export function nextBandStood(view: ConnectionView, recovered: boolean, stood: boolean, foreground = true): boolean {
  if (view.phase === "down") return foreground ? true : stood;
  if (view.phase === "ok" && !recovered) return false;
  return stood;
}

/** 대화 띠가 지금 그릴 것: 「다시 연결됐어요」는 이 띠가 끊김을 그린 적이 있을 때만이다. */
export function presentBand(view: ConnectionView, recovered: boolean, stood: boolean): ConnectionPresentation | null {
  return presentConnection(view, recovered && stood);
}
