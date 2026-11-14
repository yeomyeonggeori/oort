import { useSyncExternalStore } from "react";
import { containsSecretKey } from "@momo/core/features/chat/secretKey";
import { parseFailedSend, serializeFailedSend } from "@momo/core/features/connection/failedSendRecord";
import type { SendFailureKind } from "@momo/core/features/connection/sendFailure";
import type { PendingMessage } from "@momo/core/features/timeline/model";

// =============================================================================
// 쓰다 만 글은 채널을 옮겨도 남는다 (U4-f · 진단 H-10).
//
// 진단의 한 문장: *"채널을 옮기면 쓰던 글이 사라진다."* 컴포저는 채널마다
// 마운트/언마운트되고 본문은 `useState` 에만 있었으므로, 반쯤 쓴 문단은 탭 한 번에
// 없어졌다. 되돌릴 길이 없는 유일한 종류의 손실이다 — 보낸 메시지는 지워도 원장에
// 남지만, 안 보낸 글은 어디에도 없다.
//
// ## 어디에 두는가
//
// `localStorage`. 세 후보를 견줬다:
//
//   * **메모리** — 지금 상태. 채널 전환에 못 살아남으므로 애초에 답이 아니다.
//   * **`sessionStorage`** — 탭을 닫으면 사라진다. 데스크톱 셸(Tauri)은 창을 닫는
//     것이 곧 앱을 닫는 것이라, 「내일 이어서 쓴다」가 통째로 없어진다. 초안이
//     지켜야 할 가장 흔한 경우가 그것이다.
//   * **서버** — 다른 기기에서도 이어 쓸 수 있지만 초안 동기화 계약이 없고,
//     쓰다 만 글을 서버로 보내는 것은 이 제품이 아직 하지 않기로 한 일이다
//     (단일 쓰기경로는 **보낸 메시지**의 규율이고, 초안은 메시지가 아니다).
//
// 그래서 `localStorage` 이고, 그 선택의 비용을 여기 적어 둔다: **공용 기기에서
// 초안은 다음 사람이 읽을 수 있다.** 이 앱은 이미 같은 자리에 세션 기록을 두고
// 있고(`lib/session.ts` 가 그 위험을 적어 두었다), 로그아웃이 그 둘을 함께 지운다
// — 아래 [`closeDraftsForSignOut`] 를 세션 정리가 부른다(지우고, 다음 로그인까지 닫는다).
//
// ## 수명
//
//   * **보내면 즉시 지운다.** 컴포저가 입력을 비우는 그 자리에서 함께 지운다 —
//     화면에 없는 글이 저장소에 남으면 다음 방문에 유령이 돌아온다.
//   * **비우면 지운다.** 빈 문자열을 「빈 초안」으로 저장하지 않는다. 저장하면
//     아래 정원(TOTAL) 을 빈 항목이 차지한다.
//   * **로그아웃에 전부 지운다.**
//   * **30일이 지나면 읽을 때 폐기한다.** 「한 달 전에 쓰다 만 문장」은 이어 쓸
//     글이 아니라 그 사람이 잊은 글이고, 그것이 채널을 열 때 입력창에 복원되면
//     실수로 보내진다. 시한은 **쓸 때가 아니라 읽을 때** 판정한다: 저장소를
//     주기적으로 훑는 타이머는 이 앱에 없고, 있어야 할 이유도 없다.
//   * **최대 [`MAX_DRAFTS`] 개.** 초과하면 가장 오래된 것부터 버린다. 상한이 없으면
//     채널 수만큼 자라고, `localStorage` 는 오리진당 몇 MB짜리 공용 자원이라
//     세션 기록이 들어갈 자리를 초안이 먹을 수 있다.
//
// ## 무엇을 저장하는가 — 본문뿐
//
// 인용(`quote`)과 1회 라우팅 오버라이드는 **저장하지 않는다.** 그 둘은 이미
// 「이 전송분과 함께 떠난다」는 계약을 갖고 있고(`Composer.submit`), 하루 뒤에
// 돌아온 사람에게 그때 걸어 둔 인용이 되살아나면 그것은 그 사람이 고르지 않은
// 주장을 대화에 넣는 일이다. 초안은 **글**이지 발송 설정이 아니다.
// =============================================================================

