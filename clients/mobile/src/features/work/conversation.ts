import type {WorkSession} from '@momo/core/lib/api';
import {
  foldSessionEvents,
  mergeEvents,
  type WorkRowState,
  type WorkSessionEvent,
} from '@momo/core/features/work/workSessionModel';
import type {ThreadReply} from './queries';

// =============================================================================
// 대화 모드의 순서 (N3 #3595). 순수 함수 하나가 말풍선 목록을 만든다.
//
// 재료는 셋이다: 에이전트가 쓴 ACP 이벤트(코어가 `foldSessionEvents`로 줄로 접는다),
// 스레드의 사람 답글(내 서명된 지시와 팀원 말), 그리고 아직 읽기에 올라오지 않은
// 방금 보낸 내 지시(낙관). 셋은 **채널 seq**로 줄을 선다 - 이벤트와 답글이 같은
// 스레드의 메시지라 같은 시계를 쓴다(코어 `mergeEvents`와 같은 규칙).
//
// 에이전트의 한 답이 내 지시 때문에 둘로 갈라져야 하는 경우가 있다: 조각(`agent.partial`)이
// 이어지는 도중에 내가 끼어들면, 코어는 그 조각들을 한 줄로 합쳐 버린다. 그래서 내 답글
// 자리마다 **내용 없는 `agent.status`** 를 한 개 끼워 접는다. 코어는 이것을 줄로 만들지
// 않고(할 말이 없는 상태 프레임은 건너뛴다), 열린 조각 묶음만 닫는다.
// =============================================================================

export type ChatItem =
  | {
      kind: 'mine';
      id: string;
      atMs: number;
      seq: number | null;
      text: string;
      mode: 'queue' | 'interrupt' | null;
      /** `sending` = 서명·전송 중, `sent` = 전달됐고 읽기에 오르기를 기다린다. */
      delivery: 'sent' | 'sending';
    }
  | {
      kind: 'other';
      id: string;
      atMs: number;
      seq: number;
      authorMemberId: string;
      text: string;
    }
  | {
      kind: 'agent';
      id: string;
      atMs: number;
      seq: number | null;
      text: string;
      /** 지금 이어 붙고 있는 마지막 답. */
      streaming: boolean;
    }
  | {
      kind: 'system';
      id: string;
      atMs: number;
      seq: number | null;
      text: string;
      state: WorkRowState;
    }
  | {kind: 'permission'; id: string; atMs: number; seq: number | null};

/** 방금 보낸 내 지시. 읽기가 따라잡으면 사라진다. */
export interface PendingSend {
  localId: string;
  text: string;
  mode: 'queue' | 'interrupt';
  startedAtMs: number;
  status: 'sending' | 'sent';
}

/** 폰과 서버 시계 차이를 용서하는 폭. 같은 글을 두 번 보낸 경우를 가르는 데만 쓴다. */
export const PENDING_SKEW_MS = 60_000;

const END = Number.MAX_SAFE_INTEGER;

function order(a: {seq: number | null; atMs: number}, b: {seq: number | null; atMs: number}) {
  return (a.seq ?? END) - (b.seq ?? END) || a.atMs - b.atMs;
}

function sameText(a: string, b: string): boolean {
  return a.normalize('NFC').trim() === b.normalize('NFC').trim();
}

/**
 * 말풍선 목록. `events`는 이 세션 것만, `mergeEvents`를 거친 것이어야 한다.
 *
 * `permissionRequestId`는 카드가 그려질 수 있을 때만 넘긴다(소유자 + 서명 요구 플래그
 * 이후). 넘기지 않으면 대기 중인 승인도 그냥 한 줄이다 - 버튼이 없는 카드는 만들지
 * 않는다.
 */
