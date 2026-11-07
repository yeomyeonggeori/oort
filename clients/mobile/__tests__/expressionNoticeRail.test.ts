import type {Centrifuge} from 'centrifuge';
import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import type {ExpressionChangedDetail} from '@momo/core/features/expressions/types';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {createChannelRail} from '../src/realtime/channelRail';

// =============================================================================
// #5491 (ADR-0218 증보 9, §15) — 폰의 표현 레일이 두 알림을 어떻게 가르는가.
//
// 한 변경에 알림이 둘 간다: 상세(`expression.changed.detail`)가 먼저, 옛 `expression.changed` 가 뒤따른다. 레일은 상세를 `onDetail` 로, 옛 알림을 `onChanged`
// 로 넘긴다. 옛 폰(v0.1.44)은 `type === 'expression.changed'` 만 보므로 상세는 그 읽기에서 알림이 아니다 — 아래 마지막 시험이 그 근거를 값으로 재고,
// 상세 처리기가 없는 새 폰 처리기도 상세를 무시한다.
// =============================================================================

const WS = FIXTURE_WORKSPACE_ID;
const OTHER_WS = '00000000-0000-4000-8000-0000000000aa';
const channel = `expressions:ws${WS.toUpperCase()}`;
const centrifugeMock = jest.requireMock('centrifuge') as {
  __reset: () => void;
  Centrifuge: new (url: string, options: unknown) => Centrifuge;
};
interface FakeSub {
  options: unknown;
  __emit: (event: string, ctx: unknown) => void;
}
const detail = (over: Partial<ExpressionChangedDetail> = {}): ExpressionChangedDetail => ({
  type: 'expression.changed.detail',
  workspaceId: WS,
  version: '4',
  action: 'hidden',
  expressionIds: [FIXTURE_EXPRESSIONS[0].id],
  ...over,
});
const plain = {type: 'expression.changed', workspaceId: WS, version: '4'};

function open() {
  centrifugeMock.__reset();
  const client = new centrifugeMock.Centrifuge('wss://example.test/connection/websocket', {}) as unknown as Centrifuge & {
    subs: Map<string, FakeSub>;
  };
  const rail = createChannelRail(() => client);
  const handlers = {onChanged: jest.fn(), onDetail: jest.fn(), onResync: jest.fn()};
  const stop = rail.subscribeExpressions!(WS, handlers);
  const sub = client.subs.get(channel)!;
  const publish = (data: unknown) => sub.__emit('publication', {data});
  return {sub, publish, handlers, stop};
}

describe('폰 표현 레일: 상세 알림', () => {
  it('상세는 onDetail 로만, 옛 알림은 onChanged 로만 간다 (옛 알림에는 version 이 실린다)', () => {
    const {publish, handlers} = open();
    publish(detail());
    expect(handlers.onDetail).toHaveBeenCalledTimes(1);
    expect(handlers.onDetail).toHaveBeenCalledWith(detail());
    expect(handlers.onChanged).not.toHaveBeenCalled();
    publish(plain);
    expect(handlers.onChanged).toHaveBeenCalledTimes(1);
    expect(handlers.onChanged).toHaveBeenCalledWith('4');
    expect(handlers.onDetail).toHaveBeenCalledTimes(1);
  });

  it('옛 읽기 그대로: version 이 없거나 모양이 어긋난 옛 알림도 알림으로 읽고, version 만 null 로 넘긴다', () => {
    const {publish, handlers} = open();
    publish({type: 'expression.changed', workspaceId: WS});
    publish({type: 'expression.changed', workspaceId: WS.toUpperCase(), version: 4});
    expect(handlers.onChanged.mock.calls).toEqual([[null], [null]]);
  });

  it('다른 워크스페이스의 알림·상세와 계약에 맞지 않는 상세(이름 없는 숨김, 모르는 action)는 어느 처리기도 부르지 않는다', () => {
    const {publish, handlers} = open();
    publish({...plain, workspaceId: OTHER_WS});
    publish(detail({workspaceId: OTHER_WS}));
    publish(detail({action: 'hidden', expressionIds: []}));
    publish(detail({action: 'restored' as never}));
    publish(undefined);
    publish('expression.changed');
    expect(handlers.onChanged).not.toHaveBeenCalled();
    expect(handlers.onDetail).not.toHaveBeenCalled();
  });

  it('상세 처리기가 없는 처리기(옛 호출 모양)는 상세를 무시하고 옛 알림은 그대로 받는다', () => {
    centrifugeMock.__reset();
    const client = new centrifugeMock.Centrifuge('wss://example.test/connection/websocket', {}) as unknown as Centrifuge & {
      subs: Map<string, FakeSub>;
    };
    const rail = createChannelRail(() => client);
    const onChanged = jest.fn();
    rail.subscribeExpressions!(WS, {onChanged, onResync: jest.fn()});
    const sub = client.subs.get(channel)!;
    sub.__emit('publication', {data: detail()});
    expect(onChanged).not.toHaveBeenCalled();
    sub.__emit('publication', {data: plain});
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('재구독(subscribed)은 onResync 를 부르고, 복구도 위치 추적도 요구하지 않는 레일이다', () => {
    const {sub, handlers} = open();
    sub.__emit('subscribed', {});
    expect(handlers.onResync).toHaveBeenCalledTimes(1);
    expect(sub.options).toEqual({recoverable: false, positioned: false});
  });

  it('옛 폰의 읽기(v0.1.44: `frame.type === "expression.changed"`)는 어느 상세도 알림으로 읽지 않는다', () => {
    const oldPhoneReads = (frame: {type?: string} | undefined) => frame?.type === 'expression.changed';
    for (const action of ['created', 'edited', 'hidden', 'deleted'] as const) {
      expect(oldPhoneReads(detail({action}))).toBe(false);
    }
    expect(oldPhoneReads(detail({action: 'policy_changed', expressionIds: []}))).toBe(false);
    expect(oldPhoneReads(plain)).toBe(true); // 옛 알림은 바이트 그대로라 지금처럼 읽힌다
  });
});
