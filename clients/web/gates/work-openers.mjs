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
  // 문은 고른 세션의 채널만 가리킨다 (#1758 H-4). 세션이 있으면 첫 행을 고르고
  // 그 버튼을 누른다. 빈/오류 콘솔은 사이드바의 채널로 `?work-panel=1` 을 연다.
  const rowLink = page.locator('[data-testid="work-console-row"] a').first();
  if ((await rowLink.count()) > 0) {
    await rowLink.click();
    await page.getByTestId("open-work-panel").waitFor();
    await page.getByTestId("open-work-panel").click();
  } else {
    const href = await page
      .locator('[data-testid="channel-list"] a[href^="#/c/"]')
      .first()
      .getAttribute("href");
    if (!href) {
      throw new Error("작업 콘솔에서 WorkPanel을 열 채널이 없다");
    }
    const channelId = href.replace(/^#\/c\//, "").split("?")[0];
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}?work-panel=1`;
    }, channelId);
  }
  await page.getByTestId("work-panel").waitFor();
}
