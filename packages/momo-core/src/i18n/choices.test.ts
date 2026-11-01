import { describe, expect, it } from 'vitest';
import { languageChoices } from './choices';

describe('languageChoices', () => {
  it('기기 언어 따르기가 첫 줄이고, 그 뒤는 넘긴 언어를 순서대로 자칭 표기로 낸다', () => {
    expect(languageChoices(['ko-KR', 'en-US'])).toEqual([
      { preference: 'system', system: true, autonym: undefined },
      { preference: 'ko-KR', system: false, autonym: '한국어' },
      { preference: 'en-US', system: false, autonym: 'English' },
    ]);
  });

  it('언어가 늘면 같은 함수의 결과도 함께 는다', () => {
    const grown = languageChoices(['ko-KR', 'en-US', 'ja-JP']);
    expect(grown.map(choice => choice.preference)).toEqual(['system', 'ko-KR', 'en-US', 'ja-JP']);
    expect(grown[3]?.autonym).toBe('日本語');
  });
});
