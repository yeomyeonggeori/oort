import type {
  MemoryDigest,
  MemoryDigestPage,
  MemoryReceipt,
  MemorySettings,
} from '@momo/core/features/memory/model';

import * as copy from '../src/features/memory/copy';
import {
  coverDigests,
  digestLines,
  evidenceOf,
  MISSED_MIN_UNREAD,
  missedCardState,
  receiptChipModel,
  receiptSheetModel,
  summaryLines,
  type MissedCardInput,
} from '../src/features/memory/model';

// =============================================================================
// #3166 MEM-M1 폰 — 요약 카드의 다섯 상태와 「기억 n개 참고」 칩의 판정.
//
// 화면은 이 판정이 낸 갈래를 그릴 뿐이라, 상태와 「개수만 보이는 보류」 규칙은 렌더
// 없이 여기서 잰다. 서버가 빈 목록을 주는 이유는 여럿이다(요약 전 · 요약할 게 없음 ·
// 권한으로 가림): 이 파일은 그 셋을 서로 다른 갈래로 가른다.
// =============================================================================

const CH = 'cccccccc-1111-4111-8111-cccccccccccc';

function digest(over: Partial<MemoryDigest> = {}): MemoryDigest {
  return {
    id: 'd-1',
    channelId: CH,
    level: 'window',
    fromSeq: 11,
    toSeq: 20,
    body: '- 배포 일정이 금요일로 정해졌어요.\n- 롤백 절차는 그대로 가요.',
    sourceCount: 10,
    createdAtMs: 1_700_000_000_000,
    evidence: [{messageId: 'm-15', channelId: CH, seq: 15}],
    ...over,
  };
}

function page(over: Partial<MemoryDigestPage> = {}): MemoryDigestPage {
  return {digests: [digest()], afterSeq: 10, summarizedThroughSeq: 20, ...over};
}

function settings(over: Partial<MemorySettings> = {}): MemorySettings {
  return {
    workspace: {enabled: true, paused: false, resetEpoch: 0},
    channels: [],
    me: {paused: false},
    ...over,
  };
}

function input(over: Partial<MissedCardInput> = {}): MissedCardInput {
  return {
    channelId: CH,
    unreadCount: MISSED_MIN_UNREAD,
    eligible: true,
    headSeq: 20,
    settingsPhase: 'ready',
    settings: settings(),
    digestsPhase: 'ready',
    page: page(),
    ...over,
  };
}

describe('놓친 대화 요약 카드 — 상태 판정', () => {
  it('요약이 있으면 ready, 워커가 머리까지 왔으면 partial 이 아니다', () => {
    const state = missedCardState(input());
    expect(state).toMatchObject({kind: 'ready', partial: false});
  });

  it('워커가 머리보다 뒤에 있으면 요약이 있어도 partial 이다', () => {
    const state = missedCardState(input({headSeq: 30}));
    expect(state).toMatchObject({kind: 'ready', partial: true});
  });

  it('요약이 0건이고 워커가 머리까지 왔으면 「요약할 게 없음」이다', () => {
    const state = missedCardState(input({page: page({digests: []})}));
    expect(state.kind).toBe('empty');
  });

  it('요약이 0건이고 워커가 못 따라왔으면 「아직 요약 전」이다 (빈 목록을 없음으로 읽지 않는다)', () => {
    const behind = missedCardState(
      input({page: page({digests: [], summarizedThroughSeq: 12})}),
    );
    expect(behind.kind).toBe('notSummarized');
    // 워커가 이 채널을 시작도 안 했으면 서버는 그 필드를 뺀다.
    const notStarted = missedCardState(
      input({page: {digests: [], afterSeq: 10}}),
    );
    expect(notStarted.kind).toBe('notSummarized');
  });

  it('읽는 중은 loading, 실패는 error', () => {
    expect(
      missedCardState(input({digestsPhase: 'loading', page: undefined})).kind,
    ).toBe('loading');
    expect(
      missedCardState(input({settingsPhase: 'loading', settings: undefined}))
        .kind,
    ).toBe('loading');
    expect(
      missedCardState(input({digestsPhase: 'error', page: undefined})).kind,
    ).toBe('error');
  });

  it('설정을 못 읽었다고 요약까지 가리지 않는다', () => {
    const state = missedCardState(
      input({settingsPhase: 'error', settings: undefined}),
    );
    expect(state.kind).toBe('ready');
  });

  it.each([
    ['워크스페이스 꺼짐', settings({workspace: {enabled: false, paused: false, resetEpoch: 0}}), 'workspace'],
    ['워크스페이스 일시정지', settings({workspace: {enabled: true, paused: true, resetEpoch: 0}}), 'workspacePaused'],
    ['채널 제외', settings({channels: [{channelId: CH, excluded: true, paused: false}]}), 'channel'],
    ['채널 일시정지', settings({channels: [{channelId: CH, excluded: false, paused: true}]}), 'channelPaused'],
    ['내 일시정지', settings({me: {paused: true}}), 'me'],
  ] as const)('%s → off(%s), 요약이 와 있어도 보여 주지 않는다', (_name, s, cause) => {
    const state = missedCardState(input({settings: s}));
    expect(state).toEqual({kind: 'off', cause});
  });

  it('다른 채널의 제외는 이 채널에 걸리지 않는다', () => {
    const other = 'dddddddd-1111-4111-8111-dddddddddddd';
    const state = missedCardState(
      input({settings: settings({channels: [{channelId: other, excluded: true, paused: false}]})}),
    );
    expect(state.kind).toBe('ready');
  });

  it('안 읽은 수가 문턱 밑이거나 자격이 없는 방이면 아예 없다 (로딩도 그리지 않는다)', () => {
    expect(
      missedCardState(input({unreadCount: MISSED_MIN_UNREAD - 1, digestsPhase: 'loading', page: undefined})),
    ).toEqual({kind: 'hidden'});
    expect(missedCardState(input({eligible: false}))).toEqual({kind: 'hidden'});
  });
});