const PREFIX = "momo.draft.v1:";
/** 이보다 오래된 초안은 읽는 순간 버린다. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 동시에 들고 있는 초안의 최대 개수. */
export const MAX_DRAFTS = 50;

interface StoredDraft {
  /** 본문. 빈 값은 저장하지 않으므로 여기 오면 언제나 내용이 있다. */
  text: string;
  /** 마지막으로 손댄 시각. 수명과 정원 판정의 유일한 기준이다. */
  atMs: number;
  /** 쓴 사람(멤버 id, 소문자). 없으면 작성자를 모르는 값이다(아래 「누구의 초안인가」). */
  author?: string;
  /**
   * 답글 초안이 속한 대화(채널 id, 소문자). 열쇠가 뿌리 글 id 뿐이라 대화 단위로 찾으려면 같이 적는다(ADR-0177 증보 2026-11-14 D17).
   * 없으면 이 칸 전에 쓴 값이다.
   */
  channelId?: string;
}

/**
 * 저장소에 남아 있는 초안 한 줄. `{ text, atMs }` 스키마는 그대로이고, 열쇠에서
 * 워크스페이스·채널을 풀어 목록이 읽기만 한다. 스레드 컴포저 본문은 이 저장소에
 * 없다(채널 열쇠만 쓴다).
 */
export interface DraftRecord {
  key: string;
  workspaceId: string;
  channelId: string;
  text: string;
  atMs: number;
}

const listeners = new Set<() => void>();
let draftsEpoch = 0;

function emitDraftsChanged(): void {
  draftsEpoch += 1;
  for (const listener of listeners) listener();
}

function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function draftsEpochSnapshot(): number {
  return draftsEpoch;
}

/** 같은 탭의 초안 목록·사이드바 항법이 저장소 변화를 다시 읽게 한다. */
export function useDraftsEpoch(): number {
  return useSyncExternalStore(
    subscribeDrafts,
    draftsEpochSnapshot,
    draftsEpochSnapshot
  );
}

/**
 * 초안 하나의 열쇠. 워크스페이스까지 넣는 이유는 채널 id 가 워크스페이스마다
 * 새로 발급되기 때문이 아니라, **같은 기기에서 두 워크스페이스를 오가는 사람**의
 * 초안이 섞이지 않게 하기 위해서다.
 */
export function draftKey(workspaceId: string, channelId: string): string {
  return `${PREFIX}${workspaceId.toLowerCase()}:${channelId.toLowerCase()}`;
}

/** 저장 열쇠에서 워크스페이스·채널을 푼다. 형식이 아니면 `null`. */
export function parseDraftKey(
  key: string
): { workspaceId: string; channelId: string } | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) return null;
  const workspaceId = rest.slice(0, colon);
  const channelId = rest.slice(colon + 1);
  if (workspaceId === "" || channelId === "" || channelId.includes(":")) {
    return null;
  }
  return { workspaceId, channelId };
}

function readRaw(key: string): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(key);
  } catch {
    // 저장소가 막힌 환경(프라이빗 모드, 용량 초과, 임베디드 웹뷰 정책). 초안이
    // 살아남지 못할 뿐 입력은 그대로 동작한다 — 세션 저장소가 쓰는 규율과 같다.
    return null;
  }
}

