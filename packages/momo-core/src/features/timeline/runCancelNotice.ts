import type { Message } from "../../lib/api";

// =============================================================================
// 실행 중단 시스템 줄 (#5067).
//
// 사람이 에이전트의 실행을 멈추면 서버가 방에 시스템 한 줄을 남긴다
// (`routes/agent_runs.rs` `CANCEL_SYSTEM_LINE` · `CANCEL_PROPS_KIND`):
// `type: "system"`, `props.kind = "agent_run_cancelled"`. 작성자는 **멈춘 사람**이다 —
// 에이전트가 한 말도, 그 사람이 한 말도 아니라 방에 알리는 줄이라서 서버가 이 표식을
// 달아 둔다. 클라이언트가 표식을 보지 않으면 그 줄은 멈춘 사람이 쓴 글처럼 그려진다
// (검증 줄 1회차 design-review M3).
//
// 이 파일이 하는 일은 **판정 하나**다: 이 행이 그 줄인가. 어떻게 그릴지는 표면이
// 정한다(폰 대화는 가운데의 조용한 시스템 줄). 문장은 서버가 정한 본문을 그대로 쓴다 —
// 여기서도 표면에서도 고치지 않는다(문장은 엔진 몫이다).
// =============================================================================

/** 서버가 이 시스템 줄에 붙이는 표식 (`agent_runs.rs` `CANCEL_PROPS_KIND`). */
export const RUN_CANCELLED_NOTICE_KIND = "agent_run_cancelled";

/**
 * 이 행이 「사람이 실행을 중단했다」는 서버의 시스템 줄인가. `type` 이 `system` 인 것까지
 * 함께 본다 — 사람이 보낸 글은 표식(`props.kind`)을 흉내 내도 이 줄이 아니다.
 */
export function isRunCancelledNotice(
  message: Pick<Message, "type" | "props">
): boolean {
  return (
    message.type === "system" &&
    message.props?.["kind"] === RUN_CANCELLED_NOTICE_KIND
  );
}
