// =============================================================================
// 대화 안 검색의 순수 규칙 (#5364) — 화면도 저장소도 모르는 셈만 모은다.
//
// ## 번호는 최근 결과가 1번이다
//
// 서버는 결과를 **최근 순**으로 준다(`created_at` 내림차순, 커서로 쪽을 넘긴다). 목록의 0번이 가장 최근 글이고 쪽을 더 불러오면 꼬리가
// 늘 뿐 앞 번호는 흔들리지 않는다 — 번호를 오래된 쪽에서 세면 쪽을 불러올 때마다 모든 번호가 밀린다. 그래서 위 화살표(↑)는 **더 오래된**
// 결과로 가고(번호 +1), 아래 화살표(↓)는 **더 최근** 결과로 간다(번호 −1). 대화 화면의 위쪽이 오래된 글이라는 방향과 같다.
//
// ## 총 건수는 서버가 주지 않는다
//
// 서버는 한 쪽(기본 20)과 `nextCursor` 만 준다. 다 불러오기 전의 「총」은 지금까지 불러온 수이고, 뒤에 더 있다는 사실은 `+` 로 말한다
// (「3 / 20+」). 다 불러오면(`nextCursor` 없음) `+` 가 떨어지고 정확한 수가 된다 — 거짓 수를 지어내지 않는다.
// =============================================================================

/** 위 화살표(더 오래된 결과)가 가는 번호. 불러온 끝이면 `null` — 다음 쪽이 있으면 부르는 쪽이 더 불러온다. */
export function olderIndex(selected: number, hitCount: number): number | null {
  return selected + 1 < hitCount ? selected + 1 : null;
}

/** 아래 화살표(더 최근 결과)가 가는 번호. 가장 최근 결과면 `null`. */
export function newerIndex(selected: number): number | null {
  return selected > 0 ? selected - 1 : null;
}

export interface SearchPosition {
  /** 사람이 읽는 번호(1부터). */
  index: number;
  /** 지금까지 불러온 결과 수. 뒤에 더 있으면 `more` 가 참이다. */
  total: number;
  more: boolean;
}

/** 이동 막대의 「3 / 20+」. 고른 결과가 없으면 막대도 없다. */
export function searchPosition(
  selected: number | null,
  hitCount: number,
  hasMore: boolean,
): SearchPosition | null {
  if (selected === null || selected < 0 || selected >= hitCount) return null;
  return {index: selected + 1, total: hitCount, more: hasMore};
}

/**
 * 이 대화가 일대일(DM)인가 — 안내문·결과 머리글의 낱말이 「이 대화」인지 「이 채널」인지 가른다(코어 `searchScopeLabel` 의 규칙: DM 은 「이 대화에서」, 채널은
 * 「이 채널에서」). 종류를 아직 모르면(채널 목록이 오기 전) 채널 쪽이 아니라 **아니다**로 답한다 — 돋보기는 종류를 알 때만 서므로 그 틈은 화면에 오지 않는다.
 */
export function isDirectConversation(kind: string | undefined): boolean {
  return kind === 'dm';
}
