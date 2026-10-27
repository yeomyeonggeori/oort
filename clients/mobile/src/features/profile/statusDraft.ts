import {
  clampStatusEmoji,
  clampStatusText,
  visibleCustomStatus,
  type PhoneStatusExpiryChoice,
} from '@momo/core/features/presence/customStatus';
import type {RosterMember} from '@momo/core/lib/api';

// =============================================================================
// 「상태 설정」 시트의 판정 — **판정만**. 배선은 `StatusSheet.tsx` 다 (#4457).
//
// 머리의 ✓ 가 언제 눌리는가는 시트가 약속하는 것이다(`phone-sheets.md` §3: 「입력 전·바뀐 것이 없으면
// disabled」). 그 규칙이 배선에 섞여 있으면 `>` 가 `!==` 가 되는 식의 조용한 변조를 시험이 잡을 수
// 없으므로 순수 함수로 뗀다(`sheetModel.ts`·`edgeSwipe.ts` 와 같은 이유).
//
// **씨앗**은 시트를 여는 순간 한 번만 찍는다 — 명부가 다시 읽혀도 쓰던 글을 덮지 않는다
// (옛 `StatusPage` 와 같다). 보이는 상태(만료 전)만 씨앗이고, 만료가 지난 글은 없는 것이다.
// =============================================================================

export interface StatusSeed {
  emoji: string;
  text: string;
  /** 저장된 만료(보이는 상태일 때만). 있으면 「지금대로」가 첫 선택지다. */
  storedExpiry: number | undefined;
  /** 지금 남에게 보이는 상태가 있는가 — 「상태 지우기」 행이 서는 조건. */
  hasVisible: boolean;
}

export interface StatusDraft {
  emoji: string;
  text: string;
  expiry: PhoneStatusExpiryChoice;
}

export function statusSeed(
  self: RosterMember | undefined,
  nowMs: number,
): StatusSeed {
  const visible = self ? visibleCustomStatus(self, nowMs) : null;
  return {
    emoji: visible?.emoji ?? '',
    text: visible?.text ?? '',
    storedExpiry: visible ? self?.statusExpiresAtMs : undefined,
    hasVisible: visible !== null,
  };
}

/** 열었을 때의 기간 선택: 저장된 만료가 있으면 「지금대로」, 없으면 「지우지 않음」. */
export function initialExpiry(seed: StatusSeed): PhoneStatusExpiryChoice {
  return seed.storedExpiry !== undefined ? 'keep' : 'none';
}

export interface StatusDraftVerdict {
  /** 씨앗과 달라졌는가(공백만 다른 것은 같은 글이다 — 서버로 갈 때 잘리는 값으로 잰다). */
  dirty: boolean;
  /** ✓ 가 눌리는가. */
  canSave: boolean;
}

/**
 * 초안이 저장할 만한가.
 *
 *   - 바뀐 것이 없으면 저장하지 않는다(✓ 회색).
 *   - 비운 초안은 **지울 상태가 있을 때만** 저장이다 — 이모지·글을 다 지운 채 ✓ 를 누르는 것이
 *     「상태 지우기」와 같은 쓰기(세 키 null)다. 지울 것이 없는데 비어 있으면 저장할 것이 없다.
 */
export function statusDraftVerdict(
  seed: StatusSeed,
  draft: StatusDraft,
): StatusDraftVerdict {
  const emoji = clampStatusEmoji(draft.emoji);
  const text = clampStatusText(draft.text);
  const dirty =
    emoji !== clampStatusEmoji(seed.emoji) ||
    text !== clampStatusText(seed.text) ||
    draft.expiry !== initialExpiry(seed);
  const empty = emoji === '' && text === '';
  return {dirty, canSave: dirty && !(empty && !seed.hasVisible)};
}
