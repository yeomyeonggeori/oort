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
// — 아래 [`clearAllDrafts`] 를 세션 정리가 부른다.
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
}

/**
 * 초안 하나의 열쇠. 워크스페이스까지 넣는 이유는 채널 id 가 워크스페이스마다
 * 새로 발급되기 때문이 아니라, **같은 기기에서 두 워크스페이스를 오가는 사람**의
 * 초안이 섞이지 않게 하기 위해서다.
 */
export function draftKey(workspaceId: string, channelId: string): string {
  return `${PREFIX}${workspaceId.toLowerCase()}:${channelId.toLowerCase()}`;
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

function writeRaw(key: string, value: string | null): void {
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

function parse(raw: string | null): StoredDraft | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { text, atMs } = value as Record<string, unknown>;
    if (typeof text !== "string" || text === "") return null;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    return { text, atMs };
  } catch {
    // 손으로 고쳐졌거나 옛 판이다. 읽을 수 없는 초안은 초안이 아니다.
    return null;
  }
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
    return "";
  }
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
  if (text === "") {
    writeRaw(key, null);
    return;
  }
  writeRaw(key, JSON.stringify({ text, atMs: nowMs } satisfies StoredDraft));
  pruneDrafts(nowMs);
}

/** 보냈다. 화면에서 사라진 글은 저장소에서도 사라진다. */
export function clearDraft(workspaceId: string, channelId: string): void {
  writeRaw(draftKey(workspaceId, channelId), null);
}

/**
 * 같은 탭의 컴포저가 초안 저장소를 다시 읽게 하는 사건.
 * `storage` 이벤트는 다른 탭에만 뜨므로, 이 채널에 이미 마운트된 입력창은
 * 이 이름으로만 복원한다.
 */
export const COMPOSER_SEED_EVENT = "momo:composer-seed";

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

/** 로그아웃. 이 기기에 남은 초안을 전부 지운다. */
export function clearAllDrafts(): void {
  for (const key of draftKeys()) writeRaw(key, null);
}

/**
 * 시한 지난 것과 정원을 넘긴 것을 버린다.
 *
 * 저장할 때만 돈다. 읽기는 자기 항목 하나만 판정하므로(위 `readDraft`) 채널을
 * 여는 일이 저장소 전체를 훑는 일이 되지 않는다.
 */
export function pruneDrafts(nowMs: number = Date.now()): void {
  const entries: { key: string; atMs: number }[] = [];
  for (const key of draftKeys()) {
    const draft = parse(readRaw(key));
    if (draft === null || nowMs - draft.atMs > DRAFT_TTL_MS) {
      writeRaw(key, null);
      continue;
    }
    entries.push({ key, atMs: draft.atMs });
  }
  if (entries.length <= MAX_DRAFTS) return;
  entries.sort((a, b) => a.atMs - b.atMs);
  for (const entry of entries.slice(0, entries.length - MAX_DRAFTS)) {
    writeRaw(entry.key, null);
  }
}
