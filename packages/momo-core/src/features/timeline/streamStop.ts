// =============================================================================
// 멈춘 답 — 정지 버튼 뒤에 남는 것 (ADR-0155).
//
// 스트리밍 답은 **자라는 메시지**다(#1130 전제① — 턴 시작에 행이 생기고 `rev`
// 가 단조로 커진다). 그래서 예전의 「취소 = 아무것도 안 남김」이 성립하지 않는다.
// 사람이 정지를 누른 순간 채널에는 이미 문장이 반쯤 서 있고, 그것을 지우는 선택은
// 기각됐다(ADR-0155 B안 기각): **사람은 그 반쪽을 읽고서 눌렀다.** 근거를 지우면
// 「내가 왜 멈췄지」가 함께 사라진다.
//
// 그래서 남긴다. 남기기만 하면 거짓말이 되므로(C안 기각 — 문장 중간에서 끝난 답이
// 완결된 답과 같은 옷을 입는다) **표시한다**. 이 파일이 그 표시를 정하는 한 자리다.
//
// ## 왜 판정이 코어에 하나뿐인가
//
// 웹과 폰이 각자 「이 메시지는 끊긴 것인가」를 적으면, 한쪽만 고쳐지는 날이 온다.
// 그리고 이 판정은 특히 그렇게 틀리기 쉽다 — **두 개의 입구**가 있기 때문이다:
// 서버가 남긴 도장(`outcome`)과, 그 도장이 실패했을 때의 방어(run 은 끝났는데
// stream 은 열려 있음). 둘 중 하나만 구현한 표면은 대부분의 날에 멀쩡해 보인다.
//
// ## 왜 방어 렌더링이 필요한가 (서버 sweeper 가 아니라)
//
// 닫는 PATCH 는 **best effort** 다(ADR-0155 결정 1). 워커가 그 한 번의 쓰기에서
// 죽으면 메시지는 `streaming: true` 로 남는다. run 의 종결 상태는 이미 durable
// 하므로 — job status 가 진실이다 — 클라이언트는 「run 은 끝났는데 stream 이 열림」
// 을 스스로 알아볼 수 있고, 그것으로 충분하다. 서버가 열린 스트림을 쓸고 다니는
// 장치를 두는 대신 읽는 쪽이 한 줄 더 보게 한 것이 이 ADR 의 거래다.
//
// ## 두 낱말이 다른 이유
//
// 「중단됨」은 **사람의 행위**를 말한다. 메시지 자신이 `outcome: "cancelled"` 라고
// 적혀 있을 때만 쓴다 — 그때만 우리가 그 행위를 안다.
//
// 방어 경로에서는 그것을 모른다. 아는 것은 「답이 더 오지 않는다」뿐이다. 그래서
// 「응답이 끊김」이다. 취소였는지 프로바이더 사망이었는지 모르는 자리에서 「중단됨」
// 이라고 쓰면 아무도 하지 않은 행위를 사람에게 돌리는 것이 된다.
//
// ## 왜 accent 가 아닌가
//
// `pins.ts` 가 「고정됨」에 대해 적어 둔 것과 같은 이유이고, 여기서는 한 겹 더
// 강하다: 이것은 **상태이지 강조가 아니다**. 끊긴 답을 붉거나 밝게 그리면 화면에서
// 가장 눈에 띄는 것이 「실패했다는 사실」이 되는데, 사람이 보러 온 것은 그 위의
// 반쪽 답이다. `danger` 도 아니다 — 정지를 누른 것은 사고가 아니라 사람의 뜻이고,
// 프로바이더가 죽은 것조차 이 행에서는 **서술**이다. 「수정됨」과 같은 흐린 글자.
// =============================================================================

import type { Message } from "../../lib/api";

/**
 * 서버가 스트리밍 조립을 적어 넣는 props 키.
 *
 * Rust `momo_messaging::STREAM_PROPS_KEY` · Swift `Message.streamPropsKey` 와
 * 같은 글자다. 세 곳에 있는 이유는 세 언어이기 때문이지, 세 개의 사실이라서가
 * 아니다.
 */
