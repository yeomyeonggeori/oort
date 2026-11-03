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
import { Dimensions, Share } from 'react-native';
import { inspect } from 'util';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import { VIDEO_ICONS } from '../src/design/icons';
import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { AttachmentViewer } from '../src/features/attachments/AttachmentViewer';
import { ReplySwipeContainer } from '../src/features/conversation/ReplySwipeContainer';
import { finger } from './fixtures/finger';
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

// 열기 전의 인가 확인(`HEAD`, 401 이면 코어의 단 한 번 회전)은 코어의 일이고 코어 시험(`attachmentProbe.test.ts`)이 잰다. 여기서는 그 답
// (상태 숫자)과 **회전이 일으키는 결과(새 토큰)** 만 흉내 낸다 — 폰이 그 답으로 무엇을 하는지를 잰다. 나머지 코어는 진짜다.
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  probeAttachmentContent: jest.fn(),
}));

// =============================================================================
// 영상 첨부를 앱 안에서 바로 재생한다 (#5208) — 카카오톡처럼.
//
// 이 파일이 지키는 것은 네 가지다.
//   ① 영상은 문서 아이콘 카드가 아니다 — 포스터 카드(길이·재생 표지) 또는 영상기 아이콘 카드다.
//   ② 카드를 누르면 사진 뷰어와 같은 전체 화면에서 **전부 받기 전에** 재생이 시작된다: 영상 바이트는 앱 파일로 내려받지 않고
//      플레이어 소스(주소 + `Authorization` 헤더)로만 간다.
//   ③ 토큰은 소스의 `headers` 에만 있다 — 주소·로그·캐시에 없다. 재생 중 만료되면 한 번 새 토큰으로 바꾸고 위치를 되돌린다.
//   ④ 사진과 섞인 묶음에서 넘길 수 있고, 플레이어는 지금 보는 영상 하나뿐이다.
//
// 네이티브 플레이어는 Jest 에 없다. `expo-video` 대역(`jest.setup.js`)이 **무엇이 어디로 갔는가**를 기록한다. 실제 재생·구간 읽기(206)는
// 시뮬레이터 레인이 잰다(`maestro/124-video-viewer-live.yaml`) — 이 파일은 그것을 주장하지 않는다.
// =============================================================================

interface FakePlayer {
  sources: Array<{ uri?: string; headers?: Record<string, string>; useCaching?: boolean } | null>;
  source: FakePlayer['sources'][number];
  calls: string[];
  seeks: number[];
  released: boolean;
  playing: boolean;
  muted: boolean;
  currentTime: number;
  duration: number;
  __emit: (name: string, payload?: unknown) => void;
}
const videoMock = jest.requireMock('expo-video') as { __players: FakePlayer[]; __reset: () => void };
const fileSystem = jest.requireMock('expo-file-system') as {
  __reset: () => void;
  __state: { downloads: Array<{ url: string; destination: { uri: string }; options: { headers?: Record<string, string> } }> };
};
const { probeAttachmentContent } = jest.requireMock('@momo/core/lib/api') as {
  probeAttachmentContent: jest.Mock;
};

const BASE = 'https://api.example.com';
const CONTENT = `${BASE}/v1/workspaces/ws/channels/ch/attachments/v1/content`;
const POSTER = `${BASE}/v1/workspaces/ws/channels/ch/attachments/v1/poster`;
const ME: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws',
  kind: 'human',
  displayName: '나',
  handle: 'self',
};

const MEDIA = { kind: 'video', durationMs: 42_000, width: 1280, height: 720, hasPoster: true } as const;

function video(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'v1',
    name: 'IMG_0001.MOV',
    mime: 'video/quicktime',
    sizeBytes: 61_200_000,
    media: { ...MEDIA },
    ...over,
  };
}
const photo = (id: string): MessageAttachment => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  sizeBytes: 4096,
});

const player = (): FakePlayer => {
  const found = videoMock.__players[videoMock.__players.length - 1];
  if (found === undefined) throw new Error('no player was created');
  return found;
};
const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean).map(flatten))
    : ((style ?? {}) as Record<string, unknown>);

const consoleSpies = () =>
  (['log', 'info', 'warn', 'error', 'debug'] as const).map(name => jest.spyOn(console, name).mockImplementation(() => {}));
