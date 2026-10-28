import type { RosterMember } from "@momo/core/lib/api";
import { statusDotTooltip, type StatusDot } from "@momo/core/features/presence/statusDot";
import { cn } from "@/design/lib/cn";
import { STATUS_DOT_BADGE_CLASS, STATUS_DOT_FILL_CLASS } from "@/design/statusDot";
import { useHumanPresenceDot } from "./useHumanPresenceDot";

// =============================================================================
// 사람의 상태 점을 그리는 두 모양 (#4692, ADR-0160 ②③). 판정은 둘 다 한 훅이다(`useHumanPresenceDot` →
// 코어 `humanPresenceDot`). 모양은 글자가 곁에 있는가로 갈린다(`design/statusDot.ts` 와 같은 구분):
//
//   PresenceBadgeDot   아바타 모서리의 점 - 글자가 없으니 **모양이 말한다**: 채운 초록 = 접속 중, 속 빈 고리 =
//                      접속 없음, 채운 주황·빨강 = 스스로 정한 자리 비움·방해 금지. 행의 높이를 바꾸지 않는다.
//   HumanPresenceLabel 점 + 낱말 한 줄(대화 머리) - 낱말이 곁에 있으니 모든 톤이 채워진다.
//
// **모르면 아무것도 그리지 않는다.** 서버가 접속 여부를 못 읽은 응답, 구서버, 에이전트: 점이 없다. 근거 없는 초록이나
// 고리는 장식 점(AI-tell)이고, 브로커가 느린 것만으로 모든 동료가 꺼져 보이게 만든다.
// =============================================================================

/**
 * 아바타를 감싸는 `relative` 상자 안의 오른쪽 아래에 앉는 점. 접근 가능한 이름은 행/카드의 이름이 이어 말하므로
 * (`memberRowLabel`) 이 점은 보조기술에서 숨는다. 툴팁은 감싸는 쪽이 `statusDotTooltip` 으로 단다.
 */
export function PresenceBadgeDot({
  dot,
  testId = "presence-dot",
  className,
}: {
  dot: StatusDot | null;
  testId?: string;
  className?: string;
}) {
  if (dot === null) return null;
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      data-tone={dot.tone}
      className={cn(
        "absolute bottom-0 right-0 size-2 rounded-full border",
        STATUS_DOT_BADGE_CLASS[dot.tone],
        className
      )}
    />
  );
}

/** 아바타 + 모서리 점을 한 상자로(고정 크기라 점이 와도 행이 움직이지 않는다). */
export function AvatarWithPresence({
  member,
  children,
  className,
}: {
  member: RosterMember;
  children: React.ReactNode;
  className?: string;
}) {
  const dot = useHumanPresenceDot(member);
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      data-testid="avatar-with-presence"
      data-presence-tone={dot?.tone}
      title={dot ? statusDotTooltip(dot) : undefined}
    >
      {children}
      <PresenceBadgeDot dot={dot} />
    </span>
  );
}

const LABEL_TEXT_CLASS: Readonly<Record<StatusDot["tone"], string>> = {
  ok: "text-ink-muted",
  muted: "text-ink-muted",
  warn: "text-warn",
  danger: "text-danger",
};

/** 점 + 낱말(에이전트 생존 칩과 같은 모양). 점이 없으면 아무것도 그리지 않는다. */
export function HumanPresenceLabel({
  member,
  className,
}: {
  member: RosterMember;
  className?: string;
}) {
  const dot = useHumanPresenceDot(member);
  if (dot === null) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-timestamp",
        LABEL_TEXT_CLASS[dot.tone],
        className
      )}
      data-testid="human-presence"
      data-tone={dot.tone}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", STATUS_DOT_FILL_CLASS[dot.tone])}
      />
      <span className="min-w-0 truncate">{dot.label}</span>
    </span>
  );
}
