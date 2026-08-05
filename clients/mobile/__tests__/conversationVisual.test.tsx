import type {Message, RosterMember} from '@momo/core/lib/api';
import type {QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
import {quoteDraftFor} from '@momo/core/features/timeline/quote';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {color, space} from '../src/design/tokens';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {APP_NOTE_MARK} from '../src/features/conversation/appVoice';
import {
  QuoteBlock,
  quoteAccessibilityPhrase,
} from '../src/features/conversation/Quote';

// =============================================================================
// 시각·위계 — design-review H-2·H-4·N-1·N-2 를 **값으로** 잠근다.
//
// 이 리뷰의 시각 위상은 SKIPPED 였다(N-8: 캡처 0장). 그래서 지적들이 전부
// 「코드에서 도출한 대비·기하」였고, 그 말은 **같은 방법으로 되잴 수 있다**는
// 뜻이다. 웹이 `gate:quote` 에서 색을 매 런마다 재는 것과 같은 성질의 단정을
// RN 에서 세운다 — 캡처는 `measure/` 하네스가 따로 남기고(N-8 해소), 여기서는
// 숫자를 지킨다.
//
// 대비 계산은 WCAG 상대휘도 정의 그대로다. 토큰 값을 손으로 베끼지 않고
// `tokens.ts` 에서 읽으므로, 토큰이 바뀌면 이 단정이 그 순간 말을 한다.
// =============================================================================

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 대비비. 순서 무관. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flatten));
  }
  return (style ?? {}) as Record<string, unknown>;
}

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
    body: '본문',
    state: 'sent',
    createdAtMs: BASE_MS,
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

function deletedBlock(): QuoteBlockModel {
  return {
    kind: 'deleted',
    targetId: 'orig-1',
    targetSeq: 4,
    authorMemberId: OTHER,
  };
}

const UNRESOLVED: QuoteBlockModel = {
  kind: 'unresolved',
  targetId: 'orig-1',
  targetSeq: null,
};

const SRC = (name: string) =>
  fs.readFileSync(
    path.resolve(__dirname, `../src/features/conversation/${name}`),
    'utf8',
  );

