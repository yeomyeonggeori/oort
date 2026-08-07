import type {Message} from '@momo/core/lib/api';
import type {AgentProgressEvent} from '@momo/core/lib/realtimeEvents';
import {
  endedStreamRunIds,
  isStreamRunEnded,
  STREAM_CUT_OFF_MARK,
  STREAM_PROPS_KEY,
  streamStopMark,
} from '@momo/core/features/timeline/streamStop';

import {
  endedRunIds,
  observeAgentProgress,
  resetEndedRuns,
  seedEndedRuns,
} from '../src/features/agents/endedRuns';

// =============================================================================
// #1166 — 리로드 뒤에도 서는 꼬리 (폰).
//
// 웹의 `clients/web/src/features/agents/endedRuns.test.ts` 와 같은 것을 잰다.
// 두 벌인 이유는 스토어가 두 벌이기 때문이고(모듈 가변 상태 + React 는 코어
// 순수성 게이트가 거절한다), 한쪽만 씨딩을 잃는 날이 이 파일이 막는 그 날이다.
// =============================================================================

function status(runId: string, runStatus: string): AgentProgressEvent {
  return {
    type: 'agent.status',
    v: 1,
    ts: 1,
    payload: {
      run_id: runId,
      agent_member_id: 'a',
      channel_id: 'c',
      phase: 'thinking',
      run_status: runStatus,
    },
  } as AgentProgressEvent;
}

function orphan(runId: string, runEnded?: boolean): Message {
  return {
    id: 'm1',
    channelId: 'c1',
    seq: 7,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: 'agent',
    type: 'text',
    body: '답을 절반쯤 쓰다가',
    state: 'sent',
    createdAtMs: 1,
    props: {[STREAM_PROPS_KEY]: {rev: 9, streaming: true}, run_id: runId},
    ...(runEnded === undefined ? {} : {runEnded}),
  };
}

describe('endedRuns 씨딩', () => {
  beforeEach(() => {
    resetEndedRuns();
  });

  /**
   * **RED proof — 리로드 폐곡선.**
   *
   * 이 앱은 그 run 의 터미널 프레임을 본 적이 없다(재시작이 그것을 지웠다).
   * 페이지가 들고 온 종결을 심지 않으면 꼬리는 `null` 이고, 반쪽 답이 완결된
   * 답의 옷을 입는다 — ADR-0155 가 C안을 기각한 그 거짓말이다.
   */
  it('페이지가 들고 온 종결은 프레임을 못 본 세션에서도 꼬리를 세운다', () => {
    const row = orphan('RUN-A', true);
    expect(streamStopMark(row, isStreamRunEnded(row, endedRunIds()))).toBeNull();

    seedEndedRuns(endedStreamRunIds([row]));

    expect(endedRunIds().has('run-a')).toBe(true);
    expect(streamStopMark(row, isStreamRunEnded(row, endedRunIds()))).toBe(
      STREAM_CUT_OFF_MARK,
    );
  });

  /**
   * **RED proof — 종결 아닌 run 은 표기될 수 없다.** 서버가 침묵한 행은 씨앗을
   * 하나도 내놓지 못하므로, 도착 중인 답은 도착 중인 채로 남는다.
   */
  it('서버가 말하지 않은 run 은 심지 않는다', () => {
    const live = orphan('run-live');
    seedEndedRuns(endedStreamRunIds([live]));
    expect(endedRunIds().size).toBe(0);
    expect(
      streamStopMark(live, isStreamRunEnded(live, endedRunIds())),
    ).toBeNull();
  });

  it('실시간 프레임과 페이지 읽기가 같은 집합을 채운다', () => {
    observeAgentProgress(status('r-frame', 'cancelled'));
    seedEndedRuns(endedStreamRunIds([orphan('R-PAGE', true)]));
    expect([...endedRunIds()].sort()).toEqual(['r-frame', 'r-page']);
  });

  it('새로 아는 것이 없으면 집합의 신원이 바뀌지 않는다', () => {
    observeAgentProgress(status('r1', 'cancelled'));
    const before = endedRunIds();
    seedEndedRuns([]);
    seedEndedRuns(['r1']);
    expect(endedRunIds()).toBe(before);
  });
});
