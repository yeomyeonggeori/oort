// =============================================================================
// 데스크탑 다운로드 패널의 모델 (#4587, owner 2026-10-26: 「다운로드 관련한 버튼을 제일 상단
// 우측에 두면 일반적인 좋은 메신저 앱에서의 UX가 완성될 거 같은 느낌」).
//
// 이 파일은 **순수**하다: React도, 저장소도, 네이티브 호출도 모른다. 진행 상태 전이, 목록 기록
// (최근 N개·지워진 파일), 상단 단추의 상태(없음·진행·완료 점), 행의 행동, 저장·복원의 검증이
// 전부 여기 있고, 부수효과는 `downloadsStore.ts`가 이 함수들 위에서 일으킨다.
//
// ## 무엇이 진행인가
//
// 한 건은 `receiving → saving → done | failed`를 간다.
//   · receiving  인가 프록시에서 바이트를 받는 중. `receivedBytes`는 **잰 값**이다(코어
//                `fetchAttachmentContent`의 `onProgress`). 한 바이트도 못 받았으면 진행률은
//                「0%」가 아니라 「아직 모른다」(null)다: 0은 정직하지 않다(업로드 막대의 같은 규칙).
//   · saving     다 받은 바이트를 셸이 다운로드 폴더에 쓰는 중(짧다). 이 구간은 잴 수 없다.
//   · done       셸이 돌려준 파일 이름(`fileName`)이 생겼다. 이후 모든 요청은 이 이름으로 한다.
//   · failed     이유(`DownloadFailure`)가 있다. 이유마다 다음 행동이 다르다.
//
// ## 목록 = 이번 세션 + 최근 기록
//
// 한 줄로 이어진 하나의 목록이고 최신이 위다. 앱을 다시 켜면 끝난 것만(최근 N개) 저장소에서
// 돌아온다. 진행 중이던 것은 돌아오지 않는다: 페이지가 사라지면 받던 바이트도 사라졌다.
// 돌아온 기록은 「이미 본 것」(`seen: true`)이라 단추에 점을 켜지 않는다.
//
// 지워진 파일: 목록을 열 때 셸에 「아직 있나」를 묻고(`present`), 없으면 행이 말하고
// 「다시 다운로드」만 남긴다. 파일은 Finder에서 사람이 지울 수 있으므로 기록이 그 사실을
// 모른 채 「열기」를 누르게 두지 않는다. `null`은 「아직 묻지 않았다」이지 「없다」가 아니다.
// =============================================================================

/** 목록과 저장소가 들고 있는 최근 기록의 최대 개수. */
export const DOWNLOAD_HISTORY_LIMIT = 30;

/** 단추 링의 칸 수. 인라인 스타일이 없으므로 진행률은 이 칸으로 양자화해 CSS가 그린다. */
export const DOWNLOAD_RING_STEPS = 12;

/** 저장소 열쇠. 로그아웃이 지운다(`session.tsx`). */
export const DOWNLOAD_STORAGE_KEY = "momo.web.downloads.v1";

export type DownloadPhase = "receiving" | "saving" | "done" | "failed";

/**
 * 못 받은 이유, 화면이 구분할 수 있는 만큼만. 이유마다 **사람이 할 수 있는 다음 행동**이 다르다
 * (`canRetry`와 `downloadsCopy.ts`가 그 표다).
 *
 *   network    연결이 끊겼다                     → 연결을 확인하고 다시
 *   auth       로그인이 끝났다(401·403)          → 다시 로그인한 뒤 다시
 *   gone       첨부가 없거나 볼 권한이 없다(404)  → 다시 받아도 같다
 *   too-large  셸의 상한을 넘었다                 → 다시 받아도 같다
 *   denied     OS가 다운로드 폴더 쓰기를 거절했다   → 시스템 설정에서 허용한 뒤 다시
 *   disk-full  공간이 없다                       → 비운 뒤 다시
 *   failed     그 밖                            → 다시
 */
export type DownloadFailure =
  | "network"
  | "auth"
  | "gone"
  | "too-large"
  | "denied"
  | "disk-full"
  | "failed";

/** 같은 요청을 다시 보내면 달라질 수 있는가. 404와 상한 초과는 몇 번을 해도 같다. */
export function canRetry(failure: DownloadFailure): boolean {
  return failure !== "gone" && failure !== "too-large";
}

