import {
  ATTACH_COPY,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  beginUpload,
  completeUpload as completeDraftUpload,
  draftFor,
  failUpload,
  progressUpload,
  uploadIssueCopy,
  uploadIssueNext,
  verifyUpload,
  type AttachmentDraft,
} from '@momo/core/features/attachments/model';
import {ApiError} from '@momo/core/lib/api';
import * as api from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import {AccessibilityInfo, Linking} from 'react-native';

import {
  ATTACHMENT_SHEET_GRABBER_WIDTH,
  ATTACHMENT_TRAY_MAX_HEIGHT,
  lightPalette,
  space,
} from '../src/design/tokens';
import {FixedScheme} from '../src/design/theme';
import {AttachmentPickerSheet} from '../src/features/attachments/AttachmentPickerSheet';
import {AttachmentTray} from '../src/features/attachments/AttachmentTray';
import {Composer} from '../src/features/conversation/Composer';
import {
  addPickedFiles,
  attachmentSurfaceKey,
  resetAttachmentDraftsForTest,
} from '../src/features/attachments/draftStore';
import {pickDocument, pickPhoto} from '../src/features/attachments/picker';
import {putAttachmentBytes} from '../src/features/attachments/uploadTransport';
import * as uploadTransport from '../src/features/attachments/uploadTransport';
import {SessionProvider, useSession} from '../src/session/useSession';

const EMPTY = makeDirectory([]);
const TARGET = {workspaceId: 'ws-1', channelId: 'channel-1'};

interface ImagePickerMock {
  __state: {
    result: unknown;
    failure: Error | null;
    permission: {status: string; accessPrivileges?: string};
  };
  __reset: () => void;
}

interface DocumentPickerMock {
  __state: {result: unknown; failure: Error | null};
  __reset: () => void;
}

interface FileSystemMock {
  __state: {
    uploads: Array<{
      url: string;
      options: {headers?: Record<string, string>; onProgress?: unknown};
    }>;
    uploadFailure: Error | null;
    uploadStatus: number;
    uploadProgress: Array<{bytesSent: number; totalBytes: number}>;
    sizes: Map<string, number>;
  };
  __reset: () => void;
}

const imagePicker = jest.requireMock('expo-image-picker') as ImagePickerMock;
const documentPicker = jest.requireMock(
  'expo-document-picker',
) as DocumentPickerMock;
const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;

const createUpload = jest.spyOn(api, 'createAttachmentUpload');
const completeUpload = jest.spyOn(api, 'completeAttachmentUpload');

function completedRow(id: string) {
  return {
    id,
    channelId: TARGET.channelId,
    uploaderMemberId: 'member-1',
    name: 'picked',
    mime: 'application/octet-stream',
    size: 4,
    status: 'complete' as const,
    createdAtMs: 1,
  };
}

function successfulUploads(id: string): void {
  createUpload.mockResolvedValue({
    id: `upload-${id}`,
    status: 'pending',
    uploadUrl: `https://upload.example/${id}`,
  });
  completeUpload.mockResolvedValue(completedRow(id));
}

function openPicker(kind: 'photo' | 'file'): void {
  fireEvent.press(screen.getByTestId('composer-attach'));
  fireEvent.press(
    screen.getByTestId(
      kind === 'photo' ? 'attachment-pick-photo' : 'attachment-pick-file',
    ),
  );
}

