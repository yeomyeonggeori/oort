// =============================================================================
// 기기가 아는 온라인 여부 - 화면 밖 코드가 한 번 읽는 값 (#5222, 웹 `lib/deviceOnline.ts` 의 짝).
//
// 실패의 원인을 가를 때(`@momo/core/features/connection/failure` · `uploadFailure`) 그 순간의 기기 온라인 여부를 넘긴다. 화면이 구독하는
// 값(`useOnline`)이 아니라 **지금 한 번 읽는 값**이다. 올리기 저장소(`attachments/draftStore.ts`)처럼 React 밖에서 도는 코드가 읽어야 해서
// 모듈 변수 하나로 둔다. 쓰는 곳은 연결 공급자 하나(`ConnectionProvider`, NetInfo 구독)다.
//
// 모르면 `null`: 모르면 오프라인이라 말하지 않는다(공급자가 아직 첫 보고를 받지 못했거나 서 있지 않다).
// =============================================================================

let known: boolean | null = null;

export function deviceOnlineNow(): boolean | null {
  return known;
}

/** 연결 공급자가 NetInfo 보고를 옮겨 적는다. 공급자가 내려갈 때 `null` 로 되돌린다. */
export function recordDeviceOnline(online: boolean | null): void {
  known = online;
}
