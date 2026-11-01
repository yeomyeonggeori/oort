import { localeAutonyms } from './autonyms';
import type { LocalePreference, SupportedLocale } from './locale';

/**
 * 언어를 고르는 목록의 한 줄. 설정 › 프로필의 언어 행과 로그인 전 첫 화면의 언어 칩(#4670)이
 * **같은 목록**을 이 한 함수로 만든다: 언어가 늘면 호스트의 `available` 하나만 늘어나고 두 자리가
 * 함께 는다. 문구는 담지 않는다: 「기기 언어 따르기」 줄의 글은 사전에서 오고, 나머지는 자칭 표기다.
 */
export interface LanguageChoice {
  readonly preference: LocalePreference;
  /** 「기기 언어 따르기」 줄이다. 자칭 표기가 없다. */
  readonly system: boolean;
  /** 자기 언어로 쓴 이름. 번역하지 않는다(ADR-0213 §5). `system` 줄에는 없다. */
  readonly autonym: string | undefined;
}

export function languageChoices(available: readonly SupportedLocale[]): readonly LanguageChoice[] {
  return [
    { preference: 'system', system: true, autonym: undefined },
    ...available.map(locale => ({ preference: locale, system: false, autonym: localeAutonyms[locale] })),
  ];
}
