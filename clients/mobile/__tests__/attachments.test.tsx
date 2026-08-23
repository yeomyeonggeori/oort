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
import { Share } from 'react-native';

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

const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;

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