function renderComposer(onSend = jest.fn()) {
  return {
    onSend,
    ...render(
      <Composer
        recipient="place"
        channelLabel="general"
        directory={EMPTY}
        attachmentTarget={TARGET}
        onSend={onSend}
      />,
    ),
  };
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

function draft(
  localId: string,
  over: Partial<AttachmentDraft> = {},
): AttachmentDraft {
  return {
    ...draftFor(localId, {
      name: `${localId}.txt`,
      mime: 'text/plain',
      sizeBytes: 2048,
    }),
    ...over,
  };
}

function renderTray(drafts: AttachmentDraft[]) {
  const node = (next: AttachmentDraft[]) => (
    <FixedScheme scheme="light">
      <AttachmentTray
        drafts={next}
        pickerIssue={null}
        onRemove={jest.fn()}
        onRetry={jest.fn()}
        onClear={jest.fn()}
      />
    </FixedScheme>
  );
  const view = render(node(drafts));
  return {
    ...view,
    rerenderDrafts: (next: AttachmentDraft[]) => view.rerender(node(next)),
  };
}

function renderSignedInComposer(): {
  signOut: () => void;
  switchAccount: () => void;
  endSession: () => void;
} {
  let signOut: (() => void) | null = null;
  function Probe(): null {
    signOut = useSession().signOut;
    return null;
  }
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  const tree = (memberId: string, displayName: string) => (
    <QueryClientProvider client={client}>
      <SessionProvider
        member={
          {
            id: memberId,
            workspaceId: TARGET.workspaceId,
            kind: 'human',
            displayName,
            handle: memberId,
          } as never
        }
      >
        <Probe />
        <Composer
          recipient="place"
          channelLabel="general"
          directory={EMPTY}
          attachmentTarget={TARGET}
          onSend={jest.fn()}
        />
      </SessionProvider>
    </QueryClientProvider>
  );
  const view = render(tree('member-1', '첫 계정'));
  if (signOut === null) throw new Error('signOut을 잡지 못했다');
  return {
    signOut,
    switchAccount: () => view.rerender(tree('member-2', '다음 계정')),
    endSession: view.unmount,
  };
}

beforeEach(() => {
  (
    AccessibilityInfo.announceForAccessibility as unknown as jest.Mock
  ).mockClear();
  (
    imagePicker as unknown as {launchImageLibraryAsync: jest.Mock}
  ).launchImageLibraryAsync.mockClear();
  imagePicker.__reset();
  documentPicker.__reset();
  fileSystem.__reset();
  resetAttachmentDraftsForTest();
  createUpload.mockReset();
  completeUpload.mockReset();
});

afterEach(() => {
  cleanup();
  resetAttachmentDraftsForTest();
});

describe('picker·native upload 단위 배선', () => {
  it('사진과 파일 메타데이터를 코어 초안 입력으로 정규화한다', async () => {
    imagePicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///photos/launch%20day.jpg',
          fileName: null,
          fileSize: 7,
          mimeType: 'image/jpeg',
        },
      ],
    };
    documentPicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///docs/brief.pdf',
          name: 'brief.pdf',
          size: 9,
          mimeType: 'application/pdf',
        },
      ],
    };

    await expect(pickPhoto()).resolves.toEqual({
      kind: 'picked',
      files: [
        {
          uri: 'file:///photos/launch%20day.jpg',
          name: 'launch day.jpg',
          mime: 'image/jpeg',
          sizeBytes: 7,
          sizeKnown: true,
        },
      ],
    });
    await expect(pickDocument()).resolves.toEqual({
      kind: 'picked',
      files: [
        {
          uri: 'file:///docs/brief.pdf',
          name: 'brief.pdf',
          mime: 'application/pdf',
          sizeBytes: 9,
          sizeKnown: true,
        },
      ],
    });
  });

  it('provider와 native 파일 모두 크기를 못 읽은 경우만 unknown으로 보존한다', async () => {
    documentPicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///docs/provider.bin',
          name: 'provider.bin',
          mimeType: 'application/octet-stream',
        },
      ],
    };

    await expect(pickDocument()).resolves.toEqual({
      kind: 'picked',
      files: [
        {
          uri: 'file:///docs/provider.bin',
          name: 'provider.bin',
          mime: 'application/octet-stream',
          sizeBytes: 0,
          sizeKnown: false,
        },
      ],
    });
  });

  it('capability PUT에는 momo bearer를 싣지 않고 99% 뒤 확인 단계에 맡긴다', async () => {
    const progress: number[] = [];
    const handle = putAttachmentBytes(
      'https://upload.example/file',
      'file:///cache/file.bin',
      'application/octet-stream',
      value => progress.push(value),
    );

    await expect(handle.done).resolves.toEqual({ok: true});
    expect(progress).toEqual([0.5, 0.99]);
    expect(fileSystem.__state.uploads[0].options.headers).toEqual({
      'Content-Type': 'application/octet-stream',
    });
    expect(fileSystem.__state.uploads[0].options.headers).not.toHaveProperty(
      'Authorization',
    );
  });
});

