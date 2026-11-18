import type {Channel, MembershipRole} from '@momo/core/lib/api';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import {fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ConversationMenuSheet} from '../src/features/conversation/ConversationMenuSheet';
import {conversationMenuActionItems} from '../src/features/conversation/conversationMenu';
import {channelRowActionItems, type ChannelRowTarget} from '../src/features/sidebar/channelRowActions';

// =============================================================================
// 폰의 「이름 바꾸기」 (ADR-0225 D10 · D13, #5835). 판정 표는 코어 `rename.test.ts` 가 재고, 여기서는 (1) 폰의 두 시트가 그 판정을 줄로 내미는가
// (2) 단계의 이름 칸: 친 것과 저장될 이름이 다를 때만 미리보기, 보낼 때 접은 이름, 서버의 거절은 같은 자리, 보내는 중에는 닫는 길이 잠김.
// =============================================================================

const koFormat = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage;

const target = (over: {kind?: Channel['kind']; name?: string; role?: MembershipRole | undefined} = {}): ChannelRowTarget => ({
  channel: {id: 'c1', kind: over.kind ?? 'public', topic: ''},
  title: over.name ?? 'ops-room',
  muted: false,
  selfRole: 'role' in over ? over.role : 'admin',
  readState: null,
});

describe('줄이 서는 자리', () => {
  it.each([
    ['owner', 'public', 'ops-room', true],
    ['admin', 'private', 'ops-room', true],
    ['member', 'public', 'ops-room', false],
    ['guest', 'public', 'ops-room', false],
    [undefined, 'public', 'ops-room', false],
    // general 은 이름이 잠겼다(D10).
    ['owner', 'public', 'general', false],
    ['owner', 'dm', '박서연', false],
  ] as const)('%s · %s · %s -> %s', (role, kind, name, shown) => {
    const t = target({role, kind, name});
    const sidebar = channelRowActionItems(t, undefined, koFormat).map(item => item.key);
    const menu = conversationMenuActionItems(t, koFormat).map(item => item.key);
    expect([sidebar.includes('rename'), menu.includes('rename')]).toEqual([shown, shown]);
    if (shown) {
      expect(channelRowActionItems(t, undefined, koFormat).find(item => item.key === 'rename')?.label).toBe(
        koFormat('channels.rename.action'),
      );
    }
  });
});

function renderStep(over: {pending?: boolean; failure?: {kind: 'generalLocked'; key: 'channels.rename.generalLocked'} | null} = {}) {
  const onConfirmRename = jest.fn();
  const onClearRenameFailure = jest.fn();
  render(
    <ConversationMenuSheet
      title="ops-room"
      kind="public"
      pinLabel="고정한 메시지"
      onOpenPins={jest.fn()}
      items={[]}
      confirmingLeave={false}
      isPending={() => false}
      error={null}
      leave={{pending: false, error: null}}
      onRun={jest.fn()}
      onConfirmLeave={jest.fn()}
      onCancelLeave={jest.fn()}
      rename={{pending: over.pending ?? false, failure: over.failure ?? null}}
      onConfirmRename={onConfirmRename}
      onClearRenameFailure={onClearRenameFailure}
      onClose={jest.fn()}
    />,
  );
  return {onConfirmRename, onClearRenameFailure};
}
const NAME = 'conversation-menu-rename-name';
const SUBMIT = 'conversation-menu-rename-submit';

describe('이름 바꾸기 단계', () => {
  it('지금 이름이 채워져 있고 그대로면 바꾸기가 눌리지 않는다', () => {
    const {onConfirmRename} = renderStep();
    expect(screen.getByTestId(NAME).props.value).toBe('ops-room');
    fireEvent.press(screen.getByTestId(SUBMIT));
    expect(onConfirmRename).not.toHaveBeenCalled();
  });

  it('친 것과 저장될 이름이 다를 때만 미리보기가 서고, 보낼 때는 접은 이름이 나간다(칸은 친 그대로)', () => {
    const {onConfirmRename} = renderStep();
    fireEvent.changeText(screen.getByTestId(NAME), 'Design Review');
    expect(screen.getByTestId(NAME).props.value).toBe('Design Review');
    expect(screen.getByTestId(`${NAME}-preview`).props.children).toBe('#design-review 이름으로 바뀌어요');
    fireEvent.press(screen.getByTestId(SUBMIT));
    expect(onConfirmRename).toHaveBeenCalledWith('design-review');
    fireEvent.changeText(screen.getByTestId(NAME), 'ops-room-2');
    expect(screen.queryByTestId(`${NAME}-preview`)).toBeNull();
    expect(screen.getByTestId(`${NAME}-rule`)).toBeTruthy();
  });

  it('거절되는 이름은 칸 아래 문장이 말하고 바꾸기는 눌리지 않는다', () => {
    const {onConfirmRename} = renderStep();
    fireEvent.changeText(screen.getByTestId(NAME), 'a.b');
    expect(screen.getByTestId(`${NAME}-issue`)).toBeTruthy();
    fireEvent.press(screen.getByTestId(SUBMIT));
    expect(onConfirmRename).not.toHaveBeenCalled();
  });

  it('서버의 거절(general 잠금)은 같은 자리에서 말하고, 이름을 고치면 훅에게 지우라고 알린다', () => {
    const {onClearRenameFailure} = renderStep({failure: {kind: 'generalLocked', key: 'channels.rename.generalLocked'}});
    expect(screen.getByTestId(`${NAME}-issue`).props.children).toBe(koFormat('channels.rename.generalLocked'));
    fireEvent.changeText(screen.getByTestId(NAME), 'ops-room-3');
    expect(onClearRenameFailure).toHaveBeenCalled();
  });

  it('보내는 중에는 닫는 X 가 잠김으로 읽히고 칸은 잠긴다', () => {
    renderStep({pending: true});
    expect(screen.getByTestId('conversation-menu-rename-close').props.accessibilityState).toMatchObject({disabled: true});
    expect(screen.getByTestId(NAME).props.editable).toBe(false);
  });
});
