// =============================================================================
// 폰 홈 줄의 강조 — 「새 글이 있는 줄만 또렷하게」 (#4953, owner 10-31).
//
// 한 줄이 말할 수 있는 상태는 넷이다. 이 파일이 그 문법 하나를 쥐고, 그리는 쪽(`SidebarScreen` 의 `Row`)은
// 이 결과를 색 토큰으로 옮기기만 한다:
//
//   읽음    새 글 없음        이름·아이콘 회색(`textMuted`) · 칩 없음
//   안 읽음 새 글 N           이름·아이콘 본문색(`text`) · 굵게 · 신호색 칩 `N`
//   멘션    나를 부른 글 M    위와 같고 칩이 잉크 `@M` — 웹 `badgeFor` 의 「필요 > 일반」 한 알약과 같은 문법이다
//   음소거  (새 글이 있든 없든) 이름·아이콘 회색 · 굵지 않음 · 칩은 있으면 중성으로 흐리게(`surfaceMuted` 위 `textMuted`)
//
// 회색이 「새 글 없음」을 **말하게 됐으므로** 모를 때는 회색을 칠하지 않는다. 읽음 투영이 실패해서(`error`) 안 읽음
// 수를 못 받은 줄을 회색으로 두면 「다 읽었다」는 거짓이 된다 — 이 화면이 실패 안내(`read-state-error`)를 따로 세우는
// 이유가 바로 그 오해다. 그래서 `mayDim` 이 거짓이면 새 글 없는 줄도 본문색이다. 오는 중(`loading`)은 조용한 쪽(회색)
// 이다: 새 글이 있는 줄만 나중에 떠오르고, 대다수인 읽은 줄은 색이 다시 바뀌지 않는다. 음소거는 사실(채널 쪽이 준다)이라
// 읽음 투영과 상관없이 회색이다.
//
// 열려 있는 줄(`selected`)은 회색이 아니다 — 지금 보고 있는 대화가 흐려지면 오류처럼 읽힌다. 그 줄의 안 읽음은 이미 0
// 으로 접혀 있어(`rows.ts` 의 열린 채널 억제) 칩도 굵기도 없고, 색만 본문색으로 남는다.
//
// 에이전트 줄(아직 DM 이 없는 에이전트)은 대화가 아니라 **갈 곳**이라 읽음이 없다(`tracksRead` 거짓): 강조하지도
// 흐리게도 하지 않는다.
//
// ## 이 파일에 문자열 낱말이 없는 이유
// 직접 문구 장부(`direct-copy-baseline.json`)는 낱말 하나짜리 문자열 리터럴도 센다. 장부는 줄어들기만 하므로 새
// 파일은 0 이어야 한다. 그래서 칩의 모양은 이름 붙은 숫자(`CHIP_TONE`)이고, 칩 글자의 `@`·`+` 는 글자가 없는 기호다.
// =============================================================================

/** 칩의 모양 셋. 값이 숫자인 이유는 위 머리 주석(장부)이다. */
export const CHIP_TONE = {mention: 0, count: 1, muted: 2} as const;
export type ChipTone = (typeof CHIP_TONE)[keyof typeof CHIP_TONE];

/** 칩이 숫자를 99 까지만 그린다 — 22pt 알약이 큰 글씨에서 숫자 때문에 늘어나지 않게(시안 `.a-badge`). */
export const CHIP_COUNT_CAP = 99;

export interface RowChip {
  tone: ChipTone;
  /** 칩에 찍히는 글자: 멘션이 있으면 `@M`, 없으면 `N`. 99 를 넘으면 `99+`. */
  glyphs: string;
}

export interface RowEmphasis {
  /** 참이면 이름과 아이콘이 흐린 글자 토큰(회색)이다. */
  dim: boolean;
  /** 이름이 굵다(700). 새 글이 있고 음소거가 아닌 줄만. */
  bold: boolean;
  /** 오른쪽 칩. 새 글이 없으면 없다. */
  chip: RowChip | null;
}

export interface RowEmphasisInput {
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  /** 이 줄이 읽음을 말하는 줄인가 — 채널·DM 만 참이다. 에이전트 줄은 거짓. */
  tracksRead: boolean;
  /**
   * 새 글이 없다는 것을 「다 읽었다」로 말해도 되는가. 읽음 투영이 실패했으면(`error`) 거짓이다(머리 주석).
   * 음소거는 이 값과 상관없이 회색이다.
   */
  mayDim: boolean;
  /** 지금 열려 있는 줄. 회색이 되지 않는다. */
  selected: boolean;
}

function positive(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function capped(n: number): string {
  return n > CHIP_COUNT_CAP ? `${CHIP_COUNT_CAP}+` : String(n);
}

export function rowEmphasis(input: RowEmphasisInput): RowEmphasis {
  if (!input.tracksRead) return {dim: false, bold: false, chip: null};
  const unread = positive(input.unreadCount);
  const mention = positive(input.mentionCount);
  const news = unread > 0 || mention > 0;
  // 멘션이 있으면 칩은 하나, 잉크 `@M` 이다. 안 읽은 수는 굵은 이름과 낭독 라벨이 함께 진다 — 칩 둘을 나란히 세우지 않는다.
  const glyphs = mention > 0 ? `@${capped(mention)}` : capped(unread);
  const tone = input.muted
    ? CHIP_TONE.muted
    : mention > 0
      ? CHIP_TONE.mention
      : CHIP_TONE.count;
  return {
    dim: !input.selected && (input.muted || (!news && input.mayDim)),
    bold: news && !input.muted,
    chip: news ? {tone, glyphs} : null,
  };
}
