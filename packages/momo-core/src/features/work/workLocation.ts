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

/**
 * 이 host type이 말하는 실행 위치. 모르는 타입은 `unknown`이다.
 *
 * 이 함수가 따로 있는 이유는 역방향 표를 두 벌 만들지 않기 위해서다. 실행 티어를
 * 축으로 쓰는 표면(컴포저 라우팅 스트립, `features/routing/tierAxis.ts`)은 "이
 * 티어에 등록된 호스트가 있는가"를 물어야 하는데, 그때 `{t1: "app"}` 같은 반대
 * 방향 표를 새로 적으면 새 host type이 생겼을 때 한쪽만 고쳐진다.
 */
export function workExecutionLocationKey(
  hostType: string | null | undefined
): WorkExecutionLocationKey {
  if (hostType === "app") return "t1";
  if (hostType === "workd") return "t2";
  if (hostType === "cloud") return "t3";
  return "unknown";
}

/** 실행 위치 라벨의 정본. 표면마다 문자열을 다시 적지 않는다. */
export function workExecutionLocationLabel(
  key: WorkExecutionLocationKey
): string {
  return LOCATION_LABEL[key];
}

/** `work_host.type`이 증명한 실행 위치만 공용 표시 계약으로 옮긴다. */
export function workExecutionLocation(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): WorkExecutionLocation {
  const host =
    hosts?.find((candidate) => uuidEq(candidate.id, session.hostId)) ?? null;
  const key = workExecutionLocationKey(host?.type);
  return { key, label: LOCATION_LABEL[key], host };
}
