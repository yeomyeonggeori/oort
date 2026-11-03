import type {
  Member,
  Message,
  MessageAttachment,
  RosterMember,
} from '@momo/core/lib/api';
import { makeDirectory } from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Linking, Share } from 'react-native';

import { TOUCH_TARGET } from '../src/design/tokens';
import { AttachmentList } from '../src/features/attachments/AttachmentList';
import { resetAttachmentContentForTest } from '../src/features/attachments/content';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: { id: 'self' },
    signOut: jest.fn(),
  }),
}));

interface FileSystemMock {
  __reset: () => void;
  __state: {
    downloads: Array<{
      url: string;
      destination: { uri: string };
      options: {
        onProgress?: (value: {
          bytesWritten: number;
          totalBytes: number;
        }) => void;
      };
    }>;
    failure: Error | null;
    progress: Array<{ bytesWritten: number; totalBytes: number }>;
  };
}

interface MediaLibraryMock {
  __reset: () => void;
  __state: {
    addPermission: { status: string };
    addAnswer: { status: string; accessPrivileges: string; granted: boolean; canAskAgain: boolean };
    saved: string[];
    saveFailure: Error | null;
  };
  requestPermissionsAsync: jest.Mock;
  saveToLibraryAsync: jest.Mock;
}

const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
const mediaLibrary = jest.requireMock('expo-media-library/legacy') as MediaLibraryMock;

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BASE_MS = 1_700_000_000_000;

const SESSION_MEMBER: Member = {
  id: SELF,
  workspaceId: 'ws',
  kind: 'human',
  displayName: '나',
  handle: 'self',
};

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '김모모',
    handle: 'momo',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({ id: SELF, displayName: SESSION_MEMBER.displayName }),
  member({ id: OTHER }),
]);

function attachment(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-1',
    name: '배포-결과.pdf',
    mime: 'application/pdf',
    sizeBytes: 2048,
    ...over,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '첨부를 확인해 주세요.',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    ...over,
  };
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  fileSystem.__reset();
  mediaLibrary.__reset();
  // `__reset` 은 상태만 되돌린다 — 목 함수의 호출 기록은 시험 사이로 흐른다(「부르지 않았다」 단정이 앞 시험의 호출에 빨개진다).
  mediaLibrary.requestPermissionsAsync.mockClear();
  mediaLibrary.saveToLibraryAsync.mockClear();
  resetAttachmentContentForTest();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('첨부는 메시지에서 조용히 사라지지 않는다', () => {
  it('Message.attachments n개를 모두 읽어 카드로 그리고 낭독 라벨에도 남긴다', () => {
    const attachments = [
      attachment(),
      attachment({
        id: 'att-svg',
        name: '도식.svg',
        mime: 'image/svg+xml',
        sizeBytes: 1024,
      }),
    ];
    render(
      <MessageRow
        message={message({ attachments })}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );

    expect(screen.getAllByTestId('attachment-item')).toHaveLength(
      attachments.length,
    );
    // SVG는 이미지 MIME이어도 실행 가능한 XML이므로 미리보기 길을 얻지 않는다.
    expect(screen.queryByTestId('attachment-preview')).toBeNull();
    const label = String(
      screen.getByTestId('message-row').props.accessibilityLabel,
    );
    expect(label).toContain('첨부 배포-결과.pdf');
    expect(label).toContain('첨부 도식.svg');
  });

  it('인용 표기와 현재 메시지 첨부가 함께 선다', () => {
    render(
      <MessageRow
        message={message({ attachments: [attachment()] })}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={{
          kind: 'ready',
          targetId: 'origin',
          targetSeq: 1,
          authorMemberId: OTHER,
          lines: ['원본 본문'],
          truncated: false,
          quotesAnother: false,
          edited: false,
        }}
        quoteAttachmentCount={2}
        actions={actions()}
      />,
    );

    expect(screen.getByTestId('quote-block')).toBeTruthy();
    expect(screen.getByTestId('quote-attachments').props.children).toBe(
      '첨부 파일 2개',
    );
    expect(screen.getAllByTestId('attachment-item')).toHaveLength(1);
  });
});

