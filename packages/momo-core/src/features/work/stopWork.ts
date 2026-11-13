import {
  ApiError,
  uuidEq,
  type WorkHost,
  type WorkKillResult,
  type WorkSession,
} from "../../lib/api";

// 「멈추기」 문장과 판정 (N4 #3596, ADR-0198 「N4 확정」). 폰과 웹·데스크탑(#5595)이 같이 쓴다.
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

/**
 * 웹·데스크탑 세션 상세의 멈추기가 어느 길로 가는가 (#5595, ADR-0188 D3).
 *
 * - `kill`: kill 라우트(`work_kill.rs`)가 받는 세션이다. 세션 주인의 맥(`scope=member`, 호스트 주인 =
 *   세션 주인)에서 연 세션이고, 맥이 프로세스 트리를 끝낸다. 폰의 멈추기와 같은 길이다.
 * - `ledger`: kill 라우트가 받지 않는 세션이다. 공용 호스트(403 `kill_member_host_only`), 맥에서
 *   직접 연 창(`local_pty`, 403 `local_session_no_control`), 남의 맥으로 옮겨진 세션(403
 *   `kill_owner_only`), 폐기된 호스트(409 `work_host_revoked`). 이 세션들은 지금까지처럼 원장
 *   종료(`PATCH ended`)를 쓴다.
 *
 * 길은 **세션 주인** 기준이다. 보는 사람이 주인인지(라우트의 다른 조건)는 `canStopSession`이 따로
 * 판정한다. 그래서 남이 보는 내 맥 세션도 「멈추기」가 잠긴 모양으로 보인다. 호스트 목록을 아직 모르면
 * `kill`이다. 서버가 마지막 판정자이고, 거절은 `stopFailureLine`이 말한다.
 */
export type StopPath = "kill" | "ledger";

export function stopPath(
  session: Pick<WorkSession, "hostId" | "memberId" | "origin">,
  hosts: readonly Pick<WorkHost, "id" | "scope" | "ownerMemberId" | "revokedAtMs">[] | undefined
): StopPath {
  if (session.origin === "local_pty") return "ledger";
  const host = hosts?.find((candidate) => uuidEq(candidate.id, session.hostId));
  if (!host) return "kill";
  const ownersMac = host.scope === "member" && uuidEq(host.ownerMemberId, session.memberId);
  return ownersMac && host.revokedAtMs === undefined ? "kill" : "ledger";
}

/** `stopPath`가 kill인가. 화면이 갈래를 고를 때 쓴다. */
export function stopsWithKill(
  session: Pick<WorkSession, "hostId" | "memberId" | "origin">,
  hosts: readonly Pick<WorkHost, "id" | "scope" | "ownerMemberId" | "revokedAtMs">[] | undefined
): boolean {
  return stopPath(session, hosts) === "kill";
}

/** 멈추기 단추와 확인 단추의 낱말. */
export const STOP_ACTION_LABEL = "멈추기";
export const STOP_CONFIRM_ASK = "이 작업을 멈출까요?";
export const STOP_CONFIRM_DETAIL =
  "맥에서 돌고 있는 작업을 끝내요. 지금까지의 진행 내역은 남아요.";
export const STOP_BUSY_LINE = "멈추기를 요청하고 있어요.";
export const STOP_STOPPED_LINE = "멈췄어요.";

/** 요청이 서버에 닿은 뒤의 한 줄. 맥이 꺼져 있으면 「멈춘다」고 말하지 않는다. */
export function stopRequestedLine(result: Pick<WorkKillResult, "hostOnline">): string {
  return result.hostOnline
    ? "멈추기를 요청했어요. 맥이 멈추면 여기에 바로 보여요."
    : "맥이 꺼져 있어요. 맥이 켜지면 멈춰요.";
}

/** 남의 작업. 거절 문장이자 웹 상세가 단추를 잠글 때의 이유다(#5595). */
export const STOP_OWNER_ONLY_LINE = "작업을 시작한 사람의 맥에서만 멈출 수 있어요.";
/** 끝났거나 끊긴 작업. 거절 문장이자 웹 상세가 단추를 잠글 때의 이유다(#5595). */
export const STOP_NOT_RUNNING_LINE = "이미 멈췄거나 연결이 끊긴 작업이에요.";

/** 실패 문장. 코드로 가른다(문구는 서버가 바꿀 수 있다). */
export function stopFailureLine(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "kill_owner_only":
        return STOP_OWNER_ONLY_LINE;
      case "kill_member_host_only":
        return "공용 호스트의 작업은 여기서 멈출 수 없어요.";
      case "local_session_no_control":
        return "맥에서 직접 연 창은 여기서 멈출 수 없어요.";
      case "work_session_not_running":
        return STOP_NOT_RUNNING_LINE;
      case "work_host_revoked":
        return "이 호스트는 더 이상 연결돼 있지 않아요.";
      default:
        break;
    }
    if (error.status === 404) return "이 작업을 찾지 못했어요. 목록을 새로 불러와 주세요.";
  }
  return "멈추지 못했어요. 잠시 뒤 다시 눌러 주세요.";
}
