import { uuidEq, type WorkHost, type WorkSession } from "../../lib/api";

// =============================================================================
// 작업 실행 위치 — 웹·Tauri·React Native 공용 계약 (#1289/#1292).
//
// T1/T2/T3는 세션 상태나 요금제가 아니라 `work_host.type`이 말한 실행 위치다.
// label이나 remoteAttachAvailable 같은 주변 사실로 추측하지 않고, 알 수 없는
// 새 host type도 fail-closed unknown으로 둔다.
// =============================================================================

export type WorkExecutionLocationKey = "t1" | "t2" | "t3" | "unknown";

export interface WorkExecutionLocation {
  key: WorkExecutionLocationKey;
  label: string;
  host: WorkHost | null;
}

const LOCATION_LABEL: Readonly<Record<WorkExecutionLocationKey, string>> = {
  t1: "T1 · 데스크톱 앱",
  t2: "T2 · 셀프호스트",
  t3: "T3 · 클라우드",
  unknown: "실행 위치 확인 필요",
};

/** `work_host.type`이 증명한 실행 위치만 공용 표시 계약으로 옮긴다. */
export function workExecutionLocation(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): WorkExecutionLocation {
  const host =
    hosts?.find((candidate) => uuidEq(candidate.id, session.hostId)) ?? null;
  const key: WorkExecutionLocationKey =
    host?.type === "app"
      ? "t1"
      : host?.type === "workd"
        ? "t2"
        : host?.type === "cloud"
          ? "t3"
          : "unknown";
  return { key, label: LOCATION_LABEL[key], host };
}
