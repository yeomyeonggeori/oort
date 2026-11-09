// =============================================================================
// 지금 이 창에 열려 있는 A 칸의 세션들 (#5595). 작업 권한 요청의 승인 카드는 채널이 아니라 그 세션의 A 칸
// (`AgentProgressView`)에 있다. 그래서 「창이 앞이고 그 카드가 보이면 배너를 띄우지 않는다」를 판정하려면 칸이
// **자기가 그려지는 동안** 어느 세션을 그리는지를 여기에 적는다. 칸은 격자가 보일 때만 그려진다(도크가 닫히면
// `LocalTerminalDock`이 아무것도 그리지 않는다).
//
// 「창이 앞인가」는 이 저장소의 일이 아니다 — 판정(`notifyDecision`)이 따로 가진다(`viewedThread.ts`와 같은 나눔).
// 같은 세션을 두 칸이 그릴 수 있어 수를 센다.
// =============================================================================

const viewed = new Map<string, number>();

/** 칸이 이 세션을 그리기 시작했다. 돌려주는 함수는 그리기를 멈춤(언마운트·세션 교체)이다. */
export function viewAgentSession(sessionId: string): () => void {
  const key = sessionId.toLowerCase();
  viewed.set(key, (viewed.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (viewed.get(key) ?? 1) - 1;
    if (left <= 0) viewed.delete(key);
    else viewed.set(key, left);
  };
}

/** 이 세션의 A 칸이 지금 그려져 있는가(대소문자 무시). */
export function isAgentSessionViewed(sessionId: string): boolean {
  return (viewed.get(sessionId.toLowerCase()) ?? 0) > 0;
}

/** 시험용. */
export function resetViewedAgentSessionsForTest(): void {
  viewed.clear();
}
