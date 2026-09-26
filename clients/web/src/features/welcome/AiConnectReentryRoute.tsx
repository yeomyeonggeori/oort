import { createPortal } from "react-dom";
import { FirstAgentStage } from "./FirstAgentStage";
import { readAiConnectReentry } from "./aiConnectReentry";

// =============================================================================
// AI 연결 재진입 라우트 (#2870 → #2893).
//
// 재진입은 처음에 App 이 셸을 통째로 걷고 그 자리에 온보딩 화면을 세웠다. 그래서
// 열고 닫을 때마다 셸이 다시 마운트되었다: 실시간 연결이 두 번 끊기고 도크·서랍
// 상태가 사라졌다. 이제는 셸 **안의** 라우트(`#/ai-connect`)다. 셸은 그대로
// 서 있고(AppShell 이 이 경로 동안 셸을 inert 로 만든다), 화면은 온보딩과 같은
// 전면 층으로 body 에 포털된다. 겉모습은 전과 같다.
//
// 닫기·뒤로는 FirstAgentStage 가 해시를 출발지로 바꾸는 것으로 끝난다. 라우터가
// 그 해시를 받아 이 라우트를 내리므로 `onContinue` 가 할 일은 없다.
// =============================================================================

export function AiConnectReentryRoute() {
  const from = readAiConnectReentry(window.location.hash)?.from ?? "agents";
  return createPortal(
    <div
      className="layer-overlay-surface fixed inset-0 overflow-y-auto bg-pane"
      data-testid="ai-connect-reentry-layer"
    >
      <FirstAgentStage onContinue={() => undefined} mode="reentry" reentryFrom={from} />
    </div>,
    document.body
  );
}
