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
export async function openWorkPanelViaConsole(page, { allowHashFallback = false } = {}) {
  await page.getByTestId("nav-work-console").click();
  await page.getByTestId("work-console-route").waitFor();
  // 문은 고른 세션의 채널만 가리킨다 (#1758 H-4). 세션이 있으면 첫 행을 고르고
  // 그 버튼을 누른다. 빈/오류 콘솔의 해시 우회는 호출자가 명시해야 한다
  // (#1766 R2-N2: 기본이 우회면 버튼이 깨져도 두 레인이 초록으로 남는다).
  const rowLink = page.locator('[data-testid="work-console-row"] a').first();
  await rowLink.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
  if ((await rowLink.count()) > 0) {
    await rowLink.click();
    await page.getByTestId("open-work-panel").waitFor();
    await page.getByTestId("open-work-panel").click();
  } else if (!allowHashFallback) {
    throw new Error(
      "작업 콘솔에 세션 행이 없다. 해시 우회는 allowHashFallback 이 있을 때만."
    );
  } else {
    const href = await page
      .locator('[data-testid="channel-list"] a[href^="#/c/"]')
      .first()
      .getAttribute("href");
    if (!href) {
      throw new Error("작업 콘솔에서 WorkPanel을 열 채널이 없다");
    }
    const channelId = href.replace(/^#\/c\//, "").split("?")[0];
    console.warn(
      "openWorkPanelViaConsole: 세션 행이 없어 ?work-panel=1 해시로 연다"
    );
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}?work-panel=1`;
    }, channelId);
  }
  await page.getByTestId("work-panel").waitFor();
}

/**
 * 우측 WorkPanel. 주소(`/c/:id?work-panel=1`) 경유 — 작업 콘솔 입구를 거치지 않는다.
 *
 * #2741: 셀프호스트 기본 빌드(프로덕션)는 작업 콘솔 입구를 접는다(#2166,
 * `isSurfaceProvided("workConsole")`). 패널 자체와 주소 열쇠는 남아 있다
 * (ChatShell `work-panel` 효과). 셸의 기하·정체성을 재는 게이트(gate:shell)는
 * 배포되는 빌드를 재야 하므로 게이트 모드로 입구를 되살리지 않고, 제품이 아직
 * 받는 이 주소로 패널을 연다. 입구가 접혀 있다는 사실은 호출자가 따로 단정한다.
 */
export async function openWorkPanelByAddress(page, channelId) {
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}?work-panel=1`;
  }, channelId);
  await page.getByTestId("work-panel").waitFor();
}
