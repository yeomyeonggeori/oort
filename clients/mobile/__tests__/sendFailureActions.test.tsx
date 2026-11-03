import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {MessageAttachment} from '@momo/core/lib/api';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {Image} from 'react-native';

import {SHELL_ICONS} from '../src/design/icons';
import {CARD_ICONS} from '../src/design/icons/cardIcons';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, lightPalette, TOUCH_TARGET} from '../src/design/tokens';
import {PendingRow} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {flat, member} from './testkit';

// =============================================================================
// 보내지 못한 메시지 곁의 아이콘 둘 (#5210) — 새로고침(다시 보내기) · 빨간 X(지우기).
//
// 웹 `PendingRow.failure.test.tsx` 의 짝이다. jest 는 배치를 하지 않으므로 누르는 면은 **스타일 산수**로 잰다
// (안쪽 여백 × 2 + 글리프 = 44). 렌더된 상자·캡처는 시뮬레이터 레인 몫이다(`runtime-unverified` 로 인계에 적는다).
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const NOW = 1_700_000_000_000;
const DIRECTORY = makeDirectory([member({id: SELF, displayName: '박서연', handle: 'seoyeon'})]);

const FILE: MessageAttachment = {
  id: 'att-1',
  name: '회의록.pdf',
  mime: 'application/pdf',
  sizeBytes: 2048,
};

const failedRow = (over: Record<string, unknown> = {}) =>
  ({
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '내일 오전에 봐요',
    status: 'failed',
    sinceSeq: null,
    createdAtMs: NOW,
    ...over,
  }) as never;

function mount(
  pending: never,
  handlers: {onResend?: (id: string) => void; onDiscard?: (id: string) => void},
  scheme: 'dark' | 'light' = 'dark',
) {
  return render(
    <FixedScheme scheme={scheme}>
      <PendingRow
        pending={pending}
        startsGroup
        directory={DIRECTORY}
        onResend={handlers.onResend}
        onDiscard={handlers.onDiscard}
      />
    </FixedScheme>,
  );
}

afterEach(cleanup);