describe('요약 줄과 근거', () => {
  it('일간 요약이 덮은 창 요약은 뺀다 (같은 구간을 두 번 말하지 않는다)', () => {
    const win = digest({id: 'w', level: 'window', fromSeq: 11, toSeq: 20});
    const day = digest({id: 'd', level: 'day', fromSeq: 1, toSeq: 30});
    const later = digest({id: 'w2', level: 'window', fromSeq: 31, toSeq: 40});
    expect(coverDigests([win, day, later]).map(d => d.id)).toEqual(['d', 'w2']);
  });

  it('불릿 기호를 걷고 다섯 줄까지만 보인다', () => {
    const many = digest({body: ['- 하나', '* 둘', '• 셋', '1. 넷', '2) 다섯', '여섯'].join('\n')});
    expect(digestLines(many)).toEqual(['하나', '둘', '셋', '넷', '다섯', '여섯']);
    const lines = summaryLines([many]);
    expect(lines.shown).toHaveLength(5);
    expect(lines.hidden).toBe(1);
  });

  it('근거는 메시지 기준으로 겹치지 않고 seq 순이다', () => {
    const a = digest({id: 'a', evidence: [
      {messageId: 'm-30', channelId: CH, seq: 30},
      {messageId: 'm-15', channelId: CH, seq: 15},
    ]});
    const b = digest({id: 'b', evidence: [{messageId: 'M-15', channelId: CH, seq: 15}]});
    expect(evidenceOf([a, b]).map(l => l.seq)).toEqual([15, 30]);
  });
});

function receipt(over: Partial<MemoryReceipt> = {}): MemoryReceipt {
  return {
    runId: 'r-1',
    channelId: CH,
    servedCount: 3,
    digestIds: ['d-1'],
    digests: [digest()],
    budgetChars: 6000,
    usedChars: 1200,
    createdAtMs: 1_700_000_000_000,
    ...over,
  };
}

describe('「기억 n개 참고」 칩', () => {
  it('참고한 기억이 없으면 칩도 없다', () => {
    expect(receiptChipModel(null)).toBeNull();
    expect(receiptChipModel(undefined)).toBeNull();
    expect(receiptChipModel(receipt({servedCount: 0}))).toBeNull();
  });

  it('n 은 서버가 센 servedCount 다 — 내가 볼 수 있는 목록 길이가 아니다', () => {
    expect(receiptChipModel(receipt({servedCount: 3, digests: [digest()]}))).toEqual({count: 3});
  });

  it('보류는 서버가 개수를 줄 때만 나온다', () => {
    expect(receiptSheetModel(receipt()).withheld).toBeNull();
    expect(receiptSheetModel(receipt({withheldCount: 2})).withheld).toBe(2);
    // 0 은 「싣지 않은 것이 없다」이므로 줄을 세우지 않는다.
    expect(receiptSheetModel(receipt({withheldCount: 0})).withheld).toBeNull();
  });

  it('실린 수보다 목록이 짧으면 그 사실만 표시한다 (이유는 단정하지 않는다)', () => {
    expect(receiptSheetModel(receipt({servedCount: 3})).listShorter).toBe(true);
    expect(
      receiptSheetModel(receipt({servedCount: 1, digests: [digest()]})).listShorter,
    ).toBe(false);
  });

  it('실린 요약은 겹침을 걷지 않고 그대로 센다', () => {
    const a = digest({id: 'a', level: 'day', fromSeq: 1, toSeq: 30});
    const b = digest({id: 'b', level: 'window', fromSeq: 11, toSeq: 20});
    expect(receiptSheetModel(receipt({servedCount: 2, digests: [a, b]})).digests).toHaveLength(2);
  });
});

describe('문장은 해요체다', () => {
  const strings = Object.entries(copy)
    .filter(([, value]) => typeof value === 'string')
    .flatMap(([name, value]) => [[name, value as string]])
    .concat(
      Object.entries(copy.MISSED_OFF).map(([name, value]) => [`MISSED_OFF.${name}`, value]),
    );
  const functions = [
    copy.evidenceLabel(1),
    copy.evidenceA11y(1),
    copy.evidenceMore(2),
    copy.receiptChipLabel(3),
    copy.receiptChipA11y(3),
    copy.receiptSheetSummary(3),
    copy.withheldLine(2),
    copy.digestSourceLine(10),
  ].map((value, index) => [`fn#${index}`, value] as [string, string]);

  it.each([...strings, ...functions])('%s 는 합쇼체·em-dash 가 없다', (_name, value) => {
    expect(value).not.toMatch(/(?:습니다|ㅂ니다|입니다|하십시오)[.?!]?\s*$/);
    expect(value).not.toContain('—');
    expect(value).not.toContain('–');
  });

  it('문장은 실제로 해요체로 끝난다 (위 검사가 빈 목록으로 통과할 수 없다)', () => {
    expect(copy.MISSED_LOADING).toMatch(/요\.$/);
    expect(copy.MISSED_OFF.me).toMatch(/요\.$/);
    expect(strings.length).toBeGreaterThan(20);
  });
});
