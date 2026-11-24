import {containsSecretKey} from '@momo/core/features/chat/secretKey';
import {ApiError, sendMessage, sendThreadReply} from '@momo/core/lib/api';
import {
  dismissNotificationAsync,
  getPresentedNotificationsAsync,
  scheduleNotificationAsync,
} from 'expo-notifications';

import {
  channelDraftKey,
  readDraft,
  seedDraft,
  threadDraftKey,
} from '../features/conversation/drafts';
import {getPersistedSession} from '../storage/secureSession';
import {parsePushEnvelope, threadRootId, type PushEnvelope} from './envelope';
import {nativeQueuedReplyStore, type QueuedReplyStore} from './native';

// =============================================================================
// 잠금 화면 답장의 보관 목록을 비운다 (#6036, 수명 · 물러남 #6092 — ADR-0204 증보 7 A7-13).
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
//   - `handlePushResponse` 의 답장 갈래는 처리기가 **이 응답을 남겼으면** 보내지 않고 물러난다
//     (`notifications.ts`, `native.ts` `nativeReplyOutcome`). 남기지 못했으면 JS 가 직접 보내고, 성공하면
//     처리기가 띄운 「보내지 못했어요」 줄을 걷는다.
//   - 목록에서 지우는 것은 서버가 받았다고 답한 뒤(2xx)다. 서버가 「대화를 나가기 전에 보낸 글」(409
//     `message_before_leave`)이라고 답해도 그 글은 이미 있으므로 조용히 지운다.
//
// ## 나이를 먼저 본다 (A7-13 수명)
//
// 나이는 남긴 시각(`createdAtMs`)부터 잰다. 보내기 **전에** 본다.
//   - 7일 이상: 보내지도 초안에 두지도 않고 지운다. 새로 알리지 않고 「앱을 열면 보내요」 줄만 걷는다.
//     (로그인과 상관없이 네이티브도 앱이 뜰 때 · 새 답장을 남길 때 같은 것을 지운다.)
//   - 24시간 이상: 보내지 않고 그 대화(스레드면 스레드)의 초안으로 넘긴다.
//
// ## 끝내 못 보내면
//
// 서버가 분명히 거절했으면(408 · 429 를 뺀 4xx — 글은 쓰이지 않았다) 「거절됨」을 항목에 적고(다시 보내지
// 않는다) 초안으로 넘긴다. 초안 자리에 사람이 쓰던 글이 있으면 덮지 않고 목록에 두어 자리가 나기를 기다린다
// — 7일을 넘기지 않는다. 초안 저장소가 받지 않는 글(비밀 값처럼 보이는 글)은 지우고 「보내지 못했어요」로
// 알린다. 망이 끊긴 것 · 5xx · 429 는 같은 열쇠로 다시 보낼 수 있으므로 24시간까지 목록에 둔다.
//
// 읽지 못하는 항목(모양의 판이 다르거나 풀리지 않음)은 건너뛴다. JS 는 그 열쇠를 읽지 못하므로 네이티브가
// 키체인 계정으로 지운다(앱이 뜰 때).
//
// ## 누구의 것인가
//
// 항목에는 남길 때의 워크스페이스와 멤버가 적혀 있다. 지금 들어와 있는 사람과 다르면 **보내지도,
// 초안으로 넣지도 않고 지운다.** 멤버 id 는 워크스페이스마다 다르므로 다르면 다른 사람이거나 다른
// 워크스페이스의 신원이고, 그 사람의 글을 지금 사람의 이름으로 보내거나 지금 사람의 입력창에
// 두면 안 된다. 그 답장의 「앱을 열면 보내요」 줄은 걷기만 한다(새로 알리면 지금 사람에게 앞 사람이 답장했다는
// 것을 알려 주게 된다). 로그아웃은 목록을 통째로 지운다(`session/useSession.tsx`).
//
// 글 본문과 열쇠는 로그에 남기지 않는다.
// =============================================================================

const LOG = '[push]';

/** 남긴 지 이만큼 지난 답장은 보내지 않고 초안으로 넘긴다(A7-13). 경계는 「이상」이다. */
export const QUEUED_REPLY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** 남긴 지 이만큼 지난 답장은 보내지도 두지도 않고 지운다(A7-13). Swift `MomoPushReplyContract.maxAgeMs` 와 같다. */
export const QUEUED_REPLY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** 서버가 분명히 거절한 때. 있으면 다시 보내지 않는다(A7-13). */
  refusedAtMs?: number;
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
  if (item.refusedAtMs !== undefined && item.refusedAtMs !== null && typeof item.refusedAtMs !== 'number') {
    return null;
  }
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

/**
 * 로그인한 트리의 비우기 문맥: 「지금도 같은 사람인가」는 저장된 세션을 **물을 때마다** 다시 읽는다. 보내는 도중에
 * 로그아웃 · 다른 계정 로그인이 끼면 그 뒤의 일(초안에 넣기 · 다음 항목)을 하지 않는다. `PushProvider` 가 쓴다.
 */
export function signedInDrainContext(
  workspaceId: string,
  memberId: string,
  copy: QueuedReplyCopy,
): DrainContext {
  const wanted = memberId.toLowerCase();
  return {
    workspaceId,
    memberId,
    isCurrent: () => getPersistedSession()?.member.id.toLowerCase() === wanted,
    copy,
  };
}

export interface DrainDeps {
  store: QueuedReplyStore | null;
  send: (reply: QueuedReply, envelope: PushEnvelope) => Promise<void>;
  now: () => number;
  /** 알림 한 줄(같은 식별자의 「앱을 열면 보내요」 줄을 바꾼다). */
  notify: (identifier: string, title: string, body: string, origin: unknown) => Promise<void>;
  /** 그 식별자의 줄을 걷는다(`dismissReplyLine`). */
  dismiss: (identifier: string) => Promise<void>;
}

