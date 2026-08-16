import {readFileSync} from 'node:fs';
import path from 'node:path';
import {agentCardModel} from '@momo/core/features/timeline/agentCardModel';
import {
  LOGIN_HANDOFF_DECISION,
  LOGIN_HANDOFF_DEPLOYMENT_COPY,
  LOGIN_HANDOFF_ELSEWHERE_COPY,
  LOGIN_HANDOFF_KIND,
  LOGIN_HANDOFF_OUTCOME_DETAIL,
  loginHandoffStatusLabel,
} from '@momo/core/features/timeline/loginHandoffCard';
import type {Message} from '@momo/core/lib/api';

// =============================================================================
// 로그인 핸드오프 카드의 **폰 계약** (LIVE-4).
//
// 폰이 이 카드에 대해 지는 약속은 「그리되 결정하지 않는다」이고, 그 약속은 두
// 방향으로 깨질 수 있다:
//
//   1. 폰이 재개·중단 버튼을 갖는다 — 사람이 폰에서 「개입 완료」를 눌러 놓고
//      정작 로그인은 하지 못한다. 카드가 시키는 일이 데스크톱에서만 되는데
//      완료 신호만 폰에서 나가는 것이라, 에이전트가 로그인 안 된 화면에서
//      재개한다.
//   2. 폰이 화면을 열려고 한다 — attach 내부(capability·endpoint·peer
//      connection)가 폰에 들어온다. `workConsole.test.tsx` 가 작업 콘솔 세
//      파일에 대해 이미 세워 둔 가드와 같은 것이고, 이 카드는 그 가드가 덮지
//      않는 네 번째 파일에 산다.
//
// 렌더 트리가 아니라 **소스**를 읽는 이유가 그것이다. 여기서 지켜야 하는 것은
// 「이 상태에서 무엇이 보이는가」가 아니라 「어떤 코드가 존재하지 않는가」이고,
// 부재는 밖에서 관측되지 않는다 — 나타났을 때 빨개지는 것이 유일한 방법이다.
// (`displayStream.test.ts` 머리말의 같은 논증.)
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

const SESSION_ID = '9a1b2c3d-4e5f-4a6b-8c7d-1e2f3a4b5c6d';

function handoffMessage(props: Record<string, unknown> = {}): Message {
  return {
    id: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5b',
    channelId: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5c',
    seq: 12,
    hlcTs: 1_760_000_000_000,
    hlcCount: 0,
    authorMemberId: '0197c3aa-2f11-7a4e-9b30-8c1d2e3f4a5d',
    type: 'approval_request',
    body: 'Approval required: work.session.login_handoff',
    createdAtMs: 1_760_000_000_000,
    props: {
      kind: LOGIN_HANDOFF_KIND,
      approval_id: '5f0d2a1e-1c4b-4c9a-9f2a-0d3c8b7e6a11',
      session_id: SESSION_ID,
      status: 'pending',
      summary: '배포 콘솔이 2단계 인증을 요구합니다.',
      ...props,
    },
  };
}

