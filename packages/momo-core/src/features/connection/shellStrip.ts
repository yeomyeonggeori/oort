import { presentConnection, type ConnectionPresentation } from "./presentation";
import type { ConnectionView } from "./model";

// =============================================================================
// 폰 셸 띠: 어느 원인이 홈·받은함·에이전트까지 말하나 (#5222, #5201 S-D, owner 결정 ②·⑥).
//
// 폰은 두 곳에서 연결을 말한다.
//   · 대화 화면의 띠(머리 밑에 매달린 알약): 모든 원인. 연결 중·실시간만 끊김·알 수 없음·오프라인·서버에 닿지 못함·복구.
//   · 셸 띠(홈·받은함·에이전트 목록 위): **기기 오프라인과 서버에 닿지 못함만.** 실시간(소켓)만 끊긴 것은 대화·에이전트
//     진행을 보는 화면에서만 뜻이 있다(감사 문서 §1-2). 홈에 「새 글이 늦게 보일 수 있어요」를 세우면 사람이 할 일이 없다.
//
// 복구 표시(「끊김」이 보였을 때만 2초 「다시 연결됐어요」)는 **셸 띠가 섰던 경우에만** 셸에서 한다. 실시간만 끊겼다가
// 돌아온 것을 홈이 따로 알리면 홈은 끊김을 말한 적이 없는데 「다시 연결됐어요」만 말하는 꼴이다. 섰었다는 기억(`stood`)은
// 틈이 완전히 가라앉을 때까지 간다 — 기기가 돌아와도 소켓이 다시 붙기까지 1~10초가 걸리고, 그 사이 띠는 잠시
// 비었다가(소켓 틈은 셸이 말하지 않는다) 붙는 순간 확인 표시를 2초 보인다.
//
// 전부 순수하다: 문구 키·마크·톤은 `presentConnection`(카드·띠가 같이 읽는 판정)에서 오고, 이 파일은 「셸이 말하나」만 더한다.
// =============================================================================

/** 이 원인은 셸(홈·받은함·에이전트)까지 말한다. 기기 오프라인과 서버에 닿지 못함. */
export function shellSpeaksFor(view: ConnectionView): boolean {
  return view.phase === "down" && (view.cause === "deviceOffline" || view.cause === "serverUnreachable");
}

/** 셸 띠가 지금 그릴 것. 말할 것이 없으면 null. */
export function presentShellStrip(
  view: ConnectionView,
  recovered: boolean,
  stood: boolean
): ConnectionPresentation | null {
  if (shellSpeaksFor(view)) return presentConnection(view, false);
  if (recovered && stood) return presentConnection(view, true);
  return null;
}

/**
 * 「셸 띠가 섰었다」는 기억의 다음 값. 셸이 말하는 원인이면 서고, 틈이 완전히 가라앉으면(정상이고 복구 표시도 없다) 잊는다.
 * 그 사이(소켓 틈의 침묵·「연결 중」·실시간만 끊김, 복구 표시 2초)는 그대로 둔다.
 */
export function nextShellStood(view: ConnectionView, recovered: boolean, stood: boolean): boolean {
  if (shellSpeaksFor(view)) return true;
  if (view.phase === "ok" && !recovered) return false;
  return stood;
}
