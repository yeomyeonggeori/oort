import {ApiError, sendMessage, sendThreadReply} from '@momo/core/lib/api';
import {
  dismissNotificationAsync,
  scheduleNotificationAsync,
} from 'expo-notifications';

import {
  channelDraftKey,
  readDraft,
  seedDraft,
  threadDraftKey,
} from '../features/conversation/drafts';
import {parsePushEnvelope, threadRootId, type PushEnvelope} from './envelope';
import {nativeQueuedReplyStore, type QueuedReplyStore} from './native';

// =============================================================================
// 잠금 화면 답장의 보관 목록을 비운다 (#6036).
//
// 답장은 iOS 에서 네이티브 처리기가 먼저 받아 앱 전용 키체인에 「보낼 답장」으로 남긴다
// (`modules/momo-push-action-native/ios/MomoPushReplyQueue.swift`). 처리기의 자격(push_action
// 토큰)은 승인 결정 한 길만 부를 수 있어서 글을 보내지 못하고, scene 수명 주기(#6015) 뒤로는
// 뒤에서 깨어난 앱에 응답을 받을 JS 가 앱을 열 때까지 없을 수 있다. 그래서 보내는 일은 여기,
// 사람의 세션을 가진 JS 가 한다.
//
// ## 한 번만 간다
//
//   - 멱등 열쇠(`clientMsgId`)는 처리기가 남길 때 정한 값이다. 다시 보내도(응답을 잃은 재시도,
//     비우기가 두 번 겹친 경우) 서버는 같은 열쇠의 글을 한 번만 받는다(같은 201).
//   - 이 파일은 한 번에 하나만 돈다(`drainQueuedReplies`). 도는 중에 다시 부르면 끝난 뒤 한 번 더 돈다.
//   - iOS 에서 처리기가 붙어 있으면 `handlePushResponse` 의 답장 갈래는 보내지 않고 물러난다
//     (`notifications.ts`). 뒤에서 JS 가 같은 응답을 받아도 보내는 길은 이 목록 하나다.
//   - 목록에서 지우는 것은 서버가 받았다고 답한 뒤(2xx)다.
//
// ## 끝내 못 보내면
//
// 서버가 분명히 거절했거나(408 · 429 를 뺀 4xx — 글은 쓰이지 않았다) 남긴 지 하루가 지나도록
// 가지 못했으면, 그 대화(스레드면 스레드)의 초안으로 넣고 알린다. 초안이 이미 있으면 덮지
// 않는다(사람의 글이 먼저다) — 그때는 목록에 남겨 다음에 다시 한다. 망이 끊긴 것 · 5xx · 429 는
// 같은 열쇠로 다시 보낼 수 있으므로 하루까지 목록에 둔다.
//
// ## 누구의 것인가
//
// 항목에는 남길 때의 워크스페이스와 멤버가 적혀 있다. 지금 들어와 있는 사람과 다르면 **보내지도,
// 초안으로 넣지도 않고 지운다.** 멤버 id 는 워크스페이스마다 다르므로 다르면 다른 사람이거나 다른
// 워크스페이스의 신원이고, 그 사람의 글을 지금 사람의 이름으로 보내거나 지금 사람의 입력창에
// 두면 안 된다. 로그아웃은 목록을 통째로 지운다(`session/useSession.tsx`).
//
// 글 본문과 열쇠는 로그에 남기지 않는다.
// =============================================================================

const LOG = '[push]';

/** 남긴 지 이만큼 지나도 못 보냈으면 초안으로 넘긴다. */
export const QUEUED_REPLY_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Swift `MomoPushQueuedReply` — 키 이름이 계약이다. */
export interface QueuedReply {
  v: 1;
  clientMsgId: string;
  workspaceID: string;
  memberID: string;
  text: string;
  requestIdentifier: string;
  origin: string;
  createdAtMs: number;
}

/** 이 판이 읽는 모양이 아니면 null. */
export function parseQueuedReply(raw: string): QueuedReply | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const strings = [
    'clientMsgId',
    'workspaceID',
    'memberID',
    'text',
    'requestIdentifier',
    'origin',
  ] as const;
  if (item.v !== 1) return null;
  for (const key of strings) {
    if (typeof item[key] !== 'string' || item[key] === '') return null;
  }
  if (typeof item.createdAtMs !== 'number') return null;
  return item as unknown as QueuedReply;
}

export interface QueuedReplyCopy {
  drafted: string;
  notSentTitle: string;
  notSentBody: string;
}

export interface DrainContext {
  workspaceId: string;
  memberId: string;
  /** 지금도 같은 사람이 들어와 있는가. 기다림마다 다시 묻는다. */
  isCurrent: () => boolean;
  copy: QueuedReplyCopy;
}

export interface DrainDeps {
  store: QueuedReplyStore | null;
  send: (reply: QueuedReply, envelope: PushEnvelope) => Promise<void>;
  now: () => number;
  /** 알림 한 줄(같은 식별자의 「앱을 열면 보내요」 줄을 바꾼다). */
  notify: (identifier: string, title: string, body: string, origin: unknown) => Promise<void>;
  dismiss: (identifier: string) => Promise<void>;
}

