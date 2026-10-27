import { useSyncExternalStore } from "react";
import { ApiError, fetchAttachmentContent } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { IS_TAURI } from "@/lib/env";
import { DesktopDownloadError, desktopDownloads } from "@/lib/tauri";
import {
  addDownload,
  applyPresence,
  beginSaving,
  canRetry,
  completeDownload,
  DOWNLOAD_STORAGE_KEY,
  failDownload,
  forgetFinished,
  itemRatio,
  markAllSeen,
  markMissing,
  newDownload,
  parseHistory,
  receiveBytes,
  removeDownload,
  serializeHistory,
  type DownloadFailure,
  type DownloadItem,
  type DownloadList,
  type DownloadSource,
} from "./downloadsModel";

// =============================================================================
// 다운로드 패널의 부수효과 (#4587). 규칙은 전부 `downloadsModel.ts`(순수)에 있고, 여기 남는 것은
// 그 규칙이 아닌 것뿐이다: 모듈 전역 목록, 구독, 저장소, 그리고 한 건이 가는 길의 순서.
//
//   인가 프록시에서 받는다(코어 `fetchAttachmentContent`, 잰 진행) → 셸이 다운로드 폴더에 쓴다
//   (`desktopDownloads.save`) → 셸이 돌려준 파일 이름을 기록한다.
//
// 바이트가 가는 길은 하나다: 자격은 웹뷰를 떠나지 않는다(셸에 토큰도 URL도 주지 않는다).
// 셸은 이름만 돌려주고, 이후 열기·보기는 전부 그 이름으로 한다(경로를 아는 쪽은 셸뿐).
//
// 의존은 `DownloadsDeps`로 주입한다. 시험은 모듈을 가짜로 바꾸지 않고 의존을 손으로 꽂은 새
// 스토어를 만든다(`downloadsStore.test.ts`). 기본 스토어(`downloads`)가 실제 의존을 꽂는다.
// =============================================================================

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DownloadsDeps {
  now: () => number;
  newId: () => string;
  /** 인가 프록시에서 바이트를 받는다. `onProgress`는 도착한 바이트와 서버가 말한 길이(모르면 null). */
  fetchBytes: (
    source: DownloadSource,
    onProgress: (loaded: number, total: number | null) => void
  ) => Promise<Uint8Array>;
  save: (bytes: Uint8Array, name: string) => Promise<{ fileName: string }>;
  probe: (fileNames: readonly string[]) => Promise<boolean[]>;
  reveal: (fileName: string) => Promise<void>;
  open: (fileName: string) => Promise<void>;
  openFolder: () => Promise<void>;
  /** null이면 기록을 읽지도 쓰지도 않는다(브라우저 탭, 접근 거부). */
  storage: StorageLike | null;
}

/** 한 건이 못 끝났다. `failure`가 화면의 문장과 다음 행동을 고른다. */
export class DownloadFailedError extends Error {
  readonly failure: DownloadFailure;
  constructor(failure: DownloadFailure) {
    super(`download failed: ${failure}`);
    this.name = "DownloadFailedError";
    this.failure = failure;
  }
}

/** 열기·Finder 보기 같은 행 행동의 결과. 화면은 `ok`가 아닌 것만 그 행 아래에서 말한다. */
export type RowActionResult = "ok" | "missing" | "not-openable" | "failed";

export interface DownloadStartInput {
  workspaceId: string;
  channelId: string;
  attachment: { id: string; name: string; mime?: string; sizeBytes?: number };
}

export interface DownloadsStore {
  getItems(): DownloadList;
  subscribe(listener: () => void): () => void;
  /** 받아서 저장한다. 끝나면 resolve, 못 끝나면 `DownloadFailedError`로 reject한다. */
  start(input: DownloadStartInput): Promise<void>;
  /** 실패한 건을 같은 요청으로 다시 한다(실패 행이 새 건으로 바뀐다). */
  retry(id: string): Promise<void>;
  /** 끝난 건을 새로 받는다. 파일이 지워진 옛 행은 새 건이 대신한다. */
  redownload(id: string): Promise<void>;
  reveal(id: string): Promise<RowActionResult>;
  open(id: string): Promise<RowActionResult>;
  openFolder(): Promise<boolean>;
  /** 끝난 파일이 아직 있는지 셸에 묻고 목록에 반영한다. 못 물으면 아는 대로 둔다. */
  refreshPresence(): Promise<void>;
  /** 목록을 열었다: 끝난 건은 이제 본 것이다. */
  markSeen(): void;
  /** 끝난 기록을 모두 잊는다(디스크의 파일은 그대로). */
  clearHistory(): void;
}

