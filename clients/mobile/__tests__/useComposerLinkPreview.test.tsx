import * as api from '@momo/core/lib/api';
import {UNFURL_PREVIEW_DEBOUNCE_MS} from '@momo/core/features/timeline/unfurlDraft';
import {act, cleanup, render} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {useComposerLinkPreview} from '../src/features/conversation/useComposerLinkPreview';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// #5037: 폰 훅이 코어 컨트롤러에 입력창의 수명을 이어 주는가. 규칙(기다림·차례·429·✕…)은 코어
// `composerLinkPreview.test.ts`와 진짜 `Composer`를 올린 `composerLinkPreview.test.tsx`가 재고, 여기서는 그 시험들이
// 닿지 않는 두 줄만 잰다: 입력창이 사라지면(`dispose`) 나가 있는 요청과 아직 끝나지 않은 기다림을 끊고, 오프라인
// (`paused`)이면 묻지 않다가 풀리면 이어서 묻는다(폰 입력창의 오프라인은 다른 시험이 재지 않았다).
// =============================================================================

const A = 'https://a.example/one';
const B = 'https://b.example/two';

const signals: AbortSignal[] = [];
const ask = jest.spyOn(api, 'fetchUnfurlPreview');

function Probe({text, paused = false}: {text: string; paused?: boolean}) {
  useComposerLinkPreview({workspaceId: 'ws-1', channelId: 'ch-1', text, paused});
  return null;
}

beforeEach(() => {
  installAppClock();
  signals.length = 0;
  ask.mockReset();
  // 답이 오지 않는 요청: 끊기면 신호만 선다.
  ask.mockImplementation((_ws: string, _ch: string, _url: string, signal?: AbortSignal) => {
    if (signal !== undefined) signals.push(signal);
    return new Promise(() => undefined);
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('폰 미리보기 훅의 수명 (#5037)', () => {
  it('입력창이 사라지면 나가 있던 요청을 끊는다', async () => {
    const view = render(<Probe text={A} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS);
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('기다림이 끝나기 전에 입력창이 사라지면 아무것도 묻지 않는다', async () => {
    const view = render(<Probe text={B} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS - 1);
    });
    view.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS * 3);
    });
    expect(signals).toHaveLength(0);
    expect(ask).not.toHaveBeenCalled();
  });

  it('오프라인(paused)이면 묻지 않고, 풀리면 이어서 묻는다', async () => {
    const view = render(<Probe text={A} paused />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    });
    expect(ask).not.toHaveBeenCalled();
    view.rerender(<Probe text={A} />);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS);
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
