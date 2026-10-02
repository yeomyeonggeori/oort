import { cn } from "@/design/lib/cn";
import {
  BADGE_TONE_CLASS,
  DOT_TONE_CLASS,
  type BadgeSpec,
  type DotTone,
} from "./sidebarBadge";

/**
 * 알약 하나(시안 `.a-badge`). 색은 `BADGE_TONE_CLASS`가 정한다. `data-tone`은 시험과
 * 검수가 DOM에서 뜻(잉크/호박)을 읽는 자리이고, 색은 클래스가 진다.
 */
export function AttentionPill({
  spec,
  testId,
  className,
  max,
}: {
  spec: BadgeSpec;
  testId?: string;
  className?: string;
  /** 넘으면 「99+」. 레일 아이콘 모서리처럼 폭이 좁은 자리가 쓴다. */
  max?: number;
}) {
  return (
    <span
      className={cn("sidebar-badge", BADGE_TONE_CLASS[spec.tone], className)}
      data-numeric
      data-tone={spec.tone}
      data-testid={testId}
    >
      {max !== undefined && spec.count > max ? `${max}+` : spec.count}
    </span>
  );
}

/** 수가 없는 점. 항상 장식이다: 뜻은 링크의 접근 가능한 이름이 말한다. */
export function AttentionDot({
  tone,
  testId,
  className,
}: {
  tone: DotTone;
  testId?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("sidebar-dot", DOT_TONE_CLASS[tone], className)}
      data-tone={tone}
      data-testid={testId}
    />
  );
}