function sendQueued(reply: QueuedReply, envelope: PushEnvelope): Promise<void> {
  const root = threadRootId(envelope);
  const sent = root
    ? sendThreadReply(envelope.workspaceId, envelope.channelId, root, reply.clientMsgId, reply.text)
    : sendMessage(envelope.workspaceId, envelope.channelId, reply.clientMsgId, reply.text);
  return sent.then(() => undefined);
}

/**
 * 답장의 결과 줄(처리기가 올린 「앱을 열면 보내요」 · 「보내지 못했어요」, 여기서 올린 「초안으로 남겼어요」)을 걷는다.
 * **우리 줄일 때만** 걷는다: 줄에는 범주가 없다(단추 없음). 같은 collapse id 의 알림은 식별자를 같이 쓰므로, 그
 * 식별자에 그 사이 새 메시지 알림(범주 있음)이 왔으면 그것은 사람이 아직 보지 않은 알림이다 — 걷지 않는다.
 * 던지지 않는다.
 */
export async function dismissReplyLine(identifier: string): Promise<void> {
  try {
    const presented = await getPresentedNotificationsAsync();
    const line = presented.find(notification => notification.request.identifier === identifier);
    if (!line) return;
    const category = line.request.content.categoryIdentifier;
    if (typeof category === 'string' && category !== '') return;
    await dismissNotificationAsync(identifier);
  } catch {
    // 줄을 걷지 못해도 답장은 이미 갔다.
  }
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
  dismiss: dismissReplyLine,
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

/**
 * 「이 열쇠의 글은 대화를 나가기 전에 이미 보냈다」(ADR-0177 증보 D17). 글은 서버에 있다 — 보낸 것과 같다. 클라이언트는
 * 조용히 지운다(#6036 보안 검수 r1 L3: 거절로 읽으면 이미 간 글이 초안에 한 번 더 들어간다).
 */
function alreadySentBeforeLeave(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.code === MESSAGE_BEFORE_LEAVE;
}
const MESSAGE_BEFORE_LEAVE = 'message_before_leave';

function originOf(reply: QueuedReply): unknown {
  try {
    return JSON.parse(reply.origin);
  } catch {
    return undefined;
  }
}

/**
 * 보내지 않기로 한 항목을 그 대화의 초안으로 넘긴다. 초안 저장소가 받지 않는 글이면 지우고 「보내지 못했어요」로
 * 알린다. 자리에 쓰던 글이 있으면 목록에 둔다(다음 비우기에서 다시 해 본다 — 7일까지).
 */
async function moveToDraft(
  reply: QueuedReply,
  envelope: PushEnvelope,
  origin: unknown,
  context: DrainContext,
  deps: DrainDeps,
  store: QueuedReplyStore,
): Promise<void> {
  if (containsSecretKey(reply.text)) {
    // 초안 저장소는 비밀 값처럼 보이는 글을 받지 않는다(`drafts.ts` `saveDraft`). 자리가 나도 영원히 받지 않으므로
    // 기다릴 것이 없다.
    store.remove(reply.clientMsgId);
    await deps
      .notify(reply.requestIdentifier, context.copy.notSentTitle, context.copy.notSentBody, origin)
      .catch(() => {});
    console.warn(`${LOG} queued reply removed (the draft does not take it)`);
    return;
  }
  const root = threadRootId(envelope);
  const key = root ? threadDraftKey(root) : channelDraftKey(envelope.channelId);
  const now = deps.now();
  seedDraft(key, reply.text, now, envelope.channelId);
  if (readDraft(key, now) !== reply.text) {
    // 그 자리에 쓰던 글이 있다. 덮지 않고 다음에 다시 한다.
    console.warn(`${LOG} queued reply kept (the draft slot is taken)`);
    return;
  }
  store.remove(reply.clientMsgId);
  await deps.notify(reply.requestIdentifier, context.copy.drafted, '', origin).catch(() => {});
  console.log(`${LOG} queued reply moved to the draft`);
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
      // 지킬 수 없게 된 「앱을 열면 보내요」 줄만 걷는다. 새로 알리지 않는다(머리말 「누구의 것인가」).
      await deps.dismiss(reply.requestIdentifier).catch(() => {});
      console.log(`${LOG} queued reply removed (not this member's)`);
      continue;
    }
    const age = deps.now() - reply.createdAtMs;
    if (age >= QUEUED_REPLY_MAX_AGE_MS) {
      store.remove(reply.clientMsgId);
      await deps.dismiss(reply.requestIdentifier).catch(() => {});
      console.log(`${LOG} queued reply removed (too old)`);
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
    if (age >= QUEUED_REPLY_GIVE_UP_MS || typeof reply.refusedAtMs === 'number') {
      // 하루가 지났거나 서버가 한 번 분명히 거절했다: 다시 보내지 않는다.
      await moveToDraft(reply, envelope, origin, context, deps, store);
      continue;
    }

    try {
      await deps.send(reply, envelope);
    } catch (cause) {
      if (!context.isCurrent()) return;
      if (alreadySentBeforeLeave(cause)) {
        store.remove(reply.clientMsgId);
        await deps.dismiss(reply.requestIdentifier).catch(() => {});
        console.log(`${LOG} queued reply was already sent`);
        continue;
      }
      if (!refused(cause)) {
        console.warn(`${LOG} queued reply kept for a retry`);
        continue;
      }
      if (!store.markRefused(reply.clientMsgId)) {
        console.warn(`${LOG} queued reply could not be marked refused`);
      }
      await moveToDraft(reply, envelope, origin, context, deps, store);
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
