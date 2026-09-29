// =============================================================================
// 권한 카드의 허락 문 — 미리보기 확인을 통과해야만 열린다 (#3128, ADR-0146 증보
// 2026-09-29 R2 H1 · ADR-0188 D5).
//
// 폰·데스크탑 카드가 공용으로 쓴다. 카드는 소유자 조회(`GET …/permission-requests/
// {id}`)로 host의 미리보기를 받아 이 문에 넘긴다. 문은 `checkPermissionPreview`로
// 해시를 다시 계산해, 요청의 해시와 같고 잘리지 않았을 때만 `ready`를 준다. 허락
// 서명(`momo.human.control.v3`)에는 `ready.sha256`, 즉 **앱이 다시 계산한 값**을 싣는다.
//
// 서명 근거가 되는 화면에는 `agent.status`에서 추론한 문구를 두지 않는다. 질문 한 줄도
// 확인한 미리보기의 `kind`에서만 고르고, 확인 전에는 종류를 말하지 않는 문장을 쓴다.
// 거부는 서명하지 않으므로(D-8) 이 문과 상관없이 늘 열려 있다.
// =============================================================================

import type { WorkPermissionPreviewResponse } from "../../lib/api";
import {
  checkPermissionPreview,
  parsePermissionPreview,
  type PermissionPreview,
  type PermissionPreviewKind,
} from "./permissionPreview";

/** 소유자 조회의 상태(react-query 모양과 무관한 최소형). */
export type PermissionPreviewFetch =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; data: WorkPermissionPreviewResponse };

export type PermissionPreviewBlock =
  | "missing"
  | "malformed"
  | "mismatch"
  | "display_altered"
  | "truncated"
  | "unavailable";

export type PermissionPreviewGate =
  | { state: "loading" }
  /** 허락해도 된다. 서명에는 `sha256`(다시 계산한 값)을 싣는다. */
  | { state: "ready"; preview: PermissionPreview; sha256: string }
  | {
      state: "blocked";
      reason: PermissionPreviewBlock;
      /**
       * 보여 줄 수 있는 미리보기. 해시가 맞는데 잘린 경우(`truncated`)만 있다.
       * 해시가 맞지 않거나 모양이 틀린 것은 보여 주지 않는다(무엇인지 모른다).
       */
      preview: PermissionPreview | null;
      line: string;
    };

/** 허락할 수 없는 이유마다 한 문장(해요체). 거부는 늘 할 수 있다고 함께 말한다. */
export const PERMISSION_PREVIEW_BLOCK_LINE: Readonly<Record<PermissionPreviewBlock, string>> = {
  missing:
    "호스트가 이 요청의 미리보기를 보내지 않아 허락할 수 없어요. 거부하거나 호스트에서 결정해 주세요.",
  malformed: "미리보기를 확인할 수 없어 허락할 수 없어요. 거부하거나 호스트에서 결정해 주세요.",
  mismatch:
    "받은 미리보기가 요청과 맞지 않아 허락할 수 없어요. 서버가 내용을 바꿨을 수 있어요. 거부하거나 호스트에서 결정해 주세요.",
  display_altered:
    "미리보기에 화면에 그대로 보일 수 없는 글자가 있어 허락할 수 없어요. 거부하거나 호스트에서 결정해 주세요.",
  truncated:
    "미리보기가 길어 잘렸어요. 전체를 보지 않고는 허락할 수 없어요. 거부하거나 호스트에서 결정해 주세요.",
  unavailable:
    "미리보기를 받아 오지 못해 허락할 수 없어요. 연결이 돌아오면 다시 받아 와요. 거부는 지금도 할 수 있어요.",
};

export const PERMISSION_PREVIEW_LOADING_LINE = "미리보기를 확인하는 중이에요.";

/** 종류를 모를 때(확인 전·실패)의 질문. 추론한 종류를 쓰지 않는다. */
export const PERMISSION_ASK_UNVERIFIED = "에이전트가 도구를 쓰려고 해요.";

/** 확인한 미리보기의 종류별 질문. */
export const PERMISSION_PREVIEW_ASK: Readonly<Record<PermissionPreviewKind, string>> = {
  read: "파일을 읽어도 될까요?",
  edit: "파일을 고쳐도 될까요?",
  delete: "파일을 지워도 될까요?",
  move: "파일을 옮겨도 될까요?",
  search: "검색해도 될까요?",
  execute: "명령을 실행해도 될까요?",
  think: "도구를 써도 될까요?",
  fetch: "웹에서 가져와도 될까요?",
  switch_mode: "작업 모드를 바꿔도 될까요?",
  other: "도구를 써도 될까요?",
};