describe('Composer 첨부 렌더·발송', () => {
  it('사진 1장을 골라 트레이→업로드→파일만 발송한다', async () => {
    let resolveCreate:
      | ((
          value: Awaited<ReturnType<typeof api.createAttachmentUpload>>,
        ) => void)
      | undefined;
    createUpload.mockReturnValue(
      new Promise(resolve => {
        resolveCreate = resolve;
      }),
    );
    completeUpload.mockResolvedValue(completedRow('attachment-photo'));
    imagePicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///photos/photo.jpg',
          fileName: 'photo.jpg',
          fileSize: 4,
          mimeType: 'image/jpeg',
        },
      ],
    };
    const {onSend} = renderComposer();

    openPicker('photo');

    await waitFor(() =>
      expect(screen.getByText(new RegExp(ATTACH_COPY.uploading))).toBeTruthy(),
    );
    await act(async () => {
      resolveCreate?.({
        id: 'upload-attachment-photo',
        status: 'pending',
        uploadUrl: 'https://upload.example/attachment-photo',
      });
    });
    await waitFor(() =>
      expect(screen.getByText(new RegExp(ATTACH_COPY.uploaded))).toBeTruthy(),
    );
    expect(
      screen.getByTestId('attachment-draft').props.accessibilityLabel,
    ).toContain('photo.jpg');
    fireEvent.press(screen.getByTestId('composer-send'));

    expect(onSend).toHaveBeenCalledWith('', {
      attachments: [
        {
          id: 'attachment-photo',
          name: 'photo.jpg',
          mime: 'image/jpeg',
          sizeBytes: 4,
        },
      ],
    });
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
  });

  it('파일 1개를 골라 트레이→업로드→본문과 함께 발송한다', async () => {
    successfulUploads('attachment-file');
    documentPicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///docs/brief.pdf',
          name: 'brief.pdf',
          size: 8,
          mimeType: 'application/pdf',
        },
      ],
    };
    const {onSend} = renderComposer();

    fireEvent.changeText(screen.getByTestId('composer-input'), '검토 부탁해요');
    openPicker('file');
    await waitFor(() =>
      expect(screen.getByText(new RegExp(ATTACH_COPY.uploaded))).toBeTruthy(),
    );
    fireEvent.press(screen.getByTestId('composer-send'));

    expect(onSend).toHaveBeenCalledWith('검토 부탁해요', {
      attachments: [
        {
          id: 'attachment-file',
          name: 'brief.pdf',
          mime: 'application/pdf',
          sizeBytes: 8,
        },
      ],
    });
  });

  it('선택 취소를 코어의 인라인 문장으로 남긴다', async () => {
    renderComposer();
    openPicker('file');

    await waitFor(() =>
      expect(
        screen.getByText(uploadIssueCopy('selection-cancelled')),
      ).toBeTruthy(),
    );
    expect(createUpload).not.toHaveBeenCalled();
  });

  it('사진 권한 거부를 코어 문장과 설정 이동 행동으로 잇는다', async () => {
    imagePicker.__state.failure = new Error('permission denied');
    imagePicker.__state.permission = {
      status: 'denied',
      accessPrivileges: 'none',
    };
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);
    renderComposer();
    openPicker('photo');

    await waitFor(() =>
      expect(
        screen.getByText(uploadIssueCopy('permission-denied')),
      ).toBeTruthy(),
    );
    const next = uploadIssueNext('permission-denied');
    expect(next).not.toBeNull();
    fireEvent.press(screen.getByText(next as string));
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
  });

  it('100MB 초과를 업로드 전에 코어 문장으로 막는다', async () => {
    documentPicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///docs/too-large.zip',
          name: 'too-large.zip',
          size: MAX_ATTACHMENT_BYTES + 1,
          mimeType: 'application/zip',
        },
      ],
    };
    renderComposer();
    openPicker('file');

    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(uploadIssueCopy('too-large'))),
      ).toBeTruthy(),
    );
    expect(createUpload).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('composer-send').props.accessibilityState,
    ).toEqual({disabled: true});
  });

  it('보관소 미연결을 토스트 없이 트레이 안 코어 문장으로 남긴다', async () => {
    createUpload.mockRejectedValue(new ApiError(503, 'archive unavailable'));
    documentPicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///docs/brief.pdf',
          name: 'brief.pdf',
          size: 8,
          mimeType: 'application/pdf',
        },
      ],
    };
    renderComposer();
    openPicker('file');

    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(uploadIssueCopy('no-archive'))),
      ).toBeTruthy(),
    );
    expect(screen.getByTestId('attachment-tray')).toBeTruthy();
    expect(
      screen.getByTestId('composer-send').props.accessibilityState,
    ).toEqual({disabled: true});
  });
});

