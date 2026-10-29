import {measureComposerText} from './fixtures/composerMeasurement';
import {
  composerFieldLabel,
  composerPlaceholder,
  composerPlaceholderClauses,
  MENTION_AFFORDANCE,
} from '@momo/core/features/chat/composerCopy';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';
import {Dimensions, StyleSheet} from 'react-native';

import {SessionProvider, useSession} from '../src/session/useSession';

import {
  Composer,
  composerColumnBudget,
  composerMaxHeight,
  composerExpandedMaxHeight,
  composerCollapsedHeight,
  COMPOSER_MAX_ROWS,
  PILL_CHROME,
  COMPOSER_OFFLINE_COPY,
  INPUT_CHROME,
  INPUT_CHROME_X,
  mentionRowHeight,
  mentionSheetMaxHeight,
  PLACEHOLDER_MAX_LINES,
  placeholderRoom,
  withLatinWordBreaks,
} from '../src/features/conversation/Composer';
import {
  composerFloat,
  composerTextColumn,
} from '../src/features/conversation/convDesign';
import {line} from '../src/design/tokens';
import {matchMembers} from '../src/features/conversation/mentionQuery';
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

/** 멘션 시트를 여는 후보 하나 (#1480). 목록은 후보가 0 이면 아예 안 선다. */
const AGENT = {
  workspaceId: 'ws',
  id: 'm-hermes',
  kind: 'agent',
  status: 'active',
  displayName: '김인턴',
  handle: 'hermes',
  channelCount: 0,
  channelIds: [],
  capabilities: [],
  createdAtMs: 0,
  updatedAtMs: 0,
} as unknown as RosterMember;

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

/**
 * 동적 타입과 창 크기를 이 케이스의 것으로 바꾼다 (#1443).
 *
 * `Dimensions.set` 은 네이티브가 부르는 그 문이고(`didUpdateDimensions`), RN 은
 * 접근성 글자 크기가 바뀔 때 같은 문으로 새 `fontScale` 을 내보낸다. 즉 여기서
 * 흉내 내는 것은 테스트용 뒷문이 아니라 **기기에서 실제로 일어나는 갱신**이다.
 */
const BASE_WINDOW = Dimensions.get('window');
function setWindow(next: {fontScale?: number; height?: number; width?: number}) {
  const window = {
    ...BASE_WINDOW,
    ...(next.height === undefined ? {} : {height: next.height}),
    ...(next.width === undefined ? {} : {width: next.width}),
    ...(next.fontScale === undefined ? {} : {fontScale: next.fontScale}),
  };
  Dimensions.set({window, screen: window});
}

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
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
describe('#4790 입력창 성장', () => {
  const input = () => screen.getByTestId('composer-input');
  const style = () => StyleSheet.flatten(input().props.style);
  const measure = (height: number) => measureComposerText(height - 16);

  it.each([channelDraftKey('growth'), threadDraftKey('growth')])(
    '일반·스레드 %s: 입력창 이벤트 없이 거울이 자동 줄바꿈을 재고 다섯째 명시 줄도 스크롤한다',
    draftKey => {
      setWindow({fontScale: 1, height: 874});
      composer({draftKey});
      fireEvent.changeText(input(), '개행 없이 이어지는 긴 문단'.repeat(20));
      measure(4 * line.body + 16);
      const mirror = screen.getByTestId('composer-content-mirror', {includeHiddenElements: true});
      expect(StyleSheet.flatten(mirror.props.style).width).toBe(280 - INPUT_CHROME_X);
      expect(mirror.props.numberOfLines).toBeUndefined();
      expect(input().props.onContentSizeChange).toBeUndefined();
      expect(style().height).toBe(4 * line.body + INPUT_CHROME);
      expect(input().props.scrollEnabled).toBe(false);
      fireEvent.changeText(input(), '첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n다섯째 줄');
      expect(input().props.scrollEnabled).toBe(true);
      fireEvent.changeText(input(), '');
      expect(style().height).toBe(44);
      expect(input().props.scrollEnabled).toBe(false);
    },
  );

  it('폰 4줄과 도구 줄 44pt를 포함한 전체 상한을 잠근다', () => {
    expect(COMPOSER_MAX_ROWS).toBe(4);
    for (const height of [667, 852, 874, 956]) {
      setWindow({height, fontScale: 1});
      const view = composer();
      fireEvent.changeText(input(), '긴 문단'.repeat(100));
      measure(600);
      expect(style().height).toBe(4 * line.body + INPUT_CHROME);
      expect(input().props.scrollEnabled).toBe(true);
      expect(input().props.onContentSizeChange).toBeUndefined();
      expect(style().height + 44 + PILL_CHROME).toBe(composerExpandedMaxHeight(1, height));
      expect(composerExpandedMaxHeight(1, height)).toBe(164);
      view.unmount();
    }
  });

  it('타이핑·붙여넣기·초안 복원 모두 측정한 감긴 줄로 자라고 줄어든다', () => {
    setWindow({fontScale: 1, height: 874});
    for (const restored of [false, true]) {
      if (restored) saveDraft(CH, '복원한 문단'.repeat(40));
      const view = composer(restored ? {draftKey: CH} : {});
      if (!restored) fireEvent.changeText(input(), '긴 문단'.repeat(40));
      measure(3 * line.body + 16);
      expect(style().height).toBe(3 * line.body + INPUT_CHROME);
      expect(input().props.scrollEnabled).toBe(false);
      measure(4 * line.body + 16);
      expect(style().height).toBe(4 * line.body + INPUT_CHROME);
      expect(input().props.scrollEnabled).toBe(false);
      measure(5 * line.body + 16);
      expect(style().height).toBe(4 * line.body + INPUT_CHROME);
      expect(input().props.scrollEnabled).toBe(true);
      fireEvent.changeText(input(), '짧은 글');
      measure(line.body + 16);
      expect(style().height).toBe(44);
      expect(input().props.scrollEnabled).toBe(false);
      fireEvent.changeText(input(), '');
      expect(style().height).toBe(44);
      view.unmount();
    }
  });

  it('AX1~AX5: 접힘·펼침 첫 줄과 자리표시가 배수를 따라 온전히 선다', () => {
    for (const fontScale of [1.786, 2.143, 2.643, 3.143, 3.571]) {
      for (const height of [667, 874]) {
        setWindow({fontScale, height});
        const view = composer({channelLabel: 'release-2026-08-아주-긴-방-이름'});
        const collapsed = composerCollapsedHeight(fontScale);
        expect(style().height).toBeGreaterThanOrEqual(Math.ceil(line.body * fontScale) + INPUT_CHROME);
        const placeholder = screen.getByTestId('composer-placeholder', {includeHiddenElements: true});
        expect(placeholder.props.numberOfLines).toBe(1);
        expect(placeholder.props.ellipsizeMode).toBe('tail');
        fireEvent(input(), 'focus');
        expect(style().height).toBe(collapsed);
        fireEvent.changeText(input(), '첫 줄 gypp');
        measure(line.body * fontScale + 16);
        expect(style().height).toBeGreaterThanOrEqual(collapsed);
        expect(style().maxHeight + 44 + PILL_CHROME).toBeCloseTo(composerExpandedMaxHeight(fontScale, height));
        expect(composerMaxHeight(fontScale, height)).toBeGreaterThanOrEqual(2 * line.body * fontScale + INPUT_CHROME - 0.001);
        view.unmount();
      }
    }
  });
});

