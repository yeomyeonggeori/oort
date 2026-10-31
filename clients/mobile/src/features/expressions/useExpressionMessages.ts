import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import type {MessageArgs, MessageKey} from '@momo/core/i18n/generated/messages';
import {createMessageService} from '@momo/core/i18n/service';
import type {MessageService} from '@momo/core/i18n/types';
import {useMobileLocale} from '../../i18n/LocaleProvider';

// =============================================================================
// 팀 이모지 「＋」(가져오기·AI와 만들기)의 문구 — 사전(`expressions.json`, ko·en)에서만 온다.
//
// 제품 앱은 늘 `MobileLocaleProvider` 아래에서 돈다. 제공자가 없는 곳(격리 시험·캡처 표면)에서는 한국어 사전으로
// 답한다 — 글자를 컴포넌트에 직접 두지 않고도(`direct-copy.mjs mobile` 장부가 늘지 않는다) 그 자리가 비지 않는다.
// 코어에 이미 있는 문장(실패 사유·움직임 이름·승인 규칙)은 이 훅을 거치지 않고 코어가 말한 그대로 쓴다.
// =============================================================================

const fallback: MessageService = createMessageService({
  messageLocale: 'ko-KR',
  catalog: koCatalog,
});

/** 인자가 없는 문장의 키 — 상태에 담아 두었다가 그릴 때 읽는 키(`phase.key` 처럼)의 타입이다. */
export type PlainMessageKey = {
  [K in MessageKey]: MessageArgs[K] extends Record<string, never> ? K : never;
}[MessageKey];

/** 키 하나의 문장. 제공자가 없으면 한국어 사전이 답한다. */
export function useExpressionMessages(): MessageService['formatMessage'] {
  const locale = useMobileLocale()?.locale;
  return (locale ?? fallback).formatMessage;
}