/** 진행 알림은 퍼센트가 한 칸 바뀔 때, 길이를 모를 때는 이 간격마다 목록에 반영한다. */
const PROGRESS_INTERVAL_MS = 250;

/** 다 받은 Blob을 셸에 줄 바이트로. `FileReader`는 jsdom과 오래된 웹킷에서도 선다. */
function readAsBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error("download bytes"));
    };
    reader.onerror = () => reject(new Error("download bytes"));
    reader.readAsArrayBuffer(blob);
  });
}

/** 못 끝난 이유를 화면의 이유로. 네트워크 단절은 `fetch`가 던지는 `TypeError`도 포함한다. */
export function downloadFailureOf(error: unknown): DownloadFailure {
  if (error instanceof DesktopDownloadError) {
    switch (error.code) {
      case "too-large":
        return "too-large";
      case "denied":
        return "denied";
      case "disk-full":
        return "disk-full";
      default:
        return "failed";
    }
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return "auth";
    if (error.status === 403 || error.status === 404 || error.status === 410) return "gone";
    return "failed";
  }
  if (error instanceof NetworkError || error instanceof TypeError) return "network";
  return "failed";
}

export function createDownloadsStore(deps: DownloadsDeps): DownloadsStore {
  const listeners = new Set<() => void>();

  const restore = (): DownloadList => {
    if (deps.storage === null) return [];
    try {
      return parseHistory(deps.storage.getItem(DOWNLOAD_STORAGE_KEY));
    } catch {
      return [];
    }
  };
  let list: DownloadList = restore();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const persist = () => {
    if (deps.storage === null) return;
    try {
      deps.storage.setItem(DOWNLOAD_STORAGE_KEY, serializeHistory(list));
    } catch {
      /* 저장소가 가득 찼거나 막혔다: 목록은 이번 세션 동안 메모리에서 산다. */
    }
  };
  const find = (id: string): DownloadItem | undefined => list.find((item) => item.id === id);

  async function run(id: string, source: DownloadSource, name: string): Promise<void> {
    let lastPercent = -1;
    let lastAt = Number.NEGATIVE_INFINITY;
    try {
      const bytes = await deps.fetchBytes(source, (loaded, total) => {
        const next = receiveBytes(list, id, loaded, total);
        if (next === list) return;
        const item = next.find((candidate) => candidate.id === id);
        const ratio = item === undefined ? null : itemRatio(item);
        const percent = ratio === null ? -1 : Math.floor(ratio * 100);
        const at = deps.now();
        // 건너뛴 값은 잃지 않는다: 받은 양은 줄지 않으므로 다음 알림이 더 큰 값을 가져온다.
        if (percent === lastPercent && at - lastAt < PROGRESS_INTERVAL_MS) return;
        lastPercent = percent;
        lastAt = at;
        list = next;
        emit();
      });
      list = beginSaving(list, id, bytes.byteLength);
      emit();
      const saved = await deps.save(bytes, name);
      list = completeDownload(list, id, saved.fileName, deps.now());
      persist();
      emit();
    } catch (error) {
      const failure = downloadFailureOf(error);
      list = failDownload(list, id, failure, deps.now());
      emit();
      throw new DownloadFailedError(failure);
    }
  }

  function begin(source: DownloadSource, name: string, mime: string, sizeBytes: number) {
    const id = deps.newId();
    const item = newDownload({ id, source, name, mime, sizeBytes, nowMs: deps.now() });
    list = addDownload(list, item);
    emit();
    return run(id, source, name);
  }

  async function rowAction(
    id: string,
    act: (fileName: string) => Promise<void>
  ): Promise<RowActionResult> {
    const item = find(id);
    if (item === undefined || item.fileName === null) return "failed";
    try {
      await act(item.fileName);
      return "ok";
    } catch (error) {
      if (error instanceof DesktopDownloadError) {
        if (error.code === "missing") {
          list = markMissing(list, id);
          emit();
          return "missing";
        }
        if (error.code === "not-openable") return "not-openable";
      }
      return "failed";
    }
  }

  return {
    getItems: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start({ workspaceId, channelId, attachment }) {
      return begin(
        { workspaceId, channelId, attachmentId: attachment.id },
        attachment.name,
        attachment.mime ?? "",
        attachment.sizeBytes ?? 0
      );
    },
    retry(id) {
      const item = find(id);
      if (item === undefined || item.phase !== "failed") return Promise.resolve();
      if (item.failure !== null && !canRetry(item.failure)) return Promise.resolve();
      list = removeDownload(list, id);
      return begin(item.source, item.name, item.mime, item.sizeBytes);
    },
    redownload(id) {
      const item = find(id);
      if (item === undefined || item.phase !== "done") return Promise.resolve();
      // 파일이 없는 옛 행은 새 건이 대신한다. 파일이 있는 행은 남는다(다른 파일이다).
      if (item.present === false) {
        list = removeDownload(list, id);
        persist();
      }
      return begin(item.source, item.name, item.mime, item.sizeBytes);
    },
    reveal: (id) => rowAction(id, deps.reveal),
    open: (id) => rowAction(id, deps.open),
    async openFolder() {
      try {
        await deps.openFolder();
        return true;
      } catch {
        return false;
      }
    },
    async refreshPresence() {
      // 같은 이름은 한 번만 묻는다: 이름이 같은 두 행은 같은 파일을 가리키므로 답도 하나다.
      const names = [
        ...new Set(
          list
            .filter((item) => item.phase === "done" && item.fileName !== null)
            .map((item) => item.fileName as string)
        ),
      ];
      if (names.length === 0) return;
      let answers: boolean[];
      try {
        answers = await deps.probe(names);
      } catch {
        return;
      }
      // 답이 묻은 만큼이 아니면 믿지 않는다: 빠진 칸을 「없다」로 읽으면 한 번의 어긋남이 모든
      // 파일을 지워진 것으로 만든다. 모르는 것은 「없다」가 아니다.
      if (answers.length !== names.length) return;
      const presence = new Map<string, boolean>();
      names.forEach((name, index) => presence.set(name, answers[index] === true));
      const next = applyPresence(list, presence);
      if (next === list) return;
      list = next;
      emit();
    },
    markSeen() {
      const next = markAllSeen(list);
      if (next === list) return;
      list = next;
      emit();
    },
    clearHistory() {
      const next = forgetFinished(list);
      try {
        deps.storage?.removeItem(DOWNLOAD_STORAGE_KEY);
      } catch {
        /* 지울 수 없으면 다음 저장이 덮는다. */
      }
      if (next === list) return;
      list = next;
      emit();
    },
  };
}