function sendQueued(reply: QueuedReply, envelope: PushEnvelope): Promise<void> {
  const root = threadRootId(envelope);
  const sent = root
    ? sendThreadReply(envelope.workspaceId, envelope.channelId, root, reply.clientMsgId, reply.text)
    : sendMessage(envelope.workspaceId, envelope.channelId, reply.clientMsgId, reply.text);
  return sent.then(() => undefined);
}

const liveDeps = (): DrainDeps => ({
  store: nativeQueuedReplyStore(),
  send: sendQueued,
  now: Date.now,
  notify: async (identifier, title, body, origin) => {
    await scheduleNotificationAsync({
      identifier,
      content: {title, body, data: origin === undefined ? {} : {origin}},
      trigger: null,
    });
  },
  dismiss: identifier => dismissNotificationAsync(identifier),
});

/** 서버가 글을 쓰지 않았다고 분명히 말한 거절인가. 아니면 같은 열쇠로 다시 보낼 수 있다. */
function refused(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408 &&
    cause.status !== 429
  );
}

function originOf(reply: QueuedReply): unknown {
  try {
    return JSON.parse(reply.origin);
  } catch {
    return undefined;
  }
}

async function drainOnce(context: DrainContext, deps: DrainDeps): Promise<void> {
  const store = deps.store;
  if (!store) return;
  const listed = store.list();
  if (!listed) return;
  for (const raw of listed) {
    if (!context.isCurrent()) return;
    const reply = parseQueuedReply(raw);
    if (!reply) continue;
    if (
      reply.workspaceID.toLowerCase() !== context.workspaceId.toLowerCase() ||
      reply.memberID.toLowerCase() !== context.memberId.toLowerCase()
    ) {
      store.remove(reply.clientMsgId);
      console.log(`${LOG} queued reply removed (not this member's)`);
      continue;
    }
    const origin = originOf(reply);
    const envelope = parsePushEnvelope(origin);
    if (!envelope || envelope.workspaceId !== reply.workspaceID.toLowerCase()) {
      // 어느 대화인지 모르면 보낼 곳도, 초안을 둘 곳도 없다. 알리고 지운다.
      store.remove(reply.clientMsgId);
      await deps
        .notify(reply.requestIdentifier, context.copy.notSentTitle, context.copy.notSentBody, origin)
        .catch(() => {});
      console.warn(`${LOG} queued reply removed (unreadable notification)`);
      continue;
    }

    try {
      await deps.send(reply, envelope);
    } catch (cause) {
      if (!context.isCurrent()) return;
      const givingUp =
        refused(cause) || deps.now() - reply.createdAtMs >= QUEUED_REPLY_GIVE_UP_MS;
      if (!givingUp) {
        console.warn(`${LOG} queued reply kept for a retry`);
        continue;
      }
      const root = threadRootId(envelope);
      const key = root ? threadDraftKey(root) : channelDraftKey(envelope.channelId);
      const now = deps.now();
      seedDraft(key, reply.text, now, envelope.channelId);
      if (readDraft(key, now) !== reply.text) {
        // 그 자리에 쓰던 글이 있거나 저장소가 받지 않았다. 덮지 않고 다음에 다시 한다.
        console.warn(`${LOG} queued reply kept (the draft slot is taken)`);
        continue;
      }
      store.remove(reply.clientMsgId);
      await deps
        .notify(reply.requestIdentifier, context.copy.drafted, '', origin)
        .catch(() => {});
      console.log(`${LOG} queued reply moved to the draft`);
      continue;
    }
    store.remove(reply.clientMsgId);
    await deps.dismiss(reply.requestIdentifier).catch(() => {});
    console.log(`${LOG} queued reply sent`);
  }
}

let running: Promise<void> | null = null;
let again: {context: DrainContext; deps?: DrainDeps} | null = null;

/**
 * 보관 목록을 비운다. 한 번에 하나만 돌고, 도는 중에 부르면 끝난 뒤 마지막 부름으로 한 번 더 돈다
 * (그 사이에 새 답장이 남았을 수 있다). 던지지 않는다.
 */
export function drainQueuedReplies(
  context: DrainContext,
  deps?: DrainDeps,
): Promise<void> {
  if (running) {
    again = {context, deps};
    return running;
  }
  const run = async () => {
    let next: {context: DrainContext; deps?: DrainDeps} | null = {context, deps};
    while (next) {
      const current: {context: DrainContext; deps?: DrainDeps} = next;
      again = null;
      try {
        await drainOnce(current.context, current.deps ?? liveDeps());
      } catch (cause) {
        console.warn(`${LOG} queued replies drain failed`, cause instanceof Error ? cause.name : 'unknown');
      }
      next = again;
    }
  };
  running = run().finally(() => {
    running = null;
  });
  return running;
}

/** 로그아웃: 이 폰에 남은 답장을 모두 지운다. 던지지 않는다. */
export function clearQueuedReplies(store?: QueuedReplyStore | null): void {
  try {
    (store === undefined ? nativeQueuedReplyStore() : store)?.clear();
  } catch {
    // 키체인이 답하지 않아도 로그아웃은 막지 않는다.
  }
}
