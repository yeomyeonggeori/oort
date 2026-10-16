import { usePrefersReducedMotion } from "@/design/hooks/usePrefersReducedMotion";
import { cn } from "@/design/lib/cn";
import { KomettoMark } from "./KomettoMark";
import { OortMark } from "./OortMark";

// =============================================================================
// 오르트 로더 (#3961, 시안 A 「공전」). 연결이 끊겼거나 다시 연결하는 중, 그리고
// 첫 로딩에서 도는 브랜드 표시다. owner 2026-10-17: 「A가 심플하고 좋아보이네.
// A 방향으로 가자.」 (B 「빙글」과 C 「구름」은 기각.)
//
// 링(사람·팀)은 가만히 있고, 위성(에이전트)이 홈에서 나와 한 바퀴 돌고 다시
// 꽂힌다. 큰 자리(`hero`)는 링 대신 코메토 K6 배지가 가운데 서고 같은 위성이
// 그 둘레를 돈다. 움직임은 전부 tokens.css 의 `.oort-loader*` 가 한다
// (transform 과 opacity 만). 이 파일은 마크업과 움직임 **선택**만 맡는다.
//
// 자산은 다시 그리지 않는다:
//   링   OortMark 가 그린다(`ringOnly`: 같은 small 링 path, 위성은 빼고). 24 격자 마크를
//        30 격자 정사각 무대 안에 앉힌다. 링 중심이 무대 중심이다(CSS 가 그 자리를 안다).
//   위성 마크의 위성과 같은 원이다. 위치와 크기는 CSS 비율이고,
//        OortLoader.motion.test 가 그 비율이 GEOMETRY 와 맞는지 잰다.
//   코메토 KomettoMark 래스터 그대로(32px 미만 금지, 크롭·변형 금지).
//
// 움직임 선택(`data-motion`):
//   full     평소.
//   reduced  OS 「동작 줄이기」. 회전 대신 정지한 마크 + 투명도 1↔0.5.
//   still    호출자가 「지금 진행 중이 아니다」라고 한 자리(오프라인, 재시도 실패).
//            움직이는 로더는 거짓말이 되므로 같은 마크를 세워 둔다.
//
// 항상 `aria-hidden`이다. 로더는 곁의 문장(연결 상태, 「불러오는 중」)을 꾸미는
// 자리에 서고, 이름은 그 문장이 진다(OortMark 와 같은 규칙).
// =============================================================================

export type OortLoaderVariant = "mark" | "hero";

export function OortLoader({
  variant = "mark",
  still = false,
  className,
}: {
  /** `mark`: 링 + 위성(기본, `size-6` 24px). `hero`: 코메토 + 위성(128px, 첫 로딩). */
  variant?: OortLoaderVariant;
  /** 진행 중이 아닌 자리. 위성을 홈에 꽂은 정지 마크로 둔다. */
  still?: boolean;
  /** 호출자가 크기·정렬 여백을 얹는다. 크기 기본은 mark `size-6`, hero `size-loader-hero`. */
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const motion = still ? "still" : reduced ? "reduced" : "full";
  const hero = variant === "hero";

  return (
    <span
      aria-hidden="true"
      data-oort-loader={variant}
      data-motion={motion}
      className={cn(
        "oort-loader",
        hero ? "oort-loader-hero size-loader-hero" : "size-6",
        className
      )}
    >
      <span className="oort-loader-body">
        {/* 궤도 층이 링보다 먼저(DOM 순서)라 링이 위에 그려진다: 위성이 말풍선
            꼬리 뒤로 지나간다. */}
        <span className="oort-loader-orbit">
          {hero && (
            <>
              <span className="oort-loader-arm oort-loader-trail-far">
                <span className="oort-loader-radial">
                  <span className="oort-loader-dot" />
                </span>
              </span>
              <span className="oort-loader-arm oort-loader-trail-near">
                <span className="oort-loader-radial">
                  <span className="oort-loader-dot" />
                </span>
              </span>
            </>
          )}
          <span className="oort-loader-arm">
            <span className="oort-loader-radial">
              <span className="oort-loader-dot" />
            </span>
          </span>
        </span>
        {hero ? (
          <KomettoMark className="oort-loader-badge" />
        ) : (
          <OortMark ringOnly className="oort-loader-ring" />
        )}
      </span>
    </span>
  );
}
