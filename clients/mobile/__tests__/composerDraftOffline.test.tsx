import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';
import {StyleSheet} from 'react-native';

import {SessionProvider, useSession} from '../src/session/useSession';

import {
  Composer,
  COMPOSER_OFFLINE_COPY,
} from '../src/features/conversation/Composer';
import {
  channelDraftKey,
  DRAFT_LIMIT,
  DRAFT_TTL_MS,
  pruneDrafts,
  readDraft,
  saveDraft,
  threadDraftKey,
} from '../src/features/conversation/drafts';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';

// =============================================================================
// U4-f 폰 — 쓰던 글은 사라지지 않고, 못 보낼 때는 못 보낸다고 말한다 (감사 H-10)
//
// 감사가 이 클라이언트에 대해 적은 두 문장이 이 파일이 지키는 전부다:
//
//   *"첨부 없음, 초안 보존 없음(인메모리). 초안 유실이 특히 아픈데, 뒤로가기가
//     화면을 unmount 한다."*
//   *"전송 버튼의 유일한 비활성 조건은 빈 텍스트."*
//
// 둘은 **한 쌍**이다. 오프라인에서 전송을 막는 것이 정직해지는 유일한 조건이
// 「그동안 쓴 글이 그대로 있다」이기 때문에, 한쪽만 있으면 다른 쪽이 거짓말이
// 된다 — 초안 없이 막으면 글을 빼앗는 것이고, 막지 않고 초안만 두면 반드시
// 실패할 행을 만들어 사람에게 재시도를 떠넘긴다.
// =============================================================================

const EMPTY = makeDirectory([]);

/** MMKV 대역. `jest.setup.js` 의 전역 목은 파일 사이에 상태를 이어 가므로, 이
 *  파일은 자기 이음매를 세워 각 케이스가 빈 저장소에서 시작하게 한다. */
function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

let store = memoryStore();

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

function composer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer recipient="place"
      channelLabel="배포"
      directory={EMPTY}
      onSend={() => {}}
      {...props}
    />,
  );
}

const CH = channelDraftKey('ch-deploy');

