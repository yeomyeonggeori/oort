import { uuidEq, type WorkHost, type WorkSession } from "@momo/core/lib/api";

// =============================================================================
// 작업 콘솔 위치 배지 (#1289).
//
// 이 표면의 T1/T2/T3는 요금제나 세션 상태가 아니라 **실행 위치**다. 유일한
// 판정 근거는 서버 정본 `work_host.type`이고, 호스트 목록이 아직 없거나 등록기가
// 모르는 타입을 보내면 추측하지 않는다. 특히 이름에 "cloud"가 들어 있거나
// 세션이 원격 관전을 지원한다는 이유로 T3라고 부르면 사용자가 자기 코드를 어느
// 기계에 보냈는지에 대해 거짓말하게 된다.
// =============================================================================

export type WorkConsoleLocationKey = "t1" | "t2" | "t3" | "unknown";

export interface WorkConsoleLocation {
  key: WorkConsoleLocationKey;
  label: string;
  host: WorkHost | null;
}

const LOCATION_LABEL: Readonly<Record<WorkConsoleLocationKey, string>> = {
  // 워크스페이스 전체 목록에는 다른 멤버의 app 호스트도 선다. 그래서 T1은
  // viewer-relative한 "이 기기"가 아니라 서버가 말한 실행체 종류를 부른다.
  t1: "T1 · 데스크톱 앱",
  t2: "T2 · 셀프호스트",
  t3: "T3 · 클라우드",
  unknown: "실행 위치 확인 필요",
};

/** `work_host.type` 이 말한 것만 화면의 위치 등급으로 옮긴다. */
export function workConsoleLocation(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): WorkConsoleLocation {
  const host =
    hosts?.find((candidate) => uuidEq(candidate.id, session.hostId)) ?? null;
  const key: WorkConsoleLocationKey =
    host?.type === "app"
      ? "t1"
      : host?.type === "workd"
        ? "t2"
        : host?.type === "cloud"
          ? "t3"
          : "unknown";
  return { key, label: LOCATION_LABEL[key], host };
}

/** 한 작업 세션을 새로고침·붙여넣기에도 살아 있는 상세 주소로 만든다. */
export function workConsoleSessionPath(sessionId: string): string {
  return `/work?session=${encodeURIComponent(sessionId.toLowerCase())}`;
}
