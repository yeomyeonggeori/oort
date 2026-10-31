import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {MessageService} from '@momo/core/i18n/types';
import {
  memberNameParts,
  missingMemberLabel,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {useMemo} from 'react';

import {useMobileLocale} from '../../i18n/LocaleProvider';
import type {ReplyTarget} from './replyTarget';

// =============================================================================
// 답글 머리말의 문구 — **전부 i18n 사전의 것이다** (`catalogs/*/reply.json`).
//
// 직접 문구 장부(`direct-copy`)는 화면 소스에 새 문구를 더하지 못하게 한다. 그래서 이 파일은 한국어를 한 글자도 적지
// 않고, 서술자(`ReplyTarget`)를 사전 키로 옮기기만 한다. 사전이 없는 표면(시험·측정 하네스처럼 `MobileLocaleProvider` 없이
// 올라오는 격리 화면)에서는 **ko 카탈로그에서** 문구를 읽는다 — 리터럴 폴백을 이 소스에 두지 않는 방법이다
// (`ConversationHeader` 의 `RECONNECT_NOW_LABEL` 은 장부가 이 규칙을 세우기 전부터 있던 하나다).
// =============================================================================

export interface ReplyCopy {
  /** 머리말 첫 줄: 「○○님에게 답글」, 내 글이면 「내 글에 답글」. */
  header(target: ReplyTarget): string;
  /** 머리말 둘째 줄: 원문, 글이 없는 메시지는 「사진」·「파일」·「이모티콘」 같은 대체 글. */
  excerpt(target: ReplyTarget): string;
  /** 답글 입력칸의 안내 글. */
  placeholder(): string;
  /** ✕ 의 낭독 이름. */
  cancel(): string;
  /** 보내기 단추의 낭독 이름. */
  send(): string;
}

/** 사전 서비스와 명부로 문구 한 벌을 만든다 — 시험이 React 없이 그대로 부른다. */
export function replyCopyFor(messages: MessageService, directory: Directory): ReplyCopy {
  return {
    header: target =>
      target.mine
        ? messages.formatMessage('reply.card.headerSelf')
        : messages.formatMessage('reply.card.headerOther', {
            name: memberNameParts(
              directory,
              target.authorMemberId,
              missingMemberLabel(directory),
            ).name,
          }),
    excerpt: target => {
      const {excerpt} = target;
      switch (excerpt.kind) {
        case 'text':
          // 사용자 글이다 — 사전의 문구가 아니므로 그대로 둔다.
          return excerpt.text;
        case 'photo':
          return messages.formatMessage('reply.card.excerptPhoto');
        case 'file':
          return messages.formatMessage('reply.card.excerptFile');
        case 'expression':
          return messages.formatMessage('reply.card.excerptExpression');
        case 'empty':
          return messages.formatMessage('reply.card.excerptEmpty');
      }
    },
    // 함수인 이유: 컴포저는 답글 대상이 없을 때도 이 한 벌을 든다. 쓰는 때에만 사전을 읽는다.
    placeholder: () => messages.formatMessage('reply.composer.placeholder'),
    cancel: () => messages.formatMessage('reply.card.cancel'),
    send: () => messages.formatMessage('reply.composer.send'),
  };
}

let isolatedMessages: MessageService | null = null;

/** `MobileLocaleProvider` 밖(격리 화면)에서 쓰는 ko 서비스. 한 번만 만든다. */
function isolated(): MessageService {
  isolatedMessages ??= createMessageService({messageLocale: 'ko-KR', catalog: koCatalog});
  return isolatedMessages;
}

/** 지금 앱 언어로 답글 머리말 문구 한 벌. 언어를 바꾸면 새 서비스가 오고 문구가 따라 바뀐다. */
export function useReplyCopy(directory: Directory): ReplyCopy {
  const messages: MessageService = useMobileLocale()?.locale ?? isolated();
  return useMemo(() => replyCopyFor(messages, directory), [messages, directory]);
}
