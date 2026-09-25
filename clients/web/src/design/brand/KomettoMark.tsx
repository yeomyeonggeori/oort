// =============================================================================
// oort 대표 캐릭터 코메토 K6 플랫 얼굴 (#2732). 온보딩 S0의 히어로 로고다.
// icon-system-exception(ADR-0172): Lucide에 없는 oort 브랜드 일러스트라 로컬
// SVG로 남긴다. 기능 아이콘으로 재사용하지 않는다.
//
// 앱 아이콘(iOS·macOS Dock·PWA)과 같은 얼굴이고, 이 path는 손으로 적지 않았다.
// clients/web/scripts/brand-mark.mjs의 buildCharacter()가 만든 값을 옮겨 적었고,
// brandMark.test.ts가 docs/brand/mark/oort-kometto.svg와 같은지 본다.
//
// 다섯 조각을 이 순서로 칠한다: 후드 → 얼굴 → 림 → 눈 → 구슬.
//   림은 C2-04 마크의 링 그 자체다(홈만 뺐다). 얼굴 창이 곧 마크다.
//   구슬은 마크의 위성과 같은 −45° 대각선, 같은 호박색이다.
//
// 32px 미만에서는 쓰지 않는다. 그 크기에서는 눈과 말풍선 꼬리가 뭉개진다
// (docs/brand/mark/README.md 「작은 크기」). 락업처럼 작은 자리는 OortMark다.
//
// 색은 S0 한 벌 토큰(--onboarding-kometto-*)이다. S0는 OS 라이트·다크를
// 따르지 않는 깊은 우주 한 장이라 캐릭터도 한 벌이다.
// 구슬에는 kometto-bead 클래스가 붙는다. S0의 「위성이 날아와 앉는」 등장
// 애니메이션이 이 클래스에 묶여 있다(tokens.css .onboarding-mark .kometto-bead).
// =============================================================================

const GEOMETRY = {
  viewBox: "-1 -3 64 64",
  hood: "M7.88 27.16C10.48 12.39 44 4.4 55 4.4L55.6 8.8C51.36 4.56 49.15 10.34 54.15 19A25 25 0 1 1 7.88 27.16Z",
  face: "M43 33A12 12 0 1 1 19 33A12 12 0 1 1 43 33Z",
  rim: "M13.54 42.76A20 20 0 1 1 21.24 50.46A1.5 1.5 0 0 0 20.08 50.33L13.64 52.22A1.5 1.5 0 0 1 11.78 50.36L13.67 43.92A1.5 1.5 0 0 0 13.54 42.76ZM43 33A12 12 0 1 0 19 33A12 12 0 1 0 43 33Z",
  eyes: "M28.5 34A2.5 2.5 0 1 1 23.5 34A2.5 2.5 0 1 1 28.5 34ZM38.5 34A2.5 2.5 0 1 1 33.5 34A2.5 2.5 0 1 1 38.5 34Z",
  bead: "M62.5 6A4.5 4.5 0 1 1 53.5 6A4.5 4.5 0 1 1 62.5 6Z",
} as const;

/**
 * 코메토 얼굴. 크기는 호출자가 정한다. 기본은 `aria-hidden`이다. S0처럼 바로
 * 아래에 "oort" 워드마크가 있는 자리에서는 이름을 한 번 더 읽히지 않는다.
 */
export function KomettoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox={GEOMETRY.viewBox}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : "true"}
    >
      <path className="fill-onboarding-kometto-hood" d={GEOMETRY.hood} />
      <path className="fill-onboarding-kometto-face" d={GEOMETRY.face} />
      <path className="fill-onboarding-kometto-rim" fillRule="evenodd" d={GEOMETRY.rim} />
      <path className="fill-onboarding-kometto-rim" d={GEOMETRY.eyes} />
      <path className="kometto-bead fill-onboarding-kometto-bead" d={GEOMETRY.bead} />
    </svg>
  );
}
