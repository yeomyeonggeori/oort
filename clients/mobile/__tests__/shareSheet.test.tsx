import type {MessageAttachment} from '@momo/core/lib/api';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';
import {Share, StyleSheet, type ShareAction} from 'react-native';

import {AttachmentList} from '../src/features/attachments/AttachmentList';
import {downloadAttachmentFile} from '../src/features/attachments/content';
import {
  isShareSheetHeld,
  presentShareSheet,
  resetShareSheetForTest,
  SHARE_SHEET_MAX_HOLD_MS,
  SHARE_SHEET_TAP_GRACE_MS,
} from '../src/lib/shareSheet';
import {ShareSheetTouchShield} from '../src/lib/ShareSheetTouchShield';

// =============================================================================
// 첨부 내려받기 공유 시트를 닫는 탭이 아래 화면의 줄·단추를 누르지 않는다 (#5207, owner 11-03).
//
// iOS 공유 시트는 뒤 화면을 막지 않아서, 시트 위쪽을 눌러 닫으면 같은 터치가 RN 의 눌림 면에도 닿았다 — 시뮬레이터(iOS 26.5) 실측: 시트 바로 위 「↳ ○○님에게 답글」 줄의 `onPress`
// 가 불려 스레드가 열렸고 시트는 그 0.57초 뒤에 닫혔다. 막이(`ShareSheetTouchShield`)가 시트가 떠 있는 동안과 막 걷힌 직후 터치를 받아 그 길을 닫는다.
//
// 이 파일이 재는 것은 **막이가 서고 걷히는 때와 모양**이다. 터치가 실제로 막히는가(네이티브 히트 테스트)는 제스트에 없다 — 시뮬레이터의 `maestro/5207-share-sheet.yaml` 이 잰다
// (사보타주 표는 인계 파일). 여기의 「막이는 터치를 받는 뷰다」 단정은 그 실측이 가리킨 것(`pointerEvents` 가 `none` 이면 샌다)을 지키는 모형이다.
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

// 내려받기를 시험이 쥐고 있게 한다 — 기본 모형은 즉시 끝나서 「내려받는 동안」을 볼 수 없다.
jest.mock('../src/features/attachments/content', () => ({
  ...jest.requireActual('../src/features/attachments/content'),
  downloadAttachmentFile: jest.fn(),
}));

const DISMISSED: ShareAction = {action: Share.dismissedAction};

/** 끝낼 수 있는 `Share.share` 모형 — 호출 순간의 막이 상태를 적어 둔다. */
function pendingShares() {
  const calls: Array<{heldAtCall: boolean; finish: (result: ShareAction) => void; fail: (error: Error) => void}> = [];
  jest.spyOn(Share, 'share').mockImplementation(
    () =>
      new Promise<ShareAction>((resolve, reject) => {
        calls.push({heldAtCall: isShareSheetHeld(), finish: resolve, fail: reject});
      }),
  );
  return calls;
}

const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

