import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {MessageService} from '@momo/core/i18n/types';

import {useMobileLocale} from './LocaleProvider';

// =============================================================================
// 화면이 사전에서 문구를 읽는 한 길 (#4883, ADR-0213).
//
// 설치된 언어 서비스(`MobileLocaleProvider`)의 `formatMessage` 를 그대로 돌려준다. 앱은 늘 그 제공자 아래에서
// 도는데, 따로 떨어진 화면 하네스와 시험은 제공자 없이 화면을 세운다(`useMobileLocale` 머리말). 그때도 화면이 문구를
// 잃지 않도록 같은 사전의 한국어 판으로 읽는다 — 영어 판이 아니라 한국어인 이유는 이 앱의 기본 언어이기 때문이다.
// 문구를 코드에 직접 적는 대체 경로가 아니다: 사전의 정적 import 이고(`controller.ts` 와 같다), 키가 없으면 코어의
// `SAFE_MESSAGE` 가 나온다.
//
// 이름이 `formatMessage` 인 것은 일부러다. 직접 문구 장부(`direct-copy.mjs`)는 `formatMessage(...)` 호출 안의 키를
// 문구가 아닌 것으로 읽고 모르는 키를 잡는다 — 다른 이름으로 부르면 키 문자열이 문구로 세어진다.
// =============================================================================

let fallback: MessageService | null = null;

function fallbackService(): MessageService {
  fallback ??= createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
  return fallback;
}

export function useFormatMessage(): MessageService['formatMessage'] {
  const current = useMobileLocale();
  return current ? current.locale.formatMessage : fallbackService().formatMessage;
}
