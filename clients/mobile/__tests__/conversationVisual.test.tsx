import type {Message, RosterMember} from '@momo/core/lib/api';
import type {QuoteBlock as QuoteBlockModel} from '@momo/core/features/timeline/quote';
import {quoteDraftFor} from '@momo/core/features/timeline/quote';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {color, line, SAFE_GUTTER, space} from '../src/design/tokens';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {
  DayDivider,
  MessageRow,
  PendingRow,
  RecoveryDivider,
  rowPressedBackground,
  UnreadDivider,
} from '../src/features/conversation/MessageRow';
import {
  dividerText,
  recoveryDividerSegments,
  DIVIDER_LABEL_SIDE,
  DIVIDER_SPACE,
  DIVIDER_TONE,
  DIVIDER_TONE_SPEC,
  ROW_SPACE,
} from '@momo/core/features/timeline/divider';
import {APP_NOTE_MARK} from '../src/features/conversation/appVoice';
import {jumpMissedNotice} from '../src/features/conversation/jumpNotice';
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
    // 「중성」만 지키고 `border`(#34323b) 를 쓰면 1.43:1 이라 선이 사라진다.
    expect(contrast(color.textFaint, color.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(color.border, color.bg)).toBeLessThan(3);
  });

  it('블록에 배경이 없다 — 고도 띠는 인용의 무게를 올린다', () => {
    // 첫 판의 배경은 `surface` on `bg` 로 범위를 닫지 못했고, 그 값은 **행의 눌림
    // 색**이기도 했다. 웹도 같은 이유로 raised 배경을 넣었다 되돌렸다.
    //
    // 그 부족함을 여기서는 절대 문턱(1.1)으로 적고 있었다. #1164 가 두 표면을 웹 항
    // (`--surface`/`--surface-raised`)으로 정렬하면서 다크의 띠가 1.084 에서
    // 1.1001 이 됐고, 그 문턱은 폰이 자기 옛 값을 보고 그은 선이라 함께 무너졌다.
    // 재는 것을 관계로 되돌린다: 고도는 이 팔레트에서 **가장 조용한 구분**이고, 색을
    // 가진 가장 조용한 채움(착지 틴트)보다도 작다. 그만한 띠는 인용 블록이 자기
    // 표면을 갖는 근거가 되지 못한다. 실측 1.1001 < 1.1641.
    expect(contrast(color.surface, color.bg)).toBeLessThan(
      contrast(color.warnSurface, color.bg),
    );
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
  /** 이 기계를 타는 주어 전부. 늘어나면 여기 한 줄이고, 아래는 전부 따라온다. */
  const SUBJECTS = ['quote', 'pin', 'search', 'session'] as const;

  it('점프 고지가 danger 상자를 쓰지 않는다', () => {
    // 사람이 인용을 눌렀고, 원본은 존재하며, 아직 안 불러왔을 뿐이다. 빨간
    // 상자(`failure` = dangerSurface + dangerBorder)는 「내가 뭔가 잘못했다」를
    // 말한다. `atoms` 에 이 경우를 위한 컴포넌트가 이미 있었다.
    // 고지는 이제 **한 벌**이다 (#1196). 인용·고정·검색 진입·세션 앵커 넷이 같은
    // 착지 기계를 타므로 상자도 하나이고, 그래서 M1 이 세운 「같은 사실을 두
    // 모양으로 말하지 않는다」는 두 상자를 맞추는 일이 아니라 **한 상자로 합치는
    // 일**이 됐다. 검색 전용 배너(`anchor-missed`)는 그 합류로 사라졌다.
    {
      const at = code.indexOf('testID="jump-missed"');
      expect(at).toBeGreaterThan(-1);
      const block = code.slice(Math.max(0, at - 240), at + 40);
      expect(block).toContain('NoticeBlock');
      expect(block).not.toContain('FailureBanner');
    }
    expect(code).not.toContain('anchor-missed');
    // 그리고 이 화면에는 `FailureBanner` 를 쓰는 자리가 더 이상 없다.
    expect(code).not.toMatch(/<FailureBanner/);
  });

  it('닫는 길이 있고, 점프가 성공하면 스스로도 물러난다', () => {
    // 첫 판은 채널 이동이나 다음 점프까지 남았다.
    //
    // 닫기와 착지가 **다른 함수**인 것이 #1209 리뷰 Medium 의 수리다: 상자가
    // 「그 줄이 오면 데려간다」는 의도를 함께 들게 됐으므로 닫기는 문장만이
    // 아니라 그 의도도 무른다. 착지는 무를 것이 없다 — 이미 도착했다.
    expect(code).toMatch(/onDismiss=\{cancelJump\}/);
    expect(code).toMatch(/onJumpLanded=\{clearJumpNotice\}/);
    // 그리고 그 닫기가 실제로 기다림을 접는다. 이름만 갈라 두면 아무것도 아니다.
    const at = code.indexOf('const cancelJump');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 200)).toContain('setAwaitingJump(null)');
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
    for (const reason of ['older', 'unknown'] as const) {
      const notice = jumpMissedNotice(reason);
      expect(notice.headline).not.toBe('');
      expect(notice.detail).not.toBe('');
      expect(notice.headline).not.toBe(notice.detail);
    }
  });

  it('어디 있는지 아는 경우에만 「위쪽에 있다」고 단정한다', () => {
    // 라이브 프레임으로 온 인용에는 원본 `seq` 가 없다. 그때 「위에 있습니다」는
    // 거짓일 수 있다.
    expect(jumpMissedNotice('older').headline).toContain('위쪽');
    expect(jumpMissedNotice('unknown').headline).not.toContain('위쪽');
  });

  it('화면이 그 문장을 손으로 다시 적지 않는다 — 하네스와 갈라지지 않게', () => {
    // 문장이 두 벌이면 사진이 배송되는 화면과 다른 말을 하게 된다.
    //
    // #1193 에서 인자가 하나 늘었다(주어). 문장이 **어디 사는가**는 그대로라
    // 단정도 그대로이되, 호출 형태를 통째로 베끼는 대신 네 문장이 화면에
    // 없다는 것으로 잰다 — 그쪽이 이 검사가 실제로 지키려던 것이다.
    expect(code).toContain('jumpMissedNotice(reason,');
    for (const reason of ['older', 'unknown'] as const) {
      for (const subject of SUBJECTS) {
        expect(code).not.toContain(jumpMissedNotice(reason, subject).headline);
      }
    }
  });

  // #1193 — 「대화로」를 누른 사람은 인용을 누른 적이 없다.
  // #1196 — 고정을 누른 사람도, 검색 결과를 누른 사람도 마찬가지다.
  it('주어가 넷으로 갈린다 — 넷은 서로 다른 것을 찾고 있다', () => {
    const headlines = SUBJECTS.map(
      subject => jumpMissedNotice('unknown', subject).headline,
    );
    // 넷 다 다른 문장이다. 하나라도 겹치면 그 화면은 남의 낱말로 말하고 있다.
    expect(new Set(headlines).size).toBe(SUBJECTS.length);
    // 「인용」은 인용의 것이다.
    for (const subject of SUBJECTS) {
      const headline = jumpMissedNotice('unknown', subject).headline;
      expect(headline.includes('인용')).toBe(subject === 'quote');
    }
    // 무엇을 하면 되는지는 같은 사실이라 같은 문장이다.
    const details = SUBJECTS.map(
      subject => jumpMissedNotice('unknown', subject).detail,
    );
    expect(new Set(details).size).toBe(1);
  });

  // 셋은 seq 를 아는 주어라 「더 위쪽에 있습니다」에 도달할 길이 **있다**. 그
  // 갈래를 지우면 아는 것을 모른다고 말하게 된다 (N1 의 반대편).
  it('seq 를 아는 주어 셋은 두 갈래를 갖는다', () => {
    for (const subject of ['quote', 'pin', 'search'] as const) {
      expect(jumpMissedNotice('older', subject).headline).toContain('위쪽');
      expect(jumpMissedNotice('unknown', subject).headline).not.toContain('위쪽');
    }
  });

  // 리뷰 N1 — 배송되지 않는 문구를 들고 있지 않는다. 세션 앵커는 seq 를 모르므로
  // 「더 위쪽에 있습니다」에 도달할 길이 없고, 그러면 그 문장은 없어야 한다.
  it('세션 주어는 말할 자격이 없는 문장을 만들지 않는다', () => {
    for (const reason of ['older', 'unknown'] as const) {
      expect(jumpMissedNotice(reason, 'session').headline).not.toContain('위쪽');
    }
    expect(jumpMissedNotice('older', 'session')).toEqual(
      jumpMissedNotice('unknown', 'session'),
    );
  });

  // 그리고 하네스가 그 문장을 **사진으로** 찍는다 (리뷰 M3). 문장이 코드에만
  // 있으면 다음 리뷰는 배송되는 화면이 아니라 소스를 읽게 된다.
  it('네 주어의 문장이 모두 측정 표면에 서 있다', () => {
    const surfaces = codeOnly(
      fs.readFileSync(path.resolve(__dirname, '../measure/surfaces.tsx'), 'utf8'),
    );
    expect(surfaces).toContain("jumpMissedNotice('unknown', 'session')");
    expect(surfaces).toContain('jump-missed-session');
    // #1196 — 새 주어 둘도 사진에 든다. 코드에만 있는 문장은 다음 리뷰에게
    // 소스를 읽으라는 말이고, 그것이 M3 이 없앤 드리프트다.
    for (const subject of ['pin', 'search'] as const) {
      expect(surfaces).toContain(`jumpMissedNotice('older', '${subject}')`);
      expect(surfaces).toContain(`jump-missed-${subject}`);
    }
  });

  // 리뷰 N-b — 한글 문장을 낱말 가운데서 끊지 않는다. 상자가 드는 것은 언제나
  // 완성된 문장이므로 제목과 설명 **둘 다** 그 규칙을 받는다.
  it('고지 상자가 어절 우선 줄바꿈을 쓴다', () => {
    const atoms = codeOnly(
      fs.readFileSync(path.resolve(__dirname, '../src/design/atoms.tsx'), 'utf8'),
    );
    const at = atoms.indexOf('export function NoticeBlock');
    expect(at).toBeGreaterThan(-1);
    const block = atoms.slice(at, atoms.indexOf('export function', at + 10));
    expect(
      block.match(/lineBreakStrategyIOS="hangul-word"/g) ?? [],
    ).toHaveLength(2);
  });
});