export const STREAM_PROPS_KEY = "momo.stream";

/** 스트림이 어떻게 끝났는가 — 그냥 끝난 게 아닐 때만 실린다. */
export type StreamOutcome = "cancelled" | "failed";

/** 메시지에 실린 스트리밍 도장. 스트리밍한 적 없는 메시지에는 없다. */
export interface StreamMarker {
  /** 쓴 쪽의 단조 개정 번호. 채널의 `seq` 가 아니다. */
  rev: number;
  /** 아직 더 올 글자가 있는가. 마지막 조각에서 `false` 가 된다. */
  streaming: boolean;
  /** ADR-0155 — 끝난 방식. 정상 완결이면 없다(`null`, 키 부재). */
  outcome: StreamOutcome | null;
}

function readOutcome(value: unknown): StreamOutcome | null {
  return value === "cancelled" || value === "failed" ? value : null;
}

/**
 * 메시지의 스트리밍 도장을 읽는다. 스트리밍한 적 없으면 `null`.
 *
 * `rev` 가 있으면 도장이 있는 것으로 본다 — `streaming` 은 마지막 조각에서
 * `false` 가 되므로 그것만으로는 「조립된 메시지였다」를 잃는다. 서버는 키를
 * 지우지 않고 `false` 로 눕히는데, 그 선택이 여기서 값을 한다.
 *
 * 알 수 없는 `outcome` 값은 `null` 로 떨어진다. 서버가 두 값만 받으므로 도달할 수
 * 없는 모양이지만, 낯선 토큰을 화면에 그대로 내보내는 것보다는 말하지 않는 편이
 * 낫다.
 */
export function streamMarker(message: Message): StreamMarker | null {
  const raw = message.props?.[STREAM_PROPS_KEY];
  if (!raw || typeof raw !== "object") return null;
  const marker = raw as Record<string, unknown>;
  const rev = marker["rev"];
  if (typeof rev !== "number") return null;
  return {
    rev,
    streaming: marker["streaming"] === true,
    outcome: readOutcome(marker["outcome"]),
  };
}

/**
 * 이 메시지를 쓴 run 의 id, 없으면 `null`.
 *
 * `cascadeModel.turnRecordRunId` 와 **일부러 다른 함수**다. 저쪽은 「정착한 턴
 * 기록」으로 좁혀 놓았는데(한 run 이 승인 요청·도구 결과·턴 기록을 다 쓰기 때문에
 * 같은 알림이 세 번 나오는 것을 막으려고), 여기서 묻는 것은 그 반대다 — 자라다
 * 만 메시지에는 그 도장이 없고, 있는 것은 `momo.stream` 뿐이다.
 *
 * 그래서 스트리밍한 적 있는 메시지에만 답한다. 그 좁힘이 저쪽과 같은 역할을 한다:
 * `run_id` 는 에이전트가 쓴 모든 행에 실리므로, 좁히지 않으면 이 판정이 스트리밍과
 * 무관한 행까지 건드린다.
 */
export function streamRunId(message: Message): string | null {
  if (!streamMarker(message)) return null;
  const runId = message.props?.["run_id"];
  return typeof runId === "string" && runId !== "" ? runId.toLowerCase() : null;
}