// -----------------------------------------------------------------------------
// #1443 ② — `hangul-word` 가 손 못 대는 축: 라틴 낱말.
describe('#1443 라틴 낱말 절단 — 토큰의 자기 경계에서 끊긴다', () => {
  it('라틴/숫자 사이의 구분자 뒤에 줄바꿈 기회가 생긴다', () => {
    expect(withLatinWordBreaks('release-2026-08에 메시지 보내기')).toBe(
      'release-​2026-​08에 메시지 보내기',
    );
    expect(withLatinWordBreaks('api_v2/status.json')).toBe(
      'api_​v2/​status.​json',
    );
  });

  it('한글은 손대지 않는다 — 거기는 `hangul-word` 의 자리다', () => {
    // 한글 사이에 기회를 심으면 그 전략이 막아 둔 어절 가운데 끊김을 되살린다.
    expect(withLatinWordBreaks('프로덕트-디자인에 메시지 보내기, @로 부르기')).toBe(
      '프로덕트-디자인에 메시지 보내기, @로 부르기',
    );
    expect(withLatinWordBreaks('일반에 메시지 보내기, @로 부르기')).toBe(
      '일반에 메시지 보내기, @로 부르기',
    );
  });

  it('낱말 끝에 붙은 구분자에는 안 심는다 — 이미 줄 끝이다', () => {
    expect(withLatinWordBreaks('release- 다음')).toBe('release- 다음');
  });

  it('플레이스홀더에만 걸린다 — **사람이 친 글은 우리 것이 아니다**', () => {
    composer({channelLabel: 'release-2026-08'});
    const input = screen.getByTestId('composer-input');
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toContain('release-​2026-​08');
    // 같은 문자열을 이름으로 읽어 주는 자리에는 안 들어간다.
    expect(input.props.accessibilityLabel).not.toContain('​');
    // 그리고 값은 친 그대로다 — 이 파일의 첫 번째 규칙(머리말)이다.
    fireEvent.changeText(input, 'release-2026-08 배포합니다');
    expect(screen.getByTestId('composer-input').props.value).toBe(
      'release-2026-08 배포합니다',
    );
  });
});