const printed = (spies: jest.SpyInstance[]) =>
  spies.flatMap(spy => spy.mock.calls.flat()).map(arg => inspect(arg, { depth: 8 })).join('\n');

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
  videoMock.__reset();
  resetAttachmentContentForTest();
  resetVideoContentForTest();
  probeAttachmentContent.mockReset();
  probeAttachmentContent.mockResolvedValue(200); // 서버가 읽기를 허락한다
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function openFromCard(attachments: MessageAttachment[], pressId = 'attachment-video-item') {
  render(<AttachmentList channelId="ch" attachments={attachments} />);
  await act(async () => {});
  fireEvent.press(screen.getAllByTestId(pressId)[0] as Parameters<typeof fireEvent.press>[0]);
  await waitFor(() => expect(videoMock.__players).toHaveLength(1));
  await waitFor(() => expect(player().calls).toContain('replaceAsync'));
  await act(async () => {});
}

// -----------------------------------------------------------------------------

describe('① 대화 속 영상 카드 — 문서 아이콘이 아니다', () => {
  it('포스터가 있는 영상은 제 크기로 선 포스터 카드다: 길이 알약과 재생 표지, 포스터는 인증된 포스터 길로 받는다', async () => {
    render(<AttachmentList channelId="ch" attachments={[video()]} />);
    await act(async () => {});

    const frame = flatten(screen.getByTestId('attachment-video-frame').props.style);
    expect(frame).toMatchObject({ width: 280, height: 158 }); // 16:9, 포스터가 오기 전에도 이 크기다
    expect(screen.getByTestId('attachment-video-duration').props.children).toBe('0:42');
    expect(screen.getByTestId('attachment-video-badge')).toBeTruthy();
    expect(screen.queryByTestId('attachment-card-icon')).toBeNull(); // 문서 아이콘 카드가 아니다
    expect(screen.getByTestId('attachment-video-item').props.accessibilityLabel).toBe(
      'IMG_0001.MOV, 동영상, 0:42, 재생',
    );

    const poster = fileSystem.__state.downloads.filter(download => download.url === POSTER);
    expect(poster).toHaveLength(1);
    expect(poster[0]?.options.headers).toEqual({ Authorization: 'Bearer tok-1' });
    const image = screen.getByTestId('attachment-video-poster');
    expect(image.props.source.uri).toContain('v1-poster');
    // 영상 바이트는 카드를 그리는 데 쓰이지 않는다.
    expect(fileSystem.__state.downloads.some(download => download.url === CONTENT)).toBe(false);
  });

  it('포스터가 없는 영상은 영상기 아이콘 카드다: 길이가 든 줄, 포스터를 요청하지 않는다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[video({ media: { ...MEDIA, hasPoster: false } })]}
      />,
    );
    await act(async () => {});

    expect(screen.getByTestId('attachment-card-video-icon').props.source).toBe(VIDEO_ICONS.video);
    expect(screen.getByTestId('attachment-meta').props.children).toBe('동영상 · 0:42 · 58.4 MB');
    expect(screen.getByTestId('attachment-card-play')).toBeTruthy();
    expect(screen.queryByTestId('attachment-video-poster')).toBeNull();
    // 포스터가 없는 영상에 `GET …/poster` 를 보내면 404 만 돌아온다.
    expect(fileSystem.__state.downloads).toHaveLength(0);

    // 전체 화면(쪽의 포스터)에서도 같다 — 눌러 열어도 포스터를 요청하지 않는다.
    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(videoMock.__players).toHaveLength(1));
    await waitFor(() => expect(player().calls).toContain('replaceAsync'));
    expect(fileSystem.__state.downloads.map(download => download.url)).not.toContain(POSTER);
  });

  it('길이를 모르는 영상(재지 않는 클라가 올린)도 영상기 카드이고, 줄에는 길이가 없다', async () => {
    // 보낸 기기가 길이·치수를 재지 않았다: `media` 가 없다.
    render(<AttachmentList channelId="ch" attachments={[video({ media: undefined })]} />);
    await act(async () => {});

    expect(screen.getByTestId('attachment-card-video-icon')).toBeTruthy();
    expect(screen.getByTestId('attachment-meta').props.children).toBe('동영상 · 58.4 MB');
    expect(screen.getByTestId('attachment-item').props.accessibilityLabel).toBe('IMG_0001.MOV, 동영상, 재생');
  });

  it('WebM 은 AVFoundation 이 읽지 못한다: 앱 안 재생 대상이 아니고 파일 카드의 공유로 남는다', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    render(
      <AttachmentList
        channelId="ch"
        attachments={[video({ mime: 'video/webm', name: 'clip.webm' })]}
      />,
    );
    await act(async () => {});

    expect(screen.queryByTestId('attachment-video-item')).toBeNull();
    expect(screen.queryByTestId('attachment-card-play')).toBeNull(); // 재생 표지 대신 내려받기 표지
    expect(screen.getByTestId('attachment-card-video-icon')).toBeTruthy(); // 그래도 영상이다 — 문서 아이콘이 아니다
    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
  });
});

