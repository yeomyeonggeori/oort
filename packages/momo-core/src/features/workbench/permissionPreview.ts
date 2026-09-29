// =============================================================================
// 권한 요청 미리보기 — 허락 서명이 사람이 본 것을 묶는다 (#3118, ADR-0146 증보
// R2 H1 · ADR-0188 D5).
//
// host(momo-workd)가 원천이다. 에이전트의 ACP 권한 요청에서 도구 종류·제목·위치·
// 입력 요약을 읽어 정화(보이지 않는 문자·방향 제어 제거, 자격 문자열 가림, 필드당
// 3,500자)한 닫힌 객체와 그 SHA-256을 올린다. 서버는 소유자에게만 그대로 중계한다.
// 앱은 **자기가 렌더한 미리보기로 해시를 다시 계산**해, 그것이 요청의 해시와 같고
// 렌더가 바이트를 바꾸지 않았을 때만 허락에 서명한다(`momo.human.control.v3`의
// permission 다섯째 줄). host는 그 줄을 자기가 계산한 해시와 대조한다.
//
// 그래서 서버는 앱이 보여 주는 것을 바꿀 수는 있어도 허락이 뜻하는 바는 바꾸지
// 못한다. 서버가 미리보기와 해시를 함께 바꿔치면 여기서는 통과하지만 host가
// 거부한다. 여기의 대조는 그 거부를 서명 전에 사람에게 알리는 몫이다.
//
// 정규 바이트는 Rust `momo_wire::permission_preview`와 같다: 키 정렬·압축
// JSON(`JSON.stringify` 이스케이프). 계약 벡터:
// `docs/api/human-control-signing-v3.vectors.json`의 permission 사례.
// =============================================================================

import { sha256Utf8 } from "../../lib/sha256";
import { sanitizeDisplayText, SANITIZE_FIELD_MAX } from "./agentPane";

export const PERMISSION_PREVIEW_SCHEMA_V1 = "momo.work_permission.preview.v1";

/** ACP `ToolKind` 어휘(닫힘). 모르는 것은 host가 `other`로 보낸다. */
export const PERMISSION_PREVIEW_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;

export type PermissionPreviewKind = (typeof PERMISSION_PREVIEW_KINDS)[number];

/** host가 만든 닫힌 미리보기 객체(`momo.work_permission.preview.v1`). */
export interface PermissionPreview {
  schema: typeof PERMISSION_PREVIEW_SCHEMA_V1;
  kind: PermissionPreviewKind;
  title: string;
  /** 요청의 경로들, 한 줄에 하나. */
  locations: string;
  /** 도구의 원 입력(압축 JSON). */
  input: string;
  /** host가 어느 필드를 잘랐다. 잘린 미리보기로는 허락할 수 없다(D5). */
  truncated: boolean;
}

const TEXT_FIELDS = ["title", "locations", "input"] as const;
const KEYS = ["input", "kind", "locations", "schema", "title", "truncated"];

/** 닫힌 v1 객체일 때만 돌려준다. 키 하나라도 더 있거나 모자라면 null. */
export function parsePermissionPreview(raw: unknown): PermissionPreview | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  if (keys.length !== KEYS.length || keys.some((key, i) => key !== KEYS[i])) return null;
  if (item.schema !== PERMISSION_PREVIEW_SCHEMA_V1) return null;
  if (!(PERMISSION_PREVIEW_KINDS as readonly unknown[]).includes(item.kind)) return null;
  for (const field of TEXT_FIELDS) {
    const text = item[field];
    if (typeof text !== "string" || Array.from(text).length > SANITIZE_FIELD_MAX) return null;
  }
  if (typeof item.truncated !== "boolean") return null;
  return {
    schema: PERMISSION_PREVIEW_SCHEMA_V1,
    kind: item.kind as PermissionPreviewKind,
    title: item.title as string,
    locations: item.locations as string,
    input: item.input as string,
    truncated: item.truncated,
  };
}

/** 정규 바이트(UTF-8로 인코딩할 문자열): 키 정렬, 공백 없음, `JSON.stringify` 이스케이프. */
export function permissionPreviewCanonical(preview: PermissionPreview): string {
  const object: Record<string, string | boolean> = {
    input: preview.input,
    kind: preview.kind,
    locations: preview.locations,
    schema: preview.schema,
    title: preview.title,
    truncated: preview.truncated,
  };
  // 키가 모두 ASCII라 기본 정렬(UTF-16)이 Rust 쪽과 같다.
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(object[key])}`)
    .join(",")}}`;
}

/** 정규 바이트의 SHA-256, 소문자 hex 64자 — v3 permission 서명의 다섯째 줄. */
export function permissionPreviewSha256(preview: PermissionPreview): string {
  return Array.from(sha256Utf8(permissionPreviewCanonical(preview)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export type PermissionPreviewCheck =
  | {
      ok: true;
      preview: PermissionPreview;
      /** 앱이 렌더한 미리보기에서 다시 계산한 해시. 서명에는 이 값을 싣는다. */
      sha256: string;
    }
  | {
      ok: false;
      /**
       * - `missing`: 요청에 미리보기나 해시가 없다(옛 host). 서명한 허락을 만들 수 없다.
       * - `malformed`: 닫힌 객체가 아니다.
       * - `mismatch`: 렌더한 미리보기의 해시가 요청의 해시와 다르다(바꿔치기).
       * - `display_altered`: 화면 정화가 바이트를 바꾼다(가림·무력화) — 본 것 ≠ 서명할 것.
       * - `truncated`: 잘린 미리보기(D5: 펼치기 전에는 허락 불가).
       */
      reason: "missing" | "malformed" | "mismatch" | "display_altered" | "truncated";
    };

/**
 * 허락에 서명해도 되는가. `raw`는 소유자 조회로 받은 미리보기, `expectedSha256`는
 * 요청(이벤트·조회)의 `preview_sha256`. 통과하면 서명에 쓸 해시를 돌려준다.
 *
 * 렌더는 필드를 그대로 보여 준다는 전제다. 그래서 표시 정화(`sanitizeDisplayText`)가
 * 무엇이든 바꾸면 — 가리거나, 보이지 않는 문자를 표지로 바꾸거나, 자르면— 사람이
 * 본 것과 서명할 바이트가 갈라지므로 서명하지 않는다. host 정화가 코어 정화의
 * 상위 집합이라 정직한 미리보기에서는 일어나지 않는다.
 */
export function checkPermissionPreview(
  raw: unknown,
  expectedSha256: string | null | undefined
): PermissionPreviewCheck {
  if (raw === null || raw === undefined || typeof expectedSha256 !== "string") {
    return { ok: false, reason: "missing" };
  }
  const preview = parsePermissionPreview(raw);
  if (preview === null || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return { ok: false, reason: "malformed" };
  }
  for (const field of TEXT_FIELDS) {
    const shown = sanitizeDisplayText(preview[field]);
    if (shown.text !== preview[field] || shown.truncated || shown.masked > 0 || shown.neutralized > 0) {
      return { ok: false, reason: "display_altered" };
    }
  }
  const sha256 = permissionPreviewSha256(preview);
  if (sha256 !== expectedSha256) return { ok: false, reason: "mismatch" };
  if (preview.truncated) return { ok: false, reason: "truncated" };
  return { ok: true, preview, sha256 };
}
