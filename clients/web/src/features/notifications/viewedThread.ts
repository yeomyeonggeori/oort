// =============================================================================
// 지금 이 창이 열어 둔 스레드 (#4890). 스레드 패널은 `ChatShell` 의 컴포넌트 상태(`thread`)라서 주소에도 없고, 전역으로
// 도는 데스크탑 알림 판정(`DesktopNotifications`)이 읽을 길이 없었다. 「그 스레드를 보고 있으면 안 띄움」을 판정하려면
// 패널이 **자기가 열려 있는 동안** 어느 루트를 보여 주는지를 여기에 적는다.
//
// 「창이 앞인가」는 이 저장소의 일이 아니다 — 판정(`notifyDecision`)이 따로 가진다. 여기는 **열려 있는가**만 안다.
// 대화 표면(답글을 읽고 쓰는 패널)만 적는다: 작업 세션 패널의 행은 사건 기록이라 읽는 대화가 아니다.
// =============================================================================

interface Viewed {
  channelId: string;
  rootId: string;
}

let viewed: Viewed | null = null;

/**
 * 패널이 열렸다. 돌려주는 함수는 닫힘(언마운트·루트 교체·닫는 중)이다 — 그 사이 다른 패널이 같은 자리를 이어받았으면
 * (루트가 바뀌는 순간) 이어받은 쪽의 값을 지우지 않는다.
 */
export function viewThread(channelId: string, rootId: string): () => void {
  const mine: Viewed = { channelId, rootId };
  viewed = mine;
  return () => {
    if (viewed === mine) viewed = null;
  };
}

/** 이 루트의 스레드 패널이 지금 열려 있는가(대소문자 무시). */
export function isThreadViewed(rootId: string): boolean {
  return viewed !== null && viewed.rootId.toLowerCase() === rootId.toLowerCase();
}

/** 시험용. */
export function resetViewedThreadForTest(): void {
  viewed = null;
}