describe('미리보기와 내려받기는 상태를 숨기지 않는다', () => {
  it('미리보기는 고정 16:9 프레임에서 loading → ready로 간다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[
          attachment({ name: '화면.png', mime: 'image/png', sizeBytes: 4096 }),
        ]}
      />,
    );
    const preview = screen.getByTestId('attachment-preview');
    expect(preview.props.accessibilityValue.text).toBe('loading');
    expect(flatten(preview.props.style).aspectRatio).toBe(16 / 9);
    await waitFor(() => {
      expect(
        screen.getByTestId('attachment-preview').props.accessibilityValue.text,
      ).toBe('ready');
    });
  });

  it('미리보기 실패는 같은 프레임 안에서 말하고 파일 카드를 없애지 않는다', async () => {
    fileSystem.__state.failure = new Error('network');
    render(
      <AttachmentList
        channelId="ch"
        attachments={[
          attachment({ name: '화면.png', mime: 'image/png', sizeBytes: 4096 }),
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('attachment-preview-failed')).toBeTruthy(),
    );
    expect(screen.getByTestId('attachment-item')).toBeTruthy();
  });

  it('idle → 진행률 → 실패 → 재시도 → iOS 공유시트를 실측한다', async () => {
    fileSystem.__state.failure = new Error('network');
    fileSystem.__state.progress = [{ bytesWritten: 1, totalBytes: 4 }];
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    const item = screen.getByTestId('attachment-item');
    expect(screen.getByTestId('attachment-download-idle')).toBeTruthy();
    expect(flatten(item.props.style).minHeight).toBe(TOUCH_TARGET);

    fireEvent.press(item);
    expect(screen.getByTestId('attachment-downloading').props.children).toBe(
      '내려받는 중 25%',
    );
    await waitFor(() =>
      expect(screen.getByTestId('attachment-download-failed')).toBeTruthy(),
    );

    fileSystem.__state.failure = null;
    fireEvent.press(item);
    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    expect(Share.share).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '배포-결과.pdf',
        url: expect.stringMatching(/^file:/),
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('attachment-download-idle')).toBeTruthy(),
    );
  });
});

describe('첨부 탭과 메시지 롱프레스는 서로의 행동을 훔치지 않는다', () => {
  it('카드 탭은 스레드를 열지 않고, 같은 카드의 롱프레스는 기존 액션시트를 연다', async () => {
    const onOpenThread = jest.fn();
    render(
      <MessageRow
        message={message({ attachments: [attachment()] })}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({ onOpenThread })}
      />,
    );
    const item = screen.getByTestId('attachment-item');
    fireEvent.press(item);
    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    expect(onOpenThread).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId('message-row'), 'touchStart', {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    fireEvent(item, 'longPress');
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    // 손을 뗄 때 따라오는 탭은 다운로드를 한 번 더 시작하지 않는다.
    await act(async () => fireEvent.press(item));
    expect(Share.share).toHaveBeenCalledTimes(1);
  });
});

