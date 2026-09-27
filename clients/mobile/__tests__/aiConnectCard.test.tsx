import {ApiError} from '@momo/core/lib/api';
import type {ProviderLink, ProviderLinkTest} from '@momo/core/features/settings/api';
import {linkPill} from '@momo/core/features/settings/aiLinkPill';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';
import {Keyboard, TextInput} from 'react-native';

import {
  AI_CONNECT_CARD_COPY,
  AiConnectCard,
} from '../src/features/aiConnect/AiConnectCard';
import {
  Composer,
  PHONE_SECRET_KEY_BLOCK_COPY,
} from '../src/features/conversation/Composer';
import {
  channelDraftKey,
  readDraft,
} from '../src/features/conversation/drafts';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// #2945 GC-4 — 폰 `/연결` 카드: 읽기 + 운영자 연결 확인. 로그인·키 입력은 맥.
//
// 세 가지를 잰다.
//   1. 카드의 알약은 코어 `linkPill`이 말한 그대로다(같은 입력 → 같은 알약).
//      판정을 카드 파일에 복사하면 import 그래프 시험이 실패한다.
//   2. 폰 카드에는 키 입력 칸이 없고, 운영자에게만 「연결 확인」이 있다(Q5).
//   3. 컴포저: `/`는 명령 목록을 열고, 명령은 보내지 않고, 키 모양은 막는다.
// =============================================================================

const mockFetch = jest.fn<Promise<ProviderLink>, []>();
const mockTest = jest.fn<Promise<ProviderLinkTest>, []>();

jest.mock('@momo/core/features/settings/api', () => {
  const actual = jest.requireActual('@momo/core/features/settings/api');
  return {
    ...actual,
    fetchProviderLink: () => mockFetch(),
    testProviderLink: () => mockTest(),
  };
});

const LINK: ProviderLink = {
  schema: 'momo.provider_link.v0',
  configured: true,
  source: 'database',
  mode: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  endpointLabel: 'Anthropic',
  bearerConfigured: true,
  bearerLast4: '7c1e',
  availability: 'external',
  keyConfigured: true,
  updatedAtMs: Date.UTC(2026, 8, 20),
  diagnostics: [],
};

const PROBE_OK: ProviderLinkTest = {
  schema: 'momo.provider_link.test.v0',
  ok: true,
  source: 'database',
  mode: 'anthropic',
  endpointLabel: 'Anthropic',
  checkedAtMs: Date.now(),
};

const PROBE_FAIL: ProviderLinkTest = {
  ...PROBE_OK,
  ok: false,
  reason: 'provider_auth_failed',
};

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