// =============================================================================
// U4-3 #1078 — 앱이 말하는 문장의 구분축
//
// 첫 판의 축은 `fontStyle:'italic'` + 한 급 흐린 회색이었다. 그런데 italic 은
// 한글에서 **무동작**이었고(기울기 차 0, 픽셀 확증), 남은 회색 한 단계의 크기는
// `textFaint`↔`textMuted` = **1.785:1** 뿐이었다. 게다가 `textFaint` 는 배경
// 대비 3.562:1 로 본문 AA 를 못 지났다 — 「잘 안 보이는 것」이 구분축을 겸하고
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

// =============================================================================
// U4-3 #1079 — 싼 다듬기와, 사진이 거짓말하지 않게 하는 장치
// =============================================================================

describe('#1079 N-1 — 같은 동사에 한 이름', () => {
  // 규칙을 발명한 것이 아니라 **이미 이 앱을 지배하던 것**을 적용했다: 액션은
  // `~기` 서술형이다(답글 달기 · 인용해서 답하기 · 고치기 · 지우기 · 닫기 ·
  // 스레드 열기 · 링크 열기 · 다시 보내기 · 오류 닫기). 복사만 갈라져 있었다.
  const FILES = ['MessageBody.tsx', 'MessageRow.tsx', 'MessageActionSheet.tsx'];

  it('복사를 부르는 이름이 하나다 — 명사형이 남아 있으면 빨갛다', () => {
    for (const name of FILES) {
      const code = codeOnly(SRC(name));
      // 「복사」 뒤에 「하기」도 「됨」도 안 오는 자리가 있으면 갈라진 것이다.
      expect(code).not.toMatch(/'[^']*복사'/);
      expect(code).not.toMatch(/"[^"]*복사"/);
    }
  });

  it('이름은 서술형, 영수증은 완료형 — 둘은 다른 종류의 문장이다', () => {
    const view = render(<MessageBody body={'```sh\necho hi\n```'} />);
    const button = view.getByTestId('code-copy');
    expect(String(button.props.accessibilityLabel)).toMatch(/하기$/);
    expect(within(button).getByText(/복사/).props.children).toMatch(/하기$/);
  });

  it('시트와 코드 상자가 한 화면에서 같은 낱말을 쓴다', () => {
    // 이 둘은 마크다운 답 하나에서 **동시에** 만날 수 있는 두 문이다.
    const sheet = codeOnly(SRC('MessageActionSheet.tsx'));
    expect(sheet).toContain('COPY_MESSAGE_ACTION_LABEL');
    expect(codeOnly(SRC('MessageBody.tsx'))).toContain('복사하기');
  });
});

