import type { RosterMember } from "@momo/core/lib/api";
import type { WebStatusBadgeFace } from "@momo/core/features/presence/statusBadge";
import { statusDotTooltip, type StatusDot } from "@momo/core/features/presence/statusDot";
import { cn } from "@/design/lib/cn";
import { STATUS_DOT_FILL_CLASS } from "@/design/statusDot";
import { AvatarStatus } from "./AvatarStatus";
import { useHumanPresenceDot } from "./useHumanPresenceDot";

// =============================================================================
// 사람의 상태 점을 그리는 두 모양 (#4692, ADR-0160 ②③). 판정은 둘 다 한 훅이다(`useHumanPresenceDot` →
// 코어 `humanPresenceDot`). 모양은 글자가 곁에 있는가로 갈린다(`design/statusDot.ts` 와 같은 구분):
//
//   AvatarWithPresence 아바타 모서리의 점 - 글자가 없으니 **모양이 말한다**: 채운 원 = 접속 중, 속 빈 고리 = 접속 없음,
//                      초승달 = 자리 비움, 가로 줄 = 방해 금지. 아바타를 점 둘레만큼 도려낸 자리에 앉는다(#5786,
//                      `AvatarStatus` 한 부품). 행의 높이를 바꾸지 않는다.
//   HumanPresenceLabel 점 + 낱말 한 줄(대화 머리) - 낱말이 곁에 있으니 모든 톤이 채워진다.
//
// **모르면 아무것도 그리지 않는다.** 서버가 접속 여부를 못 읽은 응답, 구서버, 에이전트: 점이 없다. 근거 없는 초록이나
// 고리는 장식 점(AI-tell)이고, 브로커가 느린 것만으로 모든 동료가 꺼져 보이게 만든다.
// =============================================================================

/**
 * 아바타 + 모서리 점을 한 상자로(고정 크기라 점이 와도 행이 움직이지 않는다). 접근 가능한 이름은 행/카드의 이름이 이어
 * 말하므로(`memberRowLabel`) 점은 보조기술에서 숨고, 툴팁은 상자의 `title`(`statusDotTooltip`)이다.
 */
export function AvatarWithPresence({
  member,
  children,
  face = 32,
  className,
}: {
  member: RosterMember;
  children: React.ReactNode;
  /** 아바타 한 변(px): 목록 줄 32(기본), 멤버 프로필 창의 큰 얼굴 112. 점의 크기·자리가 여기서 정해진다. */
  face?: WebStatusBadgeFace;
  className?: string;
}) {
  const dot: StatusDot | null = useHumanPresenceDot(member);
  return (
    <AvatarStatus
      face={face}
      tone={dot?.tone ?? null}
      subject="human"
      className={className}
      data-testid="avatar-with-presence"
      data-presence-tone={dot?.tone}
      title={dot ? statusDotTooltip(dot) : undefined}
    >
      {children}
    </AvatarStatus>
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