describe('Buzz 식 첨부 (#3820)', () => {
  const HASH = 'geGngQxZ3pLmK9aVbT2wRq-pQ';

  it('무작위 토큰 같은 이름은 어디에도 찍히지 않고 일반 이름이 된다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[
          attachment({ id: 'h1', name: `${HASH}.webp`, mime: 'image/webp', sizeBytes: 9400 }),
          attachment({ id: 'h2', name: `${HASH}.pdf`, mime: 'application/pdf', sizeBytes: 9400 }),
        ]}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('attachment-item')).toHaveLength(2));
    // 화면에 보이는 글자와 낭독 라벨에 없어야 한다(앱 캐시 파일 경로는 화면이 아니다).
    expect(screen.queryByText(/geGngQ/)).toBeNull();
    for (const item of screen.getAllByTestId('attachment-item')) {
      expect(String(item.props.accessibilityLabel)).not.toContain('geGngQ');
    }
    expect(screen.getByText('PDF 문서')).toBeTruthy();
  });

  it('이미지는 이름·크기 줄 없이 서고, 탭하면 전체 화면 보기가 열린다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={[
          attachment({ id: 'p1', name: '화면.png', mime: 'image/png', sizeBytes: 4096 }),
        ]}
      />,
    );
    expect(screen.queryByTestId('attachment-meta')).toBeNull();
    expect(screen.queryByText(/4 KB|이미지 ·/)).toBeNull();
    fireEvent.press(screen.getByTestId('attachment-item'));
    expect(screen.getByTestId('attachment-viewer')).toBeTruthy();
    // #4775: the Modal opens immediately; controls arrive after source measurement/hero.
    fireEvent.press(await screen.findByTestId('attachment-viewer-back'));
    expect(screen.queryByTestId('attachment-viewer')).toBeNull();
  });

  it('여러 장은 한 묶음 격자이고 누른 장에서 시작한다', async () => {
    render(
      <AttachmentList
        channelId="ch"
        attachments={['a', 'b', 'c'].map(id =>
          attachment({ id, name: `${id}.png`, mime: 'image/png', sizeBytes: 4096 }),
        )}
      />,
    );
    expect(screen.getAllByTestId('attachment-image-group')).toHaveLength(1);
    fireEvent.press(screen.getAllByTestId('attachment-item')[1] as never);
    // #4775: position is in the controls that arrive after the opening hero.
    expect((await screen.findByTestId('attachment-viewer-position')).props.children).toBe('3장 중 2번');
  });
});

