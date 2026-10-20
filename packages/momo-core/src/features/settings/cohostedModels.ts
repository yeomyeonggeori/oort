// =============================================================================
// 같은 서버 Hermes의 「모델」 구획 (#4145 화면 / #4143 엔진, ADR-0203 증보 2026-10-20).
//
// Wire contract (엔진 PR #4149, docs/api/openapi.operator.yaml):
//   GET `/v1/workspaces/{ws}/cohosted-agent/models` -> `momo.cohosted_agent.models.v0`
//     Hermes가 로그인됐다고 표시한 제공자만 온다(`authenticated: true`). 그래서 이 목록에 든 제공자 = 로그인된 제공자다.
//     각 모델은 `featured`(제공자별 앞 세 개 + 쓰는 모델)·`current`를 달고 온다.
//   PUT `…/cohosted-agent/model` { provider, model } -> `momo.cohosted_agent.model.v0`
//     목록 밖이면 422 `cohosted_model_not_offered`, 운영자가 아니면 403. 본문에 주소·키·경로는 없다.
//
// Rules this file holds:
//   1. 보이지 않는 것이 기본이다: 403(운영자 아님)·404/405(이 서버에 길이 없음)는 `hidden`.
//   2. 서버가 준 모양을 믿지 않는다. 읽을 수 없는 제공자·모델은 버리고, 하나도 못 읽으면 `unknown`.
//   3. 이 파일은 제공자 슬러그와 모델 id만 다룬다. 키·주소는 오지도 가지도 않는다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { arrayField, bool, record, str } from "../../lib/wire";
import { settingsRequest } from "./api";

export interface CohostedModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface CohostedModelEntry {
  readonly id: string;
  readonly featured: boolean;
  readonly current: boolean;
}

export interface CohostedProviderModels {
  readonly provider: string;
  readonly models: readonly CohostedModelEntry[];
}

export interface CohostedModels {
  readonly agentId: string;
  /** 핀이 있으면 핀의 선택, 없으면 Hermes 자신의 현재 모델. */
  readonly current: CohostedModelRef | null;
  readonly pinned: boolean;
  /** 로그인된 제공자만. 비어 있으면 아직 아무 제공자도 로그인하지 않은 것이다. */
  readonly providers: readonly CohostedProviderModels[];
}

export type CohostedModelsRead =
  | { readonly kind: "ready"; readonly models: CohostedModels }
  | { readonly kind: "hidden" }
  | { readonly kind: "unknown"; readonly code: string | null };

function refFromWire(value: unknown): CohostedModelRef | null {
  const provider = str(value, "provider");
  const model = str(value, "model");
  return provider && model ? { provider, model } : null;
}

export function modelsFromWire(value: unknown): CohostedModels | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.cohosted_agent.models.v0") return null;
  const agentId = str(body, "agentId");
  const pinned = bool(body, "pinned");
  const rawProviders = arrayField(body, "providers");
  if (agentId === undefined || pinned === undefined || rawProviders === null) return null;
  const providers: CohostedProviderModels[] = [];
  for (const raw of rawProviders) {
    const provider = str(raw, "provider");
    const rawModels = arrayField(raw, "models");
    if (!provider || rawModels === null) return null;
    const models: CohostedModelEntry[] = [];
    for (const entry of rawModels) {
      const id = str(entry, "id");
      if (!id) return null;
      models.push({ id, featured: bool(entry, "featured") === true, current: bool(entry, "current") === true });
    }
    providers.push({ provider, models });
  }
  return { agentId, current: refFromWire(body.current), pinned, providers };
}