// 로그아웃이 지운 뒤에는 다음 로그인까지 새로 쓰지 않는다 (#5799).
//
// 지우는 순간과 세션이 실제로 내려가는 순간 사이에 쓰는 손이 있다: 열려 있던 입력창은 내려가며 마지막 글을
// 남기고, 날아가던 전송은 내려갈 때와 늦게 실패할 때 「못 보낸 글」을 남긴다. 지우는 순서를 맞추는 것으로는
// 새 입력창·늦게 끝나는 요청이 생길 때마다 다시 깨진다. 그래서 문을 쓰는 쪽(이 저장소) 하나에 둔다: 이 파일의
// 모든 쓰기가 아래 `writeRaw`를 지나므로 여기서 막으면 초안·답글 초안·보내지 못한 글이 함께 지켜진다.
// 지우기(`null`)는 언제나 통한다. 닫는 것은 `closeDraftsForSignOut`, 여는 것은 `openDraftsForSignIn`이다.
//
// 닫힘 표지는 **탭 사이에 공유되는 값**이다(`localStorage`의 한 값). 로그아웃은 같은 기기의 다른 탭·창도 끝내고, 그쪽의
// 입력창도 내려가며 쓴다 — 탭마다 메모리 깃발이면 그 쓰기를 막지 못한다(이모티콘 기기 캐시의 세션 세대와 같은 이유,
// `features/expressions/disk/generation.ts`). 이 탭은 열린 순간의 표지를 들고 있고, 표지가 바뀌었으면 쓰지 않는다.
const SIGN_OUT_MARK_KEY = "momo.drafts.signed-out-mark.v1";

function readSignOutMark(): string | null {
  return readRaw(SIGN_OUT_MARK_KEY);
}

/** 이 탭이 로그아웃했다: 공유 표지를 쓰지 못했어도 이 탭은 닫혀 있다(어떤 저장값과도 같지 않은 값). */
const CLOSED_HERE: unique symbol = Symbol("drafts-closed-here");
/** 이 탭이 쓰기를 연 순간의 표지(모듈이 뜬 때·로그인한 때). 지금 표지와 다르면 그 뒤 어디선가 로그아웃했다. */
let openedMark: string | null | typeof CLOSED_HERE = readSignOutMark();

function writeRaw(key: string, value: string | null): void {
  if (value !== null && readSignOutMark() !== openedMark) return;
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 위와 같다 */
  }
}

