import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createLocaleService, type LocaleService} from '@momo/core/i18n/context';
import {resolveLocaleContext} from '@momo/core/i18n/locale';

import {useMobileLocale} from './LocaleProvider';

// =============================================================================
// 화면이 언어 서비스를 통째로 읽는 길 (#5026).
//
// `useFormatMessage` 는 `formatMessage` 만 돌려준다. 사용자 시간대의 시각·날짜·숫자·통화로 문장을 짓는 화면(설정 ›
// 사용 한도의 「내일 오전 9시에 새로 시작해요」)은 나머지 포맷도 같은 서비스에서 받아야 둘이 어긋나지 않는다.
// 설치된 서비스(`MobileLocaleProvider`)를 그대로 돌려주고, 제공자 없이 올린 하네스·시험은 `useFormatMessage` 와 같은
// 이유로 한국어 사전의 정적 import 서비스를 쓴다(문구를 코드에 적는 길이 아니다). 시간대는 기기 정보가 없으면 UTC 다.
// =============================================================================

let fallback: LocaleService | null = null;

function fallbackService(): LocaleService {
  fallback ??= createLocaleService({
    ...resolveLocaleContext('ko-KR', {languages: ['ko-KR']}),
    catalog: koCatalog,
  });
  return fallback;
}

export function useLocaleService(): LocaleService {
  const current = useMobileLocale();
  return current ? current.locale : fallbackService();
}
