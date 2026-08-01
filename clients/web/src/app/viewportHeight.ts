// =============================================================================
// 지금 실제로 보이는 높이 (goal B9).
//
// 성재 iPhone 실캡처(2026-08-02 22:54)에서 컴포저가 사파리 하단 툴바 뒤에 있었다.
// B6이 셸 높이를 `100%`에서 `100dvh`로 옮긴 뒤였는데도 그랬다. 이유는 dvh가 답하는
// 것이 **레이아웃 뷰포트**이기 때문이다: 844px 화면에서 하단 툴바가 100px을 덮고 있어도
// `100dvh`는 여전히 844px이고, 셸의 마지막 줄은 그 100px 안에 그려진다. 실측으로 88px이
// 툴바 뒤에 있었다.
//
// 브라우저가 "지금 보이는 것"을 말해 주는 유일한 창구가 `visualViewport`다. 그 값을
// CSS 변수 하나에 옮겨 두면 높이를 쓰는 자리는 tokens.css 한 곳으로 남는다
// (`--app-viewport-height`, 폰 미디어 쿼리 안의 html/body/#root).
//
// 같은 경로가 가상 키보드도 함께 처리한다. index.html은
// `interactive-widget=resizes-content`를 싣고 있지만 그것을 읽는 것은 크로미움뿐이고,
// 사파리에서는 키보드가 올라와도 레이아웃 뷰포트가 그대로다. visualViewport는 줄어든다.
//
// 왜 리액트 밖인가: 이 값은 로그인 화면에도 필요하고(셸 밖의 유일한 표면), 어떤 라우트가
// 마운트되기 전에도 첫 페인트에서 맞아야 한다. 컴포넌트에 매달면 그 컴포넌트가 없는
// 순간에 답이 없다.
//
// 왜 요소의 style에 쓰는가: 스타일시트에는 "지금 이 기기에서 보이는 높이"를 적을 문법이
// 없다. 여기서 쓰는 것은 색이나 여백이 아니라 **측정값** 하나이고, 그것을 담을 이름은
// tokens.css가 이미 갖고 있다. 컴포넌트는 여전히 스타일을 쓰지 않는다
// (design-taste-web §1, scripts/design_preflight_web.sh).
// =============================================================================

/** tokens.css가 읽는 이름. 두 곳이 어긋나면 셸 높이가 폴백으로 돌아간다. */
const VIEWPORT_HEIGHT_VAR = "--app-viewport-height";

/**
 * visualViewport를 따라 `--app-viewport-height`를 갱신한다. 반환값은 해제 함수다.
 *
 * visualViewport가 없는 브라우저(옛 사파리, 일부 웹뷰)에서는 아무것도 하지 않는다.
 * 그 경우 변수는 tokens.css의 기본값 `100dvh`로 남고, 동작은 B6 그대로다: 없는 API를
 * 흉내내는 것보다 이전 답으로 남는 편이 낫다.
 */
export function trackViewportHeight(): () => void {
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const root = document.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    // 반올림하는 이유: 이 값은 셸의 높이가 되고, 그 셸의 마지막 줄이 화면 안에
    // 있는지를 게이트가 1px 오차로 잰다. 소수점을 그대로 흘리면 기기마다 그
    // 마지막 픽셀이 있다 없다 한다.
    root.style.setProperty(
      VIEWPORT_HEIGHT_VAR,
      `${Math.round(viewport.height)}px`
    );
  };

  // 한 프레임에 한 번만 쓴다. 키보드가 올라오는 동안 사파리는 resize와 scroll을
  // 수십 번 울리고, 그때마다 커스텀 속성을 다시 쓰면 그 자체가 레이아웃을 그만큼
  // 다시 계산하게 만든다.
  const schedule = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(apply);
  };

  apply();
  viewport.addEventListener("resize", schedule);
  // scroll도 듣는다: 사파리는 툴바가 접히고 펴지는 동안 높이 변화를 resize가 아니라
  // 시각 뷰포트의 스크롤로 흘리는 구간이 있다.
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("orientationchange", schedule);

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("orientationchange", schedule);
    root.style.removeProperty(VIEWPORT_HEIGHT_VAR);
  };
}