function draftKeys(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function threadDraftKeys(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(THREAD_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function parse(raw: string | null): StoredDraft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { text, atMs, author, channelId } = value as Record<string, unknown>;
    if (typeof text !== "string" || text === "") return null;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    const draft: StoredDraft = typeof author === "string" && author !== "" ? { text, atMs, author } : { text, atMs };
    if (typeof channelId === "string" && channelId !== "") draft.channelId = channelId;
    return draft;
  } catch {
    // 손으로 고쳐졌거나 옛 판이다. 읽을 수 없는 초안은 초안이 아니다.
    return null;
  }
}

// 누구의 초안인가 (#5799). 토큰 만료로 나가면 초안은 남는다 — 같은 사람이 다시 들어와 이어 쓰게. 그래서 초안·답글 초안에 쓴 사람을
// 적고, 읽을 때 이 탭의 지금 사람과 다르면 돌려주지 않으며, 다른 사람이 로그인하면 그때 앞 사람 것을 지운다(`adoptDraftAuthor`).
// 보내지 못한 글은 행이 이미 작성자를 든다(`row.authorMemberId`). 작성자를 모르는 값(이 규칙 전에 저장된 것)은 누구의 것으로도 치지
// 않는다: 로그인·복원 때 지우고, 그 전에도 사람이 든 탭에서는 읽지 않는다 — 한 번의 초안 손실보다 다른 사람에게 보이는 쪽이 크다.
// 지금 사람은 이 탭이 로그인·복원 때 든 값이다(세션이 끝난 뒤의 마지막 저장도 그 사람의 것으로 적히게).
let draftAuthor: string | null = null;

function writtenBy(author: string | undefined): boolean {
  return (author ?? null) === draftAuthor;
}

function stamped(text: string, atMs: number): StoredDraft {
  return draftAuthor === null ? { text, atMs } : { text, atMs, author: draftAuthor };
}

/**
 * 이 채널의 초안. 없거나 시한이 지났으면 `""`.
 *
 * 시한이 지난 항목은 **읽는 김에 지운다**: 다음 읽기에서 같은 판정을 다시 하는
 * 것보다 싸고, 이 앱에 저장소 청소 타이머를 새로 들이지 않는 유일한 길이다.
 */
export function readDraft(
  workspaceId: string,
  channelId: string,
  nowMs: number = Date.now()
): string {
  const key = draftKey(workspaceId, channelId);
  const draft = parse(readRaw(key));
  if (draft === null) return "";
  if (nowMs - draft.atMs > DRAFT_TTL_MS) {
    writeRaw(key, null);
    emitDraftsChanged();
    return "";
  }
  if (!writtenBy(draft.author)) return "";
  return draft.text;
}

/**
 * 초안을 남긴다. 빈 글은 저장이 아니라 **삭제**다.
 *
 * 정원(`MAX_DRAFTS`)을 넘기면 가장 오래된 것부터 버린다. 지금 쓰는 초안은 방금
 * 손댄 것이라 언제나 살아남는다.
 */
export function writeDraft(
  workspaceId: string,
  channelId: string,
  text: string,
  nowMs: number = Date.now()
): void {
  const key = draftKey(workspaceId, channelId);
  // 키 모양이 든 글은 두지 않는다 (#2942 GC-1, brief §3.4 「비밀값은 draftStore에
  // 가지 않는다」). 초안은 이 기기의 로컬 저장소에 평문으로 남고, 그 글은 컴포저가
  // 어차피 보내지 않는 글이다. 입력마다 쓰는 길과 창을 닫을 때 쓰는 길이 모두
  // 이 함수를 지나므로 문은 여기 하나다.
  if (text === "" || containsSecretKey(text)) {
    writeRaw(key, null);
    emitDraftsChanged();
    return;
  }
  writeRaw(key, JSON.stringify(stamped(text, nowMs)));
  pruneDrafts(nowMs);
  emitDraftsChanged();
}

/** 보냈다. 화면에서 사라진 글은 저장소에서도 사라진다. */
export function clearDraft(workspaceId: string, channelId: string): void {
  writeRaw(draftKey(workspaceId, channelId), null);
  emitDraftsChanged();
}

/**
 * 같은 탭의 컴포저가 초안 저장소를 다시 읽게 하는 사건.
 * `storage` 이벤트는 다른 탭에만 뜨므로, 이 채널에 이미 마운트된 입력창은
 * 이 이름으로만 복원한다.
 */
export const COMPOSER_SEED_EVENT = "momo:composer-seed";

/**
 * 같은 탭의 초안 목록·사이드바 항법이 저장소 직접 쓰기(캡처 하네스)를
 * 다시 읽게 하는 사건. `storage` 는 다른 탭에만 뜬다.
 */
export const DRAFTS_CHANGED_EVENT = "momo:drafts-changed";

/**
 * 빈 입력창에만 심는다. 쓰다 만 글이 있으면 덮지 않고 false.
 * 저장과 사건을 한 함수에서 내는 이유는 저장만 하고 사건이 빠지면
 * 마운트된 컴포저가 초안을 영원히 못 보기 때문이다.
 */
export function seedComposerText(
  workspaceId: string,
  channelId: string,
  text: string,
  nowMs: number = Date.now()
): boolean {
  if (text.trim() === "") return false;
  const existing = readDraft(workspaceId, channelId, nowMs);
  if (existing.trim() !== "") return false;
  writeDraft(workspaceId, channelId, text, nowMs);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(COMPOSER_SEED_EVENT, {
        detail: { workspaceId, channelId, text },
      })
    );
  }
  return true;
}

