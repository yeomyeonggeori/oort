import {MAX_ATTACHMENTS_PER_MESSAGE} from '@momo/core/features/attachments/model';
import * as api from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {ATTACH_MENU} from '../src/features/attachments/AttachMenu';
import {
  addPickedFiles,
  attachmentSurfaceKey,
  resetAttachmentDraftsForTest,
} from '../src/features/attachments/draftStore';
import {PHOTO_COPY} from '../src/features/attachments/photoCardCopy';
import {Composer} from '../src/features/conversation/Composer';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 컴포저 ↔ 사진 카드의 배선 (#4181) — `Composer` 가 첨부 메뉴에 건네는 `photos`:
//   · `room` = 한 메시지의 상한(20) − 트레이에 이미 있는 초안 수
//   · `onAttach` = 고른 사진을 **한 번의 호출로** 초안 저장소에 넣는다
// 카드·메뉴 각각의 시험(photoGridCard·attachMenuPhotos)은 이 배선을 대신 못 잰다 — 메뉴를 가짜 `photos` 로 세우기
// 때문이다. 여기서는 진짜 컴포저·진짜 네이티브 포트(목 `expo-media-library/legacy`·`expo-file-system`)로 간다.
// =============================================================================

interface MediaLibraryMock {
  __state: {
    permission: {status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean};
    assets: unknown[];
    info: Map<string, unknown>;
  };
  __reset: () => void;
}
interface FileSystemMock {
  File: {prototype: Record<string, unknown>};
  __files: Set<string>;
  __state: {sizes: Map<string, number>};
  __reset: () => void;
}

const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;
const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
const createUpload = jest.spyOn(api, 'createAttachmentUpload');

const TARGET = {workspaceId: 'ws-1', channelId: 'channel-1'};
const GRANTED = {status: 'granted', accessPrivileges: 'all', granted: true, canAskAgain: true};

beforeAll(() => {
  // 목 `File` 에는 `copy` 가 없다(`photosNative.test.ts` 와 같은 만큼만 붙인다).
  fileSystem.File.prototype.copy = async function copy(
    this: {uri: string},
    destination: {uri: string},
  ) {
    fileSystem.__files.add(destination.uri);
    fileSystem.__state.sizes.set(destination.uri, fileSystem.__state.sizes.get(this.uri) ?? 0);
  };
});

beforeEach(() => {
  installAppClock();
  mediaLibrary.__reset();
  fileSystem.__reset();
  resetAttachmentDraftsForTest();
  createUpload.mockReset();
  // 올리기는 끝나지 않는다 — 트레이에 초안이 서 있는 것만 본다.
  createUpload.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => {
  cleanup();
  resetAttachmentDraftsForTest();
  jest.useRealTimers();
});

function library(count: number): void {
  mediaLibrary.__state.permission = GRANTED;
  mediaLibrary.__state.assets = Array.from({length: count}, (_, index) => ({
    id: `c${index + 1}`,
    filename: `IMG_C${index + 1}.JPG`,
    uri: `ph://c${index + 1}`,
    mediaType: 'photo',
    width: 4032,
    height: 3024,
    creationTime: 1_760_000_000_000 - index * 1000,
    modificationTime: 1_760_000_000_000,
    duration: 0,
  }));
  for (let index = 1; index <= count; index += 1) {
    mediaLibrary.__state.info.set(`c${index}`, {localUri: `file:///library/IMG_C${index}.JPG`});
    fileSystem.__state.sizes.set(
      new (fileSystem.File as unknown as new (uri: string) => {uri: string})(
        `file:///library/IMG_C${index}.JPG`,
      ).uri,
      4096,
    );
  }
}

function renderComposer() {
  return render(
    <Composer
      recipient="place"
      channelLabel="general"
      directory={makeDirectory([])}
      attachmentTarget={TARGET}
      onSend={jest.fn()}
    />,
  );
}

/** + → 「사진」: 메뉴가 카드로 변신하고 그리드가 설 때까지. */
async function openCard(): Promise<void> {
  fireEvent.press(screen.getByTestId('composer-attach'));
  // 열린 직후의 누름은 무시한다(연타 방어) — 사람이 메뉴를 본 뒤의 선택이 되도록 그 시간을 보낸다.
  act(() => {
    jest.advanceTimersByTime(ATTACH_MENU.anchorWaitMs + ATTACH_MENU.touchGuardMs + 50);
  });
  await act(async () => {
    fireEvent.press(screen.getByTestId('attachment-pick-photo'));
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    jest.advanceTimersByTime(1500);
    await Promise.resolve();
  });
  await screen.findByTestId('photo-grid');
}

async function press(testID: string): Promise<void> {
  const element = await screen.findByTestId(testID);
  await act(async () => {
    fireEvent.press(element);
  });
}

function seedTray(count: number): void {
  addPickedFiles(
    attachmentSurfaceKey(TARGET),
    TARGET,
    Array.from({length: count}, (_, index) => ({
      uri: `file:///docs/${index}.txt`,
      name: `${index}.txt`,
      mime: 'text/plain',
      sizeBytes: 1,
      sizeKnown: true,
    })),
  );
}

describe('컴포저 → 사진 카드', () => {
  it('트레이에 이미 있는 초안만큼 카드의 상한이 줄어든다(19개가 있으면 한 장만)', async () => {
    library(3);
    seedTray(MAX_ATTACHMENTS_PER_MESSAGE - 1);
    renderComposer();
    await openCard();
    await press('photo-cell-c1');
    await press('photo-cell-c2');
    // 상한은 20 − 19 = 1 이다 — 둘째는 고르지 못하고 안내가 선다.
    expect(screen.queryByTestId('photo-order-c2')).toBeNull();
    expect(screen.getByTestId('photo-notice')).toHaveTextContent(PHOTO_COPY.capped(1));
  });

  it('고른 사진은 파일이 되어 한 번에 트레이로 가고 메뉴가 닫힌다', async () => {
    library(3);
    renderComposer();
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(0);
    await openCard();
    await press('photo-cell-c1');
    await press('photo-cell-c2');
    await press('photo-pill');
    await act(async () => {
      jest.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryAllByTestId('attachment-draft')).toHaveLength(2);
    // 메뉴는 닫힌다(접힘이 끝나면 Modal 이 내려간다).
    expect(screen.queryByTestId('attach-menu')).toBeNull();
    expect(screen.queryByTestId('photo-card')).toBeNull();
  });
});