function path(workspaceId: string, tail: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/cohosted-agent${tail}`;
}

export async function fetchCohostedModels(workspaceId: string): Promise<CohostedModelsRead> {
  try {
    const models = modelsFromWire(await settingsRequest<unknown>(path(workspaceId, "/models")));
    return models === null ? { kind: "unknown", code: null } : { kind: "ready", models };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 403 || error.status === 404 || error.status === 405) return { kind: "hidden" };
      return { kind: "unknown", code: error.code ?? null };
    }
    throw error;
  }
}

/** 모델을 고른다. 성공하면 서버가 쓴 핀을 돌려준다. 실패는 `ApiError`(문장은 `modelErrorMessage`). */
export async function putCohostedModel(workspaceId: string, choice: CohostedModelRef): Promise<CohostedModelRef> {
  const body = record(
    await settingsRequest<unknown>(path(workspaceId, "/model"), {
      method: "PUT",
      body: JSON.stringify({ provider: choice.provider, model: choice.model }),
    })
  );
  const current = body && str(body, "schema") === "momo.cohosted_agent.model.v0" ? refFromWire(body.current) : null;
  if (current === null) throw new ApiError(502, "unreadable model answer");
  return current;
}

// ---- 문장 ------------------------------------------------------------------------

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI Codex",
};

/** 제공자 슬러그의 사람 낱말. 모르는 슬러그는 그대로 보인다. */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 로그인 줄에 쓰는 이름(「Claude」·「Codex」). 모르는 슬러그는 제공자 이름. */
export function providerLoginName(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai-codex") return "Codex";
  return providerLabel(provider);
}

/** `claude-sonnet-5-5`·`claude-opus-4-1-20250805` -> 「Claude Sonnet 5.5」·「Claude Opus 4.1」. 모르는 id는 그대로. */
export function modelLabel(id: string): string {
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!match) return id;
  const family = `${match[1][0].toUpperCase()}${match[1].slice(1)}`;
  return `Claude ${family} ${match[3] ? `${match[2]}.${match[3]}` : match[2]}`;
}

export function loggedInProviders(models: CohostedModels | null): ReadonlySet<string> {
  return new Set((models?.providers ?? []).map((entry) => entry.provider));
}

export interface ModelOption {
  /** `provider` 와 모델 id 를 한 값으로 묶은 것. `splitModelValue` 로 푼다. */
  readonly value: string;
  readonly provider: string;
  readonly model: string;
  readonly featured: boolean;
}

const SEP = "\u0000";
export function modelValue(ref: CohostedModelRef): string {
  return `${ref.provider}${SEP}${ref.model}`;
}
export function splitModelValue(value: string): CohostedModelRef | null {
  const at = value.indexOf(SEP);
  return at > 0 && at < value.length - 1 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : null;
}

/**
 * 고를 수 있는 모델. 기본은 `featured` 만, `showAll` 이면 나머지까지. 쓰고 있는 모델은 featured 가 아니어도 늘 보인다
 * (고른 칸이 비어 보이면 안 된다). 순서는 서버(=Hermes)가 준 제공자·모델 순서 그대로다.
 */
export function modelOptions(models: CohostedModels, showAll: boolean, current: CohostedModelRef | null): ModelOption[] {
  const out: ModelOption[] = [];
  for (const entry of models.providers) {
    for (const model of entry.models) {
      const isCurrent = current !== null && current.provider === entry.provider && current.model === model.id;
      if (!showAll && !model.featured && !isCurrent) continue;
      out.push({ value: modelValue({ provider: entry.provider, model: model.id }), provider: entry.provider, model: model.id, featured: model.featured });
    }
  }
  return out;
}

/** 전체 보기를 눌러야 보이는 모델이 있는가. */
export function hasHiddenModels(models: CohostedModels, current: CohostedModelRef | null): boolean {
  return modelOptions(models, true, current).length > modelOptions(models, false, current).length;
}

export const COHOSTED_MODEL_COPY = {
  title: "모델",
  /** 연결 직후 한 번: 구획 제목 대신 묻는다. */
  askFirst: "어떤 모델로 쓸까요?",
  currentLead: "지금 답하는 모델",
  fieldLabel: "답하는 모델 고르기",
  placeholder: "모델 고르기",
  showAll: "전체 보기",
  showFeatured: "추천만 보기",
  saving: "바꾸는 중이에요",
  saved: "모델을 바꿨어요",
  loading: "모델 목록을 불러오고 있어요.",
  loadError: "모델 목록을 불러오지 못했어요.",
  retry: "다시 불러오기",
  noneLoggedIn: "아직 로그인된 제공자가 없어요. 아래에서 로그인하면 고를 수 있는 모델이 여기에 나타나요.",
  followingHermes: "Hermes가 정한 모델을 그대로 써요.",
  offline: "연결이 끊긴 동안에는 모델을 바꿀 수 없어요.",
  loggedInLine: "로그인됨",
  teamNote: "이 Hermes는 팀 전체가 함께 써요. 바꾸면 다음 답부터 새 모델로 나가요.",
} as const;

/** 목록을 못 읽은 이유(닫힌 낱말). */
export function modelsLoadErrorMessage(code: string | null): string {
  if (code === "cohosted_agent_not_ready") return "서버의 Hermes 설정이 아직 준비되지 않았어요.";
  if (code === "cohosted_agent_not_connected") return "Hermes가 연결돼 있지 않아요.";
  if (code === "cohosted_models_unavailable") return "Hermes가 모델 목록을 주지 않았어요. Hermes가 켜져 있는지 확인해 주세요.";
  return COHOSTED_MODEL_COPY.loadError;
}

export function modelSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "cohosted_model_not_offered" || error.status === 422) {
      return "이 모델은 이제 고를 수 없어요. 목록을 다시 불러왔으니 다시 골라 주세요.";
    }
    if (error.code === "cohosted_agent_not_connected") return "Hermes 연결이 끊겨 모델을 바꾸지 못했어요.";
    if (error.code === "cohosted_models_unavailable") return "Hermes가 답하지 않아 모델을 바꾸지 못했어요. 바뀐 것은 없어요.";
    if (error.status === 403) return "모델은 이 서버의 운영자만 바꿀 수 있어요.";
    if (error.status === 429) return "너무 자주 시도했어요. 잠시 뒤에 다시 시도해 주세요.";
  }
  return "모델을 바꾸지 못했어요. 바뀐 것은 없어요.";
}