/** 미리보기 칸의 종류 표지(데스크탑 확인 창 `preview_kind_label`과 같은 말). */
export const PERMISSION_PREVIEW_KIND_LABEL: Readonly<Record<PermissionPreviewKind, string>> = {
  read: "파일 읽기",
  edit: "파일 고치기",
  delete: "파일 지우기",
  move: "파일 옮기기",
  search: "검색",
  execute: "명령 실행",
  think: "생각 정리",
  fetch: "웹에서 가져오기",
  switch_mode: "모드 바꾸기",
  other: "기타 도구",
};

/**
 * 미리보기 칸의 필드 순서: 실행되는 **입력**이 먼저, 에이전트가 쓴 제목이 마지막이다.
 * 데스크탑 확인 창(`payload.rs` `preview_full_text`: [입력] → [위치] → [제목])과 같은
 * 순서다 — 제목 안의 줄바꿈으로 가짜 「입력」을 만들어 진짜 입력을 밀어내지 못하게
 * (#3128 보안 검수 M, design-review H2). 두 쪽 시험이 같은 순서를 잰다.
 */
export const PERMISSION_PREVIEW_FIELD_ORDER = ["input", "locations", "title"] as const;

const FIELD_LABEL = { input: "입력", locations: "위치", title: "제목" } as const;

/**
 * 미리보기 칸의 줄들: 필드를 **그대로** 보여 준다(확인이 전제한 것 — 렌더가 곧
 * 해시한 바이트다). 빈 필드는 줄을 만들지 않는다. 카드는 필드 글 앞에 표지가 결코
 * 갖지 않는 여백 선을 그린다(글은 바꾸지 않는다).
 */
export function permissionPreviewRows(
  preview: PermissionPreview
): Array<{ key: "title" | "locations" | "input"; label: string; text: string }> {
  return PERMISSION_PREVIEW_FIELD_ORDER.filter((key) => preview[key] !== "").map((key) => ({
    key,
    label: FIELD_LABEL[key],
    text: preview[key],
  }));
}

/**
 * 허락이 이 요청에서 다시 열릴 수 없는 막힘인가(모양·해시·잘림·미리보기 없음). 이때
 * 카드는 허락을 주 버튼으로 그리지 않는다 — 누를 수 있는 것은 거부뿐이다(design-review
 * M1). 받는 중·조회 실패는 다시 열릴 수 있어 그대로 둔다.
 */
export function permissionAllowGone(gate: PermissionPreviewGate): boolean {
  return gate.state === "blocked" && gate.reason !== "unavailable";
}

/**
 * 카드의 허락 문. `eventSha256`은 요청 이벤트(`approval.requested`)의 해시,
 * 조회 응답에도 해시가 있으면 둘이 같아야 한다(다르면 바꿔치기로 본다).
 */
export function permissionPreviewGate(
  eventSha256: string | null,
  fetched: PermissionPreviewFetch
): PermissionPreviewGate {
  if (fetched.status === "loading") return { state: "loading" };
  if (fetched.status === "error") {
    return { state: "blocked", reason: "unavailable", preview: null, line: PERMISSION_PREVIEW_BLOCK_LINE.unavailable };
  }
  const readSha256 = fetched.data.permissionRequest.previewSha256;
  if (eventSha256 !== null && typeof readSha256 === "string" && readSha256 !== eventSha256) {
    return { state: "blocked", reason: "mismatch", preview: null, line: PERMISSION_PREVIEW_BLOCK_LINE.mismatch };
  }
  const expected = eventSha256 ?? (typeof readSha256 === "string" ? readSha256 : null);
  const check = checkPermissionPreview(fetched.data.preview, expected);
  if (check.ok) return { state: "ready", preview: check.preview, sha256: check.sha256 };
  return {
    state: "blocked",
    reason: check.reason,
    preview: check.reason === "truncated" ? truncatedPreview(fetched.data.preview) : null,
    line: PERMISSION_PREVIEW_BLOCK_LINE[check.reason],
  };
}

/** `truncated` 판정은 해시가 맞은 뒤에만 나온다. 그 객체를 표시용으로 돌려준다. */
function truncatedPreview(raw: unknown): PermissionPreview | null {
  return parsePermissionPreview(raw);
}

/** 카드의 질문 한 줄: 허락할 수 있거나 해시가 맞은(잘린) 미리보기의 종류에서만. */
export function permissionGateAsk(gate: PermissionPreviewGate): string {
  if (gate.state === "ready") return PERMISSION_PREVIEW_ASK[gate.preview.kind];
  if (gate.state === "blocked" && gate.preview) return PERMISSION_PREVIEW_ASK[gate.preview.kind];
  return PERMISSION_ASK_UNVERIFIED;
}
