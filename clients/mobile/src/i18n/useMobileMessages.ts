import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {MessageService} from '@momo/core/i18n/types';
import {useMobileLocale} from './LocaleProvider';

// 로그인 전 첫 화면 부품(언어 칩·「이메일 기억하기」 줄)이 문구를 읽는 한 줄 (#4669·#4670). 앱의 언어 서비스가 있으면
// 그것이고(언어를 바꾸면 `MobileLocaleProvider`가 다시 그린다), 없으면(provider 없는 격리 하네스·시험) 한국어 서비스다:
// 이 화면의 나머지 문구가 아직 한국어라 격리 화면도 한 언어로 읽힌다(`replyCopy.ts`와 같은 대체). 제품 앱은 늘 provider
// 안이다. 코어 색인(`@momo/core/i18n`)이 아니라 깊은 길로 읽는다: 색인은 사전을 `import()`로 읽는 로더를 함께 내보낸다(#4910).
let isolatedMessages: MessageService | null = null;

function isolated(): MessageService {
  isolatedMessages ??= createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
  return isolatedMessages;
}

export function useMobileMessages(): MessageService {
  return useMobileLocale()?.locale ?? isolated();
}