// -----------------------------------------------------------------------------
describe('초안 — 화면이 사라져도 글은 남는다', () => {
  it('언마운트 뒤 다시 마운트하면 쓰던 글이 그 자리에 있다', () => {
    // 감사가 든 바로 그 경로: 뒤로가기가 화면을 unmount 한다.
    const first = composer({draftKey: CH});
    fireEvent.changeText(screen.getByTestId('composer-input'), '금요일 배포 건');
    first.unmount();

    composer({draftKey: CH});
    expect(screen.getByTestId('composer-input').props.value).toBe(
      '금요일 배포 건',
    );
  });

  it('첫 렌더가 이미 글을 들고 있다 — 한 프레임 뒤가 아니다', () => {
    // 효과로 채우면 빈 상자가 한 번 그려졌다가 글이 나타난다. `render` 직후의
    // 트리를 그대로 읽어 그 사이가 없음을 단정한다(MMKV 가 동기로 읽히는 것이
    // 여기서 값을 낸다).
    saveDraft(CH, '이미 쓰던 글');
    const {toJSON} = composer({draftKey: CH});
    expect(JSON.stringify(toJSON())).toContain('이미 쓰던 글');
  });

  it('키를 누를 때마다 적힌다 — 나가는 길을 하나씩 막지 않는다', () => {
    // 「나갈 때 저장」이면 프로세스가 죽는 경로에서 글을 잃는다. 매 글자를
    // 적어 두면 그 경로 자체가 없다.
    composer({draftKey: CH});
    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '금');
    expect(readDraft(CH)).toBe('금');
    fireEvent.changeText(input, '금요일');
    expect(readDraft(CH)).toBe('금요일');
  });

  it('보내면 지워진다 — 다음에 열 때 방금 보낸 글이 되살아나지 않는다', () => {
    const onSend = jest.fn();
    composer({draftKey: CH, onSend});
    fireEvent.changeText(screen.getByTestId('composer-input'), '올립니다');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('올립니다');
    expect(readDraft(CH)).toBe('');
  });

  it('채널을 옮기면 각자의 글이 각자의 자리에 선다', () => {
    // 대화 화면은 채널이 바뀌어도 언마운트되지 않는다 — 같은 컴포저에 새
    // `draftKey` 가 온다. 이 전이가 섞이면 A 에 쓰던 글이 B 로 새어 나간다.
    const other = channelDraftKey('ch-random');
    const view = composer({draftKey: CH});
    fireEvent.changeText(screen.getByTestId('composer-input'), '배포 얘기');

    view.rerender(
      <Composer recipient="place"
        channelLabel="잡담"
        directory={EMPTY}
        draftKey={other}
        onSend={() => {}}
      />,
    );
    expect(screen.getByTestId('composer-input').props.value).toBe('');

    fireEvent.changeText(screen.getByTestId('composer-input'), '점심 뭐 먹죠');
    view.rerender(
      <Composer recipient="place"
        channelLabel="배포"
        directory={EMPTY}
        draftKey={CH}
        onSend={() => {}}
      />,
    );
    expect(screen.getByTestId('composer-input').props.value).toBe('배포 얘기');
    expect(readDraft(other)).toBe('점심 뭐 먹죠');
  });

  it('스레드와 채널은 다른 이름 공간이다', () => {
    // 같은 id 문자열이 우연히 겹쳐도 두 자리는 섞이지 않는다. 겹치지 않는 것은
    // 서버 계약의 성질이지 이 파일이 기댈 사실이 아니다.
    expect(channelDraftKey('x')).not.toBe(threadDraftKey('x'));
    saveDraft(channelDraftKey('x'), '채널 글');
    saveDraft(threadDraftKey('x'), '스레드 글');
    expect(readDraft(channelDraftKey('x'))).toBe('채널 글');
    expect(readDraft(threadDraftKey('x'))).toBe('스레드 글');
  });

  it('자리가 없으면 저장소를 건드리지 않는다', () => {
    // `draftKey` 없는 컴포저(측정 하네스·테스트)는 초안 계약 밖이다.
    composer();
    fireEvent.changeText(screen.getByTestId('composer-input'), '아무 글');
    expect(store.map.get(NON_SECRET_KEYS.composerDrafts)).toBeUndefined();
  });

  it('한글 조합은 초안 저장이 붙어도 끊기지 않는다', () => {
    // `Composer.tsx` 머리말이 가장 비싸게 산 사실. 저장은 값이 쓰인 **뒤**에
    // 같은 레일에서 일어나야 하고, 값보다 앞서면 이 단정이 무너진다 —
    // 실기기(iPhone 17, iOS 26.5.1)에서 잡힌 전이를 그대로 태운다.
    composer({draftKey: CH});
    const input = screen.getByTestId('composer-input');
    for (const value of ['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕']) {
      fireEvent.changeText(input, value);
      expect(screen.getByTestId('composer-input').props.value).toBe(value);
    }
    expect(readDraft(CH)).toBe('안녕');
  });
});

