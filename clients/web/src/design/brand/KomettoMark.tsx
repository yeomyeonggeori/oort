// =============================================================================
// oort 대표 캐릭터 코메토 K6 플랫 얼굴 (#2732). 온보딩 S0의 히어로 로고다.
// icon-system-exception(ADR-0172): Lucide에 없는 oort 브랜드 일러스트라 로컬
// SVG로 남긴다. 기능 아이콘으로 재사용하지 않는다.
//
// 앱 아이콘(iOS·macOS Dock·PWA)과 같은 얼굴이고, 이 path는 손으로 적지 않았다.
// clients/web/scripts/brand-mark.mjs의 buildCharacter()가 만든 값을 옮겨 적었고,
// brandMark.test.ts가 docs/brand/mark/oort-kometto.svg와 같은지 본다.
//
// 여섯 조각을 이 순서로 칠한다: 혜성 꼬리 → 후드 → 얼굴 → 림 → 눈 → 구슬.
//   림은 C2-04 마크와 같은 문법(원 링 + 135° 말풍선 꼬리)이고, 치수는 캐릭터
//   판독이 우선이다(얼굴 창 0.8). 후드가 말풍선 꼬리를 한 겹 두른다.
//   구슬은 마크의 위성과 같은 −45° 대각선, 같은 호박색이다.
//   혜성 꼬리는 후드색 → 호박 → 살구 세 띠다(단단한 멈춤점).
//
// 32px 미만에서는 쓰지 않는다. 그 크기에서는 눈과 말풍선 꼬리가 뭉개진다
// (docs/brand/mark/README.md 「작은 크기」). 락업처럼 작은 자리는 OortMark다.
//
// 색은 S0 한 벌 토큰(--onboarding-kometto-*)이다. 띠 멈춤점의 색은 tokens.css의
// .kometto-stop-* 규칙이 칠한다. 구슬에는 kometto-bead 클래스가 붙고, S0의
// 「위성이 날아와 앉는」 등장 애니메이션이 이 클래스에 묶여 있다.
// =============================================================================

import { useId } from "react";

const GEOMETRY = {
  viewBox: "3.5 1 71 71",
  comet: "M50.52 18.88C63.14 36.9 60.74 45.69 67.55 53A11 11 0 0 1 51.45 68C43.27 59.21 38.57 54.11 45.12 49.52Z",
  hood: "M7.88 27.16C10.48 12.39 44 4.4 55 4.4L55.6 8.8C51.36 4.56 49.15 10.34 54.15 19A25 25 0 1 1 7.88 27.16ZM31 33L21.41 52.54L14.35 54.62A4 4 0 0 1 9.38 49.65L11.46 42.59Z",
  face: "M47 33A16 16 0 1 1 15 33A16 16 0 1 1 47 33Z",
  rim: "M13.54 42.76A20 20 0 1 1 21.24 50.46A1.5 1.5 0 0 0 20.08 50.33L13.64 52.22A1.5 1.5 0 0 1 11.78 50.36L13.67 43.92A1.5 1.5 0 0 0 13.54 42.76ZM47 33A16 16 0 1 0 15 33A16 16 0 1 0 47 33Z",
  eyes: "M27.5 34.5A3.5 3.5 0 1 1 20.5 34.5A3.5 3.5 0 1 1 27.5 34.5ZM41.5 34.5A3.5 3.5 0 1 1 34.5 34.5A3.5 3.5 0 1 1 41.5 34.5Z",
  bead: "M62.5 6A4.5 4.5 0 1 1 53.5 6A4.5 4.5 0 1 1 62.5 6Z",
  cometAxis: [32.5, 31.5, 67, 68.55],
  cometBands: [0.36, 0.68],
} as const;

/**
 * 코메토 얼굴. 크기는 호출자가 정한다. 기본은 `aria-hidden`이다. S0처럼 바로
 * 아래에 "oort" 워드마크가 있는 자리에서는 이름을 한 번 더 읽히지 않는다.
 */
export function KomettoMark({ className, title }: { className?: string; title?: string }) {
  const gradient = `kometto-comet-${useId().replace(/:/g, "")}`;
  const [x1, y1, x2, y2] = GEOMETRY.cometAxis;
  const [a, b] = GEOMETRY.cometBands;
  return (
    <svg
      viewBox={GEOMETRY.viewBox}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : "true"}
    >
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
          <stop offset={0} className="kometto-stop-hood" />
          <stop offset={a} className="kometto-stop-hood" />
          <stop offset={a} className="kometto-stop-mid" />
          <stop offset={b} className="kometto-stop-mid" />
          <stop offset={b} className="kometto-stop-end" />
          <stop offset={1} className="kometto-stop-end" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradient})`} d={GEOMETRY.comet} />
      <path className="fill-onboarding-kometto-hood" d={GEOMETRY.hood} />
      <path className="fill-onboarding-kometto-face" d={GEOMETRY.face} />
      <path className="fill-onboarding-kometto-rim" fillRule="evenodd" d={GEOMETRY.rim} />
      <path className="fill-onboarding-kometto-rim" d={GEOMETRY.eyes} />
      <path className="kometto-bead fill-onboarding-kometto-bead" d={GEOMETRY.bead} />
    </svg>
  );
}