function withClient(node: React.ReactElement) {
  const client = new QueryClient({
    // gcTime 무한: 캐시 수거 타이머가 jest 프로세스를 붙잡지 않게.
    defaultOptions: {
      queries: {retry: false, gcTime: Infinity},
      mutations: {retry: false, gcTime: Infinity},
    },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function card(props: Partial<React.ComponentProps<typeof AiConnectCard>> = {}) {
  return render(
    withClient(
      <AiConnectCard line={null} offline={false} onClose={() => {}} {...props} />,
    ),
  );
}

beforeEach(() => {
  mockFetch.mockReset();
  mockTest.mockReset();
  __setNonSecretStore(memoryStore());
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

const pillText = () =>
  screen.getByTestId('ai-connect-card-pill').props.accessibilityLabel as string;

// -----------------------------------------------------------------------------
describe('카드 — 판정은 코어, 행동은 연결 확인 하나', () => {
  it('머리는 「AI 연결 · 나에게만」이고 내 계정 절은 맥으로 보낸다', async () => {
    mockFetch.mockResolvedValue(LINK);
    card();
    expect(screen.getByText(AI_CONNECT_CARD_COPY.title)).toBeTruthy();
    expect(screen.getByTestId('ai-connect-card-only-me')).toBeTruthy();
    expect(screen.getByText(AI_CONNECT_CARD_COPY.mineLine)).toBeTruthy();
    expect(screen.getByText(AI_CONNECT_CARD_COPY.foot)).toBeTruthy();
    await screen.findByTestId('ai-connect-card-team');
  });

  it('운영자: 알약은 코어 linkPill 그대로이고 「연결 확인」이 결과를 제자리에 남긴다', async () => {
    mockFetch.mockResolvedValue(LINK);
    mockTest.mockResolvedValue(PROBE_OK);
    card();
    await screen.findByTestId('ai-connect-card-team');
    const before = linkPill({link: LINK, offline: false, probe: null});
    expect(pillText()).toBe(`상태 ${before.text}`);
    expect(screen.getByTestId('ai-connect-card-team-sub').props.children).toContain('••••7c1e');

    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-connect-card-team-check'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('ai-connect-card-team-result')).toBeTruthy(),
    );
    const after = linkPill({link: LINK, offline: false, probe: PROBE_OK});
    expect(pillText()).toBe(`상태 ${after.text}`);
    expect(mockTest).toHaveBeenCalledTimes(1);
  });

  it('확인 실패: 사유 + 「키는 맥·웹에서」 — 폰에는 키 바꾸기가 없다', async () => {
    mockFetch.mockResolvedValue(LINK);
    mockTest.mockResolvedValue(PROBE_FAIL);
    card();
    await screen.findByTestId('ai-connect-card-team');
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-connect-card-team-check'));
    });
    const result = await screen.findByTestId('ai-connect-card-team-result');
    expect(String(result.props.children)).toContain('provider가 키를 거절했어요.');
    expect(String(result.props.children)).toContain(AI_CONNECT_CARD_COPY.changeOnMac);
    expect(pillText()).toBe(
      `상태 ${linkPill({link: LINK, offline: false, probe: PROBE_FAIL}).text}`,
    );
    expect(screen.queryByText('키 바꾸기')).toBeNull();
    expect(screen.queryByText('키 넣기')).toBeNull();
    // 다시 확인할 길은 남는다.
    expect(screen.getByTestId('ai-connect-card-team-check')).toBeTruthy();
  });

  it('비운영자(403): 줄 대신 한 문장, 버튼 0', async () => {
    mockFetch.mockRejectedValue(new ApiError(403, 'forbidden'));
    card();
    expect(await screen.findByTestId('ai-connect-card-team-denied')).toBeTruthy();
    expect(screen.getByText(AI_CONNECT_CARD_COPY.teamDenied)).toBeTruthy();
    expect(screen.queryByTestId('ai-connect-card-team-check')).toBeNull();
  });

  it('키가 없다: 「아직 없어요」 줄, 폰은 키를 받지 않으므로 버튼 0', async () => {
    mockFetch.mockResolvedValue({
      ...LINK,
      configured: false,
      keyConfigured: false,
      bearerConfigured: false,
      bearerLast4: undefined,
      availability: 'mock',
    });
    card();
    await screen.findByTestId('ai-connect-card-team');
    expect(screen.getByText(AI_CONNECT_CARD_COPY.teamEmptySub)).toBeTruthy();
    expect(screen.queryByTestId('ai-connect-card-team-check')).toBeNull();
  });

  it('오프라인: 「확인할 수 없음」, 확인 버튼은 잠기고 요청을 내지 않는다', async () => {
    mockFetch.mockResolvedValue(LINK);
    card({offline: true});
    await screen.findByTestId('ai-connect-card-team');
    expect(pillText()).toBe('상태 확인할 수 없음');
    expect(screen.getByTestId('ai-connect-card-offline')).toBeTruthy();
    const button = screen.getByTestId('ai-connect-card-team-check');
    expect(button.props.accessibilityState).toMatchObject({disabled: true});
    fireEvent.press(button);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it('`/연결 팀키`는 팀 절만, `/연결 claude`는 내 계정 절만 연다', async () => {
    mockFetch.mockResolvedValue(LINK);
    const first = card({line: 'team'});
    expect(screen.queryByTestId('ai-connect-card-mine')).toBeNull();
    expect(screen.getByTestId('ai-connect-card-team-section')).toBeTruthy();
    await screen.findByTestId('ai-connect-card-team');
    first.unmount();
    card({line: 'claude'});
    expect(screen.getByTestId('ai-connect-card-mine')).toBeTruthy();
    expect(screen.queryByTestId('ai-connect-card-team-section')).toBeNull();
  });

  it('카드 어디에도 입력 칸이 없다(Q5) — 비밀값이 머물 자리가 없다', async () => {
    mockFetch.mockResolvedValue(LINK);
    card();
    await screen.findByTestId('ai-connect-card-team');
    expect(screen.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  });

  it('자판이 올라와 있으면 몸을 접고 머리(닫기)만 남긴다', async () => {
    mockFetch.mockResolvedValue(LINK);
    const spy = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    try {
      card();
      expect(screen.getByTestId('ai-connect-card-folded')).toBeTruthy();
      expect(screen.getByTestId('ai-connect-card-close')).toBeTruthy();
      expect(screen.queryByTestId('ai-connect-card-body')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('닫기는 부른 쪽에 알린다', async () => {
    mockFetch.mockResolvedValue(LINK);
    const onClose = jest.fn();
    card({onClose});
    fireEvent.press(screen.getByTestId('ai-connect-card-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.findByTestId('ai-connect-card-team');
  });
});

// -----------------------------------------------------------------------------
describe('import 그래프 — 알약 판정을 카드에 복사하지 않는다', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/features/aiConnect/AiConnectCard.tsx'),
    'utf8',
  );

  it('linkPill 은 코어 aiLinkPill 에서만 온다', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\blinkPill\b[^}]*\}\s*from\s*'@momo\/core\/features\/settings\/aiLinkPill'/,
    );
    expect(source).not.toMatch(/function\s+linkPill\b/);
    expect(source).not.toMatch(/const\s+linkPill\b/);
  });

  it('알약 낱말을 손으로 적지 않는다', () => {
    for (const word of ['연결됨', '확인 실패', '자격증명 없음', '모의 응답', '연결 안 됨', '확인할 수 없음']) {
      expect(source).not.toContain(`'${word}'`);
      expect(source).not.toContain(`"${word}"`);
    }
  });
});

// -----------------------------------------------------------------------------
describe('컴포저 — `/` 명령과 키 붙여넣기 차단', () => {
  const EMPTY = makeDirectory([]);
  const KEY = 'sk-ant-api03-Zx9Qw7Er5Ty3Ui1Op0As8Df6Gh4Jk2Lz';
  const CH = channelDraftKey('ch-ai');

  function composer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    return render(
      <Composer
        recipient="place"
        channelLabel="에이전트-실험"
        directory={EMPTY}
        draftKey={CH}
        onSend={() => {}}
        {...props}
      />,
    );
  }

  it('`/연`이 명령 목록을 열고, 고르면 명령이 실행되며 보내지 않는다', () => {
    const onSend = jest.fn();
    const onSlashCommand = jest.fn();
    composer({onSend, onSlashCommand});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/연');
    const rows = screen.getAllByTestId('slash-option');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByText('명령')).toBeTruthy();
    fireEvent.press(rows[0]);
    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(onSlashCommand.mock.calls[0][0].id).toBe('ai.connect');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-input').props.value).toBe('');
    expect(readDraft(CH)).toBe('');
  });

  it('폰 목록에는 구독 줄 인자(claude·codex)가 서지 않는다 — 폰 카드에 그 줄이 없다', () => {
    composer({onSlashCommand: jest.fn()});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/연');
    const labels = screen
      .getAllByTestId('slash-option')
      .map(row => String(row.props.accessibilityLabel));
    expect(labels.some(label => label.startsWith('/연결 팀키'))).toBe(true);
    expect(labels.some(label => /claude|codex/.test(label))).toBe(false);
  });

  it('목록이 열린 채 보내면 첫 줄을 고른다 — 반쯤 친 `/연`이 평문으로 나가지 않는다', () => {
    const onSend = jest.fn();
    const onSlashCommand = jest.fn();
    composer({onSend, onSlashCommand});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/연');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({id: 'ai.connect'}),
      {},
    );
  });

  it('`/연결 팀키`를 그대로 보내도 메시지가 되지 않고 팀 줄 의도가 실린다', () => {
    const onSend = jest.fn();
    const onSlashCommand = jest.fn();
    composer({onSend, onSlashCommand});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/연결 팀키');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(onSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({id: 'ai.connect'}),
      {line: 'team'},
    );
  });

  it('오프라인에서도 명령은 누를 수 있다 — 네트워크를 타지 않는다', () => {
    const onSlashCommand = jest.fn();
    composer({onSlashCommand, offline: true});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/connect');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSlashCommand).toHaveBeenCalledTimes(1);
  });

  it('모르는 `/무엇`은 평문으로 보낸다', () => {
    const onSend = jest.fn();
    const onSlashCommand = jest.fn();
    composer({onSend, onSlashCommand});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/usr/local 경로 확인');
    expect(screen.queryByTestId('slash-list')).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('/usr/local 경로 확인');
    expect(onSlashCommand).not.toHaveBeenCalled();
  });

  it('스레드(onSlashCommand 없음)에서는 `/연결`도 평문이다', () => {
    const onSend = jest.fn();
    composer({onSend});
    fireEvent.changeText(screen.getByTestId('composer-input'), '/연결');
    expect(screen.queryByTestId('slash-list')).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('/연결');
  });

  it('키 모양이 든 글은 보내지 않고, 이유를 말하고, 글은 남기고, 초안에는 적지 않는다', () => {
    const onSend = jest.fn();
    composer({onSend, onSlashCommand: jest.fn()});
    const body = `팀 키 이거 쓰세요 ${KEY}`;
    fireEvent.changeText(screen.getByTestId('composer-input'), body);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-key-blocked')).toBeTruthy();
    expect(
      screen.getByText(
        `${PHONE_SECRET_KEY_BLOCK_COPY.lead} ${PHONE_SECRET_KEY_BLOCK_COPY.tail}`,
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('composer-input').props.value).toBe(body);
    expect(readDraft(CH)).toBe('');
    // 키를 빼면 문장이 물러나고 보낼 수 있다.
    fireEvent.changeText(screen.getByTestId('composer-input'), '팀 키 이거 쓰세요');
    expect(screen.queryByTestId('composer-key-blocked')).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('팀 키 이거 쓰세요');
  });

  it('스레드 컴포저도 키를 막는다', () => {
    const onSend = jest.fn();
    composer({onSend});
    fireEvent.changeText(screen.getByTestId('composer-input'), KEY);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-key-blocked')).toBeTruthy();
  });

  it('키가 아닌 `sk-` 낱말은 막지 않는다(오탐 없음)', () => {
    const onSend = jest.fn();
    composer({onSend});
    fireEvent.changeText(screen.getByTestId('composer-input'), 'sk-learn 버전 올려 주세요');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('sk-learn 버전 올려 주세요');
  });
});
