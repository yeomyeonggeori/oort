import type {Message} from '@momo/core/lib/api';
import {
  displayGlyph,
  type CatalogEmoji,
} from '@momo/core/features/emoji/catalog';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {Keyboard, StyleSheet} from 'react-native';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {EmojiPicker} from '../src/features/emoji/EmojiPicker';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {PageSheet} from '../src/design/PageSheet';
import {TOUCH_TARGET} from '../src/design/tokens';
import {
  releaseReduceMotion,
  setReduceMotion,
  dragHeader,
  FAR_SLOW_DRAG,
} from './fixtures/sheetContract';

jest.mock('../src/features/emoji/catalog', () => ({
  loadPhoneEmojiCatalog: jest.fn(),
}));
jest.mock('../src/lib/haptics', () => ({haptics: {event: jest.fn()}}));
import {haptics} from '../src/lib/haptics';

const load = loadPhoneEmojiCatalog as jest.MockedFunction<
  typeof loadPhoneEmojiCatalog
>;
const waving: CatalogEmoji = {
  glyph: '👋',
  name: 'waving hand',
  koreanName: '손 흔들기',
  shortcodes: ['wave'],
  keywords: ['hello'],
  category: 'people',
  skins: ['👋🏻', '👋🏼', '👋🏽', '👋🏾', '👋🏿'],
  version: 1,
};
const party: CatalogEmoji = {
  glyph: '🎉',
  name: 'party popper',
  koreanName: '축하',
  shortcodes: ['tada'],
  keywords: [],
  category: 'activity',
  version: 1,
};

function picker(props: Partial<React.ComponentProps<typeof EmojiPicker>> = {}) {
  const select = jest.fn();
  const close = jest.fn();
  render(
    <PageSheet onClose={close} accessibilityLabel="이모지 고르기">
      <EmojiPicker onSelect={select} onClose={close} {...props} />
    </PageSheet>,
  );
  return {select, close};
}

beforeEach(async () => {
  jest.clearAllMocks();
  emojiFrequency.reset();
  emojiSkinTone.reset();
  load.mockResolvedValue([waving, party]);
  await setReduceMotion(true);
});
afterEach(() => {
  cleanup();
  releaseReduceMotion();
  jest.restoreAllMocks();
});

it('searches Korean, selects the global skin tone, and shares frequency on reopen', async () => {
  const {select} = picker();
  fireEvent.changeText(screen.getByTestId('emoji-search'), '손 흔들기');
  await screen.findByTestId('emoji-pick-👋');
  fireEvent.press(screen.getByTestId('emoji-tone-3'));
  expect(screen.getByText(displayGlyph(waving, 3))).toBeTruthy();
  fireEvent.press(screen.getByTestId('emoji-pick-👋'));
  expect(select).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledWith('👋🏽');
  expect(emojiFrequency.frequent()[0]).toBe('👋');
  expect(
    (haptics as unknown as {event: jest.Mock}).event,
  ).toHaveBeenCalledTimes(1); // tone; reaction owner confirms
  await act(async () => {
    cleanup();
  });
  picker();
  await screen.findByTestId('emoji-pick-👋');
  expect(screen.getByText('👋🏽')).toBeTruthy();
});