describe('PendingRow — 보내지 못한 메시지의 아이콘 둘 (#5210)', () => {
  it('짧은 「전송 실패」 곁에 새로고침(다시 보내기)과 X(지우기)가 선다. 이름은 낭독이 읽고 단추 안에 글자는 없다', () => {
    mount(failedRow(), {onResend: jest.fn(), onDiscard: jest.fn()});
    expect(screen.getByText('전송 실패')).toBeTruthy();
    const resend = screen.getByRole('button', {name: '다시 보내기'});
    const discard = screen.getByRole('button', {name: '지우기'});
    expect(resend.props.testID).toBe('pending-resend');
    expect(discard.props.testID).toBe('pending-discard');
    // 글자 단추가 아니다.
    expect(within(resend).queryAllByText(/.+/)).toHaveLength(0);
    expect(within(discard).queryAllByText(/.+/)).toHaveLength(0);
    // 「다시 보내기」는 이름으로만 있다: 화면에 글자로 찍히지 않는다.
    expect(screen.queryByText('다시 보내기')).toBeNull();
    expect(screen.queryByText('지우기')).toBeNull();
  });

  it.each([
    ['dark', darkPalette],
    ['light', lightPalette],
  ] as const)(
    '글리프는 이미 있는 아이콘 묶음의 것이고 위계를 따른다: 파괴인 X 만 위험색이다 (%s)',
    (scheme, palette) => {
      mount(failedRow(), {onResend: jest.fn(), onDiscard: jest.fn()}, scheme);
      const resendGlyph = within(screen.getByTestId('pending-resend')).UNSAFE_getByType(Image);
      const discardGlyph = within(screen.getByTestId('pending-discard')).UNSAFE_getByType(Image);
      // 새로 그린 래스터가 아니라 `CARD_ICONS.refresh`(Lucide refresh-cw) · `SHELL_ICONS.x`(Lucide x)다.
      expect(resendGlyph.props.source).toBe(CARD_ICONS.refresh);
      expect(discardGlyph.props.source).toBe(SHELL_ICONS.x);
      expect(flat(discardGlyph.props.style).tintColor).toBe(palette.danger);
      expect(flat(resendGlyph.props.style).tintColor).toBe(palette.textMuted);
      expect(palette.textMuted).not.toBe(palette.danger);
    },
  );

  it('누르는 면은 정확히 44pt(TOUCH_TARGET)이고 글리프는 16이다: 안쪽 여백 × 2 + 글리프', () => {
    mount(failedRow(), {onResend: jest.fn(), onDiscard: jest.fn()});
    for (const id of ['pending-resend', 'pending-discard']) {
      const button = screen.getByTestId(id);
      const glyph = flat(within(button).UNSAFE_getByType(Image).props.style);
      const padding = flat(button.props.style).padding as number;
      expect(glyph.width).toBe(16);
      expect(glyph.height).toBe(16);
      expect(padding * 2 + (glyph.width as number)).toBe(TOUCH_TARGET);
    }
  });

  it('X 는 지우기만, 새로고침은 다시 보내기만 부른다. 둘 다 이 행의 키를 넘긴다', () => {
    const onResend = jest.fn();
    const onDiscard = jest.fn();
    mount(failedRow({clientMsgId: 'c-42'}), {onResend, onDiscard});
    fireEvent.press(screen.getByTestId('pending-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith('c-42');
    expect(onResend).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('pending-resend'));
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onResend).toHaveBeenCalledWith('c-42');
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('핸들러가 없는 아이콘은 그리지 않는다', () => {
    const resendOnly = mount(failedRow(), {onResend: jest.fn()});
    expect(screen.queryByTestId('pending-discard')).toBeNull();
    expect(screen.getByTestId('pending-resend')).toBeTruthy();
    resendOnly.unmount();
    const discardOnly = mount(failedRow(), {onDiscard: jest.fn()});
    expect(screen.queryByTestId('pending-resend')).toBeNull();
    expect(screen.getByTestId('pending-discard')).toBeTruthy();
    discardOnly.unmount();
    mount(failedRow(), {});
    expect(screen.getByText('전송 실패')).toBeTruthy();
    expect(screen.queryByTestId('pending-resend')).toBeNull();
    expect(screen.queryByTestId('pending-discard')).toBeNull();
  });

  it('보내는 중인 행에는 아이콘이 없다: 이 키의 요청이 날아가는 중이라 지울 수 없다', () => {
    mount(failedRow({status: 'sending'}), {onResend: jest.fn(), onDiscard: jest.fn()});
    expect(screen.queryByText('전송 실패')).toBeNull();
    expect(screen.queryByTestId('pending-resend')).toBeNull();
    expect(screen.queryByTestId('pending-discard')).toBeNull();
  });

  it('첨부가 든 메시지가 실패해도 같은 두 아이콘이 서고 파일 카드가 보인다', () => {
    mount(failedRow({body: '', attachments: [FILE]}), {onResend: jest.fn(), onDiscard: jest.fn()});
    // 파일 이름은 가운데 생략으로 여러 글자 노드로 쪼개 그려진다: 카드의 낭독 이름으로 확인한다.
    expect(screen.getByTestId('attachment-item').props.accessibilityLabel).toContain('회의록.pdf');
    expect(screen.getByText('전송 실패')).toBeTruthy();
    expect(screen.getByRole('button', {name: '다시 보내기'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '지우기'})).toBeTruthy();
  });
});

describe('Timeline — 지우기 핸들러가 행까지 닿는다 (#5210)', () => {
  it('보내지 못한 메아리의 X 를 누르면 onDiscardPending 이 이 행의 키로 불린다', () => {
    const onDiscardPending = jest.fn();
    const onResendPending = jest.fn();
    render(
      <FixedScheme scheme="dark">
        <Timeline
          messages={[]}
          directory={DIRECTORY}
          status="ready"
          pending={[failedRow({clientMsgId: 'c-7'})]}
          myMemberId={SELF}
          nowMs={NOW}
          onResendPending={onResendPending}
          onDiscardPending={onDiscardPending}
        />
      </FixedScheme>,
    );
    fireEvent.press(screen.getByTestId('pending-discard'));
    expect(onDiscardPending).toHaveBeenCalledWith('c-7');
    expect(onResendPending).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('pending-resend'));
    expect(onResendPending).toHaveBeenCalledWith('c-7');
  });
});
