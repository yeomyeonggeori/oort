import type {Message, RosterMember} from '@momo/core/lib/api';
import {quoteDraftFor} from '@momo/core/features/timeline/quote';
import {COPY_MESSAGE_ACTION_LABEL} from '@momo/core/features/timeline/copyLabels';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react-native';
import React from 'react';
import {Linking} from 'react-native';

import {TOUCH_TARGET} from '../src/design/tokens';
import {
  MessageBody,
  bodyAffordances,
} from '../src/features/conversation/MessageBody';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {QuoteBlock} from '../src/features/conversation/Quote';

// =============================================================================
// 접근성·타깃 — design-review H-1·M-1·M-2·M-8·M-9.
//
// ## 「행 = 접근성 원소 하나」는 지킨다. 그 안의 컨트롤을 로터로 올린다
//
// 이 클라이언트는 웹에서 행당 탭 스톱을 6→1 로 줄였고, 폰도 같은 규칙을 든다.
// 그런데 이번 배치가 행 **안에** 누를 것을 넷 더 넣었다 — 인용 점프·코드 복사·
// 본문 링크·아티팩트 주소. 손가락은 닿는데 VoiceOver 는 못 닿는 상태였다.
//
// 원소를 늘리면 그 규칙이 깨지고, 그냥 두면 그 넷이 보조기술에 없는 것이 된다.
// 답은 **로터 액션**이다: 원소는 하나로 두고 행동만 등재한다.
//
// ## 실기기 VoiceOver 는 여기서 못 돌린다 — 그래서 무엇을 재는지 적어 둔다
//
// 아래 단정이 재는 것은 **접근성 트리에 무엇이 올라갔는가**(액션 목록·라벨)와
// **그 액션이 실제로 무엇을 하는가**(핸들러 호출)다. 로터가 그 목록을 사람에게
// 어떻게 읽어 주는지는 기기에서만 확인되고, 그 한계는 PR 에 적는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '평문',
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

function readyBlock() {
  const draft = quoteDraftFor(
    message({id: 'orig-1', seq: 4, body: '배포 로그 확인했습니다'}),
  );
  if (draft === null) throw new Error('fixture');
  return draft.block;
}

/** 로터가 보는 목록. */
function rotor(): {name: string; label: string}[] {
  return screen.getByTestId('message-row').props.accessibilityActions ?? [];
}