it('loads, fails inline, retries, then offers a search-clear action on no matches', async () => {
  let reject!: (reason: Error) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  picker();
  expect(screen.getByText('이모지 목록을 불러오는 중입니다.')).toBeTruthy();
  await act(async () => reject(new Error('bad bundle')));
  expect(screen.getByText('이모지 목록을 불러오지 못했습니다.')).toBeTruthy();
  fireEvent.press(screen.getByTestId('emoji-retry'));
  await screen.findByTestId('emoji-pick-🎉');
  fireEvent.changeText(screen.getByTestId('emoji-search'), '없는 이름');
  expect(
    screen.getByText('찾는 이모지가 없습니다. 다른 이름으로 검색해 보세요.'),
  ).toBeTruthy();
  fireEvent.press(screen.getByText('검색 지우기'));
  expect(screen.getByTestId('emoji-pick-🎉')).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it('reserves an empty team tab and passes its query to the documented extension seam', async () => {
  picker();
  fireEvent.press(screen.getByTestId('emoji-tab-team'));
  expect(screen.getByTestId('emoji-team-empty')).toBeTruthy();
  expect(screen.queryByTestId('emoji-grid')).toBeNull();
  fireEvent.press(screen.getByText('기본 이모지 고르기'));
  await screen.findByTestId('emoji-pick-👋');
  await act(async () => {
    cleanup();
  });
  const slot = jest.fn(() => null);
  picker({team: {render: slot}});
  fireEvent.press(screen.getByTestId('emoji-tab-team'));
  fireEvent.changeText(screen.getByTestId('emoji-search'), 'oort');
  expect(slot).toHaveBeenLastCalledWith({
    query: 'oort',
    onClose: expect.any(Function),
  });
});

it('bounds a large catalog and keeps every glyph target at the shared touch size', async () => {
  load.mockResolvedValue(
    Array.from({length: 2000}, (_, index) => ({
      ...waving,
      glyph: `glyph-${index}`,
    })),
  );
  picker();
  fireEvent.press(screen.getByTestId('emoji-tab-people'));
  await screen.findByTestId('emoji-pick-glyph-0');
  expect(screen.queryByTestId('emoji-pick-glyph-1999')).toBeNull();
  expect(screen.getAllByTestId(/^emoji-pick-glyph-/).length).toBeLessThan(200);
  const cell = StyleSheet.flatten(
    screen.getByTestId('emoji-pick-glyph-0').props.style,
  );
  expect(cell.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
  expect(cell.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
});

it('keeps the grid above the search keyboard and restores skin choices when it hides', async () => {
  const listeners: Record<string, Array<(event?: unknown) => void>> = {};
  const original = Keyboard.addListener.bind(Keyboard);
  const subscription = jest
    .spyOn(Keyboard, 'addListener')
    .mockImplementation((name, callback) => {
      (listeners[name] ??= []).push(callback as (event?: unknown) => void);
      return original(name, callback);
    });
  picker();
  await screen.findByTestId('emoji-pick-🎉');
  act(() =>
    listeners.keyboardWillShow?.forEach(callback =>
      callback({endCoordinates: {height: 280}}),
    ),
  );
  expect(
    StyleSheet.flatten(screen.getByTestId('emoji-grid').props.style)
      .marginBottom,
  ).toBe(280);
  expect(screen.queryByTestId('emoji-tone-3')).toBeNull();
  act(() => listeners.keyboardWillHide?.forEach(callback => callback()));
  expect(
    StyleSheet.flatten(screen.getByTestId('emoji-grid').props.style)
      .marginBottom,
  ).toBe(0);
  expect(screen.getByTestId('emoji-tone-3')).toBeTruthy();
  subscription.mockRestore();
});

it('opens from reaction +, cancels back, and sends once through the existing close path', async () => {
  const close = jest.fn();
  const react = jest.fn();
  render(
    <MessageActionSheet
      message={
        {
          id: 'msg',
          authorMemberId: 'self',
          body: '금요일 배포',
          createdAtMs: 0,
        } as Message
      }
      chips={[]}
      availability={{
        react: true,
        reply: false,
        quote: false,
        pin: false,
        edit: false,
        delete: false,
      }}
      authorLabel="기획팀"
      onClose={close}
      onToggleReaction={react}
      onReply={jest.fn()}
      onEdit={jest.fn()}
      onDelete={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByTestId('all-reactions'));
  await screen.findByTestId('emoji-pick-🎉');
  fireEvent.press(screen.getByTestId('emoji-picker-close'));
  expect(screen.getByTestId('quick-reactions')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  for (const dismiss of [
    () => fireEvent.press(screen.getByTestId('sheet-backdrop', {includeHiddenElements: true})),
    () => fireEvent(screen.getByTestId('page-sheet'), 'accessibilityEscape'),
    () => dragHeader(FAR_SLOW_DRAG),
  ]) {
    fireEvent.press(screen.getByTestId('all-reactions'));
    await screen.findByTestId('emoji-pick-🎉');
    dismiss();
    expect(screen.getByTestId('quick-reactions')).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  }
  fireEvent.press(screen.getByTestId('all-reactions'));
  await screen.findByTestId('emoji-pick-🎉');
  fireEvent.press(screen.getByTestId('emoji-pick-🎉'));
  await waitFor(() => expect(react).toHaveBeenCalledWith('🎉'));
  expect(react).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
