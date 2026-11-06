import {newerIndex, olderIndex, searchPosition} from '../src/features/conversation/conversationSearchModel';

// =============================================================================
// 대화 안 검색의 순수 규칙 (#5364). 화면은 `conversationSearch.test.tsx` 가 잰다. 최근 검색 저장은 홈 검색과 한 목록이 되어(#5384) `searchRecentsUnified.test.ts` 가 잰다.
// =============================================================================

describe('번호 이동 — 최근 결과가 1번이다', () => {
  it('↑ 는 번호가 커지는 쪽(불러온 끝에서 null), ↓ 는 작아지는 쪽(1번에서 null)이고, 총 건수는 불러온 수 + 뒤에 더 있는지다', () => {
    expect(olderIndex(0, 3)).toBe(1);
    expect(olderIndex(2, 3)).toBeNull();
    expect(newerIndex(2)).toBe(1);
    expect(newerIndex(0)).toBeNull();
    expect(searchPosition(2, 20, true)).toEqual({index: 3, total: 20, more: true});
    expect(searchPosition(2, 3, false)).toEqual({index: 3, total: 3, more: false});
    expect(searchPosition(null, 3, false)).toBeNull();
    expect(searchPosition(3, 3, false)).toBeNull();
  });
});
