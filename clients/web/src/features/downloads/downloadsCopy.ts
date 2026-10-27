import { attachmentDisplayName, formatBytes } from "@momo/core/features/attachments/model";
import {
  isActive,
  itemRatio,
  type DownloadButtonView,
  type DownloadFailure,
  type DownloadItem,
  type DownloadList,
  type RowAction,
} from "./downloadsModel";

// =============================================================================
// 다운로드 패널의 문장 (#4587). 웹 표면이라 해요체다(합쇼체·em-dash·「-하는 중」 없음: 진행 낱말은
// 「명사 + 중」이다, `design_preflight_web.sh`의 progress_word). 이름은 경로가 아니다: 어떤
// 문장도 다운로드 폴더의 경로를 말하지 않는다(셸이 경로를 웹뷰에 주지 않는다).
// =============================================================================

export const DOWNLOAD_COPY = {
  title: "다운로드",
  openFolder: "다운로드 폴더 열기",
  /** 저장 위치는 고르는 것이 아니라 알리는 것이다(OS의 다운로드 폴더 고정). */
  saveLocation: "받은 파일은 다운로드 폴더에 저장돼요",
  empty: "받은 파일이 아직 없어요",
  emptyHint: "받은 첨부파일이 여기에 모여요",
  open: "열기",
  reveal: "Finder에서 보기",
  redownload: "다시 다운로드",
  retry: "다시 시도",
  saving: "저장 중",
  missing: "파일이 지워졌어요",
  openFailed: "파일을 열지 못했어요",
  revealFailed: "Finder에서 보여 주지 못했어요",
  notOpenable: "이 종류의 파일은 여기서 열지 않아요. Finder에서 확인하세요",
  folderFailed: "다운로드 폴더를 열지 못했어요",
} as const;

const FAILURE_COPY: Record<DownloadFailure, string> = {
  network: "연결이 끊겨 받지 못했어요. 연결을 확인하고 다시 시도하세요",
  auth: "로그인이 끝나서 받지 못했어요. 다시 로그인한 뒤 시도하세요",
  gone: "첨부파일이 없거나 볼 권한이 없어요. 보낸 사람에게 다시 요청해 보세요",
  "too-large": "파일이 너무 커서 저장하지 못했어요. 보낸 사람에게 나눠서 보내 달라고 요청해 보세요",
  denied: "다운로드 폴더에 저장할 권한이 없어요. 시스템 설정에서 oort의 폴더 접근을 허용하세요",
  "disk-full": "저장 공간이 부족해요. 공간을 비우고 다시 시도하세요",
  failed: "받지 못했어요. 다시 시도하세요",
};

export function downloadFailureCopy(failure: DownloadFailure): string {
  return FAILURE_COPY[failure];
}

const ACTION_LABEL: Record<RowAction, string> = {
  open: DOWNLOAD_COPY.open,
  reveal: DOWNLOAD_COPY.reveal,
  redownload: DOWNLOAD_COPY.redownload,
  retry: DOWNLOAD_COPY.retry,
};

export function rowActionLabel(action: RowAction): string {
  return ACTION_LABEL[action];
}

/** 행의 제목: 디스크에 놓인 이름이 있으면 그것이다(Finder에서 찾을 이름). */
export function rowTitle(item: DownloadItem): string {
  return item.fileName ?? attachmentDisplayName(item);
}

/**
 * 행의 두 번째 줄. 받는 중은 잰 바이트, 끝남은 크기, 지워졌으면 그 사실, 실패는 이유와 다음 행동이다.
 * 퍼센트는 잰 값이 있을 때만 말한다(`itemRatio`가 null이면 받은 바이트만).
 */
export function rowStatusLine(item: DownloadItem): string {
  switch (item.phase) {
    case "receiving": {
      const ratio = itemRatio(item);
      return ratio === null
        ? item.receivedBytes > 0
          ? formatBytes(item.receivedBytes)
          : formatBytes(item.sizeBytes)
        : `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes ?? item.sizeBytes)}`;
    }
    case "saving":
      return DOWNLOAD_COPY.saving;
    case "failed":
      return downloadFailureCopy(item.failure ?? "failed");
    case "done":
      return item.present === false
        ? DOWNLOAD_COPY.missing
        : formatBytes(item.sizeBytes > 0 ? item.sizeBytes : item.receivedBytes);
  }
}

/** 상단 단추의 이름. 점·링은 색과 모양이라 보조기술에는 이 문장이 상태를 말한다. */
export function downloadButtonLabel(view: DownloadButtonView): string {
  // 링과 점은 함께 설 수 있다: 이름이 둘 다 말한다(링이 도는 동안 점의 뜻이 이름에서 사라지지 않게, design-review M1).
  const parts: string[] = [DOWNLOAD_COPY.title];
  if (view.activity === "progress") parts.push(`받는 중 ${view.activeCount}개`);
  if (view.badge === "failed") parts.push("받지 못한 파일이 있어요");
  else if (view.badge === "done") parts.push(`새로 받은 파일 ${view.unseenCount}개`);
  return parts.join(", ");
}

/**
 * 막 끝난 건을 낭독할 한 줄. 이전 목록과 지금 목록을 비교해 **새로 끝난** 첫 건을 말한다(끝난 것이
 * 없거나 아무것도 안 바뀌면 null). 점은 색이라 이 낭독이 없으면 보조기술은 끝난 줄을 모른다.
 */
export function finishedAnnouncement(before: DownloadList, after: DownloadList): string | null {
  for (const item of after) {
    const previous = before.find((candidate) => candidate.id === item.id);
    if (previous === undefined || !isActive(previous) || isActive(item)) continue;
    const name = rowTitle(item);
    return item.phase === "done" ? `${name} 받기를 마쳤어요` : `${name} 받지 못했어요`;
  }
  return null;
}