/**
 * 스레드 컴포저에 심는 사건 (#2948 GC-7 「운영자에게 부탁하기」).
 *
 * 스레드 초안은 저장소가 아니라 `ThreadComposer`의 지역 상태라, 심기는 마운트된
 * 입력창이 직접 받는다. 사건은 동기로 돈다: 받은 입력창이 `result`에 답을 적고,
 * 부른 쪽이 곧바로 읽는다. 받는 입력창이 없으면 `mounted=false`다.
 */
export const THREAD_COMPOSER_SEED_EVENT = "momo:thread-composer-seed";

export interface ThreadComposerSeed {
  rootId: string;
  text: string;
  result: { mounted: boolean; accepted: boolean };
}

/** 그 스레드의 입력창이 열려 있고 비어 있으면 심는다. 결과를 돌려준다. */
export function seedThreadComposerText(
  rootId: string,
  text: string
): ThreadComposerSeed["result"] {
  const detail: ThreadComposerSeed = { rootId, text, result: { mounted: false, accepted: false } };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(THREAD_COMPOSER_SEED_EVENT, { detail }));
  }
  return detail.result;
}

// 스레드 답글 초안 (#3904). 스레드 컴포저는 입력마다 저장하지 않는다. 앱이 업데이트로
// **스스로 다시 실행**하기 직전(`features/updates/relaunchFlush.ts`)에만 이 자리에 내리고,
// 스레드를 다시 열 때 비어 있으면 복원한다. 채널 초안과 열쇠 머리를 달리 둬서
// 초안 목록(`listDrafts`)·사이드바가 이 항목을 채널 초안으로 읽지 않는다.
// 같은 수명 규칙을 따른다: 비밀 키 모양은 두지 않고, 30일이 지나면 읽을 때 버리고,
// 보내거나 로그아웃하면 지운다.
const THREAD_PREFIX = "momo.thread-draft.v1:";

function threadDraftKey(workspaceId: string, rootId: string): string {
  return `${THREAD_PREFIX}${workspaceId.toLowerCase()}:${rootId.toLowerCase()}`;
}

export function writeThreadDraft(
  workspaceId: string,
  rootId: string,
  text: string,
  nowMs: number = Date.now(),
  /** 이 답글 초안이 속한 대화. 적어 두면 그 대화에서 나갈 때 찾아 지운다(`threadDraftRootsInChannel`). */
  channelId?: string
): void {
  const key = threadDraftKey(workspaceId, rootId);
  if (text.trim() === "" || containsSecretKey(text)) {
    writeRaw(key, null);
    return;
  }
  const draft = stamped(text, nowMs);
  if (channelId !== undefined && channelId !== "") draft.channelId = channelId.toLowerCase();
  writeRaw(key, JSON.stringify(draft));
}

/**
 * 이 대화의 답글 초안이 걸린 뿌리 글 id(소문자). 대화를 적어 둔 초안만 찾는다 - 적지 않은 옛 값은 대화를 알 수 없다. 작성자는 보지 않는다:
 * 1:1 대화에서 나갈 때 그 대화의 것을 지우는 데 쓴다(ADR-0177 증보 2026-11-14 D17, #5825).
 */
export function threadDraftRootsInChannel(workspaceId: string, channelId: string): string[] {
  const prefix = threadDraftKey(workspaceId, "");
  const channel = channelId.toLowerCase();
  const roots: string[] = [];
  for (const key of threadDraftKeys()) {
    if (!key.startsWith(prefix)) continue;
    const draft = parse(readRaw(key));
    if (draft?.channelId === channel) roots.push(key.slice(prefix.length));
  }
  return roots;
}

