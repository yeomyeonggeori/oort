import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  avatarIdentity,
  AVATAR_SHAPE,
  AVATAR_SIZE,
} from '@momo/core/features/workspace/avatar';
import {cleanup, render, within} from '@testing-library/react-native';
import React from 'react';

import {color} from '../src/design/tokens';
import {Avatar, avatarImageSource} from '../src/features/conversation/Avatar';
import {MessageRow, PendingRow} from '../src/features/conversation/MessageRow';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetServerBaseCache} from '../src/storage/serverBase';

// =============================================================================
// U4-d / H-11 — 폰에 아바타가 생겼다, 그리고 **모르는 것을 아는 척하지 않는다**
//
// 감사가 이 클라이언트에 대해 센 것: *"폰에는 아바타가 정말 없다 —
// `features/conversation/` 에 `Image`/`require(` 0건."* 이 파일이 그것을 닫는다.
//
// 지키는 것은 셋이다. **판정을 다시 짓지 않는다**(코어가 답한 것을 그대로
// 그린다) · **모를 때는 이니셜을 그리지 않는다**(H-11 3번: uuid 첫 글자가 사람
// 이름의 첫 글자처럼 그려지던 결함) · **왼쪽 칸이 모든 행에서 같다**(아바타가
// 묶음 전체를 가리키는 표지가 되려면 그 아래 행들도 같은 x 에서 시작해야 한다).
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GHOST = '0199dddd-1111-4111-8111-999999999999';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({
    id: AGENT,
    kind: 'agent',
    displayName: '김인턴',
    handle: 'intern-kim',
  }),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: '금요일 배포는 오전 10시에 시작합니다.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

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

function chooseServer(base: string | null): void {
  if (base === null) store.remove(NON_SECRET_KEYS.serverBase);
  else store.set(NON_SECRET_KEYS.serverBase, base);
  __resetServerBaseCache();
}

beforeEach(() => {
  store = memoryStore();
  __setNonSecretStore(store);
  chooseServer(null);
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
  __resetServerBaseCache();
});

const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean).map(flatten))
    : ((style ?? {}) as Record<string, unknown>);

/**
 * 아바타는 접근성 트리에서 **스스로를 감춘다**(웹의 `aria-hidden` 과 같은 이유:
 * 행의 라벨이 이미 작성자 이름을 말한다). 그래서 이 파일의 질의는 숨은 원소를
 * 명시적으로 포함해야 한다 — 이 옵션이 필요하다는 사실 자체가 그 계약의 증거다.
 */
const HIDDEN = {includeHiddenElements: true} as const;

