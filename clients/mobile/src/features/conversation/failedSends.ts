import {containsSecretKey} from '@momo/core/features/chat/secretKey';
import {
  parseFailedSend,
  serializeFailedSend,
} from '@momo/core/features/connection/failedSendRecord';
import type {SendFailureKind} from '@momo/core/features/connection/sendFailure';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import {DRAFT_TTL_MS} from './drafts';

// =============================================================================
// 보내지 못한 글은 화면을 떠나도 남는다 (#5222, #5201 결정 ⑤ · 웹 `chat/draftStore.ts` 의 「보내지 못한 글」 절의 짝).
//
// 보내다 실패한 글은 지금까지 메모리에만 있었다. 채널을 옮기거나 앱이 죽으면 사라졌다 - 쓰다 만 글(`drafts.ts`)과 같은 이유로(되돌릴 길이
// 없는 유일한 종류의 손실) 이 기기에 남겼다가 그 채널을 다시 열면 **실패 행으로** 돌려놓는다.
//
// 본문만 초안으로 돌려놓지 않고 **행 전체**를 남기는 까닭은 웹과 같다: 「실패」는 서버가 못 받았다는 증명이 아니다(응답만 유실됐을 수 있다).
// 행을 그대로 두면 멱등 키가 살아남아 다시 보내도 서버가 중복을 막고, 서버가 이미 받은 글이면 채널을 열 때 확정 메시지와 만나 스스로 정리된다
// (`unsettledPending`). 본문만 돌리면 새 키로 나가 같은 글이 두 번 보일 수 있다. 첨부 id·인용도 행이 들고 있어 잃지 않는다.
//
// 저장 규칙은 초안과 같다: MMKV(`NON_SECRET_KEYS`, 동기로 읽힌다), API 키 모양이 든 글은 두지 않고, 30일이 지나면 읽을 때 버리고, 최대 50개를
// 넘으면 오래된 것부터 버리고, 로그아웃이 전부 지운다(`clearAllFailedSends`, `session/useSession.tsx`). 열쇠를 열거할 수 없는 저장소 이음매라
// (`NonSecretStore` 에 `getAllKeys` 가 없다 - `drafts.ts` 머리말) 지도 하나에 담는다. 한 건의 모양은 코어(`failedSendRecord.ts`)가 갖는다:
// 읽을 때 모양을 의심하고, 읽은 행은 언제나 「못 보낸」 행이다.
//
// 스레드 답글의 행도 같은 지도에 같은 규칙으로 남는다(#5262). 뿌리(`rootId`)가 행에 실려 있어(#4888) 직렬화가
// 그대로 들고 가고, 되살린 행은 `useTimeline` 의 다시 보내기가 뿌리를 읽어 답글 길로 보낸다. 이 파일은 글과 답글을 가르지 않는다.
//
// 어떤 함수도 던지지 않는다: 저장이 실패했다고 보내기 흐름이 깨지면 안 된다. 다만 못 남기면 그 글은 예전처럼 메모리에만 있다.
// =============================================================================

/** 동시에 들고 있는 보내지 못한 글의 최대 개수. 넘으면 오래된 것부터 버린다. */
export const FAILED_SEND_LIMIT = 50;

/** 지도: 열쇠 → 코어가 직렬화한 한 건(문자열). */
type FailedSendMap = Readonly<Record<string, string>>;

function keyOf(workspaceId: string, channelId: string, clientMsgId: string): string {
  return `${workspaceId.toLowerCase()}:${channelId.toLowerCase()}:${clientMsgId.toLowerCase()}`;
}

/** 저장된 지도. 깨진 JSON 은 빈 지도로 읽는다 - 글 하나 때문에 앱이 죽는 것은 글을 잃는 것보다 나쁘다. */
function readMap(): Record<string, string> {
  const raw = nonSecretStore().getString(NON_SECRET_KEYS.failedSends);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return {};
    // 문자열이 아닌 값은 문자열로 바꿔 두면 아래 `parseFailedSend` 가 JSON 이 아니라 읽을 수 없는 항목으로 거르고 `pruned` 가 버린다
    // (모양 검사를 코어 한 곳에 둔다).
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) out[key] = String(value);
    return out;
  } catch {
    return {};
  }
}

// 로그아웃이 지운 뒤에는 다음 세션까지 새로 남기지 않는다 (#5799, 웹 `chat/draftStore.ts`의 같은 문). 세션 트리는 로그아웃 **뒤에**
// 내려가고, 내려가는 대화는 결과를 모르는 전송을 남기며(`useTimeline` 정리 함수), 그 요청이 늦게 실패하면 또 남긴다. 이 파일의 쓰기가
// 모두 `writeMap`을 지나므로 여기서 막는다. 지우기는 언제나 통한다. 닫는 것은 `closeFailedSendsForSignOut`, 여는 것은 `openFailedSendsForSession`.
let closedForSignOut = false;
/** 지금 세션의 사람(멤버 id, 소문자). 앞 사람의 요청이 다음 사람의 세션에서 늦게 실패해도 그 글은 남기지 않는다. */
let openFor: string | null = null;

