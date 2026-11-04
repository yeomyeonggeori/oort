import { matchesExpressionContract } from "./contracts";
import type { ExpressionDraft, ExpressionMetadata } from "./types";

// =============================================================================
// 사진으로 팀 이모티콘 (ADR-0218 §8 H9, #4941).
//
// 서버가 팀에 연결된 이미지 모델(OpenAI·Gemini)에 사진 한 장을 보내 「배경 지우기」나
// 「캐리커처」 그림을 받아 직접 초안으로 돌려준다. 이 파일은 그 두 경로의 모양과 판정만
// 가진다: 요청 본문, 응답 검사, 실패 코드 → 화면이 말할 상황. 문장은 여기 없다(사전이 가진다).
// 순수 모듈이다: DOM·React·플랫폼 API가 없고 웹과 폰이 같이 쓴다.
// =============================================================================

export const PHOTO_BRANCHES = ["cutout", "caricature"] as const;
export type PhotoBranch = (typeof PHOTO_BRANCHES)[number];
export const PHOTO_PROVIDERS = ["openai", "gemini"] as const;
export type PhotoProvider = (typeof PHOTO_PROVIDERS)[number];

/** 모델이 그림 하나에 쓸 수 있는 시간은 최대 2분이라(서버 120초) 요청은 그보다 오래 기다린다. */
export const PHOTO_REQUEST_TIMEOUT_MS = 150_000;

/** `GET …/expressions/photo-model`. */
export interface PhotoModel {
  /** 팀에 이미지를 그릴 수 있는 모델이 연결돼 있는가. */
  readonly available: boolean;
  /** 사진이 가게 될 회사. 모델이 없으면 null. */
  readonly provider: PhotoProvider | null;
  readonly branches: readonly PhotoBranch[];
  /** 모델을 연결할 수 있는 사람(인스턴스 운영자)인가: 설정으로 보낼지, 운영자에게 알리라고 할지를 가른다. */
  readonly canManage: boolean;
}

/** 서버가 이 그림에 한 일. null은 캐리커처(배경을 건드리지 않음). */
export type PhotoCutout = "model" | "erased" | "unchanged" | null;