describe('검수 수리 회귀 (design-review High-1·High-2)', () => {
  it('picker 제시는 시트가 사라진 뒤다 — 닫는 같은 틱에 제시하지 않는다', async () => {
    // High-1: 닫히는 Modal과 같은 틱의 제시는 iOS가 거절할 수 있고, 그 거절은
    // 「업로드 실패」 오탐으로 접힌다. 제시는 onDismiss 또는 폴백 타이머 뒤다.
    renderComposer();
    fireEvent.press(screen.getByTestId('composer-attach'));
    fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    const launch = (
      imagePicker as unknown as {launchImageLibraryAsync: jest.Mock}
    ).launchImageLibraryAsync;
    expect(launch).not.toHaveBeenCalled();
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  });

  it('첨부 상태 전이를 announceForAccessibility로 말한다 (iOS 낭독)', async () => {
    // High-2: accessibilityLiveRegion은 Android 전용이다. 폰의 전달 관례대로
    // announce를 쓰고, 문장은 코어 draftAnnouncement가 만든다(바뀐 것만).
    successfulUploads('announce');
    imagePicker.__state.result = {
      canceled: false,
      assets: [
        {
          uri: 'file:///photos/notes.jpg',
          fileName: 'notes.jpg',
          fileSize: 4,
          mimeType: 'image/jpeg',
        },
      ],
    };
    renderComposer();
    openPicker('photo');
    const announce =
      AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;
    await waitFor(() =>
      expect(
        announce.mock.calls.some(([sentence]) =>
          String(sentence).includes('notes.jpg'),
        ),
      ).toBe(true),
    );
  });

  it('권한 거부 사유도 낭독된다 — 문장과 다음 행동을 함께', async () => {
    imagePicker.__state.failure = new Error('permission denied');
    imagePicker.__state.permission = {
      status: 'denied',
      accessPrivileges: 'none',
    };
    renderComposer();
    openPicker('photo');
    const announce =
      AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;
    await waitFor(() =>
      expect(
        announce.mock.calls.some(([sentence]) =>
          String(sentence).includes(uploadIssueCopy('permission-denied')),
        ),
      ).toBe(true),
    );
  });
});