function writeMap(map: FailedSendMap): void {
  const store = nonSecretStore();
  if (Object.keys(map).length === 0) {
    store.remove(NON_SECRET_KEYS.failedSends);
    return;
  }
  if (closedForSignOut) return;
  store.set(NON_SECRET_KEYS.failedSends, JSON.stringify(map));
}

/** 시한 지난 것과 정원을 넘긴 것을 버린 지도. 모양이 깨진 항목도 버린다. 입력을 바꾸지 않는다. */
function pruned(map: FailedSendMap, nowMs: number): Record<string, string> {
  const alive: Array<[string, string, number]> = [];
  for (const [key, raw] of Object.entries(map)) {
    const stored = parseFailedSend(raw);
    if (stored === null || nowMs - stored.atMs >= DRAFT_TTL_MS) continue;
    alive.push([key, raw, stored.atMs]);
  }
  alive.sort((a, b) => b[2] - a[2]);
  return Object.fromEntries(alive.slice(0, FAILED_SEND_LIMIT).map(([key, raw]) => [key, raw]));
}

/** 보내지 못한 글을 이 기기에 남긴다(이미 있으면 갱신). 키 모양이 든 글은 남기지 않고 있던 것도 지운다. */
export function rememberFailedSend(
  workspaceId: string,
  row: PendingMessage,
  kind: SendFailureKind | null,
  nowMs: number = Date.now(),
): void {
  try {
    if (openFor !== null && row.authorMemberId.toLowerCase() !== openFor) return;
    const key = keyOf(workspaceId, row.channelId, row.clientMsgId);
    if (containsSecretKey(row.body)) {
      forgetFailedSend(workspaceId, row.channelId, row.clientMsgId);
      return;
    }
    writeMap(pruned({...readMap(), [key]: serializeFailedSend(row, kind, nowMs)}, nowMs));
  } catch {
    // 저장소가 답하지 않는다. 글은 화면에 그대로 있다.
  }
}

/** 이 글은 끝났다(보냈다·지웠다·서버가 이미 받았다). 이 기기에서도 지운다. */
export function forgetFailedSend(
  workspaceId: string,
  channelId: string,
  clientMsgId: string,
): void {
  try {
    const map = {...readMap()};
    const key = keyOf(workspaceId, channelId, clientMsgId);
    if (!(key in map)) return;
    delete map[key];
    writeMap(map);
  } catch {
    // 위와 같다.
  }
}

/**
 * 이 채널에 남아 있는 보내지 못한 글, 보낸 순서대로. 시한이 지난 항목은 읽는 김에 지운다. 다른 사람이 쓴 글(작성자가 다른 멤버)은
 * 돌려주지 않는다: 같은 기기를 나눠 쓰는 두 계정이 서로의 글을 보지 않게 한다.
 */
export function readFailedSends(
  workspaceId: string,
  channelId: string,
  authorMemberId: string,
  nowMs: number = Date.now(),
): Array<{row: PendingMessage; kind: SendFailureKind | null}> {
  try {
    const map = readMap();
    const live = pruned(map, nowMs);
    if (Object.keys(live).length !== Object.keys(map).length) writeMap(live);
    const prefix = `${workspaceId.toLowerCase()}:${channelId.toLowerCase()}:`;
    const out: Array<{row: PendingMessage; kind: SendFailureKind | null}> = [];
    for (const [key, raw] of Object.entries(live)) {
      if (!key.startsWith(prefix)) continue;
      const stored = parseFailedSend(raw);
      if (stored === null) continue;
      if (stored.row.authorMemberId.toLowerCase() !== authorMemberId.toLowerCase()) continue;
      out.push({row: stored.row, kind: stored.kind});
    }
    out.sort((a, b) => a.row.createdAtMs - b.row.createdAtMs);
    return out;
  } catch {
    return [];
  }
}

/**
 * 로그아웃했다. 이 기기에 남은 보내지 못한 글은 **전부** 없다 - 초안(`clearAllDrafts`)과 같은 이유로, 안 보낸 글은 보낸 메시지보다 사적이고
 * 이 기기에만 있다. 지도 키 자체를 지운다.
 */
export function clearAllFailedSends(): void {
  try {
    nonSecretStore().remove(NON_SECRET_KEYS.failedSends);
  } catch {
    // 로그아웃 자체는 이미 진행됐다.
  }
}

/** 로그아웃(#5799): 전부 지우고, 다음 세션까지 새로 남기지 않는다 — 내려가는 대화와 늦게 실패한 전송이 지운 자리를 되살리지 못하게. */
export function closeFailedSendsForSignOut(): void {
  closedForSignOut = true;
  clearAllFailedSends();
}

/** 세션이 섰다(로그인·복원). 이 사람의 보내지 못한 글을 다시 이 기기에 남기고, 다른 사람이 남긴 것은 지운다. */
export function openFailedSendsForSession(memberId: string): void {
  closedForSignOut = false;
  openFor = memberId.toLowerCase();
  try {
    const map = readMap();
    const mine: Record<string, string> = {};
    for (const [key, raw] of Object.entries(map)) {
      if (parseFailedSend(raw)?.row.authorMemberId.toLowerCase() === openFor) mine[key] = raw;
    }
    if (Object.keys(mine).length !== Object.keys(map).length) writeMap(mine);
  } catch {
    // 읽을 때도 작성자로 거른다(`readFailedSends`).
  }
}