/** 다시 받을 때 다시 하는 요청의 근거. 서버 id 셋이 전부이고 경로도 URL도 아니다. */
export interface DownloadSource {
  workspaceId: string;
  channelId: string;
  attachmentId: string;
}

export interface DownloadItem {
  /** 이 기기 안에서만 사는 이름. 저장소를 거쳐도 같다. */
  id: string;
  source: DownloadSource;
  /** 첨부가 올라갈 때의 이름. 디스크의 이름은 `fileName`이다. */
  name: string;
  mime: string;
  /** 첨부 메타가 말한 크기. 서버가 길이를 말하지 않을 때의 가늠이다. */
  sizeBytes: number;
  phase: DownloadPhase;
  receivedBytes: number;
  /** 서버가 말한 길이. 모르면 null(그때는 `sizeBytes`로 가늠한다). */
  totalBytes: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  /** 셸이 다운로드 폴더에서 이 파일에 준 이름. `done`에서만 있다. */
  fileName: string | null;
  /** `failed`에서만 있다. */
  failure: DownloadFailure | null;
  /** 끝난 뒤 목록을 연 적이 있는가. 거짓인 것이 단추의 점이다. */
  seen: boolean;
  /** 파일이 아직 다운로드 폴더에 있는가. null = 아직 묻지 않았다. */
  present: boolean | null;
}

export type DownloadList = readonly DownloadItem[];

export function isActive(item: Pick<DownloadItem, "phase">): boolean {
  return item.phase === "receiving" || item.phase === "saving";
}

export function newDownload(input: {
  id: string;
  source: DownloadSource;
  name: string;
  mime: string;
  sizeBytes: number;
  nowMs: number;
}): DownloadItem {
  return {
    id: input.id,
    source: input.source,
    name: input.name,
    mime: input.mime,
    sizeBytes: Math.max(0, Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0),
    phase: "receiving",
    receivedBytes: 0,
    totalBytes: null,
    startedAtMs: input.nowMs,
    finishedAtMs: null,
    fileName: null,
    failure: null,
    seen: false,
    present: null,
  };
}

// ---- 전이 ------------------------------------------------------------------
//
// 모든 전이는 새 배열을 돌려주고, 아무것도 달라지지 않으면 **같은 배열**을 돌려준다
// (`useSyncExternalStore`가 참조로 변화를 가리므로 헛된 갱신이 없다). 모르는 id는 무시한다.

function replace(
  list: DownloadList,
  id: string,
  change: (item: DownloadItem) => DownloadItem
): DownloadList {
  const index = list.findIndex((item) => item.id === id);
  if (index < 0) return list;
  const current = list[index] as DownloadItem;
  const next = change(current);
  if (next === current) return list;
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/**
 * 새 건을 맨 위에 두고 한도를 넘으면 가장 오래된 **끝난** 것부터 버린다. 진행 중인 건은 한도
 * 때문에 버리지 않는다(받는 도중의 파일이 목록에서 사라지면 끝나도 아무도 모른다).
 */
export function addDownload(
  list: DownloadList,
  item: DownloadItem,
  limit: number = DOWNLOAD_HISTORY_LIMIT
): DownloadList {
  const next = [item, ...list.filter((existing) => existing.id !== item.id)];
  while (next.length > limit) {
    let drop = -1;
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (!isActive(next[index] as DownloadItem)) {
        drop = index;
        break;
      }
    }
    if (drop < 0) break;
    next.splice(drop, 1);
  }
  return next;
}

/**
 * 바이트가 더 왔다. 받은 양은 **줄지 않는다**(느린 콜백이 늦게 와도 막대가 뒤로 가지 않는다)
 * 그리고 말한 전체를 넘지 않는다. 전체를 처음 알게 되면 그 값을 쥔다.
 */
export function receiveBytes(
  list: DownloadList,
  id: string,
  loaded: number,
  total: number | null
): DownloadList {
  return replace(list, id, (item) => {
    if (item.phase !== "receiving") return item;
    const knownTotal = total !== null && total > 0 ? total : item.totalBytes;
    const bounded = knownTotal === null ? loaded : Math.min(loaded, knownTotal);
    const receivedBytes = Math.max(item.receivedBytes, Math.max(0, bounded));
    if (receivedBytes === item.receivedBytes && knownTotal === item.totalBytes) return item;
    return { ...item, receivedBytes, totalBytes: knownTotal };
  });
}

