import { attachParticle } from "../../lib/koreanParticle";

// =============================================================================
// `member.avatar.set` 승인 카드: 「내 프로필 사진 바꾸기」 (ADR-0186 증보 2026-10-25 v4, #4385·#4394)
//
// 에이전트가 「이 사진으로 내 프로필 사진을 바꿔 줘」라는 부탁을 받아 **그 사람 본인**의
// 사진을 바꾸자고 제안한다. 승인할 수 있는 사람은 사진 주인 하나뿐이다(관리자도, 에이전트의
// 소유자도 아니다). 이 파일은 두 클라이언트가 같은 문장·같은 주소 모양을 쓰게 하려고 코어에
// 둔다 — 문장이 두 파일에 있으면 한쪽만 고쳐지는 날이 온다.
//
// ## 이 파일이 **하지 않는** 것
//
// 누가 사진 주인인지 클라이언트는 모른다. 핀(`pins.target`)은 승인의 payload(DB)에만 있고
// 카드 props 에 실리지 않는다. 그래서 「본인에게만」은 서버가 지킨다: 미리보기는 본인 아닌
// 사람에게 404, 결정은 403 `role_required`, 푸시는 본인에게만 간다. 클라이언트가 「대상」 행의
// 글자로 주인을 추측하는 길은 만들지 않는다(추측이 틀리면 남의 얼굴 카드에 버튼이 선다).
// =============================================================================

/** 레지스트리 행동 id. */
export const MEMBER_AVATAR_SET_ACTION_ID = "member.avatar.set";

export function isMemberAvatarSetAction(actionId: string | null | undefined): boolean {
  return actionId === MEMBER_AVATAR_SET_ACTION_ID;
}

/**
 * 승인 카드가 읽는 `action.preview` (kind `avatar_image`). 값은 전부 **서버가 만든** 것이다 —
 * 에이전트가 쓴 문자열은 이 블록에 실리지 않는다(ADR-0186 V1-a).
 */
export interface AvatarImagePreview {
  kind: "avatar_image";
  imageId: string;
  /** 소문자 16진 64자. 미리보기 주소의 `v` 이고, 바이트가 바뀌면 달라진다. */
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  /** 사진의 출처 코드(`attachment` 등). 화면 글자가 아니다. */
  origin: string;
  /** Authenticated, versioned server path to the picture being replaced. */
  previousAvatarUrl?: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `action.preview` 를 읽는다. 총 파싱: 모르는 `kind`·모양이 어긋난 값은 전부 `null` 이고,
 * 그때 카드는 사진 없이 서버 행만 그린다(틀린 사진 자리를 세우는 것보다 낫다).
 * `sha256` 은 소문자 16진 64자일 때만 통과한다 — 주소에 실리는 값이라서다.
 */
export function parseAvatarImagePreview(value: unknown): AvatarImagePreview | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "avatar_image") return null;
  const imageId = nonEmpty(raw.imageId);
  const mime = nonEmpty(raw.mime);
  const origin = nonEmpty(raw.origin);
  const width = positiveInt(raw.width);
  const height = positiveInt(raw.height);
  const sizeBytes = positiveInt(raw.sizeBytes);
  if (
    imageId === null ||
    mime === null ||
    origin === null ||
    width === null ||
    height === null ||
    sizeBytes === null ||
    typeof raw.sha256 !== "string" ||
    !SHA256.test(raw.sha256)
  ) {
    return null;
  }
  const previousAvatarUrl = typeof raw.previousAvatarUrl === "string" &&
    /^\/v1\/workspaces\/[A-Za-z0-9_-]+\/members\/[A-Za-z0-9_-]+\/avatar\/content\?v=[A-Za-z0-9_-]+$/.test(raw.previousAvatarUrl)
    ? raw.previousAvatarUrl : null;
  return { kind: "avatar_image", imageId, sha256: raw.sha256, mime, width, height, sizeBytes, origin,
    ...(Object.prototype.hasOwnProperty.call(raw, "previousAvatarUrl") ? { previousAvatarUrl } : {}),
  };
}