describe('#1079 M-4 — 마커 칸이 불릿과 숫자에 각각 맞는다', () => {
  function list(body: string) {
    return within(render(<MessageBody body={body} />).getByTestId('message-list'));
  }

  it('불릿은 글자가 아니라 도형이다 — 점의 크기·위치가 우리 값이어야 한다', () => {
    // 칸을 좁히면 빈칸은 줄지만(17.0 → 10.0pt), 점 자체의 폭과 자기 advance
    // 안에서의 위치는 여전히 서체가 정한다(잉크가 2.0~4.7pt 에 앉는다). 도형은
    // 셋 다 우리 값이다 — 실측 빈칸 8.0pt.
    expect(list('- 하나').queryByText('•')).toBeNull();
    const cell = flatten(list('- 하나').getByTestId('list-bullet').props.style);
    expect(cell.width).toBe(10);
  });

  it('숫자 칸은 두 자리 + 마침표만큼이고 오른쪽 정렬이다', () => {
    const marker = flatten(list('9. 아홉\n10. 열').getByText('9.').props.style);
    expect(marker.minWidth).toBe(22);
    // 마침표가 한 줄에 서야 9번과 10번의 본문 시작점도 한 줄에 선다.
    expect(marker.textAlign).toBe('right');
  });

  it('불릿 칸이 숫자 칸보다 좁다 — 하나의 값은 둘 다에게 틀렸다', () => {
    const cell = flatten(list('- 하나').getByTestId('list-bullet').props.style);
    const marker = flatten(list('9. 아홉\n10. 열').getByText('9.').props.style);
    expect(Number(cell.width)).toBeLessThan(Number(marker.minWidth));
  });
});

describe('#1079 — 사진이 배송되는 화면과 갈라지지 않게', () => {
  const HARNESS = fs.readFileSync(
    path.resolve(__dirname, '../measure/surfaces.tsx'),
    'utf8',
  );

  it('리뷰가 지목한 네 표면이 하네스에 선다', () => {
    // 사진이 없어서 SKIPPED 로 남았던 것들이다. 케이스가 사라지면 다음 배치가
    // 같은 자리에서 같은 이유로 막힌다.
    for (const name of ['typing-empty', 'jump-missed', 'row-pressed', 'sheet']) {
      expect(HARNESS).toContain(`case '${name}'`);
    }
  });

  it('하네스가 문장과 색을 베껴 적지 않는다 — 같은 심볼을 든다', () => {
    const code = codeOnly(HARNESS);
    expect(code).toContain('jumpMissedNotice(');
    expect(code).not.toContain('인용한 원본은 이 대화의');
    expect(code).toContain('rowPressedBackground(color)');
    // 색을 리터럴로 박으면 화면이 바뀌어도 사진은 옛말을 계속 한다.
    expect(code).not.toMatch(/backgroundColor: '#/);
  });

  it('N-7 — 인용 fixture 의 원본 저자가 타인이다', () => {
    // 자기 말을 자기가 인용하는 화면은 이 기능이 쓰이는 모양이 아니고, 인용
    // 머리줄이 무슨 일을 하는지도 사진에서 안 보인다.
    const code = codeOnly(HARNESS);
    expect(code).toContain('const OTHER =');
    expect(code).not.toMatch(/authorMemberId: SELF,\s*\n\s*\}\)\}/);
  });

  it('M-2 — 눌린 행과 코드 상자가 같은 값이라는 사진의 전제를 잠근다', () => {
    // 이 사진이 보여 주려는 것은 「눌리면 상자가 사라진다」이고, 그 전제는
    // 두 채움이 같은 색이라는 것이다. 전제가 깨지면 사진이 거짓말하게 되므로
    // 여기서 값으로 붙잡는다. (값 공간을 가르는 것은 U2 소관 — 범위 밖.)
    const body = render(<MessageBody body={'```sh\necho hi\n```'} />);
    const wrap = flatten(body.getByTestId('message-code-block').props.style);
    // 팔레트를 **인자로** 넘긴다 (U2). 이 스위트가 그리는 것은 다크 스킴이고
    // (`jest.setup.js`), 눌린 채움도 같은 스킴에서 물어야 같은 질문이 된다.
    const pressed = rowPressedBackground(color);
    expect(wrap.backgroundColor).toBe(pressed);
    expect(contrast(String(wrap.backgroundColor), pressed)).toBe(1);
  });
});

describe('#1079 M-7 — 사진 속 시트가 배송되는 시트와 같은 줄 수여야 한다', () => {
  const HARNESS = fs.readFileSync(
    path.resolve(__dirname, '../measure/surfaces.tsx'),
    'utf8',
  );

  it('하네스 시트가 모든 액션을 건넨다 — 안 그러면 짧은 시트를 찍는다', () => {
    // `MessageActionSheet` 은 `availability.quote && onQuote` 로 줄을 그린다.
    // 콜백이 없으면 그 줄이 사라지고, 큰 글자에서 넘침을 보려던 사진이 하필
    // 넘치지 않는 시트를 찍게 된다(AX5 캡처가 이것을 드러냈다).
    const code = codeOnly(HARNESS);
    for (const prop of [
      'onQuote=',
      'onCopy=',
      // 이슈 #1112 — 같은 함정, 같은 잠금. `availability.pin && onPin` 이라
      // 콜백이 빠지면 사진 속 시트가 또 배송본보다 한 줄 짧아진다.
      'onPin=',
      'onReply=',
      'onEdit=',
      'onDelete=',
    ]) {
      expect(code).toContain(prop);
    }
  });
});

// =============================================================================
// 이슈 #1112 — 고정이 하네스에 선다
//
// 낱말이 상태를 따라 뒤집히는 것은 **두 장**으로만 보인다(시트가 `Modal` 이라 한
// 프레임에 둘을 세울 수 없다). 그래서 두 케이스가 모두 있어야 하고, 목록은
// 채워진 판과 빈 판이 모두 있어야 한다 — 「아직 아무 말도 못 한 화면」과 「할 말이
// 없다고 말하는 화면」은 사진에서만 갈린다.
// =============================================================================

describe('#1112 — 고정 표면이 하네스에 선다', () => {
  const HARNESS = fs.readFileSync(
    path.resolve(__dirname, '../measure/surfaces.tsx'),
    'utf8',
  );

  it('고정 시트 두 판과 목록 두 판이 케이스로 있다', () => {
    for (const name of ['sheet', 'pin-sheet', 'pin-list', 'pin-list-empty']) {
      expect(HARNESS).toContain(`case '${name}'`);
    }
  });

  it('하네스가 고정의 낱말을 베껴 적지 않는다 — 화면이 코어에서 든다', () => {
    const code = codeOnly(HARNESS);
    // 라벨을 리터럴로 박으면 코어가 바뀌어도 사진은 옛말을 계속 한다.
    expect(code).not.toContain('고정 해제하기');
    expect(code).not.toContain('고정하기');
    // 대신 상태를 넘긴다: 시트가 `pinActionLabel` 로 낱말을 고른다.
    expect(code).toContain('pinned={pinned}');
  });
});