export interface PhotoDraftResult {
  readonly draft: ExpressionDraft;
  readonly cutout: PhotoCutout;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readPhotoModel(value: unknown): PhotoModel | null {
  if (!isRecord(value)) return null;
  const { available, provider, branches, canManage } = value;
  if (typeof available !== "boolean" || typeof canManage !== "boolean") return null;
  if (provider !== null && !(PHOTO_PROVIDERS as readonly unknown[]).includes(provider)) return null;
  // 모델이 있으면 어느 회사인지 알아야 하고, 없으면 회사가 없다: 서로 어긋난 답은 믿지 않는다.
  if (available !== (provider !== null)) return null;
  if (!Array.isArray(branches) || branches.length === 0 || !branches.every((branch) => (PHOTO_BRANCHES as readonly unknown[]).includes(branch))) return null;
  return { available, provider: provider as PhotoProvider | null, branches: branches as PhotoBranch[], canManage };
}

export function readPhotoDraftResult(value: unknown, workspaceId: string): PhotoDraftResult | null {
  if (!isRecord(value)) return null;
  const { draft, cutout } = value;
  if (!(cutout === null || cutout === "model" || cutout === "erased" || cutout === "unchanged")) return null;
  if (!matchesExpressionContract("Draft", draft) || (draft as ExpressionDraft).workspaceId !== workspaceId) return null;
  return { draft: draft as ExpressionDraft, cutout };
}

export interface PhotoMetadataInput {
  readonly branch: PhotoBranch;
  /** 사람이 동의한 회사: 서버가 지금 키가 닿는 회사와 맞는지 본다. */
  readonly provider: PhotoProvider;
  readonly metadata: ExpressionMetadata;
}

/** `POST …/expressions/photo-drafts`의 `metadata`. 자유 글 칸이 없다: 모델에 가는 글은 서버가 쓴다. */
export function buildPhotoMetadata(input: PhotoMetadataInput) {
  return {
    branch: input.branch,
    acknowledgedProvider: input.provider,
    name: input.metadata.name,
    displayName: input.metadata.displayName,
    tags: [...input.metadata.tags],
    subjectMemberId: input.metadata.subjectMemberId,
  };
}

/**
 * 화면이 말할 상황. 서버의 닫힌 코드(ADR-0218 §8 H9)와 기존 `expression_*` 코드를 한 어휘로 접는다.
 * 공급자가 쓴 문장은 어디에도 없다.
 */
export type PhotoFailure =
  | "unavailable"
  | "changed"
  | "refused"
  | "failed"
  | "timeout"
  | "busy"
  | "quota"
  | "role"
  | "name"
  | "media"
  | "too_large"
  | "offline"
  | "generic";

export function photoFailureOf(status: number | undefined, code: string | undefined): PhotoFailure {
  switch (code) {
    case "image_model_unavailable": return "unavailable";
    case "image_model_changed": return "changed";
    case "image_model_refused": return "refused";
    case "image_model_failed": return "failed";
    case "image_model_timeout": return "timeout";
    case "expression_quota": return "quota";
    case "expression_role_required": return "role";
    case "expression_name_reserved": return "name";
    case "expression_invalid": return "name";
    case "expression_media_invalid": return status === 413 ? "too_large" : "media";
    default: break;
  }
  if (status === 503) return "busy";
  if (status === 504) return "timeout";
  if (status === 413) return "too_large";
  if (status === 415) return "media";
  if (status === undefined) return "offline";
  return "generic";
}

/** 「여기서 다시 보낼 수 있는가」: 같은 요청을 그대로 되풀이해도 되는 실패. */
export function photoFailureRetryable(failure: PhotoFailure): boolean {
  return failure === "failed" || failure === "timeout" || failure === "busy" || failure === "offline" || failure === "generic";
}

/** 설정 › AI 연결로 가는 길. 모델이 없을 때 안내가 보내는 곳. */
export const AI_SETTINGS_PATH = "/settings?section=ai";

/** `GET …/expressions/photo-model`. */
export function photoModelRequest(base: string) {
  return { method: "GET" as const, path: `${base}/expressions/photo-model` };
}

/** `POST …/expressions/photo-drafts`: 사진은 `file`로, 나머지는 `metadata`로 간다. */
export function photoDraftRequest<F>(base: string, body: ReturnType<typeof buildPhotoMetadata>, file: F) {
  return { method: "POST" as const, path: `${base}/expressions/photo-drafts`, body, file, timeoutMs: PHOTO_REQUEST_TIMEOUT_MS };
}

/** 초안 하나를 등록한다(`POST …/expressions`). */
export function expressionActivateRequest(base: string, choice: unknown) {
  return { method: "POST" as const, path: `${base}/expressions`, body: choice };
}

/** 사진 요청의 이름·표시 이름·태그·당사자가 계약의 `Metadata` 모양인가. */
export function isPhotoMetadata(value: unknown): boolean {
  return matchesExpressionContract("Metadata", value);
}

/** 오류 본문(`{ "error": { "code": … } }`)에서 닫힌 `code`만 꺼낸다. 다른 글은 읽어도 돌려주지 않는다. */
export function errorCodeOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } } | null;
    const code = parsed?.error?.code;
    return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** 서버가 사진 길에서 답하는 닫힌 코드와 상태(ADR-0218 §8 H9). 개발용 가짜 서버와 시험이 같이 쓴다. */
export const PHOTO_FAILURE_STATUS = {
  image_model_unavailable: 409,
  image_model_changed: 409,
  image_model_refused: 422,
  image_model_failed: 502,
  image_model_timeout: 504,
} as const;
export type PhotoFailureCode = keyof typeof PHOTO_FAILURE_STATUS;

/**
 * 개발용 가짜 서버의 스위치: `?expressions=fixture&photoModel=none|openai|gemini&photoFailure=<닫힌 코드>`.
 * 모르는 값은 스위치가 없는 것으로 읽는다(그러면 사진 길 자체가 없는 가짜 서버가 된다).
 */
export function photoFixtureFromQuery(query: URLSearchParams): { model?: "none" | PhotoProvider; failure?: PhotoFailureCode } {
  const model = query.get("photoModel");
  const failure = query.get("photoFailure");
  return {
    model: model === "none" || (PHOTO_PROVIDERS as readonly (string | null)[]).includes(model) ? (model as "none" | PhotoProvider) : undefined,
    failure: failure !== null && Object.hasOwn(PHOTO_FAILURE_STATUS, failure) ? (failure as PhotoFailureCode) : undefined,
  };
}
