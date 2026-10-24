import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {Composer} from '../src/features/conversation/Composer';
import {useTimeline} from '../src/features/conversation/useTimeline';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// 「가 ⏎ 나」를 보내면 줄바꿈이 남는다 (#4321, owner 10-24).
//
// 보고: 폰에서 줄을 바꿔 쓴 메시지가 한 줄로 저장된다(운영 저장 본문 25개 중 `\n` 0개).
// 시뮬레이터 실측(iOS 26.5, Debug)은 영문·한글 2벌식·한글 10키 소프트 자판, 하드웨어식 Enter,
// 진짜 앱 + 진짜 서버 저장까지 **전 구간에서 줄바꿈이 보존됨**이었다 — 재현하지 못했다. 그래서
// 이 시험은 원인 수리의 증거가 아니라 **계약을 못 박는 가드**다. 두 칸을 따로 지킨다:
//
//   ① 입력창이 리턴 키를 무엇으로 정하는가 — `submitBehavior="newline"` 이고 `onSubmitEditing` 이 없다.
//      (`'submit'` 이면 리턴이 삼켜져 `\n` 이 사라지고, `onSubmitEditing` 이 있으면 줄마다 따로 전송된다 —
//      둘 다 시뮬레이터에서 일부러 만들어 실측했다. PR 본문의 사보타주 표.)
//   ② 입력 값의 `\n` 이 보낸 본문·요청 JSON 까지 그대로 가는가 — 컴포저의 `submit()`(양 끝만 자른다),
//      타임라인 `send`, 코어 `sendMessage` 의 JSON.
//
// **이 시험이 증명하지 못하는 것**: 리턴 키를 눌렀을 때 UIKit 이 `\n` 을 넣는다는 사실. `fireEvent.changeText`
// 는 네이티브 리턴 경로를 건너뛴다. 그 칸은 `maestro/70-composer-newline.yaml`(진짜 자판의 리턴 키)이 진다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const CH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '박서연',
  handle: 'seoyeon',
};

const EMPTY = makeDirectory([] as RosterMember[]);

interface SendLog {
  /** 요청 본문(JSON 문자열) 그대로. */
  raw: string[];
  /** 파싱한 `body` 필드. */
  bodies: string[];
}

function installFetch(): SendLog {
  const log: SendLog = {raw: [], bodies: []};
  globalThis.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const raw = String(init.body);
      log.raw.push(raw);
      const parsed = JSON.parse(raw) as {body: string};
      log.bodies.push(parsed.body);
      const echo: Message = {
        id: 'server-echo',
        channelId: CH,
        seq: 1,
        hlcTs: 1,
        hlcCount: 0,
        authorMemberId: SELF_ID,
        type: 'text',
        body: parsed.body,
        state: 'sent',
        createdAtMs: 1_700_000_000_000,
      } as Message;
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify(echo),
      } as unknown as Response;
    }
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({messages: []}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return log;
}

beforeEach(() => {
  (
    jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}
  ).__store.clear();
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: SELF,
  });
});

afterEach(cleanup);

function renderComposer(onSend: (body: string) => void) {
  render(
    <Composer
      recipient="place"
      channelLabel="general"
      directory={EMPTY}
      onSend={onSend}
    />,
  );
}

function typeAndSend(text: string) {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
  fireEvent.press(screen.getByTestId('composer-send'));
}

describe('① 리턴 키는 줄바꿈이다 — 입력창이 그렇게 말한다', () => {
  it('submitBehavior 가 "newline" 이다 — 폐기 예정인 blurOnSubmit 의 번역에 기대지 않는다', () => {
    renderComposer(() => {});
    const input = screen.getByTestId('composer-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.submitBehavior).toBe('newline');
    // 옛 철자가 되돌아오면 두 철자가 함께 서서 어느 쪽이 이기는지를 읽어야 한다 — 하나만 둔다.
    expect(input.props.blurOnSubmit).toBeUndefined();
  });

  it('onSubmitEditing 이 없다 — 리턴은 어떤 경우에도 보내기가 아니다', () => {
    renderComposer(() => {});
    expect(screen.getByTestId('composer-input').props.onSubmitEditing).toBeUndefined();
  });

  it('보내기는 단추로만 나간다', () => {
    const sent: string[] = [];
    renderComposer(body => sent.push(body));
    fireEvent.changeText(screen.getByTestId('composer-input'), '가\n나');
    // 리턴 키가 하는 일은 입력창이 이미 값에 `\n` 을 넣은 것뿐이다 — 아무것도 나가지 않았다.
    expect(sent).toEqual([]);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual(['가\n나']);
  });
});

describe('② 입력 값의 줄바꿈이 보낸 본문에 남는다', () => {
  it.each([
    ['한글', '가\n나'],
    ['영문', 'a\nb'],
    ['세 줄', '첫째 줄\n둘째 줄\n셋째 줄'],
    ['빈 줄', '가\n\n나'],
    ['줄 끝 공백', '가 \n나'],
    ['CRLF', '가\r\n나'],
  ])('%s: onSend 가 받는 본문이 입력 값 그대로다', (_label, value) => {
    const sent: string[] = [];
    renderComposer(body => sent.push(body));
    typeAndSend(value);
    expect(sent).toEqual([value]);
  });

  it('양 끝의 공백·줄바꿈만 잘린다', () => {
    const sent: string[] = [];
    renderComposer(body => sent.push(body));
    typeAndSend('\n  가\n\n나 \n');
    expect(sent).toEqual(['가\n\n나']);
  });

  it('줄바꿈만 든 글은 보내지 않는다', () => {
    const sent: string[] = [];
    renderComposer(body => sent.push(body));
    typeAndSend('\n\n');
    expect(sent).toEqual([]);
  });
});

describe('③ 요청 JSON 까지 — 컴포저 → 타임라인 → 코어 sendMessage', () => {
  function Harness({onSettled}: {onSettled: (messages: Message[]) => void}) {
    const timeline = useTimeline(null, WS, CH, SELF_ID);
    onSettled(timeline.state.messages);
    return (
      <Composer
        recipient="place"
        channelLabel="general"
        directory={EMPTY}
        onSend={body => {
          void timeline.send(body);
        }}
      />
    );
  }

  it('「가 ⏎ 나」: 요청의 body 필드가 `가\\n나` 이고 서버 확정 메시지도 같다', async () => {
    const log = installFetch();
    let latest: Message[] = [];
    render(<Harness onSettled={messages => (latest = messages)} />);
    // 바깥 `act` 안에서 치고 누르면 두 이벤트가 한 배치로 묶여 보내기 단추가 아직 꺼진 채로 눌린다 —
    // 한 이벤트마다 `fireEvent` 가 스스로 반영(flush)하게 둔다.
    await act(async () => {});
    typeAndSend('가\n나');

    await waitFor(() => expect(log.bodies).toHaveLength(1));
    expect(log.bodies[0]).toBe('가\n나');
    // 줄바꿈은 JSON 문자열 안의 이스케이프(`\n` 두 글자)로 나간다 — 날 줄바꿈이 아니다.
    expect(log.raw[0]).toContain('"body":"가\\n나"');
    await waitFor(() => expect(latest.map(m => m.body)).toContain('가\n나'));
  });
});