// -----------------------------------------------------------------------------
// #1480 — 멘션 시트의 상한도 도출된 숫자다.
//
// `Composer.tsx` 의 #1443 머리말이 이 결함을 자기 안에 이미 적어 두고 갔다:
// *"그중 하나는 같은 가족의 결함을 자기 안에 갖고 있다 — 180 은 고정 pt 라 큰
// 글자에서 담는 행 수가 줄고, 열려 있는 동안 목록을 그만큼 더 먹는다."* 여기서
// 재는 것은 그 두 축이다.
//
// ## 도크는 **입력창보다 크다** — #1443 의 모델이 그것을 안 셌다
//
// 열의 몫을 나눌 때 센 것은 입력창의 상한뿐이었다. 화면의 도크는 그것 말고도
// `styles.bar` 의 위아래 여백(`space.sm` 둘)을 지고, 시트가 열리면 시트까지 진다.
// AX-XXL 산수가 그래서 안 맞았다: 180 + 170.4 + 16 = **366.4** vs 대화 열
// **340.9** — 도크가 열을 25.5pt 넘고, 그만큼이 타임라인에서 빠진다.
//
// ## 「몇 개를 보여 주는가」 — **넷**, 그리고 오늘도 넷이었다
//
// 180 은 아무 데서도 도출되지 않은 값이고, 기본 크기에서 그것이 담던 것은
// 4행(4 × 44 = 176)과 **4pt 짜리 다섯째 행의 이마**였다. 이 레포는 그 반노출을
// 웹에서 이미 한 번 닫았다(#1418 의 `1lh` 클램프). 그러니 넷은 새 결정이 아니라
// 오늘 값의 **뜻**이고, 새로 정한 것은 그 넷이 열을 넘을 때 무엇이 이기는가다.
//
// 넷의 두 번째 근거도 **여기서 잰다**(회전 1 H1): 기준 창에서 열이 허락하는 최대
// 정수 행이 정확히 넷이다. 첫 판은 그 자리에 「`matchMembers` 가 이미 정렬한다」고
// 적었는데 그 함수는 정렬하지 않는다 — 거짓 근거 위에 선 결정은 다음 사람이 다시
// 물을 때 답이 없다.
describe('#1480 멘션 시트 상한 — 동적 타입 비례 + 도크가 열을 안 넘는다', () => {
  const AX_XXL = 3.143;
  const H = 874;
  const TOUCH_TARGET = 44;
  /**
   * 알약의 선 + `styles.bar` 의 위아래 여백(합 5 × 2)과 도크 위 여백(`space.sm` 8). 도크가 시트·입력창
   * 말고 지는 것. 알약이 Buzz 동심(원 36 · 여백 9, #4179)이 되면서 선 + 안쪽 줄 여백이 4 → 5 라
   * 16 → **18** 이다.
   */
  const BAR_CHROME = 5 * 2 + 44 + 8;

  /**
   * iOS 동적 타입 배수 **사다리 전부** (`RCTAccessibilityManager` 기본표).
   *
   * 몇 개만 골라 쓰면 고른 사람이 안 고른 칸에 대해 아무 말도 안 한 것이 된다 —
   * 아래 「거짓인 자리」 표가 잔량이려면 재는 것이 전수여야 한다(§5.5 ②).
   */
  const SCALES = [
    0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143,
    3.571,
  ];

  /**
   * 이 앱이 실제로 서는 **세로 논리 높이**, 그리고 **그 목록의 전제** (회전 2 M2).
   *
   * ## 전제 — 지원 하한은 **iOS 16.4**
   *
   * 첫 판은 이 격자를 「iOS 26 이 도는 기기」로 정당화했는데, 배송 설정은 그것을
   * 말하지 않는다: `ios/MomoMobile.xcodeproj/project.pbxproj` 는 여섯 구성 전부
   * `IPHONEOS_DEPLOYMENT_TARGET = 16.4` 다. 16.4 는 iPhone 8 Plus(414×**736**)에
   * 설치되고, 736 은 이 배치의 불변식이 **거짓인 네 번째 자리**를 든다
   * (736×3.571 → +11.2pt). 즉 736 은 틀린 수가 아니라 **하한을 어디로 잡느냐**의
   * 문제였고, 답에 따라 아래 `FLOOR_WINS` 가 세 줄이 아니라 네 줄이다. 하한을
   * 올리는 날 이 목록에서 736 을 빼는 사람은 `project.pbxproj` 를 함께 고친다.
   *
   * ## 무엇이 목록으로 닫히고 무엇이 안 닫히는가
   *
   * **아이폰은 닫힌다.** 세로 전용이므로(`Info.plist` 의
   * `UISupportedInterfaceOrientations`) 창 높이가 곧 기기 높이이고, 16.4 가 도는
   * 기기의 논리 높이는 유한하다: 667(SE 2·3 / 8) · 736(8 Plus) · 812(X·XS·11 Pro·
   * 12·13 mini) · 844(12·13·14) · 852(14 Pro·15·16) · 874(16 Pro) · 896(XR·XS Max·
   * 11·11 Pro Max) · 926(12·13 Pro Max·14 Plus) · 932(14 Pro Max·15 Plus·16 Plus) ·
   * 956(16 Pro Max).
   *
   * **아이패드는 안 닫힌다.** 가로가 열려 있어 짧은 변이 창 높이가 될 수 있고
   * (가장 작은 것이 744 — 아이패드 미니 가로), `UIRequiresFullScreen` 이 없어
   * 멀티태스킹 창 높이는 **연속값**이다. 어떤 목록도 거기서는 전수가 못 된다.
   * 그러니 이 목록이 드는 아이패드 값들(744·810·820·834·1024·1032·1080·1180·
   * 1366)은 표본이지 전수가 아니고, 연속값의 몫은 아래 **기제 단정**이 진다 —
   * 「도크가 열을 넘었다면 시트는 반드시 바닥에 앉아 있다」는 격자와 무관하게
   * 참이고, 그 테스트는 목록이 아니라 촘촘한 연속 쓸이를 돈다.
   */
  const HEIGHTS = [
    667, 736, 744, 810, 812, 820, 834, 844, 852, 874, 896, 926, 932, 956, 1024,
    1032, 1080, 1180, 1366,
  ];

  const sheetStyle = () => {
    fireEvent.changeText(screen.getByTestId('composer-input'), '@');
    return StyleSheet.flatten(
      screen.getByTestId('mention-list').props.style,
    ) as {maxHeight?: number};
  };

  it('기본 크기에서 담는 수는 그대로 넷이다 — 다섯째 행의 이마만 없어진다', () => {
    // 옛 값 180 은 4행(176)에 4pt 가 붙은 값이었다. 그 4pt 가 화면에서 하는 일은
    // 다섯째 이름의 윗동을 보여 주는 것 하나이고, 그것이 §5.3 이 세는 반노출이다.
    expect(mentionSheetMaxHeight(1, H)).toBe(3 * TOUCH_TARGET);
    expect(180 - 4 * TOUCH_TARGET).toBe(4); // 회귀 표식: 옛 값의 나머지
  });

  it('넷의 두 번째 근거 — 기준 창에서 열이 허락하는 최대 정수 행이 넷이다', () => {
    // 회전 1 H1. 첫 판은 이 자리에 「`matchMembers` 가 이미 정렬해 첫 줄을
    // 최선으로 만든다」고 적었는데, 그 함수는 `status === 'active'` 로 거르고
    // 부분일치로 거르고 `.slice` 할 뿐 **정렬하지 않는다** — 아래 단정이 그
    // 사실을 못으로 박는다(정렬이 생기는 날 이 줄이 빨갛고, 그때는 근거를 다시
    // 쓸 사람이 이 줄 앞에 선다).
    //
    // 픽스처의 두 이름은 **가나다순이 입력 순서와 어긋나게** 골랐다 (회전 2 M1).
    // 첫 판은 「나중」/「먼저」였는데 자모로 ㄴ < ㅁ 이라 이름 오름차순이 입력
    // 순서와 **같은 답**을 냈다 — 한국어 멘션 목록에 제일 들어올 법한 정렬을
    // 그 못이 통과시킨다. 「후발」(ㅎ)이 먼저 오고 「선발」(ㅅ)이 뒤에 오므로
    // 이제 이름순·핸들순 어느 쪽으로 정렬해도 아래 단정이 빨개진다.
    const roster = [
      {...AGENT, id: 'b', displayName: '후발', handle: 'zeta'},
      {...AGENT, id: 'a', displayName: '선발', handle: 'alpha'},
    ] as RosterMember[];
    // 한글 음절 블록(U+AC00~)은 초·중·종성 순으로 배열돼 있어 코드포인트 비교가
    // 곧 자모 순서다 — 로케일 데이터 없이도 가나다순을 여기서 셀 수 있다.
    const ascending = (pick: (m: RosterMember) => string) =>
      [...roster].sort((a, b) => (pick(a) < pick(b) ? -1 : 1)).map(m => m.handle);
    expect(ascending(m => m.displayName)).toEqual(['alpha', 'zeta']);
    expect(ascending(m => m.handle)).toEqual(['alpha', 'zeta']);
    // 배송되는 답은 그 둘 중 어느 것도 아니다 — **로스터가 도착한 순서** 그대로다.
    expect(matchMembers(roster, '').map(m => m.handle)).toEqual([
      'zeta',
      'alpha',
    ]);

    // 그래서 근거는 **재서 나온다.** 기준 창(874pt · 기본 크기 — 캡처를 찍는 그
    // 기기)에서 열이 허락하는 정수 행이 정확히 넷이고, 다섯은 안 든다.
    const budget = composerColumnBudget(1, H);
    const room = budget.column - budget.composer - BAR_CHROME;
    expect(room).toBeCloseTo(168.9, 1); // #4179 전 191.9 — 도크 크롬 16 → 18
    expect(Math.floor(room / TOUCH_TARGET)).toBe(3);
    expect(5 * TOUCH_TARGET).toBeGreaterThan(room);
    expect(mentionSheetMaxHeight(1, H)).toBe(3 * TOUCH_TARGET);
  });

  it('상한 4가 실제로 무는 창은 큰 것들뿐이다 — 그 아래는 열이 먼저 문다', () => {
    // 「넷」이 새 제약을 만드는 자리가 어디인지도 값이어야 한다. **배수 1 에서**
    // 열이 다섯 행을 허락하려면 창이 946pt 를 넘어야 하고, 오늘 목록에서 그런
    // 것은 여섯이다.
    const capBindsAt = (fontScale: number) =>
      HEIGHTS.filter(height => {
        const budget = composerColumnBudget(fontScale, height);
        const room = budget.column - budget.composer - BAR_CHROME;
        return Math.floor(room / mentionRowHeight(fontScale)) > 4;
      });
    expect(capBindsAt(1)).toEqual([1024, 1032, 1080, 1180, 1366]);
    // 그 문턱 자체도 값이다(창 × 0.39 − 입력창 133 − 도크 크롬 18 ≥ 5 × 44):
    // 926 은 안 물고 956 은 문다. (#4179 전 크롬 16 → 문턱 946, 지금 951)
    expect((1000 * 0.39 - 110 - BAR_CHROME) / TOUCH_TARGET).toBeLessThan(5);
    expect((1024 * 0.39 - 110 - BAR_CHROME) / TOUCH_TARGET).toBeGreaterThanOrEqual(5);

    // **946 은 배수 1 한정이다** (회전 2 nitpick). 사다리 아래쪽에서는 입력창이
    // 작아져 문턱이 내려가고 — 0.823 에서는 883.5pt 라 926 도 문다 — 위쪽에서는
    // 행이 자라 문턱이 올라가서 3.571 에서는 어느 배송 높이도 안 문다. 한정 없이
    // 적힌 946 은 「이 상한은 큰 창에서만 논다」를 사다리 전체의 사실처럼 읽힌다.
    expect(capBindsAt(0.823)).toContain(1024);
    expect(capBindsAt(3.571)).toEqual([]);
  });

  it('행이 글자를 따라간다 — 44 는 바닥이지 값이 아니다', () => {
    // 행의 두 조각(이름 13 · 핸들 12)은 한 줄로 읽혀야 하므로 `line.head`(15)를
    // 선언한다. 그 상자에 배수가 곱해지고, 44 보다 커지는 순간부터 행이 그것이다.
    expect(mentionRowHeight(1)).toBe(TOUCH_TARGET);
    expect(mentionRowHeight(AX_XXL)).toBeCloseTo(15 * AX_XXL, 5);
    expect(mentionRowHeight(AX_XXL)).toBeGreaterThan(TOUCH_TARGET);
  });

  it('행이 44 를 넘기 시작하는 자리는 배수 2.933 이다 — 그 아래 변화는 열의 몫이다', () => {
    // 회전 1 M3. 캡처 두 장(기본 · a11y-large)은 둘 다 「후보 행 44.0pt」를 적고
    // 있었다 — 그 사진들이 보여 준 4행 → 3행은 **행 스케일이 아니라 열 예산**에서
    // 온 변화다. 「동적 타입 비례」를 증거로 세우려면 행이 실제로 자라는 띠를
    // 찍어야 하고, 그 띠가 어디서 시작하는지는 여기서 값으로 답한다.
    expect(TOUCH_TARGET / 15).toBeCloseTo(2.9333, 4);
    for (const fontScale of SCALES.filter(s => s <= 2.643)) {
      expect(mentionRowHeight(fontScale)).toBe(TOUCH_TARGET);
    }
    for (const fontScale of SCALES.filter(s => s >= 3.143)) {
      expect(mentionRowHeight(fontScale)).toBeGreaterThan(TOUCH_TARGET);
      expect(mentionRowHeight(fontScale)).toBeCloseTo(15 * fontScale, 5);
    }
    // a11y-large(2.143)에서 시트가 3행이 되는 것은 행이 커져서가 아니다 — 행은
    // 그대로 44 이고, 줄어든 것은 열이 시트에 주는 몫이다.
    expect(mentionRowHeight(2.143)).toBe(mentionRowHeight(1));
    expect(mentionSheetMaxHeight(2.143, H)).toBe(2 * TOUCH_TARGET);
    expect(mentionSheetMaxHeight(1, H)).toBe(3 * TOUCH_TARGET);
    // 그리고 AX-XXL 에서는 행 자체가 자란다 — 캡처가 그 띠를 든다.
    expect(mentionRowHeight(AX_XXL)).toBeCloseTo(47.1, 1);
  });

  // ---------------------------------------------------------------------------
  // 불변식과 **그것이 거짓인 띠** (회전 1 M1)
  //
  // 첫 판은 격자를 `[812, 874, 956, 1366]` 으로 잡았고, 그 넷은 불변식이 거짓인
  // 세 자리를 정확히 비껴갔다. 산문으로는 「가장 작은 창 · 가장 큰 글자에서는
  // 바닥이 이긴다」고 고지했지만, 고지된 띠와 **값으로 고정된 띠**는 다르다 —
  // 앞의 것은 다음 사람이 식을 만질 때 아무것도 안 잡는다(#1594 가 자기 미도달
  // 띠를 표로 센 것과 같은 규율).
  //
  // 그래서 여기서는 사다리 전수 × 기기 전수를 쓸고, 거짓인 자리를 **표로** 든다.
  // ---------------------------------------------------------------------------

  /**
   * 불변식이 거짓인 자리 — `[창, 배수, 초과pt, 옛 180 이었다면 초과pt]`.
   *
   * 넷 다 「가장 작은 창 × 가장 큰 두 글자」이고, 넷 다 **바닥(2행)이 이겨서**
   * 거짓이다(아래 기제 단정). 그것이 의도라는 것은 `MENTION_MIN_ROWS` 의
   * 독스트링이 든다 — 「고를 수 있는 화면」이 「대화가 남는 화면」을 이긴다.
   *
   * 마지막 칸이 이 배치의 방향을 든다: 같은 자리에서 옛 고정 180 은 **훨씬 더**
   * 넘었다. 이 띠는 새로 생긴 결함이 아니라 좁아진 옛 결함이다.
   */
  // #4790: 도구 줄 44pt를 포함한 정직한 잔량이다. 큰 글자·작은 창의
  // 두 줄 편집 바닥과 시트 두 행 바닥이 겹칠 때 열을 넘는 기존 한계도 기록한다.
  const FLOOR_WINS: ReadonlyArray<readonly [number, number, number, number]> = [
    [667, 1.118, 5.0, 97.0],
    [667, 1.235, 5.0, 97.0],
    [667, 1.353, 5.0, 97.0],
    [667, 1.786, 5.0, 97.0],
    [667, 2.143, 6.4, 98.4],
    [667, 2.643, 29.4, 121.4],
    [736, 2.643, 2.5, 94.5],
    [667, 3.143, 58.7, 144.4],
    [736, 3.143, 31.8, 117.5],
    [744, 3.143, 28.7, 114.4],
    [810, 3.143, 3.0, 88.7],
    [812, 3.143, 2.2, 87.9],
    [667, 3.571, 91.3, 164.1],
    [736, 3.571, 64.4, 137.2],
    [744, 3.571, 61.2, 134.1],
    [810, 3.571, 35.5, 108.4],
    [812, 3.571, 34.7, 107.6],
    [820, 3.571, 31.6, 104.5],
    [834, 3.571, 26.1, 99.0],
    [844, 3.571, 22.2, 95.1],
    [852, 3.571, 19.1, 92.0],
    [874, 3.571, 10.5, 83.4],
    [896, 3.571, 2.0, 74.8],
  ];

  const dockOf = (fontScale: number, height: number) =>
    mentionSheetMaxHeight(fontScale, height) +
    composerColumnBudget(fontScale, height).composer +
    BAR_CHROME;

  it('도크가 대화 열을 안 넘는다 — 표에 든 네 자리를 빼고 전수에서', () => {
    // 이것이 이 티켓의 불변식이다. 넘으면 그 초과분은 타임라인에서 나온다.
    const over: Array<[number, number, number]> = [];
    for (const fontScale of SCALES) {
      for (const height of HEIGHTS) {
        const budget = composerColumnBudget(fontScale, height);
        const excess = dockOf(fontScale, height) - budget.column;
        if (excess > 1e-9) {
          over.push([height, fontScale, Number(excess.toFixed(1))]);
        }
      }
    }
    // 잔량이지 허용목록이 아니다: 띠가 줄면 이 단정이 먼저 빨갛고, 그때 표를
    // 줄이는 사람은 자기가 무엇을 고쳤는지 안다.
    expect(over).toEqual(FLOOR_WINS.map(([h, s, e]) => [h, s, e]));
  });

  it('거짓인 자리는 **바닥이 이길 때뿐이다** — 식이 진 것이 아니라 양보한 것', () => {
    // 표가 오늘의 기기 목록에 달려 있는 반면 이것은 기제다: 어떤 격자를 쓰든,
    // 도크가 열을 넘었다면 시트는 반드시 바닥(2행)에 앉아 있다.
    //
    // **그래서 이것만 목록을 안 쓴다** (회전 2 M2). 위 표가 못 닫는 것이 정확히
    // 아이패드 멀티태스킹 창 높이인데(`UIRequiresFullScreen` 이 없어 연속값이다),
    // 기제는 격자와 무관하므로 여기서는 240~1400pt 를 0.5pt 씩 쓴다 — 배송되는
    // 어떤 창에도, 앞으로 생길 어떤 창에도 이 단정이 먼저 선다.
    let checked = 0;
    for (const fontScale of SCALES) {
      for (let height = 240; height <= 1400; height += 0.5) {
        const budget = composerColumnBudget(fontScale, height);
        if (dockOf(fontScale, height) - budget.column <= 1e-9) continue;
        expect(mentionSheetMaxHeight(fontScale, height)).toBe(
          2 * mentionRowHeight(fontScale),
        );
        checked += 1;
      }
    }
    // 쓸이가 실제로 거짓인 자리를 지났다는 것 — 0 이면 이 테스트는 아무것도 안 봤다.
    expect(checked).toBeGreaterThan(0);
  });

  it('그 네 자리에서도 옛 값보다 낫다 — 방향이 개선이라는 것', () => {
    for (const [height, fontScale, excess, oldExcess] of FLOOR_WINS) {
      const budget = composerColumnBudget(fontScale, height);
      expect(dockOf(fontScale, height) - budget.column).toBeCloseTo(excess, 1);
      expect(180 + budget.composer + BAR_CHROME - budget.column).toBeCloseTo(
        oldExcess,
        1,
      );
      expect(oldExcess).toBeGreaterThan(excess);
    }
  });

  it('옛 값이었다면 그 자리에서 거짓이다 — 회귀 표식', () => {
    // 티켓이 인용한 산수: 도크 366.4 vs 열 340.9 — #4179 로 바 여백이 16 → 18 이라 도크 368.4.
    const budget = composerColumnBudget(AX_XXL, H);
    expect(180 + budget.composer + BAR_CHROME).toBeGreaterThan(budget.column);
    expect(180 + budget.composer + BAR_CHROME).toBeCloseTo(409.6, 1);
    expect(budget.column).toBeCloseTo(340.9, 1);
  });

  it('언제나 정수 행이다 — 반쪽 행은 이름의 이마만 보여 준다', () => {
    // 옛 값 180 을 기각한 이유가 이것이고(4행 + 이마 4pt), 상한을 도출로 바꾸면서
    // 같은 결함을 다른 크기에 다시 심으면 안 된다. 내림이 없던 첫 판은
    // a11y-large 에서 3.5행을 내고 사진에 넷째 이름의 윗동을 남겼다.
    //
    // 이것도 기제라 목록을 안 쓴다(회전 2 M2): 반쪽 행이 생길 수 있는 창은 표가
    // 못 닫는 연속값 쪽이므로, 격자가 아니라 연속 쓸이가 재야 말이 된다.
    for (const fontScale of SCALES) {
      for (let height = 240; height <= 1400; height += 0.5) {
        const row = mentionRowHeight(fontScale);
        const rows = mentionSheetMaxHeight(fontScale, height) / row;
        expect(Math.abs(rows - Math.round(rows))).toBeLessThan(1e-9);
      }
    }
  });

  it('바닥은 두 행 — 한 행 시트는 고를 것이 있다는 것만 알려 준다', () => {
    // #1443 의 `MIN_ROWS` 와 같은 논리이고, 같은 자리에서 불변식을 이긴다:
    // 가장 작은 창 · 가장 큰 글자에서는 바닥이 열을 넘는다. 조건이 부딪히면
    // 「고를 수 있는 화면」이 이긴다.
    for (const fontScale of SCALES) {
      for (const height of HEIGHTS) {
        expect(mentionSheetMaxHeight(fontScale, height)).toBeGreaterThanOrEqual(
          2 * mentionRowHeight(fontScale),
        );
      }
    }
  });

  it('예산이 시트를 자기 안에 든다 — 사진과 테스트가 같은 답을 읽는다', () => {
    const budget = composerColumnBudget(AX_XXL, H);
    expect(budget.mentions).toBe(mentionSheetMaxHeight(AX_XXL, H));
    expect(budget.dockChrome).toBe(BAR_CHROME);
    // #1443 이 세운 등식은 그대로다 — 이 필드들은 더한 것이지 고친 것이 아니다.
    expect(budget.column).toBeCloseTo(budget.list + budget.composer, 5);
  });

  it('시트가 그 식을 실제로 든다 — 스타일시트에 못 박히지 않는다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer({directory: makeDirectory([AGENT])});
    expect(sheetStyle().maxHeight).toBeCloseTo(
      mentionSheetMaxHeight(AX_XXL, H),
      5,
    );
  });

  it('기본 크기에서도 같은 식이 든다 — 오늘 화면은 4행 그대로다', () => {
    setWindow({fontScale: 1, height: H});
    composer({directory: makeDirectory([AGENT])});
    expect(sheetStyle().maxHeight).toBe(3 * TOUCH_TARGET);
  });

  it('행의 **세** 조각이 선언된 같은 줄 상자를 든다 — 한 줄로 읽힌다', () => {
    // 선언하지 않으면 RN 이 광학 중심으로 +2.67pt 어긋나게 놓는다(`tokens.ts` 의
    // `line.head` 독스트링이 그 실측을 든다). 그리고 선언된 값이 없으면 위
    // `mentionRowHeight` 의 산수는 화면이 안 쓰는 수를 쓰는 것이 된다.
    //
    // 셋째 조각(「에이전트」)이 이 단정에서 빠져 있었다(회전 1 L3). 배치가 실제로
    // 고친 것은 셋인데 재는 것이 둘이면, 셋째가 조용히 스케일 밖으로 나가는 날을
    // 아무도 못 잡는다.
    setWindow({fontScale: 1, height: H});
    composer({directory: makeDirectory([AGENT])});
    fireEvent.changeText(screen.getByTestId('composer-input'), '@');
    const name = screen.getByText(AGENT.displayName);
    const handle = screen.getByText(`@${AGENT.handle}`);
    const kind = screen.getByText('에이전트');
    expect(StyleSheet.flatten(name.props.style).lineHeight).toBe(15);
    expect(StyleSheet.flatten(handle.props.style).lineHeight).toBe(15);
    expect(StyleSheet.flatten(kind.props.style).lineHeight).toBe(15);
  });

  it('행이 넘치는 대신 **잘린다**, 그리고 잘린 조각은 **앞을 남긴다**', () => {
    // 회전 1 H2 + 회전 2 H. Yoga 의 `flexShrink` 기본값은 0 이라(같은 트리의
    // `AgentDetailScreen` 이 그 사실을 자기 주석에 든다) 옛 판에서 양보할 수 있는
    // 것은 `mentionHandle` 하나뿐이었고, 그래서 긴 한글 이름 + 행 끝의
    // 「에이전트」 조합에서 행은 잘리는 대신 넘쳤다(캡처
    // `dock1480-mention-sheet-axxl-before-dark.png` 의 첫 줄).
    //
    // 회전 1 은 그 넘침을 잡았지만 핸들에 `flex: 1` 을 남겼고, `flex: 1` 은
    // `flexBasis: 0` 이라 핸들은 **압력이 오기 전부터 자기 폭이 없는 조각**이다 —
    // 줄어드는 것이 아니라 처음부터 0 이다. 그 판의 캡처가 그대로 든다: 2.143 의
    // 첫 행에서 핸들이 맨 「@」 한 글자로 남고(생략부호도 없다) 3.143 에서는 아예
    // 사라진다. 사라지는 것이 **삽입되는 값**이고(`mentionQuery.ts`) 표시 이름은
    // 유일하지 않으므로(코어의 `isAmbiguousName`) 이것은 미관이 아니다.
    //
    // 그래서 양보 순서를 형제 셋과 같은 문법으로 다시 세운다 — `AgentsScreen`·
    // `SidebarScreen`·`HostedConnectionsScreen` 이 전부 `rowTitle`/`rowHandle`
    // **둘 다** `flexShrink: 1` 로 두고 그 둘을 `flex: 1` 짜리 묶음에 넣는다.
    // 셋째 조각(고정폭 표지)은 형제에 없어 관례가 없고, 그 자리의 판정은 유지다:
    // 잘린 **상수** 표지는 뜻이 아니라 버그로 읽히고, 그 대가로 사는 것이 이름 두
    // 글자뿐이라 거래가 남는 게 없다.
    setWindow({fontScale: 1, height: H});
    composer({directory: makeDirectory([AGENT])});
    fireEvent.changeText(screen.getByTestId('composer-input'), '@');
    const identity = screen.getAllByTestId('mention-identity')[0];
    const name = screen.getByText(AGENT.displayName);
    const handle = screen.getByText(`@${AGENT.handle}`);
    const kind = screen.getByText('에이전트');
    // 묶음이 자라고 표지는 자기 폭을 그대로 받는다.
    // (AIH-9b: 묶음은 왼쪽 칸의 첫 줄이 됐다 — 폭을 받는 것은 그 칸이다.)
    expect(
      StyleSheet.flatten(screen.getAllByTestId('mention-column')[0].props.style).flex,
    ).toBe(1);
    expect(StyleSheet.flatten(identity.props.style).flex).toBeUndefined();
    expect(StyleSheet.flatten(kind.props.style).flexShrink).toBe(0);
    // 묶음 **안의 둘은 함께** 낸다 — 둘 중 어느 것도 basis 0 이 아니다.
    for (const piece of [name, handle]) {
      const style = StyleSheet.flatten(piece.props.style);
      expect(style.flexShrink).toBe(1);
      expect(style.flex).toBeUndefined();
      expect(style.flexBasis).toBeUndefined();
    }
    // 셋 다 한 줄이다 — 접힌 행은 위 정수 행 산술이 세는 높이를 넘는다. 표지의
    // 못은 위 판정이 뒤집히는 날을 위해 미리 박아 둔 것이다.
    expect(name.props.numberOfLines).toBe(1);
    expect(handle.props.numberOfLines).toBe(1);
    expect(kind.props.numberOfLines).toBe(1);
  });

  it('스크린리더가 **표지까지** 읽는다 — 사람 행과 에이전트 행이 갈린다', () => {
    // 회전 2 M3. 행의 `Pressable` 은 `accessible` 기본값이 참이라 그 라벨이 자식
    // 셋을 덮는다. 옛 라벨은 이름과 핸들만 들었고, 그래서 눈에는 파란색 + 표지로
    // 갈라져 있는 두 종류가 VoiceOver 에서는 **똑같이** 읽혔다 — 에이전트를 1급
    // 멤버로 세우는 제품에서 「이 후보가 무엇인가」는 부수 정보가 아니다.
    const human = {
      ...AGENT,
      id: 'm-seongjae',
      kind: 'human',
      displayName: '곽성재',
      handle: 'seongjae',
    } as unknown as RosterMember;
    setWindow({fontScale: 1, height: H});
    composer({directory: makeDirectory([AGENT, human])});
    fireEvent.changeText(screen.getByTestId('composer-input'), '@');
    const labels = screen
      .getAllByTestId('mention-option')
      .map(node => node.props.accessibilityLabel);
    expect(labels).toEqual([
      `${AGENT.displayName} @${AGENT.handle} 에이전트`,
      `${human.displayName} @${human.handle}`,
    ]);
    // 눈에 보이는 표지와 **같은 문자열**이다(사본이 갈라지면 이 줄이 빨갛다).
    expect(labels[0].endsWith(screen.getByText('에이전트').props.children)).toBe(
      true,
    );
  });

  it('시트가 스크롤 막대를 든다 — 상한이 2행까지 내려갈 수 있다', () => {
    // 회전 1 L6. 옛 판은 막대를 껐고, 4행 시트가 `MENTION_LIMIT`(6)을 거의 다
    // 담던 때는 그것이 안 보였다. 이 배치가 조건을 바꾼다 — 작은 창·큰 글자에서
    // 상한은 바닥인 2행이고, 그러면 넷이 아래에 숨는다. 같은 모양의 형제
    // (`MessageActionSheet`)가 이미 막대를 켜 둔다.
    expect(mentionSheetMaxHeight(3.571, 667)).toBe(2 * mentionRowHeight(3.571));
    setWindow({fontScale: 1, height: H});
    composer({directory: makeDirectory([AGENT])});
    fireEvent.changeText(screen.getByTestId('composer-input'), '@');
    const list = screen.getByTestId('mention-list');
    const scroll = list.findByProps({keyboardShouldPersistTaps: 'always'});
    expect(scroll.props.showsVerticalScrollIndicator).not.toBe(false);
  });
});