/** 다 받았다. 이제 셸이 쓴다. 실제로 받은 크기가 가늠을 대신한다. */
export function beginSaving(list: DownloadList, id: string, bytes: number): DownloadList {
  return replace(list, id, (item) => {
    if (item.phase !== "receiving") return item;
    return { ...item, phase: "saving", receivedBytes: bytes, totalBytes: bytes };
  });
}

export function completeDownload(
  list: DownloadList,
  id: string,
  fileName: string,
  nowMs: number
): DownloadList {
  return replace(list, id, (item) => {
    if (!isActive(item)) return item;
    return {
      ...item,
      phase: "done",
      fileName,
      failure: null,
      finishedAtMs: nowMs,
      seen: false,
      present: true,
    };
  });
}

export function failDownload(
  list: DownloadList,
  id: string,
  failure: DownloadFailure,
  nowMs: number
): DownloadList {
  return replace(list, id, (item) => {
    if (!isActive(item)) return item;
    return { ...item, phase: "failed", failure, finishedAtMs: nowMs, seen: false };
  });
}

/** 목록을 열었다: 끝난 것(성공·실패)은 이제 본 것이다. 단추의 점이 꺼진다. */
export function markAllSeen(list: DownloadList): DownloadList {
  if (list.every((item) => isActive(item) || item.seen)) return list;
  return list.map((item) => (isActive(item) || item.seen ? item : { ...item, seen: true }));
}

/** 셸의 답을 반영한다. 끝난 파일 이름이 답에 있는 건만 바뀐다. */
export function applyPresence(
  list: DownloadList,
  presence: ReadonlyMap<string, boolean>
): DownloadList {
  let changed = false;
  const next = list.map((item) => {
    if (item.phase !== "done" || item.fileName === null) return item;
    const present = presence.get(item.fileName);
    if (present === undefined || present === item.present) return item;
    changed = true;
    return { ...item, present };
  });
  return changed ? next : list;
}

/** 파일이 없다는 것을 행동이 먼저 알았다(`reveal`·`open`이 missing으로 끝났다). */
export function markMissing(list: DownloadList, id: string): DownloadList {
  return replace(list, id, (item) =>
    item.phase === "done" && item.present !== false ? { ...item, present: false } : item
  );
}

export function removeDownload(list: DownloadList, id: string): DownloadList {
  return list.some((item) => item.id === id) ? list.filter((item) => item.id !== id) : list;
}

/** 기록 지우기: 끝난 건을 모두 잊는다. 진행 중인 것은 남는다. 디스크의 파일은 건드리지 않는다. */
export function forgetFinished(list: DownloadList): DownloadList {
  return list.some((item) => !isActive(item)) ? list.filter(isActive) : list;
}

// ---- 진행률과 단추 ----------------------------------------------------------

/** 이 건의 전체 크기 가늠: 서버가 말한 길이, 없으면 첨부 메타의 크기, 둘 다 모르면 null. */
export function effectiveTotal(item: DownloadItem): number | null {
  if (item.totalBytes !== null && item.totalBytes > 0) return item.totalBytes;
  return item.sizeBytes > 0 ? item.sizeBytes : null;
}

/** 0..1. 한 바이트도 못 받았거나 전체를 모르면 null(「아직 모른다」). 저장 중과 끝남은 1이다. */
export function itemRatio(item: DownloadItem): number | null {
  if (item.phase === "done" || item.phase === "saving") return 1;
  if (item.phase === "failed") return null;
  const total = effectiveTotal(item);
  if (total === null || item.receivedBytes <= 0) return null;
  return Math.min(1, item.receivedBytes / total);
}

/**
 * 진행 중인 건 전체의 한 비율. 하나라도 모르면(`itemRatio`가 null) 전체가 null이다: 일부만 재서
 * 막대를 그리면 모르는 건이 끝나는 순간 막대가 뛴다. 진행 중인 건이 없으면 null이다.
 */
export function aggregateRatio(list: DownloadList): number | null {
  const active = list.filter(isActive);
  if (active.length === 0) return null;
  let received = 0;
  let total = 0;
  for (const item of active) {
    const ratio = itemRatio(item);
    const size = effectiveTotal(item);
    if (ratio === null || size === null) return null;
    received += ratio * size;
    total += size;
  }
  return total > 0 ? Math.min(1, received / total) : null;
}