describe('폰은 그리되 결정하지 않는다', () => {
  it('두 클라가 같은 메시지에서 같은 카드를 얻는다', () => {
    const card = agentCardModel(handoffMessage());
    expect(card?.kind).toBe('login_handoff');
    // 낱말도 코어가 답한다. 폰이 자기 표를 들면 같은 상태가 두 이름을 갖는다.
    expect(loginHandoffStatusLabel({phase: 'waiting', outcome: null})).toBe(
      '개입 대기',
    );
    expect(
      loginHandoffStatusLabel({phase: 'resolved', outcome: 'expired'}),
    ).toBe('완료 불확실');
  });

  it('재개·중단 낱말이 폰 소스 어디에도 없다', () => {
    // 코어에 한 벌로 있고(`LOGIN_HANDOFF_DECISION`), 그 부재를 시험할 수 있는
    // 것도 한 벌이기 때문이다.
    for (const verb of [
      LOGIN_HANDOFF_DECISION.resumeCommit,
      LOGIN_HANDOFF_DECISION.stopCommit,
      LOGIN_HANDOFF_DECISION.resumeConfirm,
      LOGIN_HANDOFF_DECISION.stopConfirm,
      LOGIN_HANDOFF_DECISION.lead,
    ]) {
      expect(MESSAGE_ROW_CODE).not.toContain(verb);
    }
    expect(MESSAGE_ROW_CODE).not.toContain('LOGIN_HANDOFF_DECISION');
  });

  it('화면을 여는 어떤 경로도 이 파일에 들어오지 않는다', () => {
    // `workConsole.test.tsx` 의 가드와 같은 낱말 목록. 그 시험은 작업 콘솔
    // 세 파일만 읽으므로 이 카드가 사는 파일은 덮이지 않는다.
    expect(MESSAGE_ROW_CODE).not.toMatch(
      /issueDisplayAttach|DisplayAttachGrant|issueObserverTerminalAttach|TerminalAttachGrant|RTCPeerConnection|capability_token|display_endpoint|attach_endpoint|display_id|WebView/,
    );
  });

  it('배포 사실 문장은 웹의 것이고 폰은 자리 안내만 한다', () => {
    // 폰에서 「채팅에서 화면을 여는 동선이 없습니다」를 말하면 거짓 기대를
    // 만든다: 폰에는 그 동선이 배포와 무관하게 없다. 자리의 문제와 배포의
    // 문제를 구분하는 것이 정직 카피 2분법의 전부다.
    expect(MESSAGE_ROW_CODE).not.toContain(LOGIN_HANDOFF_DEPLOYMENT_COPY);
    expect(MESSAGE_ROW_CODE).toContain('LOGIN_HANDOFF_ELSEWHERE_COPY');
    expect(LOGIN_HANDOFF_ELSEWHERE_COPY).toContain('데스크톱이나 웹에서');
  });

  it('세 결과의 문장을 폰이 다시 쓰지 않는다', () => {
    expect(MESSAGE_ROW_CODE).toContain('LOGIN_HANDOFF_OUTCOME_DETAIL');
    for (const sentence of Object.values(LOGIN_HANDOFF_OUTCOME_DETAIL)) {
      expect(MESSAGE_ROW_CODE).not.toContain(sentence);
    }
  });

  it('진행 상황은 전부 그린다 — 결정할 수 없다는 것이 알 수 없다는 뜻은 아니다', () => {
    const card = agentCardModel(
      handoffMessage({
        approval_status: 'approved',
        control_started_at_ms: 1_760_000_100_000,
        control_ended_at_ms: 1_760_000_200_000,
        control_end_reason: 'expired',
      }),
    );
    expect(card).not.toBeNull();
    if (card?.kind !== 'login_handoff') throw new Error('login handoff card');
    expect(card.control).toEqual({
      startedAtMs: 1_760_000_100_000,
      endedAtMs: 1_760_000_200_000,
      endReason: 'expired',
    });
    expect(card.outcome).toBe('expired');
    // 폰이 그 세 값을 실제로 그리는 자리가 있다는 것까지.
    expect(MESSAGE_ROW_CODE).toContain('card-handoff-boundary');
    expect(MESSAGE_ROW_CODE).toContain('card-handoff-outcome');
  });

  it('세션 id 를 문자로 그리지 않는다', () => {
    const card = agentCardModel(handoffMessage());
    if (card?.kind !== 'login_handoff') throw new Error('login handoff card');
    expect(card.sessionId).toBe(SESSION_ID);
    for (const row of card.detail.rows) {
      expect(row.value).not.toContain(SESSION_ID);
    }
    // 그리고 폰 소스에도 id 를 화면에 얹는 자리가 없다.
    expect(MESSAGE_ROW_CODE).not.toContain('card.sessionId');
  });
});