// -----------------------------------------------------------------------------
describe('아바타가 선다 — 그리고 코어가 말한 그대로 선다', () => {
  it('사람은 원, 에이전트는 둥근 사각 — 색 말고 하나 더로 가른다', () => {
    // 색만으로 가르면 색각 이상이 있는 사람에게 구분이 없다. 모양은 코어가
    // 정하고(`AVATAR_SHAPE`) 이 파일은 그 값을 반지름으로 옮긴다.
    const human = render(<Avatar directory={DIRECTORY} memberId={SELF} />);
    const humanStyle = flatten(human.getByTestId('avatar-human', HIDDEN).props.style);
    expect(AVATAR_SHAPE.human).toBe('round');
    expect(humanStyle.borderRadius).toBe(AVATAR_SIZE / 2);
    expect(humanStyle.backgroundColor).toBe(color.surface);
    human.unmount();

    const agent = render(<Avatar directory={DIRECTORY} memberId={AGENT} />);
    const agentStyle = flatten(agent.getByTestId('avatar-agent', HIDDEN).props.style);
    expect(AVATAR_SHAPE.agent).toBe('rounded-square');
    expect(agentStyle.borderRadius).not.toBe(AVATAR_SIZE / 2);
    expect(agentStyle.backgroundColor).toBe(color.agentSurface);
  });

  it('크기가 코어가 정한 32 다 — 24 는 아바타로 읽히지 않았다', () => {
    const style = flatten(
      render(<Avatar directory={DIRECTORY} memberId={SELF} />).getByTestId(
        'avatar-human',
        HIDDEN,
      ).props.style,
    );
    expect(AVATAR_SIZE).toBe(32);
    expect(style.width).toBe(AVATAR_SIZE);
    expect(style.height).toBe(AVATAR_SIZE);
  });

  it('이니셜은 이름의 첫 글자다', () => {
    const view = render(<Avatar directory={DIRECTORY} memberId={SELF} />);
    expect(view.getByTestId('avatar-initial', HIDDEN).props.children).toBe('곽');
  });

  it('모르는 작성자에게는 글자를 그리지 않는다 — uuid 는 이름이 아니다 (H-11 3)', () => {
    // 이 결함이 감사가 실측한 것이다: 명부에 없는 작성자의 「이니셜」이
    // `0199dddd…` 의 `0` 이 되어 사람 이름의 첫 글자처럼 그려졌다.
    const view = render(<Avatar directory={DIRECTORY} memberId={GHOST} />);
    expect(view.getByTestId('avatar-unknown', HIDDEN)).toBeTruthy();
    expect(view.queryByTestId('avatar-initial', HIDDEN)).toBeNull();
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    // 그리고 **정체 색을 쓰지 않는다** — 색까지 주면 화면이 「이 사람은
    // 사람이다」를 확인된 사실처럼 말하게 된다.
    const style = flatten(view.getByTestId('avatar-unknown', HIDDEN).props.style);
    expect(style.backgroundColor).toBeUndefined();
    expect(style.borderColor).toBe(color.border);
  });

  it('보조기술에는 나가지 않는다 — 행의 라벨이 이미 이름을 말한다', () => {
    const node = render(
      <Avatar directory={DIRECTORY} memberId={SELF} />,
    ).getByTestId('avatar-human', HIDDEN);
    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

// -----------------------------------------------------------------------------
describe('avatarUrl 경로가 개통됐다 — 다만 폰이 실을 수 있는 것만', () => {
  const withAvatar = (avatarUrl: string) =>
    makeDirectory([member({id: SELF, displayName: '곽성재', avatarUrl})]);

  it('상대 주소는 이 기기가 고른 서버 앞에 붙는다', () => {
    // 웹에서는 `/media/…` 로 끝이지만 RN 의 `Image` 에는 문서 오리진이 없다.
    // 이 한 조각이 폰 몫이고, `serverBase.ts` 가 같은 사실을 이미 적어 두었다.
    chooseServer('https://momo.example');
    const view = render(
      <Avatar directory={withAvatar('/media/a.png')} memberId={SELF} />,
    );
    expect(view.getByTestId('avatar-image', HIDDEN).props.source).toEqual({
      uri: 'https://momo.example/media/a.png',
    });
  });

  it('서버를 아직 안 골랐으면 상대 주소는 이미지가 아니다', () => {
    // 아무 데도 안 가리키는 주소로 `Image` 를 세우면 회색 상자가 남고, 사람은
    // 「아바타가 없는 사람」과 「주소를 못 만든 앱」을 구별할 수 없다.
    chooseServer(null);
    const view = render(
      <Avatar directory={withAvatar('/media/a.png')} memberId={SELF} />,
    );
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
  });

  it('다른 오리진은 코어가 막고, 이니셜이 선다', () => {
    chooseServer('https://momo.example');
    const view = render(
      <Avatar directory={withAvatar('https://cdn.evil/a.png')} memberId={SELF} />,
    );
    expect(view.queryByTestId('avatar-image', HIDDEN)).toBeNull();
    expect(view.getByTestId('avatar-initial', HIDDEN)).toBeTruthy();
  });

  it('같은 서버의 절대 주소는 그대로 실린다', () => {
    chooseServer('https://momo.example');
    const view = render(
      <Avatar
        directory={withAvatar('https://momo.example/media/a.png')}
        memberId={SELF}
      />,
    );
    expect(view.getByTestId('avatar-image', HIDDEN).props.source).toEqual({
      uri: 'https://momo.example/media/a.png',
    });
  });

  it('`data:` 는 서버와 무관하게 실린다', () => {
    chooseServer(null);
    const uri = 'data:image/png;base64,iVBORw0KGgo=';
    expect(
      avatarImageSource(
        avatarIdentity(member({id: SELF, avatarUrl: uri}), ''),
        '',
      ),
    ).toBe(uri);
  });
});

// -----------------------------------------------------------------------------
describe('왼쪽 칸이 모든 행에서 같다', () => {
  function messageReserve(startsGroup: boolean): number | undefined {
    const view = render(
      <MessageRow
        message={message()}
        startsGroup={startsGroup}
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    const style = flatten(view.getByTestId('message-press').props.style) as {
      paddingLeft?: number;
    };
    view.unmount();
    return style.paddingLeft;
  }

  it('묶음의 머리에만 아바타가 그려진다 — 칸은 둘 다 비운다', () => {
    const head = render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(within(head.getByTestId('message-row')).getByTestId('avatar-human', HIDDEN))
      .toBeTruthy();
    head.unmount();

    const follow = render(
      <MessageRow
        message={message()}
        startsGroup={false}
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(follow.queryByTestId('avatar-human', HIDDEN)).toBeNull();

    // 그런데 **들여쓰기는 같다.** 이 단정이 이 배치의 중심이다: 다르면 한 사람이
    // 연달아 쓴 다섯 줄의 왼쪽 끝이 두 x 에 서고, 아바타는 묶음의 표지가 아니라
    // 첫 줄만의 장식이 된다.
    expect(messageReserve(true)).toBe(messageReserve(false));
    expect(messageReserve(true)).toBe(16 + AVATAR_SIZE + 8);
  });

  it('낙관적 메아리도 같은 칸을 진다 (감사 M-12 의 왼쪽 판)', () => {
    // 이 행의 존재 이유가 「서버 사본이 대체할 때 글이 다시 흐르지 않게」인데,
    // 들여쓰기가 다르면 그 흐름이 정확히 여기서 일어난다.
    const view = render(
      <PendingRow
        pending={{
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '보내는 중인 글',
          status: 'sending',
          sinceSeq: null,
          createdAtMs: BASE_MS,
        }}
        startsGroup
        directory={DIRECTORY}
      />,
    );
    const inner = view.getByTestId('pending-row').children[0] as {
      props: {style?: unknown};
    };
    expect((flatten(inner.props.style) as {paddingLeft?: number}).paddingLeft).toBe(
      messageReserve(true),
    );
    expect(view.getByTestId('avatar-human', HIDDEN)).toBeTruthy();
  });
});