/** 링 한 칸(1..N). 시작했으면 적어도 한 칸이 보인다: 움직임이 곧 정보다. */
export function ringStep(ratio: number): number {
  const step = Math.round(ratio * DOWNLOAD_RING_STEPS);
  return Math.min(DOWNLOAD_RING_STEPS, Math.max(1, step));
}

export type DownloadBadge = "none" | "done" | "failed";

export interface DownloadButtonView {
  /** progress = 하나라도 받는 중. 링이 선다. */
  activity: "idle" | "progress";
  /** 링의 칸(1..N). null이면 길이를 모르는 링(돌아간다). activity가 progress일 때만 뜻이 있다. */
  step: number | null;
  /** 끝났는데 아직 열어 보지 않은 것. 실패가 완료보다 먼저 말한다. */
  badge: DownloadBadge;
  activeCount: number;
  unseenCount: number;
}

/**
 * 상단 단추의 모습. 세 가지다: 아무것도 없음 / 받는 중 링 / 새로 끝난 것의 점. 링과 점은 함께
 * 설 수 있다(받는 사이 앞의 것이 끝났다).
 */
export function buttonView(list: DownloadList): DownloadButtonView {
  const active = list.filter(isActive);
  const unseen = list.filter((item) => !isActive(item) && !item.seen);
  const ratio = aggregateRatio(list);
  const failed = unseen.some((item) => item.phase === "failed");
  return {
    activity: active.length > 0 ? "progress" : "idle",
    step: active.length > 0 && ratio !== null ? ringStep(ratio) : null,
    badge: unseen.length === 0 ? "none" : failed ? "failed" : "done",
    activeCount: active.length,
    unseenCount: unseen.length,
  };
}

// ---- 행의 행동 -------------------------------------------------------------

/**
 * 셸이 「열기」를 거절하는 확장자(실행·설치·해석하는 핸들러). 정본은 `downloads.rs`의
 * `NOT_OPENED_EXTENSIONS`이고 이 사본은 **단추를 아예 그리지 않기 위한** 것이다. 어긋나도 셸이
 * 거절하므로 안전은 셸의 몫이고, 어긋남은 `downloadsContract.test.ts`가 두 목록을 대조해 잡는다.
 */
export const NOT_OPENED_EXTENSIONS: readonly string[] = [
  "app",
  "command",
  "tool",
  "terminal",
  "workflow",
  "action",
  "scpt",
  "scptd",
  "applescript",
  "osax",
  "pkg",
  "mpkg",
  "dmg",
  "iso",
  "xip",
  "mobileconfig",
  "prefpane",
  "saver",
  "plugin",
  "kext",
  "service",
  "webloc",
  "inetloc",
  "fileloc",
  "url",
  "ipa",
  "sh",
  "bash",
  "zsh",
  "csh",
  "ksh",
  "fish",
  "py",
  "pyc",
  "pyw",
  "pl",
  "rb",
  "php",
  "js",
  "mjs",
  "cjs",
  "jar",
  "class",
  "exe",
  "msi",
  "bat",
  "cmd",
  "com",
  "scr",
  "pif",
  "vbs",
  "vbe",
  "jse",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "reg",
  "hta",
  "cpl",
  "dll",
  "lnk",
  "msc",
  "desktop",
  "appimage",
  "run",
  "deb",
  "rpm",
  "html",
  "htm",
  "xhtml",
  "svg",
  "webarchive",
  "mht",
  "mhtml",
];

/** 셸의 `split_extension`과 같은 규칙: 마지막 점 뒤의 영문·숫자 1..16자만 확장자다. */
export function extensionOf(fileName: string): string {
  const trimmed = fileName.replace(/[.\s]+$/u, "");
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = trimmed.slice(dot + 1);
  return /^[A-Za-z0-9]{1,16}$/u.test(ext) ? ext.toLowerCase() : "";
}

export function isOpenableFileName(fileName: string): boolean {
  return !NOT_OPENED_EXTENSIONS.includes(extensionOf(fileName));
}

export type RowAction = "open" | "reveal" | "redownload" | "retry";