describe('② 카드를 누르면 전체 화면에서 바로 재생된다 — 전부 받기 전에', () => {
  it('플레이어 소스(주소 + Authorization)로 열고 바로 재생한다. 영상은 앱 파일로 내려받지 않는다', async () => {
    await openFromCard([video()]);

    // 열기 전의 인가 확인 한 번(HEAD — 본문을 받지 않는다). 소스는 그 확인 **뒤에** 만들어진다.
    expect(probeAttachmentContent).toHaveBeenCalledTimes(1);
    expect(probeAttachmentContent).toHaveBeenCalledWith('ws', 'ch', 'v1');
    expect(player().source).toEqual({
      uri: CONTENT,
      headers: { Authorization: 'Bearer tok-1' },
      useCaching: false,
    });
    expect(player().calls).toEqual(expect.arrayContaining(['replaceAsync', 'play']));
    expect(player().calls.indexOf('play')).toBeGreaterThan(player().calls.indexOf('replaceAsync'));
    // 「전부 받기 전에」: 영상 바이트는 `downloadFileAsync` 로 가지 않았다(포스터만).
    expect(fileSystem.__state.downloads.map(download => download.url)).not.toContain(CONTENT);
    // AirPlay 수신기는 헤더 없이 주소를 받으러 간다 · 잠금 화면에 서지 않는다 · 앱을 벗어나면 멈춘다.
    expect(player()).toMatchObject({
      allowsExternalPlayback: false,
      showNowPlayingNotification: false,
      staysActiveInBackground: false,
      loop: false,
    });
    // 조작은 우리 것 하나뿐이다: 시스템 조작·화면 속 화면·멈춘 장면의 「텍스트 가져오기」 단추를 켜지 않는다.
    expect(screen.getByTestId('attachment-viewer-video').props).toMatchObject({
      nativeControls: false,
      allowsPictureInPicture: false,
      allowsVideoFrameAnalysis: false,
    });
  });

  it('토큰은 소스의 headers 에 한 번만 있다 — 주소에도, 로그에도 없다', async () => {
    const spies = consoleSpies();
    await openFromCard([video()]);

    const source = player().source;
    expect(Object.keys(source?.headers ?? {})).toEqual(['Authorization']);
    expect(source?.uri).not.toContain('tok-1');
    expect(printed(spies)).not.toContain('tok-1');
    // 캐시를 끈다는 것을 명시한다(기본값에 기대지 않는다).
    expect(source?.useCaching).toBe(false);
  });

  it('닫으면 플레이어가 해제된다 — 재생이 이어지지 않는다', async () => {
    await openFromCard([video()]);
    const opened = player();
    expect(opened.released).toBe(false);

    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
    await waitFor(() => expect(screen.queryByTestId('attachment-viewer')).toBeNull());
    expect(opened.released).toBe(true);
  });
});

