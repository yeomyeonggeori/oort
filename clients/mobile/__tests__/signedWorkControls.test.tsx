import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

import {SignerRefusal} from '@momo/core/features/auth/signedControl';
import type {PendingPermission} from '@momo/core/features/workbench/agentPane';
import {ApiError} from '@momo/core/lib/api';

import {
  SignedWorkControlsView,
  type SignedWorkActions,
} from '../src/features/work/SignedWorkControls';

// =============================================================================
// #3028 R2-E8 — the phone's permission card and instruction box.
//
// Sabotage targets: an allow is only ever the signed path (Face ID), 「이 세션
// 동안」 carries scope `session`, 「거부 + 지시」 sends the note through the
// signed instruction (never as a plain reject), and a signed action that does
// not arrive says 「전달 안 됨」 and keeps the text.
// =============================================================================

const PERMISSION: PendingPermission = {
  requestEventId: 'ev-1',
  atMs: 1_790_550_000_000,
  tool: {kind: 'execute', headline: '명령을 실행해도 될까요?'},
  preview: {text: 'npm test', truncated: false, omitted: 0, masked: 0, neutralized: 0},
  allow: {kind: 'allow_once', optionId: 'once'},
  reject: {kind: 'reject_once', optionId: 'no'},
  hiddenOptions: 0,
};

function actions(overrides: Partial<SignedWorkActions> = {}): SignedWorkActions {
  return {
    allow: jest.fn(async () => undefined),
    reject: jest.fn(async () => undefined),
    rejectWithInstruction: jest.fn(async () => ({
      state: 'rejected' as const,
      instruction: {state: 'sent' as const},
    })),
    instruct: jest.fn(async () => ({state: 'sent' as const})),
    ...overrides,
  };
}

function view(a: SignedWorkActions | null, extra: Partial<React.ComponentProps<typeof SignedWorkControlsView>> = {}) {
  return render(
    <SignedWorkControlsView
      permission={PERMISSION}
      ended={false}
      online
      block={null}
      actions={a}
      fallbackReject={null}
      now={() => PERMISSION.atMs + 1_000}
      {...extra}
    />,
  );
}

afterEach(cleanup);

describe('permission card', () => {
  it('「이 세션 동안」 sends scope session through the signed allow', async () => {
    const a = actions();
    view(a);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow-session'));
    });
    expect(a.allow).toHaveBeenCalledWith(PERMISSION, 'session');
    expect(screen.getByTestId('work-permission-outcome').props.children).toContain('이 세션 동안');
  });

  it('「이번 한 번」 sends scope once', async () => {
    const b = actions();
    view(b);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(b.allow).toHaveBeenCalledWith(PERMISSION, 'once');
  });

  it('a phone that cannot sign cannot allow, but can still reject (reject is unsigned)', async () => {
    const fallbackReject = jest.fn(async () => undefined);
    view(null, {
      block: '이 폰은 아직 지시 기기가 아니에요.',
      fallbackReject,
    });
    expect(screen.getByTestId('work-signed-block')).toBeTruthy();
    expect(screen.getByTestId('work-permission-allow').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('work-permission-allow-session').props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId('work-permission-reject'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-reject-commit'));
    });
    expect(fallbackReject).toHaveBeenCalledWith(PERMISSION);
  });

  it('shows the whole preview (never clipped) and hides the allow buttons while rejecting', () => {
    view(actions());
    expect(screen.getByTestId('work-permission-preview').props.numberOfLines).toBeUndefined();
    fireEvent.press(screen.getByTestId('work-permission-reject'));
    expect(screen.queryByTestId('work-permission-allow')).toBeNull();
    expect(screen.queryByTestId('work-permission-allow-session')).toBeNull();
  });

  it('「거부 + 지시」 sends the note through the signed path, not as a plain reject', async () => {
    const a = actions();
    view(a);
    fireEvent.press(screen.getByTestId('work-permission-reject'));
    fireEvent.changeText(screen.getByTestId('work-permission-reject-note'), '테스트만 고쳐 줘');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-reject-commit'));
    });
    expect(a.rejectWithInstruction).toHaveBeenCalledWith(PERMISSION, '테스트만 고쳐 줘');
    expect(a.reject).not.toHaveBeenCalled();
  });

  it('rejected but the instruction was not delivered: both facts, 「전달 안 됨」', async () => {
    const a = actions({
      rejectWithInstruction: jest.fn(async () => ({
        state: 'rejected' as const,
        instruction: {
          state: 'not_delivered' as const,
          stage: 'server' as const,
          text: '호스트가 90초 넘게 응답하지 않아 보내지 않았어요.',
          error: null,
        },
      })),
    });
    view(a);
    fireEvent.press(screen.getByTestId('work-permission-reject'));
    fireEvent.changeText(screen.getByTestId('work-permission-reject-note'), '다르게');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-reject-commit'));
    });
    const text = String(screen.getByTestId('work-permission-outcome').props.children);
    expect(text).toContain('거부는 보냈어요');
    expect(text).toContain('전달 안 됨');
    // The written instruction is not lost: it moves into the instruction box.
    expect(screen.getByTestId('work-instruction-input').props.value).toBe('다르게');
  });

  it('a cancelled Face ID keeps the card open with its reason', async () => {
    const a = actions({
      allow: jest.fn(async () => {
        throw new SignerRefusal('Face ID를 취소해서 보내지 않았어요.', true);
      }),
    });
    view(a);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(screen.getByTestId('work-permission-error').props.children).toBe(
      'Face ID를 취소해서 보내지 않았어요.',
    );
    expect(screen.queryByTestId('work-permission-outcome')).toBeNull();
  });

  it('a request the server closed settles the card', async () => {
    const a = actions({
      allow: jest.fn(async () => {
        throw new ApiError(409, 'x', 'permission_already_decided');
      }),
    });
    view(a);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(String(screen.getByTestId('work-permission-outcome').props.children)).toContain(
      '이미 다른 결정',
    );
  });
});

describe('instruction box', () => {
  it('queue is the default button; interrupt is its own button', async () => {
    const a = actions();
    view(a, {permission: null});
    fireEvent.changeText(screen.getByTestId('work-instruction-input'), '이어서');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-instruction-interrupt'));
    });
    expect(a.instruct).toHaveBeenCalledWith('이어서', 'interrupt');
    fireEvent.changeText(screen.getByTestId('work-instruction-input'), '그다음');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-instruction-queue'));
    });
    expect(a.instruct).toHaveBeenLastCalledWith('그다음', 'queue');
    expect(screen.getByTestId('work-instruction-input').props.value).toBe('');
  });

  it('not delivered: 「전달 안 됨」 with the reason, and the text stays', async () => {
    const a = actions({
      instruct: jest.fn(async () => ({
        state: 'not_delivered' as const,
        stage: 'sign' as const,
        text: 'Face ID를 취소해서 보내지 않았어요.',
        error: null,
      })),
    });
    view(a, {permission: null});
    fireEvent.changeText(screen.getByTestId('work-instruction-input'), '이어서 해 줘');
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-instruction-queue'));
    });
    expect(screen.getByTestId('work-instruction-note').props.children).toBe(
      '전달 안 됨 · Face ID를 취소해서 보내지 않았어요.',
    );
    expect(screen.getByTestId('work-instruction-input').props.value).toBe('이어서 해 줘');
  });

  it('an ended session has no instruction box', () => {
    view(actions(), {permission: null, ended: true});
    expect(screen.queryByTestId('work-instruction-box')).toBeNull();
  });
});
