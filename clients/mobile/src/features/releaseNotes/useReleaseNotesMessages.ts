import {
  pickReleaseNoteLocale,
  type ReleaseNoteLocale,
} from '@momo/core/features/releaseNotes/model';
// 코어 색인(`@momo/core/i18n`)이 아니라 깊은 길로 읽는다: 색인은 사전을 `import()` 로 읽는 `loadMessageCatalog` 를 함께 내보내서, 값으로
// 끌어오면 Metro 개발 서버의 지연 번들이 루트 밖 파일을 못 풀어 멈춘다(#4910, `mobileCatalogStatic.test.ts`).
import {createMessageService} from '@momo/core/i18n/service';
import type {MessageService} from '@momo/core/i18n/types';

import {useMobileLocale} from '../../i18n/LocaleProvider';

// 업데이트 소식 화면이 읽는 문구 서비스와, 소식 파일의 ko·en 중 쓸 쪽 (#4937). 앱의 언어 서비스가 있으면 그것이고(언어를
// 바꾸면 `MobileLocaleProvider` 가 다시 그린다), 없으면(provider 없는 하네스·시험) 코어에 묶인 영어 사전이다. 제품 앱은
// 늘 provider 안이다. 사전이 없는 언어는 영어 문장이다(ADR-0213).
const FALLBACK: MessageService = createMessageService({messageLocale: 'en-US'});

export function useReleaseNotesMessages(): {
  messages: MessageService;
  noteLocale: ReleaseNoteLocale;
} {
  const current = useMobileLocale();
  const messages: MessageService = current ? current.locale : FALLBACK;
  return {messages, noteLocale: pickReleaseNoteLocale(messages.messageLocale)};
}