export function readThreadDraft(
  workspaceId: string,
  rootId: string,
  nowMs: number = Date.now()
): string {
  const key = threadDraftKey(workspaceId, rootId);
  const draft = parse(readRaw(key));
  if (draft === null) return "";
  if (nowMs - draft.atMs > DRAFT_TTL_MS) {
    writeRaw(key, null);
    return "";
  }
  if (!writtenBy(draft.author)) return "";
  return draft.text;
}

export function clearThreadDraft(workspaceId: string, rootId: string): void {
  writeRaw(threadDraftKey(workspaceId, rootId), null);
}

/** 로그아웃. 이 기기에 남은 초안과 보내지 못한 글을 전부 지운다. */
export function clearAllDrafts(): void {
  for (const key of draftKeys()) writeRaw(key, null);
  for (const key of threadDraftKeys()) writeRaw(key, null);
  for (const key of failedSendKeys()) writeRaw(key, null);
  emitDraftsChanged();
}

/**
 * 로그아웃(#5799). 전부 지우고, 다음 로그인까지 이 저장소에 새로 쓰지 않는다 — 내려가는 입력창의 마지막 저장과
 * 늦게 실패한 전송이 지운 자리를 되살리지 못하게.
 */
export function closeDraftsForSignOut(): void {
  // 이 탭은 공유 표지와 상관없이 닫는다: 표지를 못 써도 이 탭의 쓰기는 열린 채로 남지 않는다.
  openedMark = CLOSED_HERE;
  // 새 표지: 이 탭과 같은 기기의 다른 탭이 들고 있는 표지가 모두 낡는다. 저장소가 가득 차 못 쓰면 지운 뒤(자리가 난 뒤) 한 번 더.
  const marked = writeSignOutMark();
  clearAllDrafts();
  if (!marked) writeSignOutMark();
}

function writeSignOutMark(): boolean {
  try {
    localStorage.setItem(SIGN_OUT_MARK_KEY, freshMark());
    return true;
  } catch {
    return false;
  }
}

/** 로그인. 이 사람의 초안을 다시 남긴다(지금 표지를 이 탭의 것으로 들고, 이 사람을 이 탭의 작성자로 든다). */
export function openDraftsForSignIn(memberId: string): void {
  openedMark = readSignOutMark();
  adoptDraftAuthor(memberId);
}

/**
 * 이 탭의 작성자를 정한다(로그인·복원). 다른 사람이 쓴 것(작성자를 모르는 값 포함)은 이때 이 기기에서 지운다 — 초안·답글 초안·보내지
 * 못한 글 모두. 같은 사람이면 그대로 남아 이어 쓴다.
 */
export function adoptDraftAuthor(memberId: string): void {
  draftAuthor = memberId.toLowerCase();
  let removed = false;
  for (const key of [...draftKeys(), ...threadDraftKeys()]) {
    const draft = parse(readRaw(key));
    if (draft !== null && writtenBy(draft.author)) continue;
    writeRaw(key, null);
    removed = true;
  }
  for (const key of failedSendKeys()) {
    const stored = parseFailedSend(readRaw(key));
    if (stored !== null && stored.row.authorMemberId.toLowerCase() === draftAuthor) continue;
    writeRaw(key, null);
    removed = true;
  }
  if (removed) emitDraftsChanged();
}