// -----------------------------------------------------------------------------
describe('초안 수명 — 보낼 때까지, 다만 영원은 아니다', () => {
  const NOW = 1_700_000_000_000;

  it('빈 글은 초안이 아니다', () => {
    expect(
      pruneDrafts({a: {body: '', savedAtMs: NOW}}, NOW),
    ).toEqual({});
  });

  it('오래된 것은 복원하지 않는다', () => {
    const old = NOW - DRAFT_TTL_MS - 1;
    saveDraft('a', '한 달도 더 전에 쓰다 만 줄', old);
    expect(readDraft('a', NOW)).toBe('');
  });

  it('상한을 넘으면 **가장 오래된 것부터** 버린다', () => {
    const map: Record<string, {body: string; savedAtMs: number}> = {};
    for (let i = 0; i < DRAFT_LIMIT + 3; i += 1) {
      map[`k${i}`] = {body: `초안 ${i}`, savedAtMs: NOW - i * 1000};
    }
    const pruned = pruneDrafts(map, NOW);
    expect(Object.keys(pruned)).toHaveLength(DRAFT_LIMIT);
    expect(pruned.k0).toBeDefined();
    expect(pruned[`k${DRAFT_LIMIT + 2}`]).toBeUndefined();
  });

  it('깨진 값을 읽어도 앱이 죽지 않는다 — 빈 지도로 읽는다', () => {
    store.set(NON_SECRET_KEYS.composerDrafts, '{ 이건 JSON 이 아니다');
    expect(readDraft('a')).toBe('');
    store.set(NON_SECRET_KEYS.composerDrafts, '{"a":{"body":42}}');
    expect(readDraft('a')).toBe('');
  });

  it('마지막 초안을 지우면 키 자체가 사라진다', () => {
    saveDraft('a', '한 줄');
    expect(store.map.get(NON_SECRET_KEYS.composerDrafts)).toBeDefined();
    saveDraft('a', '');
    expect(store.map.get(NON_SECRET_KEYS.composerDrafts)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('오프라인 — 지금은 못 보낸다고 말하고, 실제로 막는다', () => {
  it('전송 버튼이 꺼진다 — 문장만 띄우고 열어 두지 않는다', () => {
    const onSend = jest.fn();
    composer({offline: true, onSend, draftKey: CH});
    fireEvent.changeText(screen.getByTestId('composer-input'), '보낼 글');
    const send = screen.getByTestId('composer-send');
    expect(send.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('막는 동안 쓰던 글은 그대로 있다 — 그래야 문장이 참이다', () => {
    composer({offline: true, draftKey: CH});
    fireEvent.changeText(screen.getByTestId('composer-input'), '연결되면 보낼 글');
    expect(screen.getByTestId('composer-input').props.value).toBe(
      '연결되면 보낼 글',
    );
    expect(readDraft(CH)).toBe('연결되면 보낼 글');
  });

  it('이유를 말한다 — 화면에도, 버튼에도', () => {
    composer({offline: true});
    expect(screen.getByTestId('composer-offline').props.children).toBe(
      COMPOSER_OFFLINE_COPY,
    );
    // 흐려진 버튼에 먼저 도착하는 길이 있다(로터·직접 탐색). 이유는 버튼도 든다.
    expect(screen.getByTestId('composer-send').props.accessibilityHint).toBe(
      COMPOSER_OFFLINE_COPY,
    );
  });

  it('연결이 돌아오면 다시 보낼 수 있다', () => {
    const onSend = jest.fn();
    const view = composer({offline: true, onSend});
    fireEvent.changeText(screen.getByTestId('composer-input'), '보낼 글');
    view.rerender(
      <Composer recipient="place"
        channelLabel="배포"
        directory={EMPTY}
        offline={false}
        onSend={onSend}
      />,
    );
    expect(screen.queryByTestId('composer-offline')).toBeNull();
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(onSend).toHaveBeenCalledWith('보낼 글');
  });

  it('문장에 em-dash 가 없다', () => {
    expect(COMPOSER_OFFLINE_COPY).not.toMatch(/[—–]/);
  });

  it('레일이 아니라 네트워크를 읽는다 — 두 컴포저 모두', () => {
    // 전송은 REST POST 다. 레일(웹소켓)이 재연결 중이어도 그 POST 는 나간다 —
    // `useOnline.ts` 머리말이 승인 컨트롤에 대해 이미 적어 둔 판정이고, 컴포저는
    // 그 수리를 못 받았을 뿐이다. 스레드 답글도 같은 POST 다.
    const thread = fs.readFileSync(
      path.resolve(__dirname, '../src/features/conversation/ThreadPanel.tsx'),
      'utf8',
    );
    expect(thread).toMatch(/const online = useOnline\(\)/);
    expect(thread).toMatch(/offline=\{!online\}/);
  });
});

// -----------------------------------------------------------------------------
describe('성장 정책 — 상한이 도출된 숫자다', () => {
  const inputStyle = () => {
    composer();
    return StyleSheet.flatten(screen.getByTestId('composer-input').props.style);
  };

  it('줄 상자가 스케일에서 나온다 — 21 이라는 손으로 적은 숫자가 아니다', () => {
    // `font.body`(16) 짜리 글자는 화면의 다른 자리에서 `line.body`(22) 를 쓴다.
    // 입력창만 21 을 들고 있었다.
    expect(inputStyle().lineHeight).toBe(22);
  });

  it('상한 = 5줄 + 패딩 + 테두리 (128)', () => {
    // 손으로 적은 120 이 아니라 도출된 값이다. 줄 상자가 바뀌면 같이 움직인다.
    expect(inputStyle().maxHeight).toBe(5 * 22 + 8 * 2 + 1 * 2);
  });

  it('한 줄일 때도 엄지가 닿는다 — 도출된 한 줄 상자보다 44 가 크다', () => {
    const style = inputStyle();
    expect(style.minHeight).toBe(44);
    expect(22 + 8 * 2 + 1 * 2).toBeLessThan(style.minHeight as number);
  });

  it('감긴 줄에도 자란다 — 웹의 개행 세기 결함이 여기엔 없다', () => {
    // 감사 H-10 이 웹에서 잡은 것: `Math.min(MAX_ROWS, text.split("\n").length)`
    // 는 하드 개행만 세므로 길게 감긴 한 줄 문단에서는 상자가 안 자란다.
    //
    // RN 은 `multiline` 입력창을 **콘텐츠 높이**로 재고 감긴 줄도 콘텐츠다. 즉
    // 그 계산이 여기 있으면 안 되고(있으면 OS 의 답을 덮어쓴다), 줄 수를 못
    // 박는 prop 도 없어야 하며, 높이는 min/max 로만 묶여야 한다.
    composer();
    const input = screen.getByTestId('composer-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.numberOfLines).toBeUndefined();
    const style = StyleSheet.flatten(input.props.style) as {height?: number};
    expect(style.height).toBeUndefined();
    // 그리고 텍스트가 늘어도 스타일은 그대로다 — 높이를 정하는 것은 이 파일이
    // 아니라 OS 다.
    fireEvent.changeText(input, '아주 길게 감기는 한 줄 문단'.repeat(20));
    expect(
      StyleSheet.flatten(screen.getByTestId('composer-input').props.style),
    ).toEqual(style);
  });
});

// -----------------------------------------------------------------------------
// H-2 (U4-6 병합 리뷰) — 로그아웃은 초안도 데리고 나간다.
//
// 리뷰가 실측한 것: 웹은 `app/session.tsx` 의 `signOut` 에서 `clearAllDrafts()`
// 를 부르고 그 이유까지 적어 두었는데(「쓰다 만 글은 보낸 메시지보다 사적이다」)
// 폰의 `signOut` 은 세션과 쿼리 캐시만 지웠다. 폰 쪽 저장소가 오히려 더 오래
// 산다 — react-query 의 캐시는 메모리라 프로세스와 함께 사라지지만 MMKV 의
// 초안은 앱이 지워질 때까지 남고, 다음 사람의 첫 입력창에 복원된다.
// -----------------------------------------------------------------------------
describe('로그아웃 — 이 기기에서 내 흔적을 지운다 (H-2)', () => {
  /** 앱이 실제로 쓰는 `signOut` 을 그 provider 에서 그대로 꺼내 온다. */
  function signOutFromApp(): () => void {
    let captured: (() => void) | null = null;
    function Probe(): React.JSX.Element | null {
      captured = useSession().signOut;
      return null;
    }
    const client = new QueryClient({
      defaultOptions: {queries: {retry: false, gcTime: 0}},
    });
    render(
      <QueryClientProvider client={client}>
        <SessionProvider
          member={
            {
              id: '11111111-1111-4111-8111-111111111111',
              workspaceId: 'ws-1',
              displayName: '곽성재',
            } as never
          }>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    if (captured === null) throw new Error('signOut 을 잡지 못했다');
    return captured;
  }

  it('로그아웃하면 채널·스레드 초안이 남지 않는다', () => {
    saveDraft(CH, '보내지 않은 문단');
    saveDraft(threadDraftKey('root-1'), '스레드에 쓰다 만 답글');
    expect(readDraft(CH)).toBe('보내지 않은 문단');

    signOutFromApp()();

    expect(readDraft(CH)).toBe('');
    expect(readDraft(threadDraftKey('root-1'))).toBe('');
    // 지도 자체가 없어야 한다 — 빈 지도가 남으면 그 안에 무엇이 있었는지는
    // 아무도 모르지만 키는 남는다.
    expect(store.map.has(NON_SECRET_KEYS.composerDrafts)).toBe(false);
  });

  it('배선이 없으면 여기서 빨강이다 — 초안만 살아남는 로그아웃', () => {
    // 이 단정이 지키는 것은 `clearAllDrafts` 가 **동작한다**가 아니라 로그아웃이
    // 그것을 **부른다**이다. 앞 판은 함수가 아예 없었고, 함수만 생기고 호출이
    // 빠지면 화면은 앞 판과 똑같다.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/session/useSession.tsx'),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toContain('clearAllDrafts()');
    expect(code).toMatch(/from '\.\.\/features\/conversation\/drafts'/);
  });

  it('로그아웃이 아닌 청소는 하지 않는다 — 수명 규칙은 그대로다', () => {
    // 「부탁받은 청소」와 「부탁받은 적 없는 청소」의 경계가 이 파일의 규율이다.
    // 초안을 읽고 쓰는 것만으로 다른 자리의 초안이 사라지면 안 된다.
    saveDraft(CH, '남아야 하는 글');
    saveDraft(threadDraftKey('root-2'), '이것도 남는다');
    expect(readDraft(CH)).toBe('남아야 하는 글');
    expect(readDraft(threadDraftKey('root-2'))).toBe('이것도 남는다');
  });
});

// =============================================================================
// #1384 CRUN-3 — 이 클라도 컴포저의 문장을 **다시 갖지 않는다**.
//
// 오프라인 문장은 이미 코어에 있었는데(위 스위트), 플레이스홀더는 두 클라가
// 각자 짓고 있었다: 이 파일 옆의 `conversation/Composer.tsx` 와 웹
// `chat/Composer.tsx` 가 `` `${channelLabel}에 메시지 보내기` `` 를 나란히
// 들고 있었고, 스레드 컴포저 둘은 `'답글 쓰기'` 를 나란히 들고 있었다. 값이
// 같아서 안 보였을 뿐, 한쪽을 고치는 날 갈라진다.
//
// 웹 쪽 짝은 `clients/web/src/features/chat/composerCopy.test.ts` 이고, 문장의
// 모양은 `packages/momo-core/src/features/chat/composerCopy.test.ts` 가 잰다.
// 여기서 재는 것은 **이 클라의 소스에 그 문장이 손으로 적혀 있지 않은가**이고,
// 그래서 전수다 — 새 화면이 컴포저를 하나 더 지어도 걸린다.
// =============================================================================

describe('컴포저 카피가 한 벌이다 (#1384)', () => {
  const withoutProse = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const phoneSources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
    };
    walk(path.resolve(__dirname, '../src'));
    return out;
  };

  it('src 전수에 컴포저 문장을 손으로 적은 자리가 없다', () => {
    const offenders: string[] = [];
    for (const file of phoneSources()) {
      const code = withoutProse(fs.readFileSync(file, 'utf8'));
      for (const [index, text] of code.split('\n').entries()) {
        const hit =
          text.includes('에 메시지 보내기') ||
          text.includes('에 보낼 메시지') ||
          text.includes("'답글 쓰기'") ||
          text.includes('"답글 쓰기"');
        if (hit) {
          offenders.push(
            `${path.relative(path.resolve(__dirname, '../src'), file)}:${index + 1}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('컴포저가 코어의 이름을 든다', () => {
    const code = withoutProse(
      fs.readFileSync(
        path.resolve(__dirname, '../src/features/conversation/Composer.tsx'),
        'utf8',
      ),
    );
    expect(code).toContain('composerPlaceholder(channelLabel, recipient)');
    expect(code).toContain('composerFieldLabel(channelLabel, recipient)');
  });

  it('조사를 정하는 사실은 화면이 넘긴다 — 컴포저가 추측하지 않는다', () => {
    // DM 의 title 은 방 이름이 아니라 상대의 displayName 이라, 앞 판은
    // 「hermes에 메시지 보내기」라고 적고 있었다. `recipient` 에 기본값이 없는
    // 것이 이 단정의 전제다: 화면이 안 넘기면 타입이 붉다.
    const screen = withoutProse(
      fs.readFileSync(
        path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'),
        'utf8',
      ),
    );
    expect(screen).toContain("recipient={peer ? 'person' : 'place'}");
  });
});