/**
 * 한 행에 설 행동. 순서가 곧 화면 순서다.
 *   · 받는 중·저장 중 → 없다(끝나기를 기다린다)
 *   · 실패           → 다시 시도(같은 요청이 달라질 수 있을 때만)
 *   · 끝남·파일 있음   → 열기(열 수 있는 종류만) · Finder에서 보기 · 다시 다운로드
 *   · 끝남·파일 없음   → 다시 다운로드뿐
 * `present`가 null(아직 안 물음)이면 있다고 본다: 틀리면 셸이 missing으로 답하고 행이 고친다.
 */
export function rowActions(item: DownloadItem): RowAction[] {
  if (isActive(item)) return [];
  if (item.phase === "failed") {
    return item.failure !== null && canRetry(item.failure) ? ["retry"] : [];
  }
  if (item.fileName === null || item.present === false) return ["redownload"];
  return isOpenableFileName(item.fileName)
    ? ["open", "reveal", "redownload"]
    : ["reveal", "redownload"];
}

// ---- 저장·복원 -------------------------------------------------------------

interface StoredDownload {
  id: string;
  workspaceId: string;
  channelId: string;
  attachmentId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  fileName: string;
  startedAtMs: number;
  finishedAtMs: number;
}

/**
 * 끝나서 파일이 있는 것만, 최근 N개를 저장한다. 실패한 건과 진행 중인 건은 저장하지 않는다:
 * 앱을 다시 켠 사람에게 어제의 실패는 소음이고, 진행 중이던 바이트는 이미 없다.
 */
export function serializeHistory(
  list: DownloadList,
  limit: number = DOWNLOAD_HISTORY_LIMIT
): string {
  const items: StoredDownload[] = [];
  for (const item of list) {
    if (item.phase !== "done" || item.fileName === null || item.finishedAtMs === null) continue;
    items.push({
      id: item.id,
      workspaceId: item.source.workspaceId,
      channelId: item.source.channelId,
      attachmentId: item.source.attachmentId,
      name: item.name,
      mime: item.mime,
      sizeBytes: item.sizeBytes,
      fileName: item.fileName,
      startedAtMs: item.startedAtMs,
      finishedAtMs: item.finishedAtMs,
    });
    if (items.length >= limit) break;
  }
  return JSON.stringify({ v: 1, items });
}

const MAX_STORED_TEXT = 512;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STORED_TEXT
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * 저장소에서 돌아온 기록. 저장소는 이 코드가 쓰지만 이 코드만 쓰는 곳이 아니다(손상·옛 판·다른
 * 손): 모양이 틀린 항목은 말없이 버리고, 맞는 것만 「이미 본 것」으로 돌려준다. 파일 이름은 셸이
 * 다시 검사하므로(경로 한 줄도 믿지 않는다) 여기서는 모양만 본다.
 */
export function parseHistory(
  raw: string | null,
  limit: number = DOWNLOAD_HISTORY_LIMIT
): DownloadItem[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const record = parsed as { v?: unknown; items?: unknown };
  if (record.v !== 1 || !Array.isArray(record.items)) return [];
  const seen = new Set<string>();
  const items: DownloadItem[] = [];
  for (const entry of record.items as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = text(e.id);
    const workspaceId = text(e.workspaceId);
    const channelId = text(e.channelId);
    const attachmentId = text(e.attachmentId);
    const name = text(e.name);
    const fileName = text(e.fileName);
    const sizeBytes = count(e.sizeBytes);
    const startedAtMs = count(e.startedAtMs);
    const finishedAtMs = count(e.finishedAtMs);
    const mime = typeof e.mime === "string" && e.mime.length <= MAX_STORED_TEXT ? e.mime : "";
    if (
      id === null ||
      workspaceId === null ||
      channelId === null ||
      attachmentId === null ||
      name === null ||
      fileName === null ||
      sizeBytes === null ||
      startedAtMs === null ||
      finishedAtMs === null ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    items.push({
      id,
      source: { workspaceId, channelId, attachmentId },
      name,
      mime,
      sizeBytes,
      phase: "done",
      receivedBytes: sizeBytes,
      totalBytes: sizeBytes,
      startedAtMs,
      finishedAtMs,
      fileName,
      failure: null,
      seen: true,
      present: null,
    });
  }
  items.sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0));
  return items.slice(0, limit);
}
