import { ApiError, uuidEq, type WorkKillResult, type WorkSession } from "../../lib/api";

// 폰의 「멈추기」 문장과 판정 (N4 #3596, ADR-0198 「N4 확정」).
// 화면과 시험이 같은 값을 본다: 버튼은 소유자 + 실행 중·대기 중에서만 있다.

/** 소유자 본인의 running/idle 세션만 멈출 수 있다(서버 409 `work_session_not_running`과 같은 선). */
export function canStopSession(
  session: Pick<WorkSession, "status" | "memberId">,
  memberId: string
): boolean {
  return (
    uuidEq(session.memberId, memberId) &&
    (session.status === "running" || session.status === "idle")
  );
}

export const STOP_CONFIRM_ASK = "이 작업을 멈출까요?";
export const STOP_CONFIRM_DETAIL =
  "맥에서 돌고 있는 작업이 바로 끝나요. 지금까지의 진행 내역은 남지만 이어서 돌릴 수는 없어요.";
export const STOP_BUSY_LINE = "멈추기를 요청하고 있어요.";
export const STOP_STOPPED_LINE = "멈췄어요.";

/** 요청이 서버에 닿은 뒤의 한 줄. 맥이 꺼져 있으면 「멈춘다」고 말하지 않는다. */
export function stopRequestedLine(result: Pick<WorkKillResult, "hostOnline">): string {
  return result.hostOnline
    ? "멈추기를 요청했어요. 맥이 멈추면 여기에 바로 보여요."
    : "맥이 꺼져 있어요. 맥이 켜지면 멈춰요.";
}

/** 실패 문장. 코드로 가른다(문구는 서버가 바꿀 수 있다). */
export function stopFailureLine(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "kill_owner_only":
        return "작업을 시작한 사람의 맥에서만 멈출 수 있어요.";
      case "kill_member_host_only":
        return "공용 호스트의 작업은 여기서 멈출 수 없어요.";
      case "local_session_no_control":
        return "맥에서 직접 연 창은 여기서 멈출 수 없어요.";
      case "work_session_not_running":
        return "이미 멈췄거나 연결이 끊긴 작업이에요.";
      case "work_host_revoked":
        return "이 호스트는 더 이상 연결돼 있지 않아요.";
      default:
        break;
    }
    if (error.status === 404) return "이 작업을 찾지 못했어요. 목록을 새로 불러와 주세요.";
  }
  return "멈추지 못했어요. 잠시 뒤 다시 눌러 주세요.";
}
