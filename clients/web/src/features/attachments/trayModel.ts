import {
  CLEAR_ALL_MIN_DRAFTS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  sendBlockReason,
  showsDraftThumbnail,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 입력창 안 첨부 줄의 모델 (#5200). 화면이 아니라 **판정**만 든다: 어느 모양의 카드인가 ·
// 초점이 어디로 가는가 · 어느 쪽 가장자리가 흐린가 · 몇 개이고 무엇을 알려야 하는가.
// 컴포넌트는 이 값을 그리기만 하므로, 이 파일의 시험이 곧 줄의 규칙의 시험이다.
// =============================================================================

/**
 * 카드의 세 모양.
 *
 *   thumb   정사각 썸네일. 이름은 화면에 없고 낭독에만 있다(스크린샷은 그림으로 알아본다).
 *   file    같은 높이에 가로로 넓다: 가운데 아이콘 + 아래 이름·크기. 영상·PDF·로그·그림이 못 되는 그림.
 *   failed  이유를 읽어야 하므로 종류와 상관없이 이 모양이다: 이름 + 이유 + (되돌릴 값이 있으면) 다시 시도.
 */
export type CardShape = "thumb" | "file" | "failed";

/** 가운데 아이콘을 고르는 종류. */
export type CardKind = "image" | "video" | "audio" | "file";

export type ThumbnailPhase = "none" | "loading" | "ready" | "failed";

export function cardKind(mime: string): CardKind {
  const top = mime.trim().toLowerCase().split("/")[0];
  if (top === "image") return "image";
  if (top === "video") return "video";
  if (top === "audio") return "audio";
  return "file";
}

/**
 * 이 초안이 어느 모양의 카드인가.
 *
 * 썸네일이 **아직 그려지는 중**이어도 thumb 이다: 카드가 도착 순간에 자라지 않는다. 디코드에 **실패한**
 * 이미지(예: Chrome 의 HEIC)만 file 로 돌아간다. 그림이 없는 카드에 이름까지 없으면 어느 파일인지
 * 알 방법이 없다.
 */
export function cardShape(draft: AttachmentDraft, thumbnail: ThumbnailPhase): CardShape {
  if (draft.status === "failed") return "failed";
  if (!showsDraftThumbnail(draft)) return "file";
  return thumbnail === "failed" ? "file" : "thumb";
}

// ---- 키보드 -------------------------------------------------------------------

export type TrayKeyAction = "remove" | "prev" | "next" | "first" | "last";

/** 카드에 초점이 있을 때 이 줄이 가져가는 키. 그 밖의 키는 건드리지 않는다. */
export function trayKeyAction(key: string): TrayKeyAction | null {
  switch (key) {
    case "Backspace":
    case "Delete":
      return "remove";
    case "ArrowLeft":
      return "prev";
    case "ArrowRight":
      return "next";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/**
 * 탭 정거장이 되는 카드 하나. 20장이어도 줄은 탭 한 번에 지나간다(행 하나 = 정거장 하나, 로빙).
 * 기억해 둔 카드가 사라졌으면 첫 카드다.
 */
export function rovingStop(ids: readonly string[], remembered: string | null): string | null {
  if (ids.length === 0) return null;
  if (remembered !== null && ids.includes(remembered)) return remembered;
  return ids[0] ?? null;
}

/** ←/→/Home/End 가 가는 카드. 끝에서 돌아 나가지 않는다(스무 장짜리 줄이 끝에서 처음으로 튀지 않게). */
export function moveTarget(
  ids: readonly string[],
  from: string,
  action: "prev" | "next" | "first" | "last"
): string | null {
  const at = ids.indexOf(from);
  if (at < 0 || ids.length === 0) return null;
  switch (action) {
    case "prev":
      return ids[Math.max(0, at - 1)] ?? null;
    case "next":
      return ids[Math.min(ids.length - 1, at + 1)] ?? null;
    case "first":
      return ids[0] ?? null;
    case "last":
      return ids[ids.length - 1] ?? null;
  }
}

/**
 * 카드 하나를 뺀 뒤 초점이 갈 곳: 같은 자리로 올라오는 **다음 카드**, 마지막이었으면 **앞 카드**,
 * 하나뿐이었으면 `null`(= 글 칸). 초점이 사라진 카드와 함께 `<body>` 로 떨어지면 키보드 사용자는
 * 줄을 다시 찾느라 탭을 수십 번 누른다.
 */
export function focusAfterRemove(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

// ---- 가장자리 흐림 --------------------------------------------------------------

export type StripFade = "none" | "start" | "end" | "both";

/**
 * 어느 쪽이 넘치는가. **넘치는 쪽만** 흐리다: 끝까지 밀었을 때 마지막 카드와 그 X 가 흐려지면 안 된다.
 * 2px 의 오차는 소수점 스크롤이 만드는 가짜 넘침이다.
 */
export function stripFade(metrics: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): StripFade {
  const slack = 2;
  const start = metrics.scrollLeft > slack;
  const end = metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - slack;
  if (start && end) return "both";
  if (start) return "start";
  if (end) return "end";
  return "none";
}

// ---- 개수와 알림 ----------------------------------------------------------------

export interface TrayCounts {
  count: number;
  /** 한 메시지의 상한(코어가 정본이다. 서버도 같은 수). */
  limit: number;
  full: boolean;
  /** 「모두 지우기」를 보일 것인가. 셋 이하는 하나씩 빼는 쪽이 빠르다. */
  showsClearAll: boolean;
  rejected: number;
  folders: number;
  /** 상한·폴더로 못 받은 것이 있어 한 줄을 말해야 하는가. */
  showsNotice: boolean;
  /** 지금 보낼 수 없는 이유(없으면 `null`). 문장은 코어의 `sendBlockCopy` 가 낸다. */
  blocked: "uploading" | "failed" | null;
}

export function trayCounts(
  drafts: readonly AttachmentDraft[],
  rejected: number,
  folders: number
): TrayCounts {
  const list = [...drafts];
  return {
    count: list.length,
    limit: MAX_ATTACHMENTS_PER_MESSAGE,
    full: list.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    showsClearAll: list.length >= CLEAR_ALL_MIN_DRAFTS,
    rejected,
    folders,
    showsNotice: rejected > 0 || folders > 0,
    blocked: sendBlockReason(list),
  };
}
