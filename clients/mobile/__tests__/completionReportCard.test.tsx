import {readFileSync} from 'node:fs';
import path from 'node:path';
import {agentCardModel} from '@momo/core/features/timeline/agentCardModel';
import {
  COMPLETION_CHECK_TONE,
  COMPLETION_REPORT_KIND,
} from '@momo/core/features/timeline/completionReportCard';
import type {Message} from '@momo/core/lib/api';

// =============================================================================
// 작업 완료 리포트 카드의 **폰 계약** (UXC-A).
//
// 로그인 핸드오프의 `loginHandoffCard.test.tsx` 와 같은 계약이다. 완료 리포트는
// 결정 컨트롤이 애초에 없으므로 폰이 지는 약속은 「웹과 같은 것을 그린다」이고,
// 그 약속이 깨지는 두 방향은:
//
//   1. 폰이 코어의 낱말·서식을 다시 짓는다 — 그 순간 두 클라가 같은 리포트를
//      다르게 말하기 시작한다.
//   2. 게이트 색을 손으로 정한다(raw hex) — 침묵(skip)을 실패색으로 칠하는 실수가
//      한쪽 클라에만 조용히 들어온다.
//
// 렌더 트리가 아니라 **소스**를 읽는 이유는 핸드오프 테스트 머리말과 같다: 이
// 클라에는 렌더 하네스가 없고, 지켜야 하는 것은 「무엇이 존재하지 않는가」다.
// =============================================================================

const MESSAGE_ROW = readFileSync(
  path.join(__dirname, '../src/features/conversation/MessageRow.tsx'),
  'utf8',
);

