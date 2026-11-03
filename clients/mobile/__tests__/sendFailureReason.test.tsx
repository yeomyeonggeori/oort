import type {SendFailureKind} from '@momo/core/features/connection/sendFailure';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import {FixedScheme} from '../src/design/theme';
import {rememberFailedSend, readFailedSends} from '../src/features/conversation/failedSends';
import {PendingRow} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore} from '../src/storage/kv';
import {member} from './testkit';

// =============================================================================
// 못 보낸 이유의 한 줄과 로그아웃 (#5222, #5201 결정 ⑤).
//   · 행은 이유의 종류(오프라인 · 서버에 닿지 못함 · 서버가 거절)의 **완결된 문장**을 말한다. 상태 코드·서버 원문은 없다. 종류를 모르면 지금까지처럼
//     「전송 실패」다.
//   · 로그아웃은 이 기기에 남은 못 보낸 글을 전부 지운다(초안과 같은 이유).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
const DIRECTORY = makeDirectory([member({id: SELF, displayName: '박서연', handle: 'seoyeon'})]);

const failed = (id = 'c-1'): PendingMessage => ({
  clientMsgId: id,
  channelId: 'ch',
  authorMemberId: SELF,
  body: '내일 오전에 봐요',
  status: 'failed',
  sinceSeq: null,
  createdAtMs: NOW,
});

function mount(failureKind: SendFailureKind | null, language = 'ko-KR') {
  return render(
    <MobileLocaleProvider
      createController={() =>
        createMobileLocaleController({
          port: {
            readPreference: () => 'system',
            writePreference: () => {},
            readDevice: () => ({languages: [language], timeZone: 'UTC'}),
          },
        })
      }>
      <FixedScheme scheme="light">
        <PendingRow pending={failed()} startsGroup directory={DIRECTORY} failureKind={failureKind} onResend={jest.fn()} />
      </FixedScheme>
    </MobileLocaleProvider>,
  );
}

afterEach(cleanup);

describe('PendingRow — 못 보낸 이유의 한 줄', () => {
  it.each([
    ['offline', '오프라인이라 보내지 못했어요'],
    ['server', '서버에 닿지 못해 보내지 못했어요'],
    ['rejected', '서버가 받지 못했어요'],
  ] as const)('%s: 완결된 문장 하나를 말하고 상태 코드·서버 원문이 없다', async (kind, sentence) => {
    mount(kind);
    await waitFor(() => expect(screen.getByTestId('pending-failed-reason')).toHaveTextContent(sentence));
    expect(screen.getByTestId('pending-failed-reason')).not.toHaveTextContent(/\d{3}/);
    expect(screen.queryByText('전송 실패')).toBeNull();
  });

  it('이유를 모르면 지금까지처럼 「전송 실패」만 말한다', async () => {
    mount(null);
    await waitFor(() => expect(screen.getByTestId('pending-failed-reason')).toHaveTextContent('전송 실패'));
  });

  it('영어 기기는 sentence case 문장이다', async () => {
    mount('offline', 'en-US');
    await waitFor(() =>
      expect(screen.getByTestId('pending-failed-reason')).toHaveTextContent("Couldn't send because you're offline"),
    );
  });
});

describe('Timeline — 행마다 자기 이유를 받는다', () => {
  it('실패 둘이 서로 다른 이유를 말한다. 이유가 없는 행은 「전송 실패」다', async () => {
    const rows = [failed('a'), failed('b'), failed('c')].map((row, at) => ({...row, createdAtMs: NOW + at}));
    render(
      <FixedScheme scheme="light">
        <Timeline
          messages={[]}
          directory={DIRECTORY}
          status="ready"
          pending={rows}
          myMemberId={SELF}
          nowMs={NOW}
          onResendPending={jest.fn()}
          failureKinds={new Map<string, SendFailureKind>([['a', 'offline'], ['b', 'rejected']])}
        />
      </FixedScheme>,
    );
    const sentences = (await screen.findAllByTestId('pending-failed-reason')).map(node => node.props.children);
    expect(sentences).toEqual([
      '오프라인이라 보내지 못했어요',
      '서버가 받지 못했어요',
      '전송 실패',
    ]);
  });
});

describe('로그아웃 — 이 기기의 못 보낸 글도 지운다', () => {
  it('signOut 이 남은 못 보낸 글을 전부 지운다 (다음 사람의 같은 채널에서 되살아나지 않는다)', () => {
    const map = new Map<string, string>();
    __setNonSecretStore({
      getString: key => map.get(key),
      set: (key, value) => void map.set(key, String(value)),
      remove: key => map.delete(key),
    });
    try {
      rememberFailedSend('ws-1', {...failed('c-1'), channelId: 'ch-1'}, 'server', NOW);
      expect(readFailedSends('ws-1', 'ch-1', SELF, NOW)).toHaveLength(1);

      let captured: (() => void) | null = null;
      function Probe(): React.JSX.Element | null {
        captured = useSession().signOut;
        return null;
      }
      render(
        <QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}})}>
          <SessionProvider member={{id: SELF, workspaceId: 'ws-1', displayName: '곽성재'} as never}>
            <Probe />
          </SessionProvider>
        </QueryClientProvider>,
      );
      expect(captured).not.toBeNull();
      captured!();
      expect(readFailedSends('ws-1', 'ch-1', SELF, NOW)).toEqual([]);
    } finally {
      __setNonSecretStore(null);
    }
  });
});
