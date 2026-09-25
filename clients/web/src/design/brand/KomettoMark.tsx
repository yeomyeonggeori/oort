// =============================================================================
// oort 대표 캐릭터 코메토 (#2732). 온보딩 S0의 히어로 로고다.
//
// owner가 고른 레퍼런스(docs/brand/kometto/K6-flat-dark.png)를 **그대로** 쓴다
// (#2732 R2, owner 2026-09-26: 「레퍼런스 선택한걸 왜 그대로 안쓰고 굳이 다른
// 형태로 만들어 ?」). 다시 그리지 않고, 레퍼런스의 남색 배지 원만 오려 낸 래스터다.
// scripts/render-brand-icons.mjs가 떠내고, 원본에서 파생됐는지(픽셀 차)를 검사한다.
// SVG 트레이스는 쓰지 않았다. 레퍼런스 픽셀과 가장 가까운 것은 원본 래스터다.
//
// 576px(히어로 상한 192px × 3x)이고 원 밖은 투명이다. 기본은 장식이다(alt="").
// S0처럼 바로 아래에 "oort" 워드마크가 있는 자리에서는 이름을 한 번 더 읽히지 않는다.
//
// 32px 미만에서는 쓰지 않는다. 그 크기에서는 눈과 말풍선 꼬리가 읽히지 않는다
// (docs/brand/mark/README.md 「작은 크기」). 락업처럼 작은 자리는 OortMark다.
// =============================================================================

import badge from "@/assets/brand/kometto-badge.png";

export function KomettoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <img
      src={badge}
      alt={title ?? ""}
      aria-hidden={title ? undefined : "true"}
      draggable={false}
      className={className}
    />
  );
}
