import type {MessageAttachment} from '@momo/core/lib/api';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Share, type ShareAction} from 'react-native';

import {AttachmentViewer} from '../src/features/attachments/AttachmentViewer';
import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {isShareSheetHeld, resetShareSheetForTest, SHARE_SHEET_TAP_GRACE_MS} from '../src/lib/shareSheet';

// =============================================================================
// 사진 뷰어에서 연 공유 시트를 닫는 탭이 사진에 새지 않는다 (#5207, 같은 부류의 결함).
//
// 뷰어는 RN `Modal` — 자기 네이티브 창이라 셸의 막이(`AppShell` 의 `ShareSheetTouchShield`)가 덮지 못한다. 시뮬레이터 실측(`PHOTO-VIEWER-SOLO` 표면, 사진 뷰어 → [공유] → 시트 → 시트 위쪽 탭):
// 막이가 없으면 그 탭이 사진에 닿아 조작(‹ 뒤로·[저장]·[공유])이 숨었고(#4297 — 사진을 한 번 누르면 조작이 숨는다), 시트를 아래로 쓸어 닫으면 조작이 그대로였다. 그래서 뷰어의 Modal 안에도 막이가 한 번 선다.
// 이 파일은 그 배선만 잰다(터치가 실제로 막히는가는 네이티브 — 인계 파일의 실측).
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

// 막이는 뷰어 본문(`ViewerFrame`, `accessibilityViewIsModal`)의 **형제**라 RNTL 의 기본 질의는 접근성에서 가려진 것으로 보고 건너뛴다 — 비어 있어 읽힐 것이 없는 뷰라서 맞는 모양이다.
const HIDDEN_TOO = {includeHiddenElements: true} as const;

const IMAGES: MessageAttachment[] = [{id: 'photo-1', name: '현장.png', mime: 'image/png', sizeBytes: 4096}];

const a11y = AccessibilityInfo as unknown as {
  isReduceMotionEnabled: jest.Mock;
  isScreenReaderEnabled: jest.Mock;
  isReduceTransparencyEnabled: jest.Mock;
};

beforeEach(() => {
  jest.useFakeTimers();
  resetAttachmentContentForTest();
  resetShareSheetForTest();
  a11y.isReduceMotionEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isScreenReaderEnabled.mockImplementation(() => Promise.resolve(false));
  a11y.isReduceTransparencyEnabled.mockImplementation(() => Promise.resolve(false));
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('사진 뷰어 Modal 안의 공유 시트 막이', () => {
  it('[공유]가 시트를 열면 뷰어 Modal 안에 막이가 서고, 시트가 끝나고 유예가 지나면 걷힌다', async () => {
    let finish!: (result: ShareAction) => void;
    jest.spyOn(Share, 'share').mockImplementation(() => new Promise<ShareAction>(resolve => (finish = resolve)));
    render(
      <AttachmentViewer workspaceId="ws" channelId="ch" images={IMAGES} startIndex={0} onClose={jest.fn()} />,
    );
    fireEvent(screen.getByTestId('attachment-viewer-modal'), 'show');
    await screen.findAllByTestId('attachment-viewer-image');
    await act(async () => {});
    const modal = screen.getByTestId('attachment-viewer-modal');
    expect(within(modal).queryByTestId('share-sheet-touch-shield', HIDDEN_TOO)).toBeNull();

    fireEvent.press(screen.getByTestId('attachment-viewer-share'));
    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    expect(isShareSheetHeld()).toBe(true);
    await act(async () => {});
    // 막이는 **Modal 안에** 선다 — 셸의 막이는 이 창을 덮지 못한다.
    expect(within(modal).getByTestId('share-sheet-touch-shield', HIDDEN_TOO)).toBeTruthy();

    await act(async () => {
      finish({action: Share.dismissedAction});
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SHARE_SHEET_TAP_GRACE_MS);
    });
    expect(within(modal).queryByTestId('share-sheet-touch-shield', HIDDEN_TOO)).toBeNull();
    // 깨뜨리면: `AttachmentViewer` 의 Modal 안에서 `<ShareSheetTouchShield />` 를 빼면 `getByTestId` 가 던진다.
  });
});