export function buildConversation(input: {
  events: readonly WorkSessionEvent[];
  session: Pick<WorkSession, 'status'>;
  truncated: boolean;
  replies: readonly ThreadReply[];
  selfMemberId: string;
  pending: readonly PendingSend[];
  permissionRequestId: string | null;
}): ChatItem[] {
  const self = input.selfMemberId.toLowerCase();
  const breakers: WorkSessionEvent[] = input.replies.map(reply => ({
    eventId: `reply:${reply.id}`,
    type: 'agent.status',
    sessionId: '',
    atMs: reply.atMs,
    seq: reply.seq,
    payload: {},
  }));
  const merged = mergeEvents(input.events, breakers);
  const folded = foldSessionEvents(merged, input.session, input.truncated);

  const position = new Map<string, {seq: number | null; atMs: number}>();
  for (const event of input.events) {
    position.set(event.eventId.toLowerCase(), {
      seq: event.seq ?? null,
      atMs: event.atMs,
    });
  }
  const permissionId = input.permissionRequestId?.toLowerCase() ?? null;

  const items: ChatItem[] = [];
  for (const row of folded.rows) {
    const at = position.get(row.id.toLowerCase()) ?? {seq: null, atMs: row.atMs};
    const base = {id: row.id, atMs: at.atMs, seq: at.seq};
    if (row.kind === 'message') {
      items.push({...base, kind: 'agent', text: row.headline, streaming: row.state === 'running'});
    } else if (
      row.kind === 'approval' &&
      row.state === 'pending' &&
      permissionId !== null &&
      row.id.toLowerCase() === permissionId
    ) {
      items.push({...base, kind: 'permission'});
    } else {
      items.push({...base, kind: 'system', text: row.headline, state: row.state});
    }
  }

  const durableMine: ThreadReply[] = [];
  for (const reply of input.replies) {
    if (reply.authorMemberId.toLowerCase() === self) {
      durableMine.push(reply);
      items.push({
        kind: 'mine',
        id: reply.id,
        atMs: reply.atMs,
        seq: reply.seq,
        text: reply.text,
        mode: reply.mode ?? null,
        delivery: 'sent',
      });
    } else {
      items.push({
        kind: 'other',
        id: reply.id,
        atMs: reply.atMs,
        seq: reply.seq,
        authorMemberId: reply.authorMemberId,
        text: reply.text,
      });
    }
  }

  // 읽기가 이미 담은 낙관 말풍선은 뺀다(같은 글, 보낸 시각 이후). 하나가 하나만 지운다.
  const used = new Set<string>();
  for (const pending of input.pending) {
    const match = durableMine.find(
      reply =>
        !used.has(reply.id) &&
        sameText(reply.text, pending.text) &&
        reply.atMs >= pending.startedAtMs - PENDING_SKEW_MS,
    );
    if (match !== undefined) {
      used.add(match.id);
      continue;
    }
    items.push({
      kind: 'mine',
      id: pending.localId,
      atMs: pending.startedAtMs,
      seq: null,
      text: pending.text,
      mode: pending.mode,
      delivery: pending.status === 'sending' ? 'sending' : 'sent',
    });
  }

  // 정렬은 안정적이다(같은 키는 들어온 순서).
  return items
    .map((item, index) => ({item, index}))
    .sort((a, b) => order(a.item, b.item) || a.index - b.index)
    .map(entry => entry.item);
}

// ---- 맨 아래 따라가기 --------------------------------------------------------------

/** 이 안쪽이면 「맨 아래」로 본다(말풍선 한 줄이 새로 붙어도 따라가는 폭). */
export const FOLLOW_THRESHOLD = 48;

/** 스크롤 위치가 맨 아래 근처인가. 사용자가 위로 올렸으면 false. */
export function isNearBottom(
  offsetY: number,
  viewportHeight: number,
  contentHeight: number,
  threshold = FOLLOW_THRESHOLD,
): boolean {
  return contentHeight - (offsetY + viewportHeight) <= threshold;
}

/**
 * 내용이 자랐을 때 맨 아래로 따라가는가. 사용자가 위에서 읽고 있으면 따라가지 않고
 * (`unseen`으로 「새 답」 표지를 띄운다), 내가 방금 보낸 것은 어디서든 따라간다.
 */
export function followDecision(input: {
  following: boolean;
  mineJustSent: boolean;
}): 'scroll' | 'hold' {
  return input.following || input.mineJustSent ? 'scroll' : 'hold';
}

/** 시각 구분선을 둘 간격. */
export const TIME_BREAK_MS = 10 * 60_000;
