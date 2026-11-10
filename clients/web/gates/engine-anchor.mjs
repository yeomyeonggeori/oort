// 흔들림 게이트(typing-jitter · expression-jitter · send-follow)의 머리 출력 (#5638).
//
// 브라우저의 스크롤 앵커링(`overflow-anchor`)은 엔진마다 다르다. 2026-11-10 이 맥 실측: Playwright Chromium 149 ·
// Playwright WebKit 26.5 · macOS 27의 WKWebView 모두 켜져 있다. macOS 14~26의 시스템 WebKit(Safari 26까지)에는 없다(Safari 27
// 릴리스 노트에서 처음 켜짐 — 이 맥에서는 잴 수 없다). 데스크탑 앱은 OS 의 WebKit 을 쓰므로 팀 맥의 OS 판에 따라 둘 다 만난다.
// 타임라인 스크롤러는 앵커링을 끄고(`timeline-scroller`) 가상 목록 + `scrollHold` 한 길로만 움직인다. 이 출력은 게이트가 잰
// 엔진이 앵커링을 아는지(`CSS.supports('overflow-anchor','auto')`)와, 그 엔진이 타임라인 스크롤러에 계산한 값을 남긴다.
// 숫자를 읽는 사람이 「이 엔진에서 브라우저가 손을 댈 수 있었나」를 출력만 보고 알 수 있게 한다. Playwright WebKit 이 앵커링을
// 안다는 것은 「게이트의 WebKit = 앵커링 없는 데스크탑」이 아니라는 뜻이기도 하다: 앵커링 없는 판의 길은 스크롤러를 끈 뒤에야 같다.

/** 엔진 하나의 머리 줄: 판 · `CSS.supports('overflow-anchor','auto')`. 빈 페이지에서 잰다(번들과 무관한 엔진 사실). */
export async function printEngineAnchorHeader(browser, engine) {
  const page = await browser.newPage();
  try {
    const supports = await page.evaluate(() => ({
      auto: CSS.supports("overflow-anchor", "auto"),
      none: CSS.supports("overflow-anchor", "none"),
    }));
    console.log(
      `[엔진 ${engine} ${browser.version()}] CSS.supports('overflow-anchor','auto')=${supports.auto} · ('overflow-anchor','none')=${supports.none}`
    );
    return supports;
  } finally {
    await page.close();
  }
}

/** 이 페이지의 스크롤러에 엔진이 계산한 `overflow-anchor`. 속성을 모르는 엔진은 빈 값이라 「(계산값 없음)」으로 적는다. */
export async function scrollerOverflowAnchor(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (node === null) return "(스크롤러 없음)";
    return getComputedStyle(node).getPropertyValue("overflow-anchor") || "(계산값 없음)";
  }, selector);
}
