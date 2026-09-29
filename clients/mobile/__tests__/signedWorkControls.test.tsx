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

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  fetchWorkPermissionPreview: jest.fn(),
}));

import {SignerRefusal} from '@momo/core/features/auth/signedControl';
import type {PendingPermission} from '@momo/core/features/workbench/agentPane';
import {
  permissionPreviewGate,
  PERMISSION_PREVIEW_BLOCK_LINE,
  type PermissionPreviewGate,
} from '@momo/core/features/workbench/permissionPreviewGate';
import {
  permissionPreviewSha256,
  type PermissionPreview,
} from '@momo/core/features/workbench/permissionPreview';
import {ApiError, fetchWorkPermissionPreview} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  ALLOW_SETTLE_MS,
  SignedWorkControlsView,
  usePermissionPreviewGate,
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

// #3128: the host's preview from the #3118 v3 vectors (execute, whole).
const V3 = JSON.parse(
  readFileSync(join(__dirname, '../../../docs/api/human-control-signing-v3.vectors.json'), 'utf8'),
) as {cases: {name: string; content: {preview?: PermissionPreview; preview_sha256?: string}}[]};
const HOST = V3.cases.find(c => c.name === 'control_v3_permission_once')!.content;
const HOST_PREVIEW = HOST.preview!;
const HOST_HASH = HOST.preview_sha256!;
const CUT = V3.cases.find(c => c.name === 'control_v3_permission_session')!.content;