// -----------------------------------------------------------------------------
// #1479 — 빈 상자에 못 서는 문장은 절 경계에서 접힌다.
//
// #1422 가 「폰은 이 규칙을 안 부른다」를 실측으로 정했을 때 그 근거는 전제
// 하나였다: RN 의 multiline 입력창은 콘텐츠 높이로 자라므로 **잃는 것이 없다.**
// #1443 이 세운 성장 상한(대화 열의 몫)은 그 전제를 큰 글자에서 무너뜨린다 —
// 상자는 더 못 자라는데 문장은 4~5줄이고, **빈 상자는 스크롤이 대신해 주지
// 않는다**(스크롤하는 것은 콘텐츠이고 플레이스홀더는 콘텐츠가 아니다). 전제가
// 무너진 자리에서는 웹의 판정이 그대로 선다: 어차피 못 설 절은 절 경계에서
// 통째로 사라져야 하고, 반쪽 절(「보내기, @」)이나 반노출 줄로 남으면 안 된다.
//
// 규칙은 코어의 것이고(`fitComposerPlaceholder`) 자는 이 클라의 것이다: 입력창과
// 같은 토큰·같은 폭·같은 줄바꿈 전략으로 숨은 프로브를 세워 `onTextLayout` 으로
// 재고, 그 세로를 문턱과 대조한다.
//
// **문턱은 #4179 가 바꿨다** — 옛 판은 `composerMaxHeight` 가 든 상자의 글자리(기본 크기에서
// 문장이 언제나 「든다」)였고, 지금은 **알약의 한 줄**(`placeholderRoom`, 성재 결정 2026-10-21
// 「40 + 문장 한 줄」)이다: 한 줄에 안 드는 문장은 기본 크기에서도 뒷절이 절 경계에서 빠지고,
// 재기 전에는 머리 절로 시작한다(높이가 처음부터 한 줄이게).
describe('#1479 절 예산 · #4179 한 줄 문턱 — 한 줄에 못 서는 문장은 절 경계에서 접힌다', () => {
  const AX_XXL = 3.143;
  const H = 874;
  /**
   * 입력창 패딩(8·8)과 테두리(1·1). 상한에서 이만큼을 빼면 글이 서는 자리다.
   * 위 #1443 블록과 같은 이유로 배송되는 상수에 묶인다 (회전 1 M4).
   */
  const CHROME = 8 * 2 + 1 * 2;
  it('크롬 사본이 배송되는 값과 같다', () => {
    expect(CHROME).toBe(INPUT_CHROME);
  });

  /** iOS 동적 타입 배수 사다리 전부(`RCTAccessibilityManager` 기본표) — 몇 개만 고르면 고른 사람이 안 고른 칸에 대해 말하지 않은 것이다. */
  const LADDER = [
    0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143,
    3.571,
  ];

  const input = () => screen.getByTestId('composer-input');

  /** 입력창이 자기 폭을 알린다 — 프로브는 그 다음에야 선다. */
  const layoutInput = (width = 358) =>
    fireEvent(input(), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width, height: 44}},
    });

  /**
   * 프로브를 찾는다. `includeHiddenElements` 가 **필요한 것 자체가 단정**이다 —
   * 이 자는 투명하고 `accessibilityElementsHidden` 이라 접근성 트리 밖에 서고,
   * 그래서 기본 질의로는 안 잡힌다. 아래 「소리를 안 낸다」 케이스가 그 짝이다.
   */
  const probes = () =>
    screen.queryAllByTestId('composer-placeholder-probe', {
      includeHiddenElements: true,
    });

  /** 프로브가 잰 줄들. 실기기의 `onTextLayout` 이 돌려주는 모양 그대로다. */
  const measureProbe = (lineHeights: number[]) =>
    fireEvent(probes()[0], 'textLayout', {
      nativeEvent: {lines: lineHeights.map(height => ({height}))},
    });

  const FULL = () => withLatinWordBreaks(composerPlaceholder('배포', 'place'));
  const HEAD = () =>
    withLatinWordBreaks(composerPlaceholderClauses('배포', 'place')[0].text);

  it('재기 전에는 머리 절이다 (#4179) — 알약 높이가 처음부터 한 줄이고 재고 나서 붙는다', () => {
    // 옛 판은 문장 전체로 시작했다(「일단 짧게」는 드는 상자에서 광고를 한 프레임 지운다).
    // 한 줄 예산에서는 안 드는 문장이 흔한 쪽이라 그 한 프레임이 알약이 두 줄로 섰다가
    // 줄어드는 **높이 점프**가 된다 — 머리 절로 시작하면 어느 쪽 답이 와도 높이가 안 움직인다.
    for (const fontScale of [1, AX_XXL]) {
      setWindow({fontScale, height: H});
      const view = composer();
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
      // 입력창이 폭을 알려도(프로브가 서도) 프로브가 답하기 전까지는 머리 절이다.
      layoutInput();
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
      // 한 줄로 든다는 답이 오면 그제야 뒷절이 붙는다 — 글자만, 높이는 그대로.
      measureProbe([line.body * fontScale]);
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
      view.unmount();
    }
  });

  it('큰 글자에서 문장이 한 줄을 넘으면 뒷절이 통째로 사라진다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer();
    layoutInput();
    const row = line.body * AX_XXL; // 화면의 줄 상자 — 72.3pt
    // 문장 4줄 = 289.2pt. 문턱은 한 줄 반(108.4pt) — 못 선다.
    measureProbe([row, row, row, row]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe('배포에 메시지 보내기');
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).not.toContain(MENTION_AFFORDANCE);
    // 절 경계에서 끝났다 — 반쪽 절이 아니다.
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children.endsWith(',')).toBe(false);
  });

  it('칸이 다시 넓어져 한 줄에 들면 광고가 돌아온다 — 접힘은 상태가 아니라 답이다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer();
    layoutInput();
    const row = line.body * AX_XXL;
    measureProbe([row, row, row, row]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).not.toContain(MENTION_AFFORDANCE);
    // 같은 표면을 두 줄로 다시 재도(옛 판은 여기서 돌아왔다 — 상자 글자리 152.4pt 에 두 줄은
    // 들었다) 한 줄 예산에서는 여전히 안 든다.
    measureProbe([row, row]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
    // 회전·iPad 로 한 줄에 서면 그제야 돌아온다.
    measureProbe([row]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
  });

  it('기본 글자 크기에서도 한 줄 예산이다 (#4179) — 두 줄이면 뒷절이 빠지고 한 줄이면 문장 전체다', () => {
    // 옛 판은 여기서 두 줄(`[22, 22]`)도 「든다」였다 — 상자 글자리 110pt 에 44pt 는 넉넉했다. 그것이
    // 402pt 에서 빈 알약을 72.7pt 로 키웠고(Buzz 53.3pt), 성재 결정이 문턱을 한 줄로 내렸다.
    setWindow({fontScale: 1, height: H});
    composer();
    layoutInput();
    measureProbe([line.body, line.body]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).not.toContain(MENTION_AFFORDANCE);
    measureProbe([line.body]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toContain(MENTION_AFFORDANCE);
  });

  it('경계값: 한 줄은 반올림 잡음이 있어도 접지 않고, 두 줄은 접는다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer();
    layoutInput();
    const row = line.body * AX_XXL;
    // 네이티브가 줄 상자를 픽셀 격자에 반올림해 한 줄이 0.4pt 더 커도 한 줄이다 — 이 오답은
    // **들어가는 문장의 뒷절을 지운다.**
    measureProbe([row + 0.4]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
    // 합이 정확히 문턱인 판 — 부동소수 잡음으로 접으면 안 된다.
    measureProbe([placeholderRoom(AX_XXL)]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
    // 문턱을 조금만 넘어도 접힌다. 두 줄은 문턱(한 줄 반)을 한 줄의 절반이나 넘는다.
    measureProbe([placeholderRoom(AX_XXL) + 0.01]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
    measureProbe([row, row]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
  });

  it('문턱은 한 줄과 두 줄 사이다 — 배수 사다리 전부에서 (#4179)', () => {
    expect(PLACEHOLDER_MAX_LINES).toBe(1);
    for (const fontScale of LADDER) {
      const row = line.body * fontScale;
      expect(placeholderRoom(fontScale)).toBeGreaterThan(row);
      expect(placeholderRoom(fontScale)).toBeLessThan(2 * row);
    }
  });

  it.each(LADDER)(
    '배수 %s: 한 줄이면 문장 전체, 두 줄 이상이면 머리 절만 — 반쪽 절은 없다 (#4179)',
    fontScale => {
      setWindow({fontScale, height: H});
      composer();
      layoutInput();
      const row = line.body * fontScale;
      // 어느 답이 와도 보이는 글은 **절 경계가 만든 둘 중 하나**다 — 머리 절 아니면 문장 전체.
      const allowed = [HEAD(), FULL()];
      for (const lines of [[row], [row, row], [row, row, row], [row, row, row, row]]) {
        measureProbe(lines);
        expect(allowed).toContain(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children);
        expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(lines.length === 1 ? FULL() : HEAD());
      }
      // 머리 절이 한 줄을 넘는 크기(접근성 쪽)에서도 머리 절은 안 버린다 — 버릴 절이 없다.
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children.startsWith(HEAD())).toBe(true);
    },
  );

  it('낭독 라벨은 줄 예산과 무관하다 — 뒷절이 빠져도 필드 이름 전체가 그대로다 (#4179)', () => {
    for (const fontScale of [1, AX_XXL]) {
      setWindow({fontScale, height: H});
      const view = composer();
      layoutInput();
      const label = composerFieldLabel('배포', 'place');
      expect(input().props.accessibilityLabel).toBe(label);
      measureProbe([line.body * fontScale]);
      expect(input().props.accessibilityLabel).toBe(label);
      measureProbe([line.body * fontScale, line.body * fontScale]);
      // 보이는 글은 머리 절로 줄었어도 라벨은 안 줄었다 — 같은 문자열이 아니다.
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
      expect(input().props.accessibilityLabel).toBe(label);
      expect(input().props.accessibilityLabel).not.toBe(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children);
      view.unmount();
    }
  });

  it('빠진 절은 낭독 힌트로 이어진다 — 눈에서 빠진 뒷절이 귀에서도 빠지지 않는다 (#4179)', () => {
    // RN iOS 의 멀티라인 입력창은 빈 칸일 때 「JS 라벨 + 보이는 플레이스홀더」를 읽는다
    // (`RCTUITextView.mm` 의 `accessibilityLabel`). 그래서 보이는 글이 줄면 귀도 줄고, 힌트가 그 몫을 받는다.
    const clauses = composerPlaceholderClauses('배포', 'place');
    const heard = () =>
      [screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children, input().props.accessibilityHint]
        .filter(Boolean)
        .join(' ')
        .replace(/\u200b/g, '');
    for (const fontScale of LADDER) {
      setWindow({fontScale, height: H});
      const view = composer();
      layoutInput();
      const row = line.body * fontScale;
      // 재기 전(머리 절만 보임)에도 귀는 문장 전체를 듣는다.
      expect(input().props.accessibilityHint).toBe(MENTION_AFFORDANCE);
      for (const clause of clauses) expect(heard()).toContain(clause.text);
      // 두 줄 → 뒷절이 빠지고 힌트가 정확히 그 절이다.
      measureProbe([row, row]);
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(HEAD());
      expect(input().props.accessibilityHint).toBe(MENTION_AFFORDANCE);
      for (const clause of clauses) expect(heard()).toContain(clause.text);
      // 한 줄 → 장식 Text는 낭독하지 않으므로 멘션 힌트는 계속 남는다(#4790).
      measureProbe([row]);
      expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe(FULL());
      expect(input().props.accessibilityHint).toBe(MENTION_AFFORDANCE);
      for (const clause of clauses) expect(heard()).toContain(clause.text);
      view.unmount();
    }
  });

  it('글이 있으면 힌트도 없다 — 플레이스홀더가 안 보이는데 힌트만 남지 않는다 (#4179)', () => {
    setWindow({fontScale: 1, height: H});
    composer({draftKey: CH});
    layoutInput();
    measureProbe([line.body, line.body]);
    expect(input().props.accessibilityHint).toBe(MENTION_AFFORDANCE);
    fireEvent.changeText(input(), '안녕하세요');
    expect(input().props.accessibilityHint).toBeUndefined();
    // 지우면 플레이스홀더와 함께 돌아온다.
    fireEvent.changeText(input(), '');
    expect(input().props.accessibilityHint).toBe(MENTION_AFFORDANCE);
  });

  it('프로브가 서는 폭은 알약의 글 칸이다 — 하네스의 자와 같은 수 (#4179)', () => {
    // 입력창은 알약에서 양쪽 (원 + 원↔가장자리)를 뺀 칸이고, 프로브는 그 칸에서 입력창 자신의
    // 안쪽 여백·테두리를 뺀 글 칸에 선다. 계측 하네스(`PlaceholderProbe`)가 이 수를 읽는다 —
    // 옛 하네스는 알약 이전 바(좌우 16·「보내기」 글자 버튼)를 복제해서 다른 칸을 쟀다.
    for (const [width, fontScale] of [
      [402, 1],
      [393, 1],
      [375, 1],
      [440, 1],
      [393, AX_XXL],
    ] as const) {
      setWindow({width, fontScale, height: H});
      const view = composer();
      const inputWidth =
        width - 2 * composerFloat(width, fontScale) - 2 * (9 + 36);
      layoutInput(inputWidth);
      const probeStyle = StyleSheet.flatten(probes()[0].props.style) as {
        width?: number;
      };
      expect([width, fontScale, probeStyle.width]).toEqual([
        width,
        fontScale,
        composerTextColumn(width, fontScale),
      ]);
      view.unmount();
    }
  });

  it('문장을 넘겨받은 자리(스레드)는 절 계약 밖이다 — 프로브도 안 선다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer({placeholder: '답글 쓰기'});
    layoutInput();
    expect(probes()).toHaveLength(0);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toBe('답글 쓰기');
    // 빠진 절이 없으니 힌트도 없다(#4179).
    expect(input().props.accessibilityHint).toBeUndefined();
  });

  it('자는 소리를 안 낸다 — 접근성 트리에 같은 문장이 두 번 서지 않는다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer();
    layoutInput();
    // 숨은 것까지 세면 하나 있고, VoiceOver 가 훑는 트리에서는 없다. 이 둘이
    // 함께여야 「재기는 하는데 안 읽힌다」가 단정된다.
    expect(probes()).toHaveLength(1);
    expect(
      screen.queryAllByTestId('composer-placeholder-probe'),
    ).toHaveLength(0);
  });

  it('자는 placeholder 만 잰다 — 사람이 친 글과 필드 이름은 건드리지 않는다', () => {
    setWindow({fontScale: AX_XXL, height: H});
    composer({draftKey: CH});
    layoutInput();
    const row = line.body * AX_XXL;
    measureProbe([row, row, row, row]);
    // 접힌 상태에서 쳐도 값은 친 그대로다 — 이 파일의 첫 번째 규칙.
    fireEvent.changeText(input(), '안녕하세요');
    expect(input().props.value).toBe('안녕하세요');
    // 필드 이름은 별도 문장이고 joiner 도 없다(VoiceOver 전문).
    expect(input().props.accessibilityLabel).toBe('배포에 보낼 메시지');
    expect(input().props.accessibilityLabel).not.toContain('\u2060');
  });

  it('joiner 가 이 화면까지 온다 — 광고 절은 「@로」가 한 낱말이다 (#1479 ①)', () => {
    setWindow({fontScale: 1, height: H});
    composer();
    layoutInput();
    // 한 줄에 든다는 답이 와야 광고 절이 붙는다(#4179: 재기 전에는 머리 절이다).
    measureProbe([line.body]);
    expect(screen.getByTestId('composer-placeholder', {includeHiddenElements: true}).props.children).toContain('@\u2060로 부르기');
    // withLatinWordBreaks 는 라틴/숫자 사이만 만지므로 joiner 를 안 건드린다.
    expect(withLatinWordBreaks('@\u2060로 부르기')).toBe('@\u2060로 부르기');
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
    // 문장이 아니라 **절**을 받는다 (#1479). 이 클라가 절 예산을 부르면서 소비
    // 지점이 `composerPlaceholder` 에서 `composerPlaceholderClauses` 로 내려갔고,
    // 그것이 여전히 코어의 이름인 것이 이 단정이 지키는 전부다.
    expect(code).toContain('composerPlaceholderClauses(channelLabel, recipient)');
    expect(code).toContain('composerFieldLabel(channelLabel, recipient)');
    // 이음쇠도 코어의 것이다 — 절을 이어 붙이는 것은 `fitComposerPlaceholder`
    // 이고, 이 파일이 이음쇠를 적으면 그것이 두 번째 정본이다.
    expect(code).toContain('fitComposerPlaceholder(');
    expect(code).not.toContain('COMPOSER_PLACEHOLDER_JOINER');
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
    expect(screen).toContain('recipient={recipientKind}');
    expect(screen).toContain('labelRecipientKind(channelLabelParts(');
  });
});