// =============================================================================
// U4-4 M2 (#1083) — 시간과 경계
//
// 감사 H-3: 그룹 창이 **5분**인데(`AUTHOR_GROUP_WINDOW_MS`) 그 안 개별 발화의
// 시각이 화면 어디에도 없었다. 그런데 **접근성 라벨에는 모든 행의 시각이 있다** —
// 로터는 아는 것을 눈은 몰랐다. 웹은 hover 로 주지만 폰에는 hover 가 없으므로
// 선택지는 「항상」 아니면 「전혀」뿐이고, 「전혀」가 고장난 쪽이었다.
// =============================================================================

describe('#1083 H-3 — 모든 행이 자기 시각을 말한다', () => {
  /** 시각은 접근성에서 숨겨져 있으므로 기본 쿼리가 건너뛴다 — 그것이 설계다. */
  const HIDDEN = {includeHiddenElements: true} as const;

  function rowAt(startsGroup: boolean) {
    return render(
      <MessageRow
        message={message({body: '재시작하면 seq 는 이어집니다'})}
        startsGroup={startsGroup}
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
  }

  it('연속 행에도 시각이 있다 — 예전에는 그룹 머리에만 있었다', () => {
    expect(rowAt(false).getByTestId('row-time', HIDDEN)).toBeTruthy();
  });

  it('시각이 **한 칸**에 있다 — 머리 행과 연속 행이 같은 자리다', () => {
    // 두 자리에 있으면 눈이 매 줄 어느 쪽을 볼지 다시 정해야 한다. 한 칸이면
    // 그 칸을 **안 보기로** 정할 수 있다.
    //
    // ## 이 단정이 「칸」으로 좁아진 이유 (u44 리뷰 M-2)
    //
    // 첫 판은 두 스타일 객체가 **통째로** 같기를 요구했다. 그 요구는 칸이 하는
    // 일보다 넓다: 칸을 만드는 것은 x·폭·정렬·잉크이고, `lineHeight` 는 칸이
    // 아니라 **그 글자가 어느 줄 옆에 앉는가**를 정한다. 그리고 그 줄이 두
    // 경우에 다르다 — 그룹 머리의 첫 줄은 작성자 줄(13pt)이고 연속 행의 첫
    // 줄은 본문(16pt)이다. 하나로 묶어 두었더니 시각이 작성자 이름보다 2~3pt
    // 아래에 앉았고(리뷰 실측), 그것이 M-2 다.
    //
    // 그래서 칸의 정체성은 아래 네 값이 지고, 줄 상자는 **다르기를** 요구한다.
    const head = flatten(rowAt(true).getByTestId('row-time', HIDDEN).props.style);
    const cont = flatten(rowAt(false).getByTestId('row-time', HIDDEN).props.style);
    for (const key of ['right', 'width', 'textAlign', 'color', 'fontSize', 'top']) {
      expect([key, head[key]]).toEqual([key, cont[key]]);
    }
    expect(head.position).toBe('absolute');
    expect(head.textAlign).toBe('right');
  });

  it('M-2 — 시각의 줄 상자가 자기 옆에 선 줄을 따라간다', () => {
    const head = flatten(rowAt(true).getByTestId('row-time', HIDDEN).props.style);
    const cont = flatten(rowAt(false).getByTestId('row-time', HIDDEN).props.style);
    // 그룹 머리 = 머리줄, 연속 행 = 본문 줄. 둘 다 **스케일 위의 이름**이고,
    // 리뷰가 잡아낸 스케일 밖 숫자(22 를 손으로 적어 둔 것)는 이제 없다.
    expect(head.lineHeight).toBe(line.head);
    expect(cont.lineHeight).toBe(line.body);
    // 그리고 작성자 이름이 **같은 이름의 상자**를 든다 — 두 조각이 한 줄로
    // 읽히는 근거가 그것이다(폰에는 컨테이너를 건너뛰는 baseline 정렬이 없다).
    const author = flatten(rowAt(true).getByText('김인턴').props.style);
    expect(author.lineHeight).toBe(head.lineHeight);
  });

  it('M-2 — 시각의 y 가 그릇의 위쪽 패딩과 **같은 곳에서** 온다', () => {
    // 절대 배치 자식은 부모의 패딩을 건너뛰므로, 첫 줄의 y 는 `paddingTop` 이고
    // 시각의 y 는 `top` 이다. 두 숫자가 따로 적혀 있으면(4 대 6) 그 차이가 그대로
    // 어긋남이 된다 — 그것이 M-2 의 절반이었다.
    const view = rowAt(true);
    const inner = flatten(view.getByTestId('message-press').props.style);
    const time = flatten(view.getByTestId('row-time', HIDDEN).props.style);
    expect(Number(time.top)).toBe(Number(inner.paddingVertical));
  });

  it('세로를 한 픽셀도 안 쓴다 — 줄을 세우면 5연발에 80pt 가 사라진다', () => {
    expect(
      flatten(rowAt(false).getByTestId('row-time', HIDDEN).props.style).position,
    ).toBe('absolute');
  });

  it('본문이 시각 밑으로 흘러들지 않는다', () => {
    // 이 단정은 예전에 `continuationBody`(본문에 걸린 여백)를 소스에서 찾았다.
    // 그 여백이 **본문에만** 있었다는 것이 M-1 이 말한 구멍이므로, 이제
    // 그려진 값으로 그릇을 본다 — 아래 M-1 절이 나머지 첫 자식들을 센다.
    const view = rowAt(false);
    const inner = flatten(view.getByTestId('message-press').props.style);
    const time = flatten(view.getByTestId('row-time', HIDDEN).props.style);
    expect(Number(inner.paddingRight)).toBe(
      SAFE_GUTTER + Number(time.width) + space.sm,
    );
    expect(codeOnly(SRC('MessageRow.tsx'))).not.toContain('continuationBody');
  });

  it('보조기술이 같은 시각을 두 번 읽지 않는다', () => {
    const view = rowAt(false);
    const time = view.getByTestId('row-time', HIDDEN);
    // 기본 쿼리로는 안 찾힌다 — 그것 자체가 「로터가 안 만난다」의 뜻이다.
    expect(view.queryByTestId('row-time')).toBeNull();
    expect(time.props.accessibilityElementsHidden).toBe(true);
    expect(time.props.importantForAccessibility).toBe('no-hide-descendants');
    // 그래도 라벨에는 있다 — 눈에서 뺀 것이 아니라 눈에 **더한** 것이다.
    expect(
      String(view.getByTestId('message-row').props.accessibilityLabel),
    ).toMatch(/\d\d:\d\d/);
  });

  it('시각이 본문 AA 를 지난다 — 뜻을 나르는 글자다', () => {
    const style = flatten(rowAt(false).getByTestId('row-time', HIDDEN).props.style);
    expect(style.color).toBe(color.textMuted);
    expect(contrast(String(style.color), color.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('그룹 머리의 시각도 같은 밝기다 — 덜 중요한 쪽이 더 밝지 않게', () => {
    const source = codeOnly(SRC('MessageRow.tsx'));
    expect(source).not.toMatch(/time: \{fontSize: font\.meta, color: color\.textFaint\}/);
  });
});

// =============================================================================
// #1092 M-1 — 시각 칸을 예약하는 것은 「행의 첫 줄」이다
//
// 예약이 **자식**(작성자 줄과, 연속 행일 때의 본문)에 걸려 있었다. 그래서 행의 첫
// 흐름 자식이 답글 표식·인용·묘비·아티팩트 카드·승인 카드일 때는 예약이 없었고,
// 리뷰는 저장소가 커밋한 캡처에서 그 겹침을 읽어 냈다(`...문서에⁷젝³`).
//
// 그 구멍의 성질이 요점이다: **자식 종류가 늘 때마다 같은 구멍이 다시 생긴다.**
// 그래서 이 절은 「이 여섯 경우가 맞다」를 세지 않고 **그릇 하나가 진다**를 센다 —
// 앞으로 무엇이 더 들어와도 같은 여백 밑으로 들어오게.
// =============================================================================

describe('#1092 M-1 — 예약은 자식이 아니라 그릇이 진다', () => {
  const HIDDEN = {includeHiddenElements: true} as const;

  /** 이 행에서 **첫 흐름 자식**이 무엇인가로 갈리는 경우들. */
  const LEADS: {name: string; props: Partial<React.ComponentProps<typeof MessageRow>>}[] = [
    {name: '본문', props: {message: message({body: '재시작하면 seq 는 이어집니다'})}},
    {
      name: '답글 표식',
      props: {
        message: message({rootId: 'root-1'} as never),
        replyParent: message({id: 'root-1', body: '원본'}),
      },
    },
    {name: '인용', props: {quote: readyBlock()}},
    {name: '묘비', props: {message: message({state: 'deleted'})}},
    {
      name: '승인 카드',
      props: {
        message: message({
          type: 'approval_request',
          body: '툴 호출 승인',
          props: {
            approval_id: 'ap-1',
            title: 'github.search_issues 실행 허가',
            approval_status: 'pending',
          },
        } as never),
      },
    },
    {
      name: '아티팩트 카드',
      props: {
        message: message({
          type: 'artifact',
          body: '',
          props: {
            artifact_kind: 'pr',
            title: 'PR #12',
            url: 'https://github.com/example/repo/pull/12',
          },
        } as never),
      },
    },
    {name: '내용 없는 메시지', props: {message: message({body: ''})}},
  ];

  function renderLead(
    props: Partial<React.ComponentProps<typeof MessageRow>>,
  ) {
    return render(
      <MessageRow
        message={message()}
        startsGroup={false}
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        {...props}
      />,
    );
  }

  it.each(LEADS)('첫 자식이 $name 이어도 시각 칸이 비어 있다', ({props}) => {
    const view = renderLead(props);
    const inner = flatten(view.getByTestId('message-press').props.style);
    const time = flatten(view.getByTestId('row-time', HIDDEN).props.style);
    // 시각은 화면 오른쪽에서 `right` 만큼 떨어져 서고 폭이 `width` 다. 흐름
    // 자식의 오른쪽 끝은 그보다 최소 `space.sm` 더 안쪽이어야 한다 — 그렇지
    // 않으면 그 자식이 시각 밑으로 흘러든다.
    expect(Number(inner.paddingRight)).toBeGreaterThanOrEqual(
      Number(time.right) + Number(time.width) + space.sm,
    );
  });

  it('예약이 `startsGroup` 에 따라 달라지지 않는다 — 시각은 두 경우 다 선다', () => {
    // 예전 예약은 연속 행에만 있었다(`startsGroup ? undefined : ...`). 시각은
    // 두 경우 다 서므로 예약도 두 경우 다 서야 한다.
    const head = flatten(
      renderLead({startsGroup: true}).getByTestId('message-press').props.style,
    );
    const cont = flatten(
      renderLead({startsGroup: false}).getByTestId('message-press').props.style,
    );
    expect(head.paddingRight).toBe(cont.paddingRight);
  });

  it('예약이 소스에서 한 곳뿐이다 — 자식마다 걸면 다음 자식이 또 빠진다', () => {
    const code = codeOnly(SRC('MessageRow.tsx'));
    const reservations = code.match(/TIME_COLUMN \+ space\.sm/g) ?? [];
    expect(reservations).toHaveLength(1);
    expect(code).toMatch(
      /rowTimeReserve: \{paddingRight: SAFE_GUTTER \+ TIME_COLUMN \+ space\.sm\}/,
    );
  });

  it('카드가 시각을 덮지 않는다 — 시각이 흐름 자식보다 **뒤에** 칠해진다', () => {
    // RN 에는 z-index 기본값이 없다: 형제는 쓰인 순서대로 칠해진다. 불투명한
    // `styles.card` 배경을 든 카드가 시각보다 뒤에 있으면 시각이 조용히
    // 사라진다 — 자리를 비워도 칠이 덮으면 같은 결함이다.
    const code = codeOnly(SRC('MessageRow.tsx'));
    expect(code.indexOf('testID="row-time"')).toBeGreaterThan(
      code.indexOf('<AgentCard'),
    );
    expect(code.indexOf('testID="row-time"')).toBeGreaterThan(
      code.indexOf('<ArtifactCard'),
    );
    // 그리고 런타임에서도 마지막 형제다 — 소스 순서만 보면 조건부 분기가
    // 순서를 뒤집는 날을 못 잡는다.
    const view = renderLead(LEADS[4].props);
    const kids = view
      .getByTestId('message-press')
      .children.filter((kid: unknown) => {
        // `Pressable` 이 스스로 덧붙이는 개발용 오버레이. 우리가 쓴 자식이 아니다.
        if (typeof kid === 'string') return true;
        const type = (kid as {type?: {name?: string}}).type;
        return type?.name !== 'PressabilityDebugView';
      });
    const last = kids[kids.length - 1];
    expect(typeof last === 'string' ? last : last.props.testID).toBe(
      'row-time',
    );
  });

  it('상태 칩이 시각 칸 밖에 선다 — 카드가 예약 안으로 들어왔다', () => {
    // 승인 카드의 「승인 대기」 칩은 카드 오른쪽 위, 정확히 시각의 칸 자리에
    // 있다. 카드가 그릇의 예약을 함께 받으면 칩도 그 왼쪽으로 물러난다.
    const view = renderLead(LEADS[4].props);
    expect(view.getByTestId('agent-card')).toBeTruthy();
    const inner = flatten(view.getByTestId('message-press').props.style);
    const time = flatten(view.getByTestId('row-time', HIDDEN).props.style);
    expect(Number(inner.paddingRight)).toBeGreaterThanOrEqual(
      Number(time.right) + Number(time.width) + space.sm,
    );
  });

  it('시각이 없는 행은 자리를 비우지 않는다 — 없는 것을 위한 예약은 여백일 뿐', () => {
    // `WorkingRow` 에는 시각이 없다. 예약을 `rowInner` 자체에 넣었다면 이 행도
    // 42pt 를 잃었을 것이다.
    const code = codeOnly(SRC('MessageRow.tsx'));
    expect(code).not.toMatch(
      /rowInner: \{[^}]*paddingRight: SAFE_GUTTER \+ TIME_COLUMN/s,
    );
  });
});

describe('#1092 M-1 — 하네스가 그 경로를 실제로 세운다', () => {
  const HARNESS = fs.readFileSync(
    path.resolve(__dirname, '../measure/surfaces.tsx'),
    'utf8',
  );

  it('연속 승인 카드가 픽스처에 있다 — 가장 흔한 미캡처 경로였다', () => {
    // U4-4 의 픽스처는 승인 카드 셋 전부에 `startsGroup` 을 걸었다. 즉 타임라인이
    // 승인 카드를 둘 이상 보여 주는 경로는 **한 번도 촬영된 적이 없었고**, M-1 의
    // 겹침은 정확히 거기서 일어난다.
    expect(HARNESS).toContain("case 'row-lead'");
    expect(codeOnly(HARNESS)).toContain('startsGroup={false}');
  });
});

describe('#1083 — 아직 서버 시계가 없는 행은 시각을 지어내지 않는다', () => {
  it('보내는 중인 메아리는 시각 대신 「전송 중」을 든다', () => {
    // `Author` 가 시각을 들고 있을 때 낙관적 메아리도 **기기 시계**를 그렸다.
    // 그건 이 행의 머리말이 스스로 적은 규율("no seq and no clock")과 어긋나고,
    // 서버가 찍을 시각과 다를 수 있다. 시각이 행으로 옮겨가면서 이 행에는
    // 붙지 않게 됐고, 그 자리는 이미 「전송 중」이 갖고 있다.
    const view = render(
      <PendingRow
        pending={
          {
            clientMsgId: 'c1',
            channelId: 'ch',
            authorMemberId: OTHER,
            body: '보내는 중입니다',
            createdAtMs: BASE_MS,
            state: 'sending',
          } as never
        }
        startsGroup
        directory={DIRECTORY}
      />,
    );
    expect(view.getByTestId('pending-sending')).toBeTruthy();
    expect(
      view.queryByTestId('row-time', {includeHiddenElements: true}),
    ).toBeNull();
  });
});

describe('#1083 H-7(폰) — 그룹 안에서 메시지 경계가 보인다', () => {
  it('연속 행 세로 여백이 3pt 보다 크다', () => {
    // 한 사람이 연달아 쓴 다섯 줄이 한 덩이 문단으로 읽혔다. 시각이 오른쪽에
    // 표식을 만들고, 세로 여백이 그 둘을 함께 경계로 만든다.
    //
    // 소스 문자열이 아니라 **그려진 값**을 잰다: `paddingVertical: 3` 은 반응
    // 칩에도 있고, 그것까지 금지하면 이 단정은 자기가 무엇을 지키는지 모르는
    // 단정이 된다.
    const view = render(
      <MessageRow
        message={message()}
        startsGroup={false}
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    const inner = flatten(view.getByTestId('message-press').props.style);
    expect(Number(inner.paddingVertical)).toBeGreaterThan(3);
    // 값은 **코어가 정한다**. 두 행 사이에 실제로 남는 거리가 `withinGroup`
    // 이 되도록 절반씩 나눠 문다 — 웹은 같은 값을 위아래 패딩의 합으로 만든다.
    expect(Number(inner.paddingVertical) * 2).toBe(ROW_SPACE.withinGroup);
  });

  it('그룹 사이 여백이 그룹 안 여백보다 크다 — 아니면 경계가 뒤집힌다', () => {
    expect(ROW_SPACE.betweenGroups).toBeGreaterThan(ROW_SPACE.withinGroup);
    const head = render(
      <MessageRow
        message={message()}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    const outer = flatten(head.getByTestId('message-row').props.style);
    // 안쪽이 절반씩 물고 있으므로 차이만 더한다: 6+6=12(안), 6+6+6=18(사이).
    expect(
      Number(outer.marginTop) + ROW_SPACE.withinGroup,
    ).toBe(ROW_SPACE.betweenGroups);
  });
});

describe('#1083 H-4·M-2 — 구분선은 코어 판정을 소비한다', () => {
  it('오늘/어제를 말한다 — 절대 날짜를 읽고 오늘인지 계산하게 하지 않는다', () => {
    // **그려진 글자**를 본다. 첫 판은 `dividerText(dayDividerSegments(...))` 를
    // 단정했는데 그건 코어를 시험하는 것이지 이 화면을 시험하는 것이 아니다 —
    // 컴포넌트가 코어를 안 쓰도록 되돌려도 초록이었다(red proof 가 잡아냈다).
    const day = (atMs: number) =>
      within(
        render(<DayDivider atMs={atMs} nowMs={BASE_MS} />).getByTestId(
          'day-divider',
        ),
      );
    expect(day(BASE_MS).getByText('오늘')).toBeTruthy();
    expect(day(BASE_MS - 26 * 3_600_000).getByText('어제')).toBeTruthy();
    // 그리고 오래된 것은 절대 날짜로 돌아간다 — 「40일 전」은 날짜가 아니다.
    const old = day(BASE_MS - 40 * 24 * 3_600_000);
    expect(old.queryByText('오늘')).toBeNull();
    expect(old.queryByText('어제')).toBeNull();
    // 숫자 조각이 자기 `Text` 로 서 있다(자릿폭 고정을 걸어야 하므로).
    expect(old.getAllByText(/^\d+$/).length).toBeGreaterThanOrEqual(2);
  });

  it('보이는 글자와 읽히는 글자가 다르다 — 라벨은 절대 날짜를 함께 말한다', () => {
    // 「오늘」은 눈에는 가장 값싼 낱말이지만 귀에는 어느 날인지 알려주지 않는다.
    const view = render(<DayDivider atMs={BASE_MS} nowMs={BASE_MS} />);
    const label = String(
      view.getByTestId('day-divider').props.accessibilityLabel,
    );
    expect(label).toContain('오늘');
    expect(label).toMatch(/\d{4}년 \d{1,2}월 \d{1,2}일/);
  });

  it('라벨이 앞에 서고 rule 은 하나다 — 가운데 라벨은 글자 수만큼 움직인다', () => {
    const view = render(<DayDivider atMs={BASE_MS} nowMs={BASE_MS} />);
    const kids = view.getByTestId('day-divider').props.children;
    expect(DIVIDER_LABEL_SIDE).toBe('leading');
    // 양쪽 rule 은 라벨을 가운데 고정할 때만 뜻이 있다. 소스에 둘이 남아 있으면
    // 폰만 다시 가운데로 돌아간 것이다.
    const source = codeOnly(SRC('MessageRow.tsx'));
    expect(source).not.toMatch(
      /<View style=\{styles\.dividerLine\} \/>\s*\n\s*<DividerLabel/,
    );
    expect(kids).toBeTruthy();
  });

  it('숫자만 자릿폭을 고정한다 — 조사·단위가 함께 받으면 음절이 벌어진다', () => {
    const view = render(<UnreadDivider count={12} />);
    const figures = within(view.getByTestId('unread-divider'))
      .getAllByText(/^\d+$/)
      .map(node => flatten(node.props.style));
    expect(figures.length).toBeGreaterThan(0);
    for (const style of figures) {
      expect(style.fontVariant).toEqual(['tabular-nums']);
    }
  });

  it('세 구분선이 같은 여백이 아니다 — 날짜가 가장 큰 경계다', () => {
    const day = flatten(
      render(<DayDivider atMs={BASE_MS} nowMs={BASE_MS} />).getByTestId(
        'day-divider',
      ).props.style,
    );
    const unread = flatten(
      render(<UnreadDivider count={1} />).getByTestId('unread-divider').props
        .style,
    );
    expect(Number(day.paddingTop)).toBe(DIVIDER_SPACE.day.blockStart);
    expect(Number(unread.paddingTop)).toBe(DIVIDER_SPACE.marker.blockStart);
    expect(Number(day.paddingTop)).toBeGreaterThan(Number(unread.paddingTop));
  });

  it('구분선 글자가 본문 AA 를 지난다', () => {
    const view = render(<UnreadDivider count={1} />);
    const label = flatten(view.getByText(/새 메시지/).props.style);
    expect(contrast(String(label.color ?? color.textMuted), color.bg)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

// =============================================================================
// #1092 D-1 — 복구 구분선에서 두 클라가 같은 문장을 말한다
//
// 「(다시 읽음)」은 **이 파일 안에서** 이어 붙던 낱말이었다. 웹은 같은 사실을
// `data-source` 속성으로만 내보내 화면에는 한 글자도 없었다. 코어 `divider.ts` 가
// 존재하는 이유가 정확히 이것(*"각자 짓는 한 고쳐도 다시 벌어진다"*)인데, 모듈을
// 만든 그 커밋이 어휘 판정 하나를 로컬에 남겼다.
// =============================================================================

describe('#1092 D-1 — 복구 구분선의 낱말이 코어의 것이다', () => {
  const rendered = (source: 'replay' | 'backfill') =>
    within(
      render(<RecoveryDivider seq={4821} source={source} />).getByTestId(
        'recovery-divider',
      ),
    );

  it.each(['replay', 'backfill'] as const)(
    '%s — 화면 문장이 코어 조각과 **글자 하나까지** 같다',
    source => {
      // 이 단정이 잡는 것은 두 방향이다: 화면이 코어보다 더 말하거나(로컬 접합),
      // 덜 말하거나(웹의 현행). 둘 다 두 클라를 갈라놓는다.
      const expected = dividerText(recoveryDividerSegments(4821, source));
      expect(rendered(source).getByText(expected)).toBeTruthy();
    },
  );

  it('되읽은 구간만 그렇게 말한다 — 두 레일이 같은 문장이면 구분이 없다', () => {
    expect(
      rendered('backfill').queryByText(/다시 읽음/),
    ).not.toBeNull();
    expect(rendered('replay').queryByText(/다시 읽음/)).toBeNull();
  });

  it('낱말이 이 파일에 없다 — 있으면 다음 goal 에서 다시 갈라진다', () => {
    // 판정이 화면 파일에 남아 있으면 웹은 그것을 영영 모른다. 그 구멍이 D-1 이다.
    expect(codeOnly(SRC('MessageRow.tsx'))).not.toContain('다시 읽음');
  });
});

// =============================================================================
// U4-4 D-2 — 「경계를 그리는 색」이 우연이 아니라 계약이다
//
// 리뷰가 실측한 것: 안읽음 경계를 웹은 `--accent`(호박)로, 폰은 `color.warn`
// (그때 #d9a441)으로 그린다. 두 값이 그때도 닮아 보였지만 **계약이 아니었다** — 폰의
// `accent` 는 그 시점에 파랑(#3b6fd4)이라 이름으로는 대응조차 안 됐고, 어느 한쪽
// 팔레트를 손대는 날 경계가 조용히 갈라질 자리였다.
//
// 그리고 두 번 손댔다: #1155 가 폰 다크의 accent 가족을 웹 다크 항(#f0a850)으로,
// #1164 가 `warn` 을 웹 다크 항(#d4a72c)으로 정렬했다. 이름으로 대응했더라면 그날 이
// 경계가 파랑에서 호박으로 **뜻 없이** 옮겨갔을 것이다. 역할로 대응했으므로 아래
// 단정은 두 번 다 한 줄도 고치지 않았다 — 값이 움직여도 역할이 그대로면 이 표는
// 아무 말도 바꿀 필요가 없다. 그것이 이 설계가 실제로 산 것이다.
//
// 코어가 올린 것은 값이 아니라 **역할**이다(`DIVIDER_TONE`·`DIVIDER_TONE_SPEC`).
// 여기서 재는 것은 이 팔레트가 그 역할을 실제로 만족하는가이고, 그 판정은
// **그려진 트리에서** 한다 — U4-4R W-2 가 남긴 규율(가드는 실표를 봐야 한다).
// 값 자체는 이 배치에서 바뀌지 않았다. 바뀐 것은 그것이 우연이 아니게 된 것이다.
// =============================================================================

describe('D-2 — 구분선의 색이 코어가 정한 역할을 만족한다', () => {
  /** 라벨의 **바깥** `Text` — 안쪽 조각(`figure`)은 자릿폭만 들고 색은 없다. */
  const labelStyle = (
    view: ReturnType<typeof render>,
    testID: string,
    match: RegExp,
  ) =>
    flatten(within(view.getByTestId(testID)).getByText(match).props.style) as {
      color?: string;
    };

  const ruleStyle = (
    view: ReturnType<typeof render>,
    testID: string,
  ): {backgroundColor?: string} => {
    // rule 은 낱말이 없는 `View` 다. 형제 중 배경색을 든 것 하나.
    const children: unknown[] = view.getByTestId(testID).children;
    for (const child of children) {
      if (typeof child === 'string') continue;
      const style = flatten(
        (child as {props?: {style?: unknown}}).props?.style,
      ) as {backgroundColor?: string};
      if (style.backgroundColor !== undefined) return style;
    }
    return {};
  };

  it('세 구분선이 코어의 표대로 역할을 나눠 갖는다', () => {
    expect(DIVIDER_TONE.day).toBe('quiet');
    expect(DIVIDER_TONE.recovery).toBe('quiet');
    expect(DIVIDER_TONE.unread).toBe('boundary');
  });

  it('boundary 만 rule 을 칠한다 — 한 경계는 한 색이다', () => {
    expect(DIVIDER_TONE_SPEC.boundary.paintsRule).toBe(true);
    expect(DIVIDER_TONE_SPEC.quiet.paintsRule).toBe(false);

    const unread = render(<UnreadDivider count={3} />);
    const boundaryLabel = labelStyle(unread, 'unread-divider', /새 메시지/).color;
    const boundaryRule = ruleStyle(unread, 'unread-divider').backgroundColor;
    // 라벨과 rule 이 **같은** 색이다. 둘이 다르면 한 경계가 두 색이 된다.
    expect(boundaryRule).toBe(boundaryLabel);

    const day = render(<DayDivider atMs={BASE_MS} nowMs={BASE_MS} />);
    expect(ruleStyle(day, 'day-divider').backgroundColor).toBe(color.border);
    expect(ruleStyle(day, 'day-divider').backgroundColor).not.toBe(boundaryRule);
  });

  it('boundary 가 quiet · agent · danger 와 다르다 (mustDifferFrom)', () => {
    // 계약의 심장. 「경계가 무슨 색인가」는 팔레트마다 달라도 되지만 「무엇이
    // 아니어야 하는가」는 두 클라에 공통이다.
    expect([...DIVIDER_TONE_SPEC.boundary.mustDifferFrom].sort()).toEqual([
      'agent',
      'danger',
      'quiet',
    ]);

    const unread = render(<UnreadDivider count={3} />);
    const boundary = labelStyle(unread, 'unread-divider', /새 메시지/).color;
    expect(boundary).toBeDefined();

    // quiet — 실제로 그려진 조용한 표지의 색.
    const day = render(<DayDivider atMs={BASE_MS} nowMs={BASE_MS} />);
    const quiet = labelStyle(day, 'day-divider', /오늘|년/).color ?? color.textMuted;
    expect(boundary).not.toBe(quiet);

    // agent — 이 조건이 없으면 accent 가 「여기를 보라」를 맡지 않는 팔레트에서
    // 경계가 에이전트 색을 빌려 쓰는 일이 조용히 일어난다. 폰의 accent 가 정확히
    // 그런 팔레트다 (「내가 한 것」 가족 — 호박으로 정렬된 뒤에도 그 뜻은 그대로).
    expect(boundary).not.toBe(color.agent);
    // danger — 안 읽은 것은 사고가 아니다.
    expect(boundary).not.toBe(color.danger);
  });

  it('그리고 그 색이 실제로 읽힌다 — 배경 위 AA', () => {
    const unread = render(<UnreadDivider count={3} />);
    const boundary = String(labelStyle(unread, 'unread-divider', /새 메시지/).color);
    expect(contrast(boundary, color.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

// =============================================================================
// ADR-0155 — 멈춘 답의 꼬리
// =============================================================================

describe('ADR-0155 — 멈춘 답은 꼬리 한 낱말로 말한다', () => {
  function streamed(marker: Record<string, unknown>): Message {
    return message({body: '답을 절반쯤 쓰다가', props: {'momo.stream': marker}});
  }

  function row(over: Message, runEnded?: boolean) {
    return render(
      <MessageRow
        message={over}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        runEnded={runEnded}
      />,
    );
  }

  it('잘 끝난 답에는 아무 말도 붙지 않는다', () => {
    row(streamed({rev: 17, streaming: false}));
    expect(screen.queryByTestId('stream-stop-mark')).toBeNull();
  });

  it('도착 중인 답에도 붙지 않는다 — 침묵이 기본값이다', () => {
    row(streamed({rev: 4, streaming: true}), false);
    expect(screen.queryByTestId('stream-stop-mark')).toBeNull();
  });

  it('취소된 답은 「중단됨」이라고 말하고, 본문은 그대로다', () => {
    row(streamed({rev: 5, streaming: false, outcome: 'cancelled'}));
    expect(screen.getByTestId('stream-stop-mark').props.children).toBe('중단됨');
    // 얼린다는 것은 지우지 않는다는 뜻이다 — 사람이 읽고서 누른 그 글자가 남는다.
    expect(screen.getByText('답을 절반쯤 쓰다가')).toBeTruthy();
  });

  it('run 은 끝났는데 stream 이 열려 있으면 「응답이 끊김」', () => {
    // 닫는 PATCH 가 못 닿은 메시지. 방어 렌더링이 없으면 이 행은 영원히
    // 도착 중인 답으로 서 있는다.
    row(streamed({rev: 9, streaming: true}), true);
    expect(screen.getByTestId('stream-stop-mark').props.children).toBe(
      '응답이 끊김',
    );
  });

  /**
   * **강조가 아니라 서술이다.** 끊긴 답을 accent 나 danger 로 그리면 화면에서
   * 가장 눈에 띄는 것이 「실패했다는 사실」이 되는데, 사람이 보러 온 것은 그 위의
   * 반쪽 답이다. 「수정됨」·「고정됨」과 **같은 글자**여야 하고, 그 동일성은
   * 여기서 값으로 잠긴다.
   */
  it('꼬리의 다른 낱말과 같은 흐린 글자다 — accent 도 danger 도 아니다', () => {
    const stopped = row(
      message({
        body: '답을 절반쯤 쓰다가',
        state: 'edited',
        props: {'momo.stream': {rev: 5, streaming: false, outcome: 'cancelled'}},
      }),
    );
    const mark = flatten(
      within(stopped.getByTestId('message-row'))
        .getByTestId('stream-stop-mark')
        .props.style,
    );
    const edited = flatten(
      within(stopped.getByTestId('message-row')).getByTestId('edited-mark').props
        .style,
    );
    expect(mark.color).toBe(edited.color);
    expect(mark.color).toBe(color.textFaint);
    expect(mark.color).not.toBe(color.accent);
    expect(mark.color).not.toBe(color.danger);
  });

  /**
   * 꼬리 배열이 낭독 라벨의 재료이므로, 화면에 넣는 것만으로 귀에도 닿아야 한다.
   * 눈에만 그리고 배열에 안 넣으면 보조기술 사용자에게 이 메시지는 완결된 답이다.
   */
  it('귀에도 닿는다 — 낭독 라벨이 같은 낱말을 읽는다', () => {
    row(streamed({rev: 5, streaming: false, outcome: 'cancelled'}));
    expect(
      String(screen.getByTestId('message-row').props.accessibilityLabel),
    ).toContain('중단됨');
  });

  it('묘비에는 그리지 않는다 — 없는 본문을 서술할 수는 없다', () => {
    row(
      message({
        state: 'deleted',
        body: undefined,
        props: {'momo.stream': {rev: 5, streaming: false, outcome: 'cancelled'}},
      }),
    );
    expect(screen.queryByTestId('stream-stop-mark')).toBeNull();
  });
});