beforeEach(() => {
  jest.useFakeTimers();
  resetShareSheetForTest();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('공유 시트 문 — 막이가 서고 걷히는 때', () => {
  it('시트를 열기 전에 서고, 시트가 끝난 뒤에도 유예가 지나서야 걷힌다', async () => {
    const shares = pendingShares();
    const done = presentShareSheet({url: 'file:///cache/v1.mp4'});
    expect(shares).toHaveLength(1);
    expect(shares[0].heldAtCall).toBe(true); // 시트가 올라오는 동안에도 뒤 화면은 눌리지 않는다.
    expect(isShareSheetHeld()).toBe(true);

    await act(async () => {
      shares[0].finish(DISMISSED);
      await done;
    });
    // 시트는 끝났지만(닫는 탭의 0.57초 뒤) 막 걷힌 직후의 둘째 탭도 막는다.
    expect(isShareSheetHeld()).toBe(true);
    advance(SHARE_SHEET_TAP_GRACE_MS - 1);
    expect(isShareSheetHeld()).toBe(true);
    advance(1);
    expect(isShareSheetHeld()).toBe(false);
    // 깨뜨리면: `finally` 에서 유예 없이 곧바로 거두면 「끝난 직후」의 `true` 단정이, 시트를 연 뒤에야 막이를 세우면 `heldAtCall` 단정이 빨갛다.
  });

  it('시트를 못 열어도(거절) 오류는 그대로 올라가고 막이는 유예 뒤에 걷힌다', async () => {
    const shares = pendingShares();
    const done = presentShareSheet({url: 'file:///cache/v1.mp4'});
    shares[0].fail(new Error('boom'));
    await act(async () => {
      await expect(done).rejects.toThrow('boom');
    });
    expect(isShareSheetHeld()).toBe(true);
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(isShareSheetHeld()).toBe(false);
  });

  it('끝나지 않는 시트가 앱을 가두지 않는다 — 천장에서 걷히고, 늦은 끝은 남의 막이를 거두지 않는다', async () => {
    const shares = pendingShares();
    const first = presentShareSheet({url: 'file:///cache/a.mp4'});
    advance(SHARE_SHEET_MAX_HOLD_MS - 1);
    expect(isShareSheetHeld()).toBe(true);
    advance(1);
    expect(isShareSheetHeld()).toBe(false); // 천장

    // 새 시트가 서 있는 동안 앞 시트의 끝이 뒤늦게 와도 그 막이를 거두지 않는다(한 번만 거둔다).
    const second = presentShareSheet({url: 'file:///cache/b.mp4'});
    expect(isShareSheetHeld()).toBe(true);
    await act(async () => {
      shares[0].finish(DISMISSED);
      await first;
    });
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(isShareSheetHeld()).toBe(true);
    await act(async () => {
      shares[1].finish(DISMISSED);
      await second;
    });
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(isShareSheetHeld()).toBe(false);
    // 깨뜨리면: 거두기를 한 번만 하게 하는 `released` 검사를 빼면 가운데 `true` 단정이, 천장 타이머를 빼면 천장 직후의 `false` 단정이 빨갛다.
  });

  it('겹친 두 시트는 각자 걷힌다', async () => {
    const shares = pendingShares();
    const a = presentShareSheet({url: 'file:///cache/a.mp4'});
    const b = presentShareSheet({url: 'file:///cache/b.mp4'});
    await act(async () => {
      shares[0].finish(DISMISSED);
      await a;
    });
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(isShareSheetHeld()).toBe(true); // b 가 아직 서 있다.
    await act(async () => {
      shares[1].finish(DISMISSED);
      await b;
    });
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(isShareSheetHeld()).toBe(false);
  });
});

describe('막이 — 터치를 받는 뷰이고 서 있는 동안만 선다', () => {
  it('평소엔 그리지 않고, 시트가 떠 있는 동안 화면 전체를 덮는 터치 받는 뷰이며, 걷히면 사라진다', async () => {
    const shares = pendingShares();
    render(<ShareSheetTouchShield />);
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();

    let done!: Promise<ShareAction>;
    act(() => {
      done = presentShareSheet({url: 'file:///cache/v1.mp4'});
    });
    const shield = screen.getByTestId('share-sheet-touch-shield');
    // 시뮬레이터 실측의 사보타주: `pointerEvents="none"` 이면 막이가 서 있어도 탭이 샌다.
    expect(shield.props.pointerEvents).not.toBe('none');
    expect(shield.props.onStartShouldSetResponder()).toBe(true);
    expect(StyleSheet.flatten(shield.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    });

    await act(async () => {
      shares[0].finish(DISMISSED);
      await done;
    });
    expect(screen.getByTestId('share-sheet-touch-shield')).toBeTruthy(); // 유예 동안 그대로
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();
    // 깨뜨리면: 막이에 `pointerEvents="none"` 을 달면 `pointerEvents` 단정이, 서 있는 동안 그리지 않게 하면 `getByTestId` 가 던진다.
  });
});

describe('첨부 카드 → 공유 시트 배선', () => {
  const FILE: MessageAttachment = {id: 'att-video', name: 'v1.mp4', mime: 'video/mp4', sizeBytes: 61_235_000};

  function renderCard() {
    return render(
      <>
        <AttachmentList channelId="ch" attachments={[FILE]} />
        <ShareSheetTouchShield />
      </>,
    );
  }

  it('내려받는 동안은 막이가 없고(앱이 눌려야 한다), 시트를 여는 순간부터 닫힌 뒤 유예까지만 선다', async () => {
    let finishDownload!: (file: {uri: string}) => void;
    (downloadAttachmentFile as jest.Mock).mockImplementation(
      () => new Promise(resolve => (finishDownload = resolve)),
    );
    const shares = pendingShares();
    renderCard();

    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(screen.getByTestId('attachment-downloading')).toBeTruthy());
    // 58MB 를 받는 몇 초 동안 사람은 목록을 읽고 스크롤한다 — 이때 막이가 서면 앱이 먹통이다.
    expect(isShareSheetHeld()).toBe(false);
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();
    expect(shares).toHaveLength(0);

    await act(async () => {
      finishDownload({uri: 'file:///cache/oort-attachments/att-video-v1.mp4'});
    });
    await waitFor(() => expect(shares).toHaveLength(1));
    expect(shares[0].heldAtCall).toBe(true); // 시트가 올라오기 전에 섰다.
    expect(screen.getByTestId('share-sheet-touch-shield')).toBeTruthy();

    await act(async () => {
      shares[0].finish(DISMISSED);
    });
    expect(screen.getByTestId('share-sheet-touch-shield')).toBeTruthy(); // 닫힌 직후 유예
    advance(SHARE_SHEET_TAP_GRACE_MS);
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();
    // 카드는 처음으로 돌아왔다.
    await waitFor(() => expect(screen.getByTestId('attachment-download-idle')).toBeTruthy());
    // 깨뜨리면: `useShareAttachment` 가 `Share.share` 를 곧바로 부르게 되돌리면 시트가 열린 뒤의 막이 단정이 빨갛다(막이가 서지 않는다).
  });

  it('내려받기가 실패하면 시트가 열리지 않으니 막이도 서지 않는다', async () => {
    (downloadAttachmentFile as jest.Mock).mockRejectedValue(new Error('network'));
    const shares = pendingShares();
    renderCard();

    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(screen.getByTestId('attachment-download-failed')).toBeTruthy());
    expect(shares).toHaveLength(0);
    expect(isShareSheetHeld()).toBe(false);
    expect(screen.queryByTestId('share-sheet-touch-shield')).toBeNull();
  });
});