// ---- 파일 카드의 「저장」 (#5209) ------------------------------------------------------------------------------------------
describe('파일 카드의 ↓ 는 「저장」이다 — 카드 탭(공유)과 따로 눌린다', () => {
  interface PickMock {
    __files: Set<string>;
    __state: {
      pick: { directory: string; cancel: boolean; failure: Error | null };
      pickCalls: number;
      downloads: unknown[];
    };
    File: new (...parts: unknown[]) => { uri: string };
  }
  const fs = fileSystem as unknown as PickMock;
  const save = () => screen.getByTestId('attachment-card-save');
  const line = () => screen.queryByTestId('attachment-save-status')?.props.children;
  const VIDEO = attachment({ id: 'v1', name: '영상.mp4', mime: 'video/mp4', sizeBytes: 6_000_000 });
  const SVG = attachment({ id: 's1', name: '로고.svg', mime: 'image/svg+xml', sizeBytes: 1024 });

  it('PDF: ↓ 는 파일 앱에서 위치를 고르게 하고 첨부 이름으로 복사한다 — 공유 시트는 열리지 않는다', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    expect(save().props.accessibilityLabel).toBe('파일에 저장');
    expect(save().props.accessibilityRole).toBe('button');
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('파일에 저장했어요'));
    expect(fs.__state.pickCalls).toBe(1);
    // 사람의 폴더에는 캐시 이름(첨부 id 가 앞에 붙는다)이 아니라 사람이 보던 이름으로 선다.
    const target = new fs.File(new fs.File('file:///picked'), '배포-결과.pdf');
    expect(fs.__files.has(target.uri)).toBe(true);
    expect(Share.share).not.toHaveBeenCalled();
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('파일에 저장했어요');
    // 영수증은 걷힌 뒤 원래 줄(「첨부파일 내려받기」)로 돌아온다 — 실제 걷힘은 훅 시험이 시계로 잰다.
  });

  it('카드 탭은 지금처럼 공유 시트다 — ↓ 와 서로의 일을 하지 않는다', async () => {
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    fireEvent.press(screen.getByTestId('attachment-item'));
    await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(1));
    expect(fs.__state.pickCalls).toBe(0);
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
  });

  it('폴더 선택 창을 닫으면 실패가 아니다 — 줄은 그대로다', async () => {
    fs.__state.pick.cancel = true;
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    fireEvent.press(save());
    await waitFor(() => expect(fs.__state.pickCalls).toBe(1));
    await act(async () => {});
    expect(line()).toBeUndefined();
    expect(screen.getByTestId('attachment-download-idle')).toBeTruthy();
  });

  it('영상: ↓ 는 사진 보관함에 더한다 — 처음 한 번 추가 전용으로 묻고, 파일 앱 창은 열지 않는다', async () => {
    render(<AttachmentList channelId="ch" attachments={[VIDEO]} />);
    expect(save().props.accessibilityLabel).toBe('사진에 저장');
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('사진에 저장했어요'));
    expect(mediaLibrary.requestPermissionsAsync.mock.calls).toEqual([[true]]);
    expect(mediaLibrary.__state.saved).toEqual([expect.stringMatching(/^file:.*v1-영상\.mp4$/)]);
    expect(fs.__state.pickCalls).toBe(0);
    expect(Share.share).not.toHaveBeenCalled();
  });

  it('SVG 는 보관함이 읽지 못한다 — 처음부터 파일 갈래다', async () => {
    render(<AttachmentList channelId="ch" attachments={[SVG]} />);
    expect(save().props.accessibilityLabel).toBe('파일에 저장');
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('파일에 저장했어요'));
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('거부: 내려받지 않고 「설정 열기」 줄이 서서 남고, 누르면 설정 앱으로 간다', async () => {
    mediaLibrary.__state.addAnswer = { status: 'denied', accessPrivileges: 'none', granted: false, canAskAgain: false };
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    render(<AttachmentList channelId="ch" attachments={[VIDEO]} />);
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('사진 접근이 꺼져 있어요 · 설정 열기'));
    expect(fs.__state.downloads).toHaveLength(0);
    expect(mediaLibrary.saveToLibraryAsync).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('attachment-save-settings'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('실패: 줄이 말하고 ↓ 를 다시 누르면 다시 시도한다', async () => {
    mediaLibrary.__state.addPermission = { status: 'granted' };
    mediaLibrary.__state.saveFailure = new Error('boom');
    render(<AttachmentList channelId="ch" attachments={[VIDEO]} />);
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('저장하지 못했어요 · 다시 시도'));
    mediaLibrary.__state.saveFailure = null;
    fireEvent.press(save());
    await waitFor(() => expect(line()).toBe('사진에 저장했어요'));
  });

  it('VoiceOver 는 카드 하나로 읽으므로 저장은 로터의 동작이다 — 같은 저장이다', async () => {
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    const card = screen.getByTestId('attachment-item');
    expect(card.props.accessibilityActions).toEqual([{ name: 'save', label: '파일에 저장' }]);
    await act(async () => {
      card.props.onAccessibilityAction({ nativeEvent: { actionName: 'save' } });
    });
    await waitFor(() => expect(line()).toBe('파일에 저장했어요'));
    expect(fs.__state.pickCalls).toBe(1);
  });

  it('누르는 면은 44 다 — 높이는 상자가, 가로는 hitSlop 이 채운다', () => {
    render(<AttachmentList channelId="ch" attachments={[attachment()]} />);
    const style = flatten(save().props.style);
    const slop = save().props.hitSlop as { left: number; right: number };
    expect(style.height).toBe(TOUCH_TARGET);
    expect((style.width as number) + slop.left + slop.right).toBeGreaterThanOrEqual(TOUCH_TARGET);
  });

  it('↓ 위의 롱프레스는 메시지 액션시트를 열고, 따라오는 탭은 저장을 시작하지 않는다', async () => {
    render(
      <MessageRow
        message={message({ attachments: [attachment()] })}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    fireEvent(screen.getByTestId('message-row'), 'touchStart', {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    fireEvent(save(), 'longPress');
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    await act(async () => fireEvent.press(save()));
    expect(fs.__state.pickCalls).toBe(0);
  });
});
