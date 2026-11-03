import type { Member, MessageAttachment } from '@momo/core/lib/api';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Dimensions, Share } from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { AttachmentViewer } from '../src/features/attachments/AttachmentViewer';
import { resetAttachmentContentForTest } from '../src/features/attachments/content';
import { resetVideoContentForTest } from '../src/features/attachments/videoContent';
import { __resetSessionStore, sessionPort } from '../src/storage/secureSession';
import { __resetServerBaseCache, setServerBase } from '../src/storage/serverBase';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: { id: 'self' },
    signOut: jest.fn(),
  }),
}));

// 열기 전의 인가 확인은 코어의 일이다(`attachmentVideo.test.tsx` 와 같은 대역).
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  probeAttachmentContent: jest.fn(),
}));

// =============================================================================
// 영상 뷰어의 [저장]은 영상을 사진 보관함에 더한다 (#5209 × #5208).
//
// #5208 이 영상 쪽을 사진 뷰어와 **같은 조작 줄**에 얹었으므로 [저장]은 같은 `useSaveAttachment` 훅으로 지금 쪽(`current`)을 저장한다.
// 영상은 스트리밍으로 재생되고 앱 파일로 받지 않는다(`attachmentVideo.test.tsx` ②) — [저장]이 처음으로 그 바이트를 받는다. 그래서
// 권한이 **먼저**이고(거부면 한 바이트도 받지 않는다 — 이 파일에서 그것을 `downloadFileAsync` 호출로 잴 수 있다: 사진과 달리 영상은 미리보기로
// 이미 받아 둔 파일이 없다), 받는 길은 재생과 같은 인증 헤더다.
//
// 실제 보관함·시스템 프롬프트는 시뮬레이터 레인이 잰다 — 이 파일은 그것을 주장하지 않는다.
// =============================================================================

interface MediaLibraryMock {
  __reset: () => void;
  __state: {
    addPermission: { status: string };
    addAnswer: { status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean };
    saved: string[];
    saveFailure: Error | null;
  };
  requestPermissionsAsync: jest.Mock;
  getPermissionsAsync: jest.Mock;
  saveToLibraryAsync: jest.Mock;
}
const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;
const fileSystem = jest.requireMock('expo-file-system') as {
  __reset: () => void;
  __state: {
    downloads: Array<{ url: string; destination: { uri: string }; options: { headers?: Record<string, string> } }>;
    pickCalls: number;
  };
};
const videoMock = jest.requireMock('expo-video') as {
  __players: Array<{ released: boolean; calls: string[] }>;
  __reset: () => void;
};
const { probeAttachmentContent } = jest.requireMock('@momo/core/lib/api') as { probeAttachmentContent: jest.Mock };

const BASE = 'https://api.example.com';
const CONTENT = `${BASE}/v1/workspaces/ws/channels/ch/attachments/v1/content`;
const ME: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws',
  kind: 'human',
  displayName: '나',
  handle: 'self',
};

const MEDIA = { kind: 'video', durationMs: 42_000, width: 1280, height: 720, hasPoster: true } as const;
function video(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return { id: 'v1', name: 'IMG_0001.MOV', mime: 'video/quicktime', sizeBytes: 61_200_000, media: { ...MEDIA }, ...over };
}
const photo = (id: string): MessageAttachment => ({ id, name: `${id}.png`, mime: 'image/png', sizeBytes: 4096 });

const save = () => screen.getByTestId('attachment-viewer-save');
const status = () => screen.queryByTestId('attachment-viewer-status')?.props.children;
const contentDownloads = () => fileSystem.__state.downloads.filter(download => download.url === CONTENT);
const { width } = Dimensions.get('window');