export function hasProfileAvatarPreview(action: { id: string; preview?: AvatarImagePreview } | null | undefined): boolean {
  return isMemberAvatarSetAction(action?.id) ||
    (action?.id === "agent.profile.update" && action.preview !== undefined);
}

export function profileAvatarHeadline(actionId: string | null | undefined, agentName: string | null | undefined): string | null {
  return memberAvatarSetHeadline(actionId, agentName) ??
    (actionId === "agent.profile.update" ? "에이전트의 프로필 사진을 바꾸려고 해요" : null);
}

/** `GET …/approvals/{approval}/avatar-preview?v={sha256}` 의 모양. 베어러를 싣기 전에 대조한다. */
// 세그먼트는 UUID·슬러그 글자(`[A-Za-z0-9_-]`)만 받는다: `.`·`..`·`%2e`·`\`·탭·개행처럼 URL 파서가
// 다른 경로로 정규화하는 표기는 글자째 들어올 수 없다(보안 검수 L1·r2 — 정규화되면 같은 서버의
// 다른 GET 경로로 베어러가 간다). 서버 id 는 UUID 라 정상 경로는 그대로 통과한다.
export const APPROVAL_AVATAR_PREVIEW_PATH =
  /^\/v1\/workspaces\/[A-Za-z0-9_-]+\/approvals\/[A-Za-z0-9_-]+\/avatar-preview\?v=[0-9a-f]{64}$/;

export function isApprovalAvatarPreviewPath(path: string | null | undefined): boolean {
  return typeof path === "string" && APPROVAL_AVATAR_PREVIEW_PATH.test(path);
}

/** 미리보기를 읽는 인가 경로. 재료가 모자라거나 모양이 어긋나면 `null`(사진 자리를 세우지 않는다). */
export function approvalAvatarPreviewPath(
  workspaceId: string | null | undefined,
  approvalId: string | null | undefined,
  preview: AvatarImagePreview | null
): string | null {
  if (!workspaceId || !approvalId || preview === null) return null;
  const path = `/v1/workspaces/${encodeURIComponent(workspaceId)}/approvals/${encodeURIComponent(
    approvalId
  )}/avatar-preview?v=${preview.sha256}`;
  return isApprovalAvatarPreviewPath(path) ? path : null;
}

/**
 * 카드의 첫 문장. 주어는 **카드를 올린 에이전트의 이름**(디렉터리가 푼 값)이다. 이 행동이
 * 아니면 `null` — 다른 카드의 머리를 이 문장으로 덮지 않는다.
 */
export function memberAvatarSetHeadline(
  actionId: string | null | undefined,
  agentName: string | null | undefined
): string | null {
  if (!isMemberAvatarSetAction(actionId)) return null;
  const name = agentName?.trim();
  const subject = name ? attachParticle(name, "subject") : "에이전트가";
  return `${subject} 내 프로필 사진을 이 사진으로 바꾸려고 해요`;
}

/** 사진 칸의 접근성 이름. */
export const AVATAR_PREVIEW_ALT = "내 프로필 사진으로 제안된 사진";

/**
 * 사진을 못 불러왔을 때(본인이 아니라 404, 네트워크, 만료) 사진 자리에 서는 한 줄.
 * 원인을 가르지 않는다 — 서버가 일부러 같은 404 로 답하기 때문이고, 어느 쪽이든 사람에게
 * 맞는 말은 「이 사진은 본인만 볼 수 있어요」다.
 */
export const AVATAR_PREVIEW_UNAVAILABLE = "이 사진은 요청한 본인만 볼 수 있어요.";

/** 사진이 승인 전에 보인다는 사실을 버튼 위에서 말하는 줄. */
export const AVATAR_PREVIEW_CAPTION = "승인하면 내 프로필 사진이 이 사진으로 바뀌어요.";