/** 주석을 걷어낸 코드만. 규율을 **설명하는** 주석이 단정에 걸리면 안 된다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

afterEach(cleanup);

describe('H-2 — 인용을 그리는 선이 accent 가 아니다', () => {
  it('규정선이 중성이고, accent 는 닿지 않는다', () => {
    // 블록이 실제로 서는 것부터 — 안 그려지는 화면에서 「accent 가 없다」는
    // 아무것도 증명하지 못하는 초록이다.
    render(<QuoteBlock block={readyBlock()} directory={DIRECTORY} />);
    expect(screen.getByTestId('quote-block')).toBeTruthy();
    // 규정선 값은 소스에서 확인한다 — 2px 짜리 `View` 에 testID 를 걸면 접근성
    // 트리에 낱말이 하나 더 얹히고, 이 행은 접근성 원소 하나여야 한다.
    const code = codeOnly(SRC('Quote.tsx'));
    expect(code).toMatch(/rule:\s*\{width:\s*2,\s*backgroundColor:\s*color\.textFaint\}/);
    expect(code).toMatch(/draftRule:.*color\.textFaint/);
    // accent 가 이 파일 어디에도 없다. 이 화면에서 accent 는 이미 보내기 버튼과
    // 내 반응 칩의 뜻이고, 세 번째 뜻을 갖게 두지 않는다.
    expect(code).not.toContain('color.accent');
  });

  it('그 중성이 실제로 보인다 — 웹이 컨트롤 테두리에 요구하는 ≥3:1', () => {
    // 「중성」만 지키고 `border`(#2a2f38) 를 쓰면 1.41:1 이라 선이 사라진다.
    expect(contrast(color.textFaint, color.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(color.border, color.bg)).toBeLessThan(3);
  });

  it('블록에 배경이 없다 — 고도 띠는 인용의 무게를 올린다', () => {
    // 첫 판의 배경은 `surface` on `bg` = 1.084:1 로 범위를 닫지 못했고,
    // 그 값은 **행의 눌림 색**이기도 했다. 웹도 같은 이유로 raised 배경을
    // 넣었다 되돌렸다.
    expect(contrast(color.surface, color.bg)).toBeLessThan(1.1);
    const code = codeOnly(SRC('Quote.tsx'));
    expect(code).not.toMatch(/block:\s*\{[^}]*backgroundColor/);
    // 눌림 피드백은 남는다 — 이제 **누를 때만** 나타난다.
    expect(code).toMatch(/blockPressed:\s*\{backgroundColor:\s*color\.surfacePressed\}/);
  });
});

describe('H-4 — 확정된 코드가 「보내는 중」과 같은 잉크가 아니다', () => {
  const ANSWER = ['설명 문장', '', '```sh', 'systemctl restart momo', '```'].join(
    '\n',
  );

  it('코드 글자가 본문과 같은 잉크다', () => {
    render(<MessageBody body={ANSWER} />);
    const style = flatten(screen.getAllByText(/systemctl/)[0].props.style);
    expect(style.color).toBe(color.text);
    // 그리고 그 값이 「보내는 중」의 값과 **다르다** — 첫 판은 같았다.
    expect(style.color).not.toBe(color.textMuted);
  });

  it('보내는 중이면 코드도 함께 흐려진다', () => {
    // 첫 판은 낙관적 메아리에서 산문만 흐려지고 코드는 안 흐려졌다 — 자기
    // 상태에 대해 두 가지를 말하는 행이었다.
    const {rerender} = render(<MessageBody body={ANSWER} />);
    const bright = flatten(screen.getAllByText(/systemctl/)[0].props.style);
    rerender(<MessageBody body={ANSWER} muted />);
    const dim = flatten(screen.getAllByText(/systemctl/)[0].props.style);
    expect(bright.color).toBe(color.text);
    expect(dim.color).toBe(color.textMuted);
  });

  it('N-1 — 코드 상자 배경이 토큰이고, 앱 배경보다 **위**다', () => {
    const code = codeOnly(SRC('MessageBody.tsx'));
    expect(code).not.toContain('#0b0d11');
    // 웹은 한 단 올린다(`bg-surface-hover`). 폰의 그 한 단이 `surface` 다.
    expect(luminance(color.surface)).toBeGreaterThan(luminance(color.bg));
    // 그 위에서 코드 글자가 AA 를 넘는다(구 배경에서는 textFaint 가 4.02:1 이었다).
    expect(contrast(color.text, color.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(color.textMuted, color.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('N-2 — 간격이 스케일 위에 있다', () => {
  it('대화 표면에 스케일 밖 간격이 없다', () => {
    const scale = new Set<number>(Object.values(space));
    for (const file of ['Quote.tsx', 'MessageBody.tsx']) {
      const code = codeOnly(SRC(file));
      // `gap`·`marginTop`·`marginBottom` 의 숫자 리터럴만 본다. `width: 2`(규정선
      // 두께)나 `lineHeight` 는 간격 스케일의 대상이 아니다.
      const offScale = [...code.matchAll(/\b(gap|marginTop|marginBottom):\s*(\d+)/g)]
        .filter(m => !scale.has(Number(m[2])))
        .map(m => `${file} ${m[1]}: ${m[2]}`);
      expect(offScale).toEqual([]);
    }
  });
});

describe('M-3 — 같은 동사에 같은 계약', () => {
  it('시트 복사도 영수증을 낸다', async () => {
    render(
      <MessageRow
        message={message({body: '복사할 내용'})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={{
          myMemberId: SELF,
          onToggleReaction: async () => {},
          onEdit: async () => {},
          onDelete: async () => {},
        }}
      />,
    );
    const point = {
      nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
    };
    fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
    fireEvent(screen.getByTestId('message-press'), 'longPress');
    fireEvent.press(screen.getByTestId('sheet-copy'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('message-copy-receipt').props.children).toBe(
      '복사됨',
    );
  });

  it('두 복사가 같은 시간을 쓴다 — 한 상수에서', () => {
    const body = codeOnly(SRC('MessageBody.tsx'));
    const row = codeOnly(SRC('MessageRow.tsx'));
    expect(body).toContain('COPY_RECEIPT_MS');
    expect(row).toContain('COPY_RECEIPT_MS');
    // 어느 쪽도 자기 숫자를 들고 있지 않다.
    expect(body).not.toMatch(/setTimeout\([^)]*1_500\)/);
    expect(row).not.toMatch(/setTimeout\([^)]*1_500\)/);
  });
});

describe('H-5 — 실패가 아닌 것을 실패로 말하지 않는다', () => {
  const SCREEN = fs.readFileSync(
    path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'),
    'utf8',
  );
  const code = codeOnly(SCREEN);

  it('점프 고지가 danger 상자를 쓰지 않는다', () => {
    // 사람이 인용을 눌렀고, 원본은 존재하며, 아직 안 불러왔을 뿐이다. 빨간
    // 상자(`failure` = dangerSurface + dangerBorder)는 「내가 뭔가 잘못했다」를
    // 말한다. `atoms` 에 이 경우를 위한 컴포넌트가 이미 있었다.
    // 두 고지가 **둘 다** 사실 진술이다. 인용 점프 고지만 고치면 M1 이 세운
    // 「같은 사실을 두 모양으로 말하지 않는다」가 깨진다.
    for (const id of ['quote-jump-missed', 'anchor-missed']) {
      const at = code.indexOf(`testID="${id}"`);
      expect(at).toBeGreaterThan(-1);
      const block = code.slice(Math.max(0, at - 240), at + 40);
      expect(block).toContain('NoticeBlock');
      expect(block).not.toContain('FailureBanner');
    }
    // 그리고 이 화면에는 `FailureBanner` 를 쓰는 자리가 더 이상 없다.
    expect(code).not.toMatch(/<FailureBanner/);
  });

  it('닫는 길이 있고, 점프가 성공하면 스스로도 물러난다', () => {
    // 첫 판은 채널 이동이나 다음 점프까지 남았다.
    expect(code).toMatch(/onDismiss=\{clearJumpNotice\}/);
    expect(code).toMatch(/onJumpLanded=\{clearJumpNotice\}/);
    // 그리고 목록이 실제로 그 신호를 낸다.
    const timeline = codeOnly(
      fs.readFileSync(
        path.resolve(__dirname, '../src/features/conversation/Timeline.tsx'),
        'utf8',
      ),
    );
    expect(timeline).toContain('onJumpLanded?.()');
  });

  it('한 덩이 문장이 아니라 무슨 일 + 무엇을 하면 되는지로 나뉜다', () => {
    expect(code).toContain("headline: '인용한 원본은 이 대화의 더 위쪽에 있습니다'");
    expect(code).toContain("headline: '인용한 원본을 이 화면에서 찾지 못했습니다'");
  });
});

// =============================================================================
// U4-3 #1078 — 앱이 말하는 문장의 구분축
//
// 첫 판의 축은 `fontStyle:'italic'` + 한 급 흐린 회색이었다. 그런데 italic 은
// 한글에서 **무동작**이었고(기울기 차 0, 픽셀 확증), 남은 회색 한 단계의 크기는
// `textFaint`↔`textMuted` = **1.834:1** 뿐이었다. 게다가 `textFaint` 는 배경
// 대비 3.909:1 로 본문 AA 를 못 지났다 — 「잘 안 보이는 것」이 구분축을 겸하고
// 있었다.
//
// 축을 글자로 옮겼다(`appVoice.ts` 의 `※`). 아래 단정들은 그 축이 **서체·
// 팔레트·플랫폼 어디에도 기대지 않는다**는 것을 지킨다.
// =============================================================================

function DeletedRow(): React.JSX.Element {
  return (
    <MessageRow
      message={message({state: 'deleted'})}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={{
        myMemberId: SELF,
        onToggleReaction: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
      }}
    />
  );
}

describe('#1078 — 묘비·미해결의 구분축', () => {
  const APP_SENTENCE_FILES = ['Quote.tsx', 'MessageRow.tsx'];

  it('italic 이 되살아나면 빨갛다 — 한글에 무동작인 축을 다시 세우지 않는다', () => {
    for (const name of APP_SENTENCE_FILES) {
      expect(codeOnly(SRC(name))).not.toMatch(/fontStyle/);
    }
  });

  it('앱의 문장이 본문 AA 를 지난다 — 흐림이 구분을 겸하지 않는다', () => {
    render(<QuoteBlock block={deletedBlock()} directory={DIRECTORY} />);
    const tombstone = flatten(screen.getByTestId('quote-tombstone').props.style);
    expect(tombstone.color).toBe(color.textMuted);
    expect(contrast(String(tombstone.color), color.bg)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('축이 글자에 있다 — 부재를 말하는 세 문장 모두 표시를 단다', () => {
    const deleted = render(
      <QuoteBlock block={deletedBlock()} directory={DIRECTORY} />,
    );
    expect(deleted.getByTestId('quote-tombstone').props.children).toContain(
      APP_NOTE_MARK,
    );
    deleted.unmount();

    const unresolved = render(
      <QuoteBlock block={UNRESOLVED} directory={DIRECTORY} />,
    );
    expect(unresolved.getByTestId('quote-unresolved').props.children).toContain(
      APP_NOTE_MARK,
    );
    unresolved.unmount();

    const row = render(<DeletedRow />);
    expect(row.getByTestId('tombstone').props.children).toContain(
      APP_NOTE_MARK,
    );
  });

  it('같은 낱말이면 같은 모양이다 — 행의 묘비와 인용 안의 묘비', () => {
    const rowView = render(<DeletedRow />);
    const rowStyle = flatten(rowView.getByTestId('tombstone').props.style);
    const rowText = rowView.getByTestId('tombstone').props.children;
    rowView.unmount();

    const quoteView = render(
      <QuoteBlock block={deletedBlock()} directory={DIRECTORY} />,
    );
    const node = quoteView.getByTestId('quote-tombstone');
    const quoted = flatten(node.props.style);
    expect(node.props.children).toBe(rowText);
    expect(quoted.color).toBe(rowStyle.color);
    expect(quoted.fontSize).toBe(rowStyle.fontSize);
  });

  it('표시가 잘림 접미사와 겹치지 않는다 — 한 글자가 두 뜻을 갖지 않는다', () => {
    // `…` 는 이미 「인용문이 더 있다」를 뜻한다. 구분축이 그 글자를 빌리면
    // 「더 있다」와 「못 불러왔다」가 같은 모양이 된다.
    expect(APP_NOTE_MARK).not.toBe('…');
    expect(APP_NOTE_MARK).not.toContain('.');
    // 마크다운 문자도 아니다 — 우리 문장은 파서를 타지 않으므로, 마크업처럼
    // 생긴 표시는 「안 그려진 마크다운」으로 읽힌다(BL-1 의 실패 모양).
    expect(APP_NOTE_MARK).not.toMatch(/[*_`#[\]()>|~]/);
  });

  it('보조기술 라벨에는 표시가 없다 — 눈으로 훑을 때의 단서다', () => {
    expect(quoteAccessibilityPhrase(deletedBlock(), DIRECTORY)).not.toContain(
      APP_NOTE_MARK,
    );
    expect(quoteAccessibilityPhrase(UNRESOLVED, DIRECTORY)).not.toContain(
      APP_NOTE_MARK,
    );
    // 행 라벨도 마찬가지다. 이건 자동으로 참이 아니라 **`deleted` 플래그에서
    // 짓기 때문에** 참이다 — 화면 글자를 긁어 라벨을 만들었다면 표시가 딸려
    // 들어갔을 자리다.
    const row = render(<DeletedRow />);
    expect(
      String(row.getByTestId('message-row').props.accessibilityLabel),
    ).not.toContain(APP_NOTE_MARK);
    expect(
      String(row.getByTestId('message-row').props.accessibilityLabel),
    ).toContain('삭제된 메시지');
  });

  it('표시를 짓는 자리가 하나다 — 사이 공백이 자리마다 어긋나지 않는다', () => {
    for (const name of APP_SENTENCE_FILES) {
      // 문자를 손으로 박은 자리가 있으면 `appNote()` 를 우회한 것이다.
      expect(codeOnly(SRC(name))).not.toContain(APP_NOTE_MARK);
    }
  });
});