describe('#1703 M-2 후속 폴리시', () => {
  it('진행 트랙 자리를 전 상태 예약하고 첫 측정 전에는 indeterminate로 말한다', () => {
    const ready = draft('slot');
    const view = renderTray([ready]);
    expect(
      flatten(screen.getByTestId('attachment-draft-progress-slot').props.style)
        .height,
    ).toBe(space.xs);
    expect(screen.queryByTestId('attachment-draft-progress')).toBeNull();

    const uploading = beginUpload([ready], ready.localId)[0];
    view.rerenderDrafts([uploading]);
    expect(
      screen.getByTestId('attachment-draft-progress').props.accessibilityValue,
    ).toEqual({
      text: ATTACH_COPY.uploading,
    });
    expect(
      flatten(
        screen.getByTestId('attachment-draft-progress-indeterminate').props
          .style,
      ).alignSelf,
    ).toBe('center');
    expect(screen.queryByTestId('attachment-draft-progress-fill')).toBeNull();

    const measured = progressUpload([uploading], ready.localId, 0.34)[0];
    view.rerenderDrafts([measured]);
    expect(
      flatten(screen.getByTestId('attachment-draft-progress-fill').props.style)
        .width,
    ).toBe('34%');
    expect(
      screen.getByTestId('attachment-draft-progress').props.accessibilityValue,
    ).toEqual({
      min: 0,
      max: 100,
      now: 34,
    });
    expect(
      screen.queryByTestId('attachment-draft-progress-indeterminate'),
    ).toBeNull();

    const verifying = verifyUpload([measured], ready.localId)[0];
    const settled = [
      verifying,
      completeDraftUpload([verifying], ready.localId, 'att-slot')[0],
      failUpload([ready], ready.localId, 'unavailable')[0],
    ];
    for (const nonUploading of settled) {
      view.rerenderDrafts([nonUploading]);
      expect(
        flatten(
          screen.getByTestId('attachment-draft-progress-slot').props.style,
        ).height,
      ).toBe(space.xs);
      expect(screen.queryByTestId('attachment-draft-progress')).toBeNull();
    }
  });

  it('발치 경고색은 failed 존재가 아니라 웹과 같은 sendBlockReason을 따른다', () => {
    const queued = draft('queued');
    const failed = failUpload([draft('failed')], 'failed', 'unavailable')[0];
    const view = renderTray([queued, failed]);
    expect(
      flatten(screen.getByTestId('attachment-blocked').props.style).color,
    ).toBe(lightPalette.textMuted);

    view.rerenderDrafts([failed]);
    expect(
      flatten(screen.getByTestId('attachment-blocked').props.style).color,
    ).toBe(lightPalette.warn);
  });

  it('크기를 읽지 못한 파일은 0 B라고 측정한 척하지 않는다', () => {
    renderTray([draft('unknown-size', {sizeBytes: 0, sizeKnown: false})]);
    const status = String(
      screen.getByTestId('attachment-draft-status').props.children,
    );
    expect(status).toBe(ATTACH_COPY.queued);
    expect(status).not.toContain('0 B');
  });

  it('grabber와 트레이 상한은 TOUCH_TARGET 대신 명명 측정을 소비한다', () => {
    render(
      <FixedScheme scheme="light">
        <AttachmentTray
          drafts={[draft('measure')]}
          pickerIssue={null}
          onRemove={jest.fn()}
          onRetry={jest.fn()}
          onClear={jest.fn()}
        />
        <AttachmentPickerSheet
          visible
          onClose={jest.fn()}
          onPickPhoto={jest.fn()}
          onPickFile={jest.fn()}
        />
      </FixedScheme>,
    );
    expect(
      flatten(screen.getByTestId('attachment-tray-list').props.style).maxHeight,
    ).toBe(ATTACHMENT_TRAY_MAX_HEIGHT);
    expect(
      flatten(screen.getByTestId('attachment-picker-grabber').props.style)
        .width,
    ).toBe(ATTACHMENT_SHEET_GRABBER_WIDTH);
  });

  it('현재 단건 picker 불변식에서 rejected를 일부 수락 뒤 무음 폐기하지 않는다', () => {
    const tooMany = Array.from(
      {length: MAX_ATTACHMENTS_PER_MESSAGE + 1},
      (_, index) => ({
        uri: `file:///docs/${index}.txt`,
        name: `${index}.txt`,
        mime: 'text/plain',
        sizeBytes: 1,
        sizeKnown: true,
      }),
    );
    const key = attachmentSurfaceKey(TARGET);

    expect(() => addPickedFiles(key, TARGET, tooMany)).toThrow(
      /rejected files need a visible notice/,
    );
    renderComposer();
    expect(screen.queryByTestId('attachment-tray')).toBeNull();
    expect(createUpload).not.toHaveBeenCalled();
  });

  it('로그아웃은 드래프트 0건으로 만들고 진행 중 native PUT을 취소한다', async () => {
    let settleUpload:
      | ((value: {ok: false; failure: 'aborted'}) => void)
      | undefined;
    const abort = jest.fn();
    const put = jest
      .spyOn(uploadTransport, 'putAttachmentBytes')
      .mockReturnValue({
        done: new Promise(resolve => {
          settleUpload = resolve;
        }),
        abort,
      });
    createUpload.mockResolvedValue({
      id: 'old-bearer-upload',
      status: 'pending',
      uploadUrl: 'https://upload.example/old-bearer-upload',
    });
    const {signOut} = renderSignedInComposer();

    act(() => {
      addPickedFiles(attachmentSurfaceKey(TARGET), TARGET, [
        {
          uri: 'file:///docs/private.txt',
          name: 'private.txt',
          mime: 'text/plain',
          sizeBytes: 8,
          sizeKnown: true,
        },
      ]);
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(screen.getAllByTestId('attachment-draft')).toHaveLength(1);

    act(() => signOut());

    expect(abort).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);
    expect(screen.queryByTestId('attachment-tray')).toBeNull();

    await act(async () => {
      settleUpload?.({ok: false, failure: 'aborted'});
      await Promise.resolve();
    });
    expect(completeUpload).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);
    put.mockRestore();
  });

  it('계정 전환은 늦은 구 bearer upload session id를 native PUT에 넘기지 않는다', async () => {
    let resolveCreate:
      | ((
          value: Awaited<ReturnType<typeof api.createAttachmentUpload>>,
        ) => void)
      | undefined;
    createUpload.mockReturnValue(
      new Promise(resolve => {
        resolveCreate = resolve;
      }),
    );
    const put = jest.spyOn(uploadTransport, 'putAttachmentBytes');
    const {switchAccount} = renderSignedInComposer();

    act(() => {
      addPickedFiles(attachmentSurfaceKey(TARGET), TARGET, [
        {
          uri: 'file:///docs/old-account.txt',
          name: 'old-account.txt',
          mime: 'text/plain',
          sizeBytes: 8,
          sizeKnown: true,
        },
      ]);
    });
    await waitFor(() => expect(createUpload).toHaveBeenCalledTimes(1));

    act(() => switchAccount());
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);

    await act(async () => {
      resolveCreate?.({
        id: 'old-account-upload',
        status: 'pending',
        uploadUrl: 'https://upload.example/old-account-upload',
      });
      await Promise.resolve();
    });
    expect(put).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);
    put.mockRestore();
  });

  it('토큰 만료처럼 provider가 내려가도 진행 중 native PUT과 드래프트를 끝낸다', async () => {
    let settleUpload:
      | ((value: {ok: false; failure: 'aborted'}) => void)
      | undefined;
    const abort = jest.fn();
    const put = jest
      .spyOn(uploadTransport, 'putAttachmentBytes')
      .mockReturnValue({
        done: new Promise(resolve => {
          settleUpload = resolve;
        }),
        abort,
      });
    createUpload.mockResolvedValue({
      id: 'expired-session-upload',
      status: 'pending',
      uploadUrl: 'https://upload.example/expired-session-upload',
    });
    const {endSession} = renderSignedInComposer();

    act(() => {
      addPickedFiles(attachmentSurfaceKey(TARGET), TARGET, [
        {
          uri: 'file:///docs/expired.txt',
          name: 'expired.txt',
          mime: 'text/plain',
          sizeBytes: 8,
          sizeKnown: true,
        },
      ]);
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    act(() => endSession());
    expect(abort).toHaveBeenCalledTimes(1);
    renderComposer();
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);

    await act(async () => {
      settleUpload?.({ok: false, failure: 'aborted'});
      await Promise.resolve();
    });
    expect(completeUpload).not.toHaveBeenCalled();
    put.mockRestore();
  });
});