const PERMISSION: PendingPermission = {
  requestEventId: 'ev-1',
  atMs: 1_790_550_000_000,
  // Inferred from agent.status: must never reach a signing card (#3118 H1).
  tool: {kind: 'read', headline: '파일을 읽어도 될까요?'},
  preview: {text: 'INFERRED README.md', truncated: false, omitted: 0, masked: 0, neutralized: 0},
  previewSha256: HOST_HASH,
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

function readOf(preview: unknown, previewSha256?: string) {
  return {
    permissionRequest: {
      id: 'r',
      sessionId: 's',
      requestEventId: 'ev-1',
      status: 'pending' as const,
      ...(previewSha256 ? {previewSha256} : {}),
    },
    options: [],
    preview,
  };
}

const READY: PermissionPreviewGate = permissionPreviewGate(HOST_HASH, {
  status: 'ok',
  data: readOf(HOST_PREVIEW, HOST_HASH),
});

function view(a: SignedWorkActions | null, extra: Partial<React.ComponentProps<typeof SignedWorkControlsView>> = {}) {
  return render(
    <SignedWorkControlsView
      permission={PERMISSION}
      preview={READY}
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
    expect(a.allow).toHaveBeenCalledWith(PERMISSION, 'session', {
      preview: HOST_PREVIEW,
      sha256: HOST_HASH,
    });
    expect(screen.getByTestId('work-permission-outcome').props.children).toContain('이 세션 동안');
  });

  it('「이번 한 번」 sends scope once', async () => {
    const b = actions();
    view(b);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(b.allow).toHaveBeenCalledWith(PERMISSION, 'once', {
      preview: HOST_PREVIEW,
      sha256: HOST_HASH,
    });
  });

  it('an allow that opens under the finger takes no press for a moment (design-review R2 H-1)', async () => {
    const a = actions();
    const r = view(a, {preview: {state: 'loading'}});
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    r.rerender(
      <SignedWorkControlsView
        permission={PERMISSION}
        preview={READY}
        ended={false}
        online
        block={null}
        actions={a}
        fallbackReject={null}
        now={() => PERMISSION.atMs + 1_000}
      />,
    );
    now.mockReturnValue(1_000_000 + ALLOW_SETTLE_MS - 1);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow-session'));
    });
    expect(a.allow).not.toHaveBeenCalled();
    now.mockReturnValue(1_000_000 + ALLOW_SETTLE_MS);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow-session'));
    });
    expect(a.allow).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('shows the host preview verbatim and asks from its kind — nothing inferred (#3118 H1)', () => {
    view(actions());
    expect(screen.getByText('명령을 실행해도 될까요?')).toBeTruthy();
    expect(screen.queryByText('파일을 읽어도 될까요?')).toBeNull();
    expect(screen.queryByText('INFERRED README.md')).toBeNull();
    expect(screen.getByTestId('work-permission-preview-title').props.children).toBe(HOST_PREVIEW.title);
    expect(screen.getByTestId('work-permission-preview-input').props.children).toBe(HOST_PREVIEW.input);
  });

  it.each([
    ['loading', {state: 'loading'} as PermissionPreviewGate, null],
    ['mismatch', permissionPreviewGate(HOST_HASH, {status: 'ok', data: readOf({...HOST_PREVIEW, title: 'Read README.md', kind: 'read'})}), PERMISSION_PREVIEW_BLOCK_LINE.mismatch],
    ['truncated', permissionPreviewGate(CUT.preview_sha256!, {status: 'ok', data: readOf(CUT.preview)}), PERMISSION_PREVIEW_BLOCK_LINE.truncated],
    ['missing', permissionPreviewGate(null, {status: 'ok', data: readOf(null)}), PERMISSION_PREVIEW_BLOCK_LINE.missing],
    ['unavailable', permissionPreviewGate(HOST_HASH, {status: 'error'}), PERMISSION_PREVIEW_BLOCK_LINE.unavailable],
  ])('%s: no allow, one honest sentence, reject still open', async (_what, gate, line) => {
    const a = actions();
    view(a, {preview: gate});
    expect(screen.getByTestId('work-permission-allow').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('work-permission-allow-session').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(a.allow).not.toHaveBeenCalled();
    if (line) expect(screen.getByTestId('work-permission-preview-blocked').props.children).toBe(line);
    else expect(screen.getByTestId('work-permission-preview-loading')).toBeTruthy();
    expect(screen.getByTestId('work-permission-reject').props.accessibilityState.disabled).toBe(false);
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

// Sabotage, end to end through the product hook: the server's owner read
// answers with a swapped preview (a harmless read over the real command). The
// card must never open the allow, and the signer is never asked.
describe('owner read → gate (#3128)', () => {
  function Harness({a}: {a: SignedWorkActions}) {
    const gate = usePermissionPreviewGate('ws', 'sess', PERMISSION, true);
    return (
      <SignedWorkControlsView
        permission={PERMISSION}
        preview={gate}
        ended={false}
        online
        block={null}
        actions={a}
        fallbackReject={null}
        now={() => PERMISSION.atMs + 1_000}
      />
    );
  }
  function mount(a: SignedWorkActions) {
    const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    return render(
      <QueryClientProvider client={client}>
        <Harness a={a} />
      </QueryClientProvider>,
    );
  }

  it('a swapped preview from the server: allow stays shut, Face ID never asked', async () => {
    const swapped = {...HOST_PREVIEW, kind: 'read', title: 'Read README.md', input: '{"path":"README.md"}'};
    (fetchWorkPermissionPreview as jest.Mock).mockResolvedValue(
      // The server even sends the swapped preview's own hash: the event's
      // (host's) hash still disagrees.
      readOf(swapped, permissionPreviewSha256(swapped as PermissionPreview)),
    );
    const a = actions();
    mount(a);
    await screen.findByTestId('work-permission-preview-blocked');
    expect(fetchWorkPermissionPreview).toHaveBeenCalledWith('ws', 'sess', 'ev-1');
    expect(screen.queryByText('Read README.md')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    expect(a.allow).not.toHaveBeenCalled();
  });

  it('the host preview: allow opens and signs the recomputed hash', async () => {
    (fetchWorkPermissionPreview as jest.Mock).mockResolvedValue(readOf(HOST_PREVIEW, HOST_HASH));
    const a = actions();
    mount(a);
    await screen.findByTestId('work-permission-preview');
    // The allow just opened under the finger: it settles first (R2 H-1).
    const opened = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(opened + ALLOW_SETTLE_MS + 1);
    await act(async () => {
      fireEvent.press(screen.getByTestId('work-permission-allow'));
    });
    now.mockRestore();
    expect(a.allow).toHaveBeenCalledWith(PERMISSION, 'once', {preview: HOST_PREVIEW, sha256: HOST_HASH});
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