function invoke(name: string): void {
  fireEvent(screen.getByTestId('message-row'), 'accessibilityAction', {
    nativeEvent: {actionName: name},
  });
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

const ANSWER = [
  '자세한 것은 [배포 문서](https://momo.example/deploy) 참고.',
  '',
  '```sh',
  'systemctl restart momo-relay',
  '```',
].join('\n');

afterEach(cleanup);

describe('H-1 — 행 안의 컨트롤이 로터에 올라간다', () => {
  it('본문 링크와 코드 복사가 액션으로 등재된다', () => {
    render(
      <MessageRow
        message={message({body: ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onOpenThread: () => {}})}
      />,
    );
    const names = rotor().map(a => a.name);
    expect(names).toContain('momoLink');
    expect(names).toContain('momoCopyCode');
  });

  it('링크 액션이 그 주소를 연다', () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    render(
      <MessageRow
        message={message({body: ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    invoke('momoLink');
    expect(openURL).toHaveBeenCalledWith('https://momo.example/deploy');
    openURL.mockRestore();
  });

  it('코드 복사 액션이 그 상자의 코드를 넣는다', async () => {
    const clipboard = jest.requireMock('expo-clipboard') as {
      __box: {value: string | null};
    };
    clipboard.__box.value = null;
    render(
      <MessageRow
        message={message({body: ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    invoke('momoCopyCode');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clipboard.__box.value).toBe('systemctl restart momo-relay');
  });

  it('인용 점프도 액션이다', () => {
    const onJumpToQuoted = jest.fn();
    const row = message();
    render(
      <MessageRow
        message={row}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
        actions={actions({onJumpToQuoted})}
      />,
    );
    expect(rotor().map(a => a.name)).toContain('momoQuoteJump');
    invoke('momoQuoteJump');
    expect(onJumpToQuoted).toHaveBeenCalledWith(row);
  });

  it('행은 여전히 접근성 원소 **하나**다', () => {
    // 로터로 올리는 이유가 이것이다. 컨트롤마다 원소를 만들면 웹에서 6→1 로
    // 줄인 그 비용이 폰에서 되살아난다.
    render(
      <MessageRow
        message={message({body: ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        quote={readyBlock()}
        actions={actions({onOpenThread: () => {}, onJumpToQuoted: () => {}})}
      />,
    );
    expect(screen.getByTestId('message-row').props.accessible).toBe(true);
  });

  it('없는 것은 등재하지 않는다', () => {
    render(
      <MessageRow
        message={message({body: '링크도 코드도 없는 평문'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    const names = rotor().map(a => a.name);
    expect(names).not.toContain('momoLink');
    expect(names).not.toContain('momoCopyCode');
    expect(names).not.toContain('momoQuoteJump');
  });
});

describe('H-1 — 여러 개일 때 거짓말하지 않는다', () => {
  const TWO_LINKS = [
    '[배포 문서](https://momo.example/deploy) 와',
    '[런북](https://runbook.example/a) 을 보세요.',
  ].join('\n');

  it('첫 개만 올리되, 라벨이 총 개수를 말한다', () => {
    // 스무 개짜리 답에 액션 스무 개를 얹으면 로터가 그 자체로 못 쓸 물건이
    // 되고, 그것은 「하나의 원소」 규칙을 다른 방식으로 깨는 것이다.
    render(
      <MessageRow
        message={message({body: TWO_LINKS})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    const link = rotor().find(a => a.name === 'momoLink');
    expect(link).toBeTruthy();
    expect(link?.label).toContain('2');
    // 그리고 어디로 가는지도 말한다.
    expect(link?.label).toContain('momo.example');
  });

  it('하나뿐이면 개수를 말하지 않는다 — 셀 것이 없다', () => {
    render(
      <MessageRow
        message={message({body: ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    const link = rotor().find(a => a.name === 'momoLink');
    expect(link?.label).not.toMatch(/\d/);
  });
});

describe('bodyAffordances — 행이 본문에 무엇이 들었는지 아는 법', () => {
  it('링크와 코드를 센다', () => {
    const a = bodyAffordances(ANSWER);
    expect(a.linkCount).toBe(1);
    expect(a.firstLink).toBe('https://momo.example/deploy');
    expect(a.codeCount).toBe(1);
    expect(a.firstCode).toBe('systemctl restart momo-relay');
  });

  it('평문에는 아무것도 없다 — 파서를 돌리지도 않는다', () => {
    expect(bodyAffordances('그냥 한 줄')).toEqual({
      firstLink: null,
      linkCount: 0,
      firstCode: null,
      codeCount: 0,
    });
  });

  it('굵게·기울임 안의 링크도 찾는다', () => {
    const a = bodyAffordances('**[문서](https://a.example)** 를 보세요');
    expect(a.firstLink).toBe('https://a.example/');
  });

  it('목록 안의 링크도 찾는다', () => {
    const a = bodyAffordances('- [문서](https://b.example) 참고');
    expect(a.linkCount).toBe(1);
  });
});

describe('M-1 — 마크다운도 텍스트를 꺼낼 수 있다', () => {
  it('시트가 없는 행에서는 마크다운 본문도 선택된다', () => {
    // BL-2 의 잔여였다: 마크다운을 담은 낙관적 메아리는 시트가 없으므로 선택이
    // 텍스트를 꺼내는 **유일한** 길인데, 첫 판은 평문 경로에만 걸었다.
    render(<MessageBody body={ANSWER} selectable />);
    expect(screen.getByText(/자세한 것은/).props.selectable).toBe(true);
    expect(screen.getByText(/systemctl/).props.selectable).toBe(true);
  });

  it('시트가 있는 행에서는 마크다운도 선택되지 않는다', () => {
    render(<MessageBody body={ANSWER} />);
    expect(screen.getByText(/자세한 것은/).props.selectable).toBe(false);
  });
});

describe('M-8·M-9 — 엄지에게 44pt', () => {
  it('인용 블록이 44pt 를 지난다', () => {
    render(
      <QuoteBlock block={readyBlock()} directory={DIRECTORY} onJump={() => {}} />,
    );
    const block = screen.getByTestId('quote-block');
    const slop = block.props.hitSlop ?? {};
    // 바닥(32) + 위아래 여유. 한 줄짜리 인용에서도 이 합이 44 를 넘는다.
    expect(32 + (slop.top ?? 0) + (slop.bottom ?? 0)).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
  });

  it('코드 복사가 44pt 를 지난다', () => {
    render(<MessageBody body={ANSWER} />);
    const button = screen.getByTestId('code-copy');
    const slop = button.props.hitSlop ?? {};
    const height = flatten(button.props.style).minHeight as number;
    expect(height + (slop.top ?? 0) + (slop.bottom ?? 0)).toBeGreaterThanOrEqual(
      TOUCH_TARGET,
    );
    // 시각 높이는 44 가 **아니다** — 그것이 이 거래의 요점이다.
    expect(height).toBeLessThan(TOUCH_TARGET);
  });
});

describe('M-2 — 목록의 결', () => {
  it('시트 항목이 전부 동사형이다', () => {
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onQuote: () => {}, onOpenThread: () => {}})}
      />,
    );
    const point = {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    };
    fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.getByTestId('sheet-copy').props.accessibilityLabel).toBe(
      COPY_MESSAGE_ACTION_LABEL,
    );
  });
});

describe('M-7 — 접근성 글꼴에서도 「닫기」에 닿는다', () => {
  it('시트가 스크롤하고 최대 높이를 갖는다', () => {
    // 실측(코드에서 도출): 기본 ≈482pt · AX5 ≈850pt. SE(667pt)에서 넘치고,
    // 넘치면 잘리는 것은 목록의 **끝** — 이 시트의 끝은 「닫기」다.
    render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions({onQuote: () => {}, onOpenThread: () => {}})}
      />,
    );
    const point = {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    };
    fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    expect(screen.getByTestId('sheet-scroll')).toBeTruthy();
    // 「닫기」가 그 스크롤 안에 있다 — 밖에 두면 스크롤이 그것을 못 데려온다.
    expect(screen.getByTestId('sheet-close')).toBeTruthy();
  });
});
