import type { NeedsMe } from "@momo/core/features/inbox/needsMe";

// =============================================================================
// 표시 문법 하나 (#3338 / #3335 T3, 시안 `?panel=grammar`).
//
// 색을 새로 만들지 않는다. 지금 코드의 규칙을 한 자리로 모은다:
//   잉크 알약 (`--primary`) = 나에게 직접 필요한 수 (승인 · 응답 필요 · 안 읽은 멘션)
//   호박 알약 (`--signal`)  = 안 읽은 일반 글 수 (현행)
//   점 (수 없음)            = 접혀서 수를 못 그릴 때만. 호박 = 안 읽은 일반 글, 초록 = 아직
//                             안 본 끝난 세션(`--ok`)
//
// 같은 자리에 둘 이상이 서면 알약은 **잉크 하나**만 그린다(필요 > 일반): 일반 안 읽음 수는
// 채널·DM 줄에서만 센다. 사이드바 줄·접힌 구획 머리·접힌 레일이 전부 이 파일을 읽으므로 한
// 곳이 다르게 말할 수 없다(시험이 같은 입력에서 둘을 맞대어 잰다).
// =============================================================================

export type BadgeTone = "ink" | "amber";
export type DotTone = "amber" | "ok";

/** 알약의 색은 이 표 하나가 진다. 호출처는 클래스를 직접 적지 않는다. */
export const BADGE_TONE_CLASS: Readonly<Record<BadgeTone, string>> = {
  ink: "bg-primary text-on-primary",
  amber: "bg-signal text-on-signal",
};

export const DOT_TONE_CLASS: Readonly<Record<DotTone, string>> = {
  amber: "bg-signal",
  ok: "bg-ok",
};

export interface BadgeSpec {
  tone: BadgeTone;
  count: number;
}

function positive(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 한 자리의 알약. 나에게 필요한 수가 있으면 잉크, 아니면 일반 안 읽음이 호박, 둘 다 없으면 없다.
 * 멘션은 `needsMe` 쪽이다: 멘션이 호박으로 그려지면 「나를 부른 것」이 「안 읽은 글」로 읽힌다.
 */
export function badgeFor(input: { needsMe?: number; unread?: number }): BadgeSpec | null {
  const needs = positive(input.needsMe);
  if (needs > 0) return { tone: "ink", count: needs };
  const unread = positive(input.unread);
  if (unread > 0) return { tone: "amber", count: unread };
  return null;
}

export interface DestinationMark {
  pill: BadgeSpec | null;
  /** 알약이 없는 자리에서 수를 못 그릴 때만 서는 점. 알약이 있으면 항상 null. */
  dot: DotTone | null;
}

export interface DestinationMarks {
  chat: DestinationMark;
  inbox: DestinationMark;
  mine: DestinationMark;
}

const NONE: DestinationMark = { pill: null, dot: null };

/**
 * 목적지별 표지. 펼친 구획 A·B의 줄과 접힌 레일 아이콘이 **같은 결과**를 읽는다.
 *   chat  = 수 없는 호박 점(안 읽은 채널이 있다). 펼침에서는 아래 채널 줄이 수를 말하므로 줄에는
 *           안 그리고, 접힌 레일만 그린다(`WorkspaceRail`).
 *   inbox = 잉크 알약, 나에게 필요한 일 전부.
 *   mine  = 잉크 알약(응답 필요 칸), 없으면 아직 안 본 끝남이 초록 점.
 */
export function destinationMarks(input: {
  needsMe: Pick<NeedsMe, "total" | "panes">;
  unreadChannels: number;
  doneUnseen: boolean;
}): DestinationMarks {
  const minePill = badgeFor({ needsMe: input.needsMe.panes });
  return {
    chat: positive(input.unreadChannels) > 0 ? { pill: null, dot: "amber" } : NONE,
    inbox: { pill: badgeFor({ needsMe: input.needsMe.total }), dot: null },
    mine: {
      pill: minePill,
      dot: minePill === null && input.doneUnseen ? "ok" : null,
    },
  };
}