describe('③ 토큰이 만료되면', () => {
  /** 다음 확인에서 코어가 한 번 회전한 것을 흉내 낸다: 옛 토큰이면 새 토큰으로 바뀐 채 200 을 돌려준다. */
  function tokenRotatesOnNextProbe() {
    probeAttachmentContent.mockImplementation(async () => {
      if (sessionPort.getAccessToken() === 'tok-1') sessionPort.applyRotation('tok-2', 'ref-2');
      return 200;
    });
  }
  const failure = (message = 'x') => ({ status: 'error', error: { message } });

  it('재생 중 오류가 나면 한 번 다시 확인해 새 토큰으로 소스를 바꾸고 재생 위치와 재생을 되돌린다 (오류 → 복구)', async () => {
    const spies = consoleSpies();
    await openFromCard([video()]);
    const active = player();
    act(() => {
      active.currentTime = 12.5; // 재생 중이던 자리
    });
    active.seeks.length = 0; // 이 쓰기는 사람이 옮긴 것이 아니다 — 복구가 되돌린 것만 아래에서 센다
    tokenRotatesOnNextProbe();

    await act(async () => {
      active.__emit('statusChange', failure());
    });
    await waitFor(() => expect(active.sources).toHaveLength(3)); // 빈 소스, 처음 연 소스, 복구한 소스

    expect(probeAttachmentContent).toHaveBeenCalledTimes(2); // 처음 열 때 한 번, 복구 때 한 번
    expect(active.source?.headers).toEqual({ Authorization: 'Bearer tok-2' });
    expect(active.seeks).toEqual([12.5]); // 위치 복원 — 복구가 한 번, 그 자리로
    expect(active.calls.filter(call => call === 'play')).toHaveLength(2); // 재생 복원
    expect(printed(spies)).not.toMatch(/tok-[12]/);
  });

  it('오류 칸이 남은 정상 알림(오류가 아닌 상태)은 복구를 일으키지 않는다 — 멀쩡한 재생을 실패로 만들지 않는다', async () => {
    await openFromCard([video()]);
    const active = player();
    await act(async () => {
      // 네이티브는 오류를 먼저 적고 상태를 바꾼다 — 이전 오류가 다음 알림의 오류 칸에 남아 있을 수 있다.
      active.__emit('statusChange', { status: 'readyToPlay', error: { message: 'stale' } });
      active.__emit('statusChange', { status: 'readyToPlay', error: { message: 'stale' } });
    });
    expect(probeAttachmentContent).toHaveBeenCalledTimes(1); // 다시 확인하지 않았다
    expect(active.sources).toHaveLength(2);
    expect(screen.queryByTestId('attachment-viewer-video-retry')).toBeNull();
  });

  it('복구한 자리에서 또 실패하면 다시 열지 않고 실패로 선다 — 다시 시도는 사람이 누른다', async () => {
    await openFromCard([video()]);
    const active = player();
    tokenRotatesOnNextProbe();
    await act(async () => {
      active.__emit('statusChange', failure());
    });
    await waitFor(() => expect(active.sources).toHaveLength(3));

    // 앞으로 나아가지 못하고(위치 사건 없음) 같은 오류가 다시 온다.
    await act(async () => {
      active.__emit('statusChange', failure());
    });
    expect(await screen.findByTestId('attachment-viewer-video-retry')).toBeTruthy();
    expect(screen.getByTestId('attachment-viewer-video-status').props.children).toBe('영상을 재생하지 못했어요');
    expect(active.sources).toHaveLength(3); // 세 번째 소스를 만들지 않았다
    expect(probeAttachmentContent).toHaveBeenCalledTimes(2);

    fireEvent.press(screen.getByTestId('attachment-viewer-video-retry'));
    await waitFor(() => expect(active.sources).toHaveLength(4)); // 사람이 누르면 처음부터 다시 연다
  });

  it('인가를 되살리지 못하면(401) 소스를 만들지 않고 실패로 선다 — 만료 선언은 코어가 이미 했다', async () => {
    probeAttachmentContent.mockResolvedValue(401);
    render(<AttachmentList channelId="ch" attachments={[video()]} />);
    await act(async () => {});
    fireEvent.press(screen.getByTestId('attachment-video-item'));

    expect(await screen.findByTestId('attachment-viewer-video-retry')).toBeTruthy();
    expect(videoMock.__players[0]?.calls).not.toContain('replaceAsync'); // 거절된 토큰으로 소스를 만들지 않았다
  });

  it('서버에 닿지 못하면 다시 시도를 내밀고 소스를 만들지 않는다', async () => {
    probeAttachmentContent.mockRejectedValue(new Error('network down'));
    render(<AttachmentList channelId="ch" attachments={[video()]} />);
    await act(async () => {});
    fireEvent.press(screen.getByTestId('attachment-video-item'));

    expect(await screen.findByTestId('attachment-viewer-video-retry')).toBeTruthy();
    expect(screen.getByTestId('attachment-viewer-video-status').props.children).toBe('영상을 재생하지 못했어요');
    expect(videoMock.__players[0]?.calls).not.toContain('replaceAsync');
    // 닿는 순간 다시 시도하면 처음부터 다시 열린다.
    probeAttachmentContent.mockResolvedValue(200);
    fireEvent.press(screen.getByTestId('attachment-viewer-video-retry'));
    await waitFor(() => expect(videoMock.__players[0]?.calls).toContain('replaceAsync'));
  });

  it('서버가 더는 보여 주지 않으면(404) 다시 시도 없이 안내만 한다', async () => {
    probeAttachmentContent.mockResolvedValue(404);
    render(<AttachmentList channelId="ch" attachments={[video()]} />);
    await act(async () => {});
    fireEvent.press(screen.getByTestId('attachment-video-item'));

    expect((await screen.findByTestId('attachment-viewer-video-status')).props.children).toBe(
      '이 영상은 더 이상 볼 수 없어요',
    );
    expect(screen.queryByTestId('attachment-viewer-video-retry')).toBeNull();
    expect(videoMock.__players[0]?.calls).not.toContain('replaceAsync');
  });
});

