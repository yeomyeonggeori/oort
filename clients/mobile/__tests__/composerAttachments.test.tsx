import {
  ATTACH_COPY,
  MAX_ATTACHMENT_BYTES,
  uploadIssueCopy,
  uploadIssueNext,
} from '@momo/core/features/attachments/model';
import {ApiError} from '@momo/core/lib/api';
import * as api from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
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

import {Composer} from '../src/features/conversation/Composer';
import {resetAttachmentDraftsForTest} from '../src/features/attachments/draftStore';
import {pickDocument, pickPhoto} from '../src/features/attachments/picker';
import {putAttachmentBytes} from '../src/features/attachments/uploadTransport';

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

beforeEach(() => {
  (
    AccessibilityInfo.announceForAccessibility as unknown as jest.Mock
  ).mockClear();
  (imagePicker as unknown as {launchImageLibraryAsync: jest.Mock})
    .launchImageLibraryAsync.mockClear();
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
    const announce = AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;
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
    const announce = AccessibilityInfo.announceForAccessibility as unknown as jest.Mock;
    await waitFor(() =>
      expect(
        announce.mock.calls.some(([sentence]) =>
          String(sentence).includes(uploadIssueCopy('permission-denied')),
        ),
      ).toBe(true),
    );
  });
});