/**
 * 페이지가 「끝났다」고 말한 run 들의 id (#1166).
 *
 * ## 왜 이 함수가 필요한가
 *
 * 위의 방어 렌더링은 [[isStreamRunEnded]] 를 거쳐 호스트의 종결 기록에 묻는데,
 * 그 기록은 **터미널 프레임을 그 세션에서 본 run** 만 안다(`endedRuns.ts`).
 * 닫는 PATCH 가 실패한 채로 사람이 새로고침하면 볼 프레임이 이미 지나갔고,
 * 반쪽 답이 완결된 답의 옷을 입는다 — ADR-0155 가 C안을 기각한 그 거짓말이다.
 * 그 판을 닫으려고 서버가 페이지 읽기 응답에 `runEnded` 를 실어 보낸다.
 *
 * ## 왜 메시지의 플래그를 그대로 쓰지 않고 run id 를 거두는가
 *
 * 같은 run 이 쓴 행은 하나가 아닐 수 있고, 그중 일부는 이 페이지 뒤에
 * 실시간으로 도착한다. 판정을 행에 붙여 두면 그 행들이 서로 다른 답을 받는다.
 * 그래서 페이지가 가져온 것은 **사실 하나**(이 run 은 끝났다)로 접어 종결
 * 기록에 심고, 꼬리 판정은 예전처럼 그 기록 하나에 대고 묻는다.
 *
 * 열쇠 규칙도 같은 이유로 여기 있다: [[streamRunId]] 가 소문자로 접으므로
 * 스토어에 심는 글자와 나중에 묻는 글자가 어긋날 수 없다. 두 클라가 각자
 * `message.props.run_id` 를 읽었다면 한쪽만 접는 날이 온다.
 *
 * `runEnded` 가 없거나 `false` 인 행은 아무것도 내놓지 않는다 — 모르는 것과
 * 끝난 것은 다르다.
 */
export function endedStreamRunIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.runEnded !== true) continue;
    const runId = streamRunId(message);
    if (runId !== null) ids.push(runId);
  }
  return ids;
}

/**
 * 「이 메시지의 run 이 끝난 것을 보았는가」 — 호스트의 종결 기록에 대고 묻는다.
 *
 * 두 표면이 각자 두 줄로 적으면 한쪽만 소문자로 접거나 한쪽만 스트리밍 메시지로
 * 좁히는 날이 온다. 열쇠 규칙(`streamRunId` 가 소문자로 접는다)이 스토어와
 * 어긋나는 순간 이 판정은 **조용히** 항상 거짓이 되므로, 짓는 자리를 하나로 둔다.
 */
export function isStreamRunEnded(
  message: Message,
  endedRunIds: ReadonlySet<string>,
): boolean {
  const runId = streamRunId(message);
  return runId !== null && endedRunIds.has(runId);
}

/** 사람이 정지를 눌러 얼어붙은 답. 메시지 자신이 그렇다고 적혀 있을 때만. */
export const STREAM_CANCELLED_MARK = "중단됨";

/**
 * 답이 더 오지 않는데 왜인지는 모를 때.
 *
 * 프로바이더 사망(`outcome: "failed"`)과, 닫는 PATCH 가 실패해 열린 채 남은
 * 메시지가 같은 낱말을 쓴다. 둘 다 사람에게는 같은 사실이다 — 문장이 끊겼고 뒤는
 * 오지 않는다.
 */
export const STREAM_CUT_OFF_MARK = "응답이 끊김";

/**
 * 이 메시지 꼬리에 설 낱말, 없으면 `null` — **판정 하나** (ADR-0155 결정 3).
 *
 * `runIsOver` 는 호스트가 넣는다. 코어는 순수하고, 「이 run 이 끝났는가」는
 * 표면마다 다른 곳에서 온다(웹·폰은 `agentRail.isRunOver`, 혹은 히스토리를 읽는
 * 자리라면 이미 종결된 run 의 목록). 메시지가 run 을 가리키지 않거나 호스트가
 * 모르면 `false` 를 넣으면 되고, 그때는 도장이 있는 경우만 그린다.
 *
 * 침묵이 기본값이다. 잘 도착한 답, 아직 도착 중인 답, 사람이 친 글은 전부 `null`
 * 을 받는다 — 꼬리 한 줄은 할 말이 있을 때만 선다.
 */
export function streamStopMark(
  message: Message,
  runIsOver: boolean,
): string | null {
  const marker = streamMarker(message);
  if (!marker) return null;
  if (marker.outcome === "cancelled") return STREAM_CANCELLED_MARK;
  if (marker.outcome === "failed") return STREAM_CUT_OFF_MARK;
  // 방어 렌더링. 도장이 없는데 열려 있고 run 은 끝났다 — 닫는 PATCH 가 못 닿은
  // 메시지다. 아직 열려 있고 run 도 살아 있으면 그냥 도착 중이므로 아무 말도 하지
  // 않는다.
  if (marker.streaming && runIsOver) return STREAM_CUT_OFF_MARK;
  return null;
}