async function mountViewer(images: MessageAttachment[], startIndex = 0) {
  render(
    <AttachmentViewer
      workspaceId="ws"
      channelId="ch"
      images={images}
      startIndex={startIndex}
      onClose={jest.fn()}
    />,
  );
  fireEvent(screen.getByTestId('attachment-viewer-modal'), 'show');
  await act(async () => {});
}
const swipeTo = async (page: number) => {
  await act(async () => {
    fireEvent(screen.getByTestId('attachment-viewer-scroll'), 'momentumScrollEnd', {
      nativeEvent: { contentOffset: { x: page * width, y: 0 } },
    });
  });
};
/** 이 기기가 이미 사진 추가를 허용했다(프롬프트 없이 저장된다). */
const granted = () => {
  mediaLibrary.__state.addPermission = { status: 'granted' };
};

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase(BASE);
  sessionPort.applyLogin({
    accessToken: 'tok-1',
    refreshToken: 'ref-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: ME,
  });
  fileSystem.__reset();
  mediaLibrary.__reset();
  mediaLibrary.requestPermissionsAsync.mockClear();
  mediaLibrary.getPermissionsAsync.mockClear();
  mediaLibrary.saveToLibraryAsync.mockClear();
  videoMock.__reset();
  resetAttachmentContentForTest();
  resetVideoContentForTest();
  probeAttachmentContent.mockReset();
  probeAttachmentContent.mockResolvedValue(200);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('영상 뷰어의 [저장] (#5209)', () => {
  it('영상을 통째로 받아(재생과 같은 인증 헤더) 사진 보관함에 더한다 — 공유 시트도 파일 앱 창도 열지 않는다', async () => {
    const sheet = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    await mountViewer([video()], 0);
    await waitFor(() => expect(videoMock.__players).toHaveLength(1));
    // 재생은 스트리밍이다 — 아직 영상 바이트를 앱 파일로 받지 않았다. [저장]을 누르기 전에 읽은 권한도 없다.
    expect(contentDownloads()).toHaveLength(0);
    expect(mediaLibrary.getPermissionsAsync).not.toHaveBeenCalled();
    expect(save().props.accessibilityLabel).toBe('저장');
    expect(save().props.accessibilityHint).toBe('영상을 사진 보관함에 저장해요');

    fireEvent.press(save());
    await waitFor(() => expect(status()).toBe('사진에 저장했어요'));
    // 처음이라 추가 전용으로 한 번 물었다.
    expect(mediaLibrary.requestPermissionsAsync.mock.calls).toEqual([[true]]);
    // 보관함으로 간 것은 **내려받은 영상 파일**이다(`saveToLibraryAsync` 가 요구하는 확장자가 있다).
    expect(mediaLibrary.__state.saved).toEqual([expect.stringMatching(/^file:.*v1-IMG_0001\.MOV$/)]);
    expect(contentDownloads()).toHaveLength(1);
    expect(contentDownloads()[0]?.options.headers).toEqual({ Authorization: 'Bearer tok-1' });
    expect(sheet).not.toHaveBeenCalled();
    expect(fileSystem.__state.pickCalls).toBe(0);
    expect(announce).toHaveBeenCalledWith('사진에 저장했어요');
  });

  it('거부하면 영상을 한 바이트도 내려받지 않는다 — 재생은 그대로 선다', async () => {
    mediaLibrary.__state.addAnswer = { status: 'denied', accessPrivileges: 'none', granted: false, canAskAgain: false };
    await mountViewer([video()], 0);
    await waitFor(() => expect(videoMock.__players).toHaveLength(1));
    fireEvent.press(save());
    await waitFor(() => expect(status()).toBe('사진 접근이 꺼져 있어요 · 설정 열기'));
    // 58 MB 를 받게 한 뒤 「저장할 수 없어요」라고 말하지 않는다: 권한이 내려받기보다 먼저다.
    expect(contentDownloads()).toHaveLength(0);
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(videoMock.__players[0]?.released).toBe(false);
  });

  it('사진과 섞인 묶음에서 [저장]은 지금 쪽을 저장한다 — 사진 쪽은 사진 파일, 영상 쪽은 영상 파일', async () => {
    granted();
    await mountViewer([photo('p1'), video(), photo('p2')], 0);
    // 사진 쪽: 사진 말, 사진 파일.
    expect(save().props.accessibilityHint).toBe('사진 보관함에 저장해요');
    fireEvent.press(save());
    await waitFor(() => expect(status()).toBe('사진에 저장했어요'));
    expect(mediaLibrary.__state.saved).toEqual([expect.stringMatching(/^file:.*p1-p1\.png$/)]);

    // 영상 쪽으로 넘기면 앞 쪽의 영수증은 걷히고 힌트·저장 대상이 영상으로 바뀐다.
    await swipeTo(1);
    await waitFor(() => expect(save().props.accessibilityHint).toBe('영상을 사진 보관함에 저장해요'));
    expect(status()).toBeUndefined();
    await waitFor(() => expect(save().props.accessibilityState?.disabled).toBeFalsy());
    fireEvent.press(save());
    await waitFor(() => expect(mediaLibrary.saveToLibraryAsync).toHaveBeenCalledTimes(2));
    expect(mediaLibrary.__state.saved[1]).toMatch(/^file:.*v1-IMG_0001\.MOV$/);
    expect(contentDownloads()).toHaveLength(1);
  });

  it('영상 쪽의 [공유]는 앞 판 그대로 공유 시트다 — 사진 보관함에 닿지 않는다', async () => {
    const sheet = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    await mountViewer([video()], 0);
    await waitFor(() => expect(videoMock.__players).toHaveLength(1));
    fireEvent.press(screen.getByTestId('attachment-viewer-share'));
    await waitFor(() => expect(sheet).toHaveBeenCalledTimes(1));
    expect(sheet.mock.calls[0]?.[0]).toMatchObject({ title: 'IMG_0001.MOV', url: expect.stringMatching(/^file:/) });
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('파일 카드의 ↓ 와 재생 카드 (#5209 × #5208)', () => {
  it('재생되는 영상 카드에는 ↓ 가 없다 — ▶ 가 서고, 그 영상의 저장은 전체 화면 보기의 [저장]이다', async () => {
    render(<AttachmentList channelId="ch" attachments={[video({ media: { ...MEDIA, hasPoster: false } })]} />);
    await act(async () => {});
    expect(screen.getByTestId('attachment-card-play')).toBeTruthy();
    expect(screen.queryByTestId('attachment-card-save')).toBeNull();
    // 로터에도 저장 동작이 없다(눌러도 아무 일도 없는 동작을 알리지 않는다).
    expect(screen.getByTestId('attachment-item').props.accessibilityActions).toBeUndefined();
  });

  it('WebM 은 보관함이 받지 못한다 — 파일 카드로 남고 ↓ 는 파일 앱 위치 고르기, 카드 탭은 공유 시트다', async () => {
    const sheet = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    render(
      <AttachmentList
        channelId="ch"
        attachments={[video({ id: 'w1', name: 'clip.webm', mime: 'video/webm', media: undefined })]}
      />,
    );
    await act(async () => {});
    const button = screen.getByTestId('attachment-card-save');
    expect(button.props.accessibilityLabel).toBe('파일에 저장');
    expect(screen.queryByTestId('attachment-card-play')).toBeNull();
    fireEvent.press(button);
    await waitFor(() => expect(screen.getByTestId('attachment-save-status').props.children).toBe('파일에 저장했어요'));
    expect(fileSystem.__state.pickCalls).toBe(1);
    // 보관함의 권한을 읽지도 묻지도, 쓰지도 않는다(WebM 은 어차피 받지 못한다).
    expect(mediaLibrary.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(sheet).not.toHaveBeenCalled();
    // 카드 탭은 지금처럼 공유 시트다.
    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(sheet).toHaveBeenCalledTimes(1));
  });
});