function freshMark(): string {
  try {
    const random = globalThis.crypto?.randomUUID?.();
    if (random !== undefined) return random;
  } catch {
    // 아래의 대체 값을 쓴다.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 시한 지난 것과 정원을 넘긴 것을 버린다.
 *
 * 저장할 때만 돈다. 읽기는 자기 항목 하나만 판정하므로(위 `readDraft`) 채널을
 * 여는 일이 저장소 전체를 훑는 일이 되지 않는다.
 */
export function pruneDrafts(nowMs: number = Date.now()): void {
  const entries: { key: string; atMs: number }[] = [];
  let removed = false;
  for (const key of draftKeys()) {
    const draft = parse(readRaw(key));
    if (draft === null || nowMs - draft.atMs > DRAFT_TTL_MS) {
      writeRaw(key, null);
      removed = true;
      continue;
    }
    entries.push({ key, atMs: draft.atMs });
  }
  if (entries.length > MAX_DRAFTS) {
    entries.sort((a, b) => a.atMs - b.atMs);
    for (const entry of entries.slice(0, entries.length - MAX_DRAFTS)) {
      writeRaw(entry.key, null);
      removed = true;
    }
  }
  if (removed) emitDraftsChanged();
}

/**
 * 이 기기에 살아 있는 초안. 시한이 지난 항목은 세지 않는다. 읽는 함수라
 * 저장소를 지우지 않는다(`useSyncExternalStore`의 스냅샷이 부수효과를 내면
 * 구독이 재귀한다). 청소는 `pruneDrafts`와 `readDraft`가 진다.
 */
export function listDrafts(nowMs: number = Date.now()): DraftRecord[] {
  const out: DraftRecord[] = [];
  for (const key of draftKeys()) {
    const ids = parseDraftKey(key);
    if (ids === null) continue;
    const draft = parse(readRaw(key));
    if (draft === null) continue;
    if (nowMs - draft.atMs > DRAFT_TTL_MS) continue;
    if (!writtenBy(draft.author)) continue;
    out.push({
      key,
      workspaceId: ids.workspaceId,
      channelId: ids.channelId,
      text: draft.text,
      atMs: draft.atMs,
    });
  }
  out.sort((a, b) => b.atMs - a.atMs);
  return out;
}

/** 지금 워크스페이스의 초안만. 다른 워크스페이스 글은 섞지 않는다. */
export function listWorkspaceDrafts(
  workspaceId: string,
  nowMs: number = Date.now()
): DraftRecord[] {
  const needle = workspaceId.toLowerCase();
  return listDrafts(nowMs).filter((draft) => draft.workspaceId === needle);
}

// =============================================================================
// 보내지 못한 글 (#5221, #5201 S-C 결정 ⑤).
//
// 보내다 실패한 글은 지금까지 메모리에만 있어서 채널을 옮기거나 새로고침하면 사라졌다. 쓰다 만 글과 같은 이유로
// (되돌릴 길이 없는 유일한 종류의 손실) 이 기기에 남겼다가 그 채널을 다시 열면 **실패 행으로** 돌려놓는다.
//
// 본문만 초안(`writeDraft`)으로 돌려놓지 않고 **행 전체**를 남기는 까닭: 「실패」는 서버가 못 받았다는 증명이
// 아니다(응답만 유실됐을 수 있다). 행을 그대로 두면 멱등 키가 살아남아 다시 보내도 서버가 중복을 막고, 서버가
// 이미 받은 글이면 채널을 열 때 확정 메시지와 만나 스스로 정리된다(`unsettledPending`). 본문만 초안으로 돌리면 새
// 키로 나가 같은 글이 두 번 보일 수 있다. 첨부·인용·모델 고르기도 행이 들고 있어 잃지 않는다.
//
// 저장 규칙은 초안과 같다(위 머리말): `localStorage`, 비밀 키 모양이 든 글은 두지 않고, 30일이 지나면 읽을 때 버리고,
// 최대 `MAX_FAILED_SENDS`개를 넘으면 오래된 것부터 버리고, 로그아웃(`clearAllDrafts`)이 함께 지운다. 한 행이
// 한 열쇠라 쓰기가 서로의 것을 덮지 않는다. 개인 에이전트를 부른 전송(호출 계획이 함수를 든다)은 남기지 않는다.
// =============================================================================

const FAILED_SEND_PREFIX = "momo.failed-send.v1:";
/** 동시에 들고 있는 보내지 못한 글의 최대 개수. */
export const MAX_FAILED_SENDS = 50;

function failedSendKey(workspaceId: string, channelId: string, clientMsgId: string): string {
  return `${FAILED_SEND_PREFIX}${workspaceId.toLowerCase()}:${channelId.toLowerCase()}:${clientMsgId.toLowerCase()}`;
}

function failedSendKeys(): string[] {
  try {
    // 저장소가 없는 환경(ReferenceError)이나 막힌 환경은 아래 catch 가 같이 받는다.
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(FAILED_SEND_PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

/** 보내지 못한 글을 이 기기에 남긴다(이미 있으면 갱신). 키 모양이 든 글은 남기지 않고 있던 것도 지운다. */
export function rememberFailedSend(
  workspaceId: string,
  row: PendingMessage,
  kind: SendFailureKind | null,
  nowMs: number = Date.now()
): void {
  const key = failedSendKey(workspaceId, row.channelId, row.clientMsgId);
  if (containsSecretKey(row.body)) {
    writeRaw(key, null);
    return;
  }
  // 이 탭의 지금 사람이 쓴 글만 남긴다: 앞 사람의 요청이 다음 사람이 들어온 뒤에 늦게 실패해도 그 글은 이 기기에 남지 않는다.
  if (draftAuthor !== null && row.authorMemberId.toLowerCase() !== draftAuthor) return;
  writeRaw(key, serializeFailedSend(row, kind, nowMs));
  pruneFailedSends(nowMs);
}

/** 이 글은 끝났다(보냈다·지웠다·서버가 이미 받았다). 이 기기에서도 지운다. */
export function forgetFailedSend(workspaceId: string, channelId: string, clientMsgId: string): void {
  writeRaw(failedSendKey(workspaceId, channelId, clientMsgId), null);
}

/**
 * 이 채널에 남아 있는 보내지 못한 글, 보낸 순서대로. 시한이 지난 항목은 읽는 김에 지운다. 다른 사람이 쓴 글(작성자가
 * 다른 멤버)은 돌려주지 않는다: 같은 기기를 나눠 쓰는 두 계정이 서로의 글을 보지 않게 한다.
 */
export function readFailedSends(
  workspaceId: string,
  channelId: string,
  authorMemberId: string,
  nowMs: number = Date.now()
): { row: PendingMessage; kind: SendFailureKind | null }[] {
  const prefix = failedSendKey(workspaceId, channelId, "");
  const out: { row: PendingMessage; kind: SendFailureKind | null }[] = [];
  for (const key of failedSendKeys()) {
    if (!key.startsWith(prefix)) continue;
    const stored = parseFailedSend(readRaw(key));
    if (stored === null || nowMs - stored.atMs > DRAFT_TTL_MS) {
      writeRaw(key, null);
      continue;
    }
    if (stored.row.authorMemberId.toLowerCase() !== authorMemberId.toLowerCase()) continue;
    out.push({ row: stored.row, kind: stored.kind });
  }
  out.sort((a, b) => a.row.createdAtMs - b.row.createdAtMs);
  return out;
}

function pruneFailedSends(nowMs: number): void {
  const entries: { key: string; atMs: number }[] = [];
  for (const key of failedSendKeys()) {
    const stored = parseFailedSend(readRaw(key));
    if (stored === null || nowMs - stored.atMs > DRAFT_TTL_MS) {
      writeRaw(key, null);
      continue;
    }
    entries.push({ key, atMs: stored.atMs });
  }
  if (entries.length <= MAX_FAILED_SENDS) return;
  entries.sort((a, b) => a.atMs - b.atMs);
  for (const entry of entries.slice(0, entries.length - MAX_FAILED_SENDS)) writeRaw(entry.key, null);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(PREFIX)) {
      emitDraftsChanged();
    }
  });
  // Same-tab writes that bypass `writeDraft` (캡처 하네스가 localStorage에
  // 직접 심는 경우). `storage` 사건은 다른 탭에만 뜬다.
  window.addEventListener(DRAFTS_CHANGED_EVENT, () => {
    emitDraftsChanged();
  });
}