describe('④ 조작 — 재생·멈춤·탐색·소리', () => {
  it('재생 ↔ 멈춤, 소리 끄기·켜기', async () => {
    await openFromCard([video()]);
    const active = player();
    expect(active.calls.filter(call => call === 'play')).toHaveLength(1);

    fireEvent.press(screen.getByTestId('attachment-viewer-video-toggle'));
    expect(active.calls).toContain('pause');
    fireEvent.press(screen.getByTestId('attachment-viewer-video-toggle'));
    expect(active.calls.filter(call => call === 'play')).toHaveLength(2);

    expect(active.muted).toBe(false);
    fireEvent.press(screen.getByTestId('attachment-viewer-video-mute'));
    expect(active.muted).toBe(true);
  });

  it('진행 막대를 눌러 옮기면 그 비율의 위치로 간다 (끄는 동안 옮기지 않고 놓을 때 한 번)', async () => {
    await openFromCard([video()]);
    const active = player();
    active.duration = 40;
    act(() => {
      active.__emit('sourceLoad', { duration: 40 }); // 플레이어가 길이를 알려 준다
    });
    const seek = screen.getByTestId('attachment-viewer-video-seek');
    fireEvent(seek, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 44 } } });

    fireEvent(seek, 'responderGrant', { nativeEvent: { locationX: 100 } });
    fireEvent(seek, 'responderMove', { nativeEvent: { locationX: 150 } });
    expect(active.seeks).toHaveLength(0); // 끄는 동안은 플레이어를 건드리지 않는다
    fireEvent(seek, 'responderRelease', { nativeEvent: { locationX: 150 } });

    expect(active.seeks[active.seeks.length - 1]).toBe(30); // 150/200 × 40초
  });

  it('끝까지 본 뒤 재생 단추는 처음부터 다시 재생한다', async () => {
    await openFromCard([video()]);
    const active = player();
    await act(async () => {
      active.__emit('playToEnd');
    });
    expect(screen.getByTestId('attachment-viewer-video-toggle').props.accessibilityLabel).toBe('처음부터 다시 재생');
    fireEvent.press(screen.getByTestId('attachment-viewer-video-toggle'));
    expect(active.calls).toContain('replay');
  });

  it('영상 쪽에는 확대가 없다', async () => {
    await openFromCard([video()]);
    expect(screen.queryByTestId('attachment-viewer-zoom')).toBeNull();
    expect(screen.getByTestId('attachment-viewer-video')).toBeTruthy();
  });
});