/** 이 레포는 주석에 반례를 그대로 인용한다. 스캔 전에 걷어낸다. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(?<!:)\/\/.*$/gm, '');
}

const MESSAGE_ROW_CODE = codeOnly(MESSAGE_ROW);

function reportMessage(props: Record<string, unknown> = {}): Message {
  return {
    id: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5b',
    channelId: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5c',
    seq: 12,
    hlcTs: 1_760_000_000_000,
    hlcCount: 0,
    authorMemberId: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5d',
    // 평범한 에이전트 턴 메시지 — 새 메시지 타입이 아니다.
    type: 'text',
    body: '환경 셋업을 마쳤습니다.',
    createdAtMs: 1_760_000_000_000,
    props: {
      kind: COMPLETION_REPORT_KIND,
      title: '환경 셋업 완료',
      summary: 'oort 모노레포입니다. 게이트를 전부 초록으로 맞췄습니다.',
      elapsed_ms: 1_468_000,
      actions: [{text: 'Rust 1.83에서 1.97로 범프', note: 'edition2024 요구'}],
      gates: [
        {surface: '웹', checks: [{label: '테스트', outcome: 'pass', detail: '896 통과'}]},
      ],
      ...props,
    },
  };
}

describe('완료 리포트는 승인 카드 가족을 재사용한다 (새 메시지 타입 없음)', () => {
  it('평범한 턴 메시지가 완료 리포트 카드로 파싱된다', () => {
    const card = agentCardModel(reportMessage());
    expect(card?.kind).toBe('completion_report');
    expect(reportMessage().type).toBe('text');
  });

  it('kind 만 있고 내용이 없으면 카드가 아니다', () => {
    const card = agentCardModel(
      reportMessage({summary: undefined, actions: [], gates: []}),
    );
    expect(card?.kind).not.toBe('completion_report');
  });
});

describe('폰이 완료 리포트를 그린다 — 결정 없이', () => {
  it('MessageRow 가 카드 뷰를 배선한다', () => {
    expect(MESSAGE_ROW_CODE).toContain('function CompletionReportCardView(');
    expect(MESSAGE_ROW_CODE).toContain("card.kind === 'completion_report'");
    expect(MESSAGE_ROW_CODE).toContain('<CompletionReportCardView');
  });

  it('결정 컨트롤이 없다 — 이 카드는 읽기뿐이다', () => {
    // 완료 리포트 뷰 안에 결정 프리미티브(`ApprovalDecision`)가 없다.
    const view = MESSAGE_ROW_CODE.slice(
      MESSAGE_ROW_CODE.indexOf('function CompletionReportCardView('),
      MESSAGE_ROW_CODE.indexOf('function AgentCard('),
    );
    expect(view).not.toContain('ApprovalDecision');
    expect(view).not.toContain('Pressable');
  });
});

describe('폰이 코어의 낱말과 색을 다시 짓지 않는다', () => {
  it('경과 서식·결과 낱말·집계는 코어 헬퍼가 답한다', () => {
    expect(MESSAGE_ROW_CODE).toContain('formatElapsed(card.elapsedMs)');
    expect(MESSAGE_ROW_CODE).toContain('COMPLETION_CHECK_OUTCOME_LABEL[');
    expect(MESSAGE_ROW_CODE).toContain('completionCheckCounts(');
  });

  it('겹친 라벨의 칸 순서를 코어가 준다 — 실패가 통과 아래로 밀리지 않는다', () => {
    // 웹 셀이 겹친 칸을 최악 톤 먼저로 쌓는 것과 같은 순서를 폰도 코어에서 받는다.
    expect(MESSAGE_ROW_CODE).toContain('completionRowChecks(row)');
  });

  it('게이트 색은 코어의 톤 역할을 지난다 (divider/approvalNote 계약)', () => {
    expect(MESSAGE_ROW_CODE).toContain('COMPLETION_CHECK_TONE[');
    expect(MESSAGE_ROW_CODE).toContain('buildCompletionToneStyle');
    // fail 만 danger. skip·pending 은 아니다 — 침묵을 실패로 칠하지 않는다.
    expect(COMPLETION_CHECK_TONE.fail).toBe('danger');
    expect(COMPLETION_CHECK_TONE.skip).not.toBe('danger');
    expect(COMPLETION_CHECK_TONE.pending).not.toBe('danger');
  });

  it('세부가 결과 낱말을 대신할 때 결과 낱말을 보조기술에 함께 읽힌다 (L3)', () => {
    // 「896 통과」만 화면에 서면 소리로는 통과인지 실패인지 모른다 — 웹의 sr-only
    // 짝이다. 세부가 있을 때 accessibilityLabel 로 결과 낱말을 붙인다.
    const view = MESSAGE_ROW_CODE.slice(
      MESSAGE_ROW_CODE.indexOf('function CompletionReportCardView('),
      MESSAGE_ROW_CODE.indexOf('function AgentCard('),
    );
    expect(view).toContain('accessibilityLabel');
    expect(view).toContain('COMPLETION_CHECK_OUTCOME_LABEL[check.outcome]');
  });

  it('상한에 걸려 안 그린 것을 「N개 더」로 정직 표기한다 (M3)', () => {
    const view = MESSAGE_ROW_CODE.slice(
      MESSAGE_ROW_CODE.indexOf('function CompletionReportCardView('),
      MESSAGE_ROW_CODE.indexOf('function AgentCard('),
    );
    expect(view).toContain('card.omitted.actions');
    expect(view).toContain('card.omitted.gates');
    expect(view).toContain('card.omitted.checks');
    expect(view).toContain('개 더');
  });

  it('네 역할이 각자 다른 팔레트 토큰을 들고, raw hex 가 아니다', () => {
    // 역할 하나가 남의 토큰을 빌려 쓰면(예: warn: {color: color.danger}) 그
    // 토큰이 빠져 이 단정이 붉어진다 — 침묵을 실패색으로 칠하는 그 오타를 잡는
    // 자리다. 웹 쪽 짝은 `completionTone.test.ts` 가 tokens.css 로 잰다.
    const helper = MESSAGE_ROW_CODE.slice(
      MESSAGE_ROW_CODE.indexOf('const buildCompletionToneStyle'),
      MESSAGE_ROW_CODE.indexOf('function handoffClock('),
    );
    // jest 의 `expect` 는 두 번째 인자를 받지 않으므로(vitest 와 다르다) 무엇이
    // 빠졌는지는 토큰을 값에 넣어 찍는다.
    const missing = ['color.ok', 'color.danger', 'color.warn', 'color.textMuted'].filter(
      token => !helper.includes(token),
    );
    expect(missing).toEqual([]);
    expect(helper).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
