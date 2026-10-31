import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createLocaleService, type LocaleService} from '@momo/core/i18n/context';
import {resolveLocaleContext} from '@momo/core/i18n/locale';
import {useMobileLocale} from './LocaleProvider';

// 화면이 사전 문구를 얻는 문 하나 (#4878 — 타임라인의 첫 사전 소비처라 이 모양이 다음 화면의 본이 된다).
//
// 제품 앱은 늘 언어 공급자를 세운다(`MobileLocaleProvider`). 공급자 밖의 격리 화면(시험·측정 하니스)은 **정적 한국어
// 카탈로그**로 물러난다: 폰은 두 카탈로그를 정적으로 들고 있어(`mobileCatalogStatic.test.ts`, #4910 — 코어 배럴이
// 아닌 잎 모듈만 부른다) 새 덩어리가 들지 않고, 폴백 문구를 화면 코드에 리터럴로 두지 않는다. 기존 격리 하니스들이
// 한국어로 문구를 단정해 온 것과 같은 기본값이다.

let koFallback: LocaleService | undefined;

function fallbackLocale(): LocaleService {
  koFallback ??= createLocaleService({
    ...resolveLocaleContext('ko-KR', {languages: ['ko-KR'], timeZone: 'Asia/Seoul'}),
    catalog: koCatalog,
  });
  return koFallback;
}

/** 선택한 언어의 `formatMessage`. 언어가 바뀌면 공급자가 값을 갈아 끼워 다시 그려진다. */
export function useFormatMessage(): LocaleService['formatMessage'] {
  return (useMobileLocale()?.locale ?? fallbackLocale()).formatMessage;
}
