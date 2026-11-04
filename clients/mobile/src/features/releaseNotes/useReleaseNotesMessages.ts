import type {MessageService} from '@momo/core/i18n/types';

import {useMobileMessages} from '../../i18n/useMobileMessages';

// 업데이트 소식 화면이 읽는 문구 서비스 (#4937). 앱의 언어 서비스가 있으면 그것이고(언어를 바꾸면 `MobileLocaleProvider` 가
// 다시 그린다), 없으면(provider 없는 하네스·시험) 한국어 서비스다 — 다른 문구 훅(`useMobileMessages`·`useExpressionMessages`·
// `useReplyCopy`)과 같은 대체라서 `useMobileMessages` 를 그대로 쓴다: 격리 화면의 나머지 문구가 한국어이니 한 화면이 한 언어로
// 읽힌다. 처음에는 이 자리가 영어 사전이었고, 그래서 provider 없는 설정 표면(`shell-profile-bottom`)의 「정보」 카드 첫 줄이
// 한국어 화면에서 「What's new」로 섰다(#5047). 제품 앱은 늘 provider 안이라(`App.tsx`) 앱의 문구는 그대로다.
//
// 소식의 글도 화면 문구와 같은 사전의 키라서(`ReleaseNote` 의 `summary`·`title`…, #5054) 소식 쪽에 언어 갈래가 없다: 사전이
// 없는 언어는 사전의 영어 대체를 그대로 탄다(ADR-0213).
export function useReleaseNotesMessages(): {messages: MessageService} {
  return {messages: useMobileMessages()};
}