describe('⑤ 사진과 섞인 묶음', () => {
  const MIXED = [photo('p1'), video(), photo('p2')];
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
  const caption = () => screen.getByTestId('attachment-viewer-position').props.children as string;
  const swipeTo = async (page: number) => {
    await act(async () => {
      fireEvent(screen.getByTestId('attachment-viewer-scroll'), 'momentumScrollEnd', {
        nativeEvent: { contentOffset: { x: page * width, y: 0 } },
      });
    });
  };

  it('사진에서 열면 플레이어가 없다. 영상으로 넘겨야 하나가 서고, 거기서는 자동 재생하지 않는다', async () => {
    await mountViewer(MIXED, 0);
    expect(videoMock.__players).toHaveLength(0);
    expect(caption()).toBe('3개 중 1번');
    // 영상의 바이트를 사진 미리보기로 내려받지 않는다(썸네일은 포스터다).
    expect(fileSystem.__state.downloads.map(download => download.url)).not.toContain(CONTENT);

    await swipeTo(1);
    await waitFor(() => expect(videoMock.__players).toHaveLength(1));
    await waitFor(() => expect(player().calls).toContain('replaceAsync'));
    expect(caption()).toBe('3개 중 2번');
    expect(screen.getByTestId('attachment-viewer-video-controls')).toBeTruthy();
    expect(player().calls).not.toContain('play'); // 넘겨서 닿은 영상은 멈춰 서서 기다린다
    // 영상이 지금 쪽이 되어도 그 바이트를 사진 미리보기로 받지 않는다.
    expect(fileSystem.__state.downloads.map(download => download.url)).not.toContain(CONTENT);
    fireEvent.press(await screen.findByTestId('attachment-viewer-video-play'));
    expect(player().calls).toContain('play');

    // 다시 사진으로 넘기면 플레이어가 풀리고 조작 줄이 사라진다.
    const gone = player();
    await swipeTo(2);
    expect(gone.released).toBe(true);
    expect(screen.queryByTestId('attachment-viewer-video-controls')).toBeNull();
  });

  it('사진만의 묶음은 그대로다: 「3장 중 n번」이고 플레이어를 만들지 않는다', async () => {
    await mountViewer([photo('p1'), photo('p2'), photo('p3')], 0);
    expect(caption()).toBe('3장 중 1번');
    expect(videoMock.__players).toHaveLength(0);
  });
});

describe('⑥ 뷰어 안의 쓸기는 아래 행의 「밀어서 답글」로 새지 않는다 (#5208 시뮬레이터 실측)', () => {
  // 뷰어(Modal)는 메시지 행의 React 자손이라 행의 밀기 컨테이너가 capture 길에서 뷰어 안의 오른쪽→왼쪽 쓸기를 먼저 가져간다. 가져가면 다음
  // 장으로 넘기는 동시에 뒤 대화에 답글 입력칸이 열리고 자판이 올라와 영상 조작 줄을 덮는다. 같은 표지(`ReplySwipeGuardContext`)를 뷰어의 터치
  // 시작마다 세워 막는다. jest 는 응답자 플러그인을 돌리지 못한다 — 손가락(`finger`)이 컨테이너의 capture 질문을 그대로 재생한다.
  const X0 = 300;
  const Y0 = 400;

  async function mountRowWithViewer() {
    const onCommit = jest.fn();
    render(
      <ReplySwipeContainer enabled onCommit={onCommit}>
        <AttachmentList channelId="ch" attachments={[photo('p1'), video()]} />
      </ReplySwipeContainer>,
    );
    await act(async () => {});
    fireEvent.press(screen.getByTestId('attachment-video-item'));
    await screen.findByTestId('attachment-viewer-video-controls');
    return onCommit;
  }
  const swipeLeft = (touch: ReturnType<typeof finger>) => {
    touch.down(X0, Y0);
    const claimed = touch.move(X0 - 40, Y0);
    touch.move(X0 - 120, Y0);
    touch.up();
    return claimed;
  };

  it('대조: 뷰어가 터치를 알리지 않으면 컨테이너는 이 쓸기를 가져가 답글을 연다 (새는 길이 실제로 있다)', async () => {
    const onCommit = await mountRowWithViewer();
    expect(swipeLeft(finger(screen.getByTestId('reply-swipe')))).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('뷰어 안에서 시작한 터치는 컨테이너가 가져가지 않아 답글이 열리지 않는다 — 다음 터치(뷰어 밖)는 다시 민다', async () => {
    const onCommit = await mountRowWithViewer();
    const touch = finger(screen.getByTestId('reply-swipe'));
    touch.down(X0, Y0);
    // 뷰어 루트의 `onTouchStart` 가 컨테이너의 capture 시작(표지 거둠) **뒤에** 불린다.
    fireEvent(screen.getByTestId('attachment-viewer'), 'touchStart', {
      nativeEvent: { pageX: X0, pageY: Y0, locationX: X0, locationY: Y0 },
    });
    expect(touch.move(X0 - 40, Y0)).toBe(false);
    touch.move(X0 - 120, Y0);
    touch.up();
    expect(onCommit).not.toHaveBeenCalled();

    // 뷰어를 닫은 뒤의 새 터치는 표지가 거둬져 다시 민다.
    fireEvent.press(screen.getByTestId('attachment-viewer-back'));
    await waitFor(() => expect(screen.queryByTestId('attachment-viewer')).toBeNull());
    expect(swipeLeft(finger(screen.getByTestId('reply-swipe')))).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
