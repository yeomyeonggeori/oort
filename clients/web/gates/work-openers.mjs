// TC-1 (#1758) opener helpers.
//
// 헤더 SquareTerminal = 하단 도크 (`open-terminal-dock`).
// 우측 WorkPanel = 사이드바 「작업 콘솔」 (`nav-work-console` →
// `open-work-panel` → `?work-panel=1`). 헤더 testid 를 `open-work-panel` 로
// 남기면 게이트가 도크를 패널로 착각한다.

/** 채널 하단 터미널 도크. 채널 스코프 관전 진입. */
export async function openTerminalDock(page) {
  await page.getByTestId("open-terminal-dock").click();
  await page.getByTestId("terminal-dock").waitFor();
}

/** 우측 WorkPanel. 작업 콘솔 경유 — 헤더를 누르지 않는다. */
export async function openWorkPanelViaConsole(page) {
  await page.getByTestId("nav-work-console").click();
  await page.getByTestId("work-console-route").waitFor();
  await page.getByTestId("open-work-panel").waitFor();
  await page.getByTestId("open-work-panel").click();
  await page.getByTestId("work-panel").waitFor();
}