// ---- 실제 의존 --------------------------------------------------------------

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function realDeps(): DownloadsDeps {
  return {
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    async fetchBytes(source, onProgress) {
      const blob = await fetchAttachmentContent(
        source.workspaceId,
        source.channelId,
        source.attachmentId,
        undefined,
        onProgress
      );
      return readAsBytes(blob);
    },
    save: (bytes, name) => desktopDownloads.save(bytes, name),
    probe: (names) => desktopDownloads.probe(names),
    reveal: (fileName) => desktopDownloads.reveal(fileName),
    open: (fileName) => desktopDownloads.open(fileName),
    openFolder: () => desktopDownloads.openFolder(),
    // 브라우저 탭은 패널이 없다: 기록을 만들지도 읽지도 않는다.
    storage: IS_TAURI ? browserStorage() : null,
  };
}

/** 앱 하나에 목록 하나. 기본 스토어. */
export const downloads: DownloadsStore = createDownloadsStore(realDeps());

/** 목록을 구독한다. 목록은 바뀔 때만 새 참조가 된다. 시험은 자기 스토어를 꽂는다. */
export function useDownloadList(store: DownloadsStore = downloads): DownloadList {
  return useSyncExternalStore(store.subscribe, store.getItems, store.getItems);
}

/**
 * 로그아웃이 부른다(`session.tsx`): 기록은 이 기기에서 이 사람이 받은 파일의 이름이라 다음
 * 사람이 읽게 두지 않는다. 디스크의 파일과 진행 중인 건은 건드리지 않는다.
 */
export function clearDownloadHistory(): void {
  downloads.clearHistory();
  try {
    browserStorage()?.removeItem(DOWNLOAD_STORAGE_KEY);
  } catch {
    /* 이미 막혀 있다. */
  }
}
