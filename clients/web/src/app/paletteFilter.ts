// =============================================================================
// ⌘K 팔레트의 걸러내기 (#4111).
//
// cmdk 기본 점수(`command-score`)는 **부분수열**이다: 「ai」는 `nav.activity`의
// a…i에도, `nav.inbox`·`nav.settings`·`nav.directory`의 id에도 걸린다. 게다가
// 줄의 `value`에 id와 별칭을 통째로 실었으므로 「ai」를 치면 거의 모든 명령이
// 남았고, 사람이 보기엔 걸러지지 않고 선택만 맞는 줄로 내려갔다(성재 0.1.32 실기).
//
// 그래서 명령 줄은 **사람이 읽는 말**(이름·작은 글씨·별칭)만, 그것도 낱말의
// 앞머리로만 잰다. id는 줄의 정체(`value`)일 뿐 검색 재료가 아니다. 채널·사람
// 줄(`keywords` 없음)은 예전처럼 흐릿한 부분수열 일치를 낮은 점수로 유지한다 —
// 「dpl」로 `deploy`를 찾는 길을 이번 수리가 끊지 않는다.
// =============================================================================

const WORD_SPLIT = /[\s·:/._-]+/;

function words(text: string): string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter((word) => word !== "");
}

/** 한 낱말(질의 조각)이 재료에 얼마나 맞는가. 0이면 맞지 않는다. */
function tokenScore(token: string, parts: readonly string[]): number {
  let best = 0;
  parts.forEach((part, index) => {
    // 첫 재료는 이름(제목)이다. 이름에 맞는 줄이 별칭에만 맞는 줄보다 위에 선다.
    const weight = index === 0 ? 1 : 0.8;
    const lowered = part.toLowerCase();
    if (words(lowered).some((word) => word.startsWith(token))) {
      best = Math.max(best, weight);
    } else if (token.length >= 3 && lowered.includes(token)) {
      // 세 글자 이상은 낱말 속 일치도 인정하되 앞머리 일치보다 낮다.
      best = Math.max(best, weight * 0.5);
    }
  });
  return best;
}

function subsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const ch of haystack) {
    if (ch === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * cmdk `filter` prop. 0이면 숨기고, 클수록 위에 선다.
 *
 * `keywords`가 있으면 명령 줄이다: `[이름, 작은 글씨, ...별칭]`을 낱말 앞머리로 잰다.
 * 질의의 **모든** 낱말이 맞아야 하고, 점수는 낱말 점수의 평균이다.
 */
export function paletteFilter(
  value: string,
  search: string,
  keywords?: readonly string[]
): number {
  const tokens = words(search);
  if (tokens.length === 0) return 1;
  if (keywords !== undefined && keywords.length > 0) {
    let total = 0;
    for (const token of tokens) {
      const score = tokenScore(token, keywords);
      if (score === 0) return 0;
      total += score;
    }
    return total / tokens.length;
  }
  // 채널·사람 줄: 앞머리 > 부분 문자열 > 부분수열.
  const lowered = value.toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (words(lowered).some((word) => word.startsWith(token))) total += 1;
    else if (lowered.includes(token)) total += 0.6;
    else if (subsequence(token, lowered)) total += 0.1;
    else return 0;
  }
  return total / tokens.length;
}
