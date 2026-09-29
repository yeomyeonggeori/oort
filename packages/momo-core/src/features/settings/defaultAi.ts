// =============================================================================
// 기본 AI 표의 팀 줄 — 서버 저장 (#3042, 서버 #3009 `GET/PUT /v1/provider/default-ai`).
//
// Wire contract: docs/api/openapi.yaml `ProviderDefaultAiResponse`,
// `PutProviderDefaultAiRequest`; model ids come from the connection check's
// `ProviderProbeDetail.modelIds` (openapi.operator.yaml) and nowhere else.
//
// Rules this file holds (brief §4.2·§4.5, ADR-0147 증보 2026-09-28):
//   1. 팀 줄은 팀 연결(`team_link`)만 가리킨다. 이 파일이 만드는 선택지와 PUT 본문
//      어디에도 개인 구독이 들어갈 자리가 없다(`source`는 상수).
//   2. 모델 이름은 지어내지 않는다. 선택지는 방금 한 연결 확인이 돌려준 `modelIds`
//      뿐이고, 목록이 없으면 「기본 모델」(= `modelId: null`, 연결이 정한 모델)만.
//      서버에 저장된 값이 목록에 없으면 그 값을 「목록 확인 전」으로 남긴다.
//   3. 저장된 연결이 체인에서 바뀌었으면(`linkResolved: false`) 조용히 따라가지
//      않고 문장으로 말한다.
//   4. 운영자 판정은 서버 답이다(GET 200 = 고를 수 있음, 403 = 읽기 전용).
//
// Its own file rather than an addition to ./api.ts (the ./notificationRules.ts
// reason: parallel workers edit the settings surface and api.ts collides). It
// reuses `settingsRequest`, so one transport and one auth path.
// =============================================================================

import { ApiError } from "../../lib/api";
import { arrayField, bool, num, record, str } from "../../lib/wire";
import { settingsRequest } from "./api";
import { teamKeyHost } from "./aiDefaults";

/** 서버에 저장되는 팀 줄. 가드레일은 `off`만 받으므로 여기 없다. */
export const TEAM_DEFAULT_ROW_IDS = ["teamAgent", "summary"] as const;
export type TeamDefaultRowId = (typeof TEAM_DEFAULT_ROW_IDS)[number];

/** `ProviderDefaultAiRow`. 키·경로·토큰 칸은 서버 모양에도 없다. */
export interface TeamDefaultAiRow {
  readonly linkPosition: number;
  /** 고를 때의 endpoint label 스냅샷(가린 주소). */
  readonly endpointLabel: string;
  /** false = 그 위치가 사라졌거나 지금은 다른 주소다. */
  readonly linkResolved: boolean;
  /** null = 연결이 정한 기본 모델. */
  readonly modelId: string | null;
}

export interface ProviderDefaultAi {
  readonly teamAgent: TeamDefaultAiRow | null;
  readonly summary: TeamDefaultAiRow | null;
}

/** OpenAPI `modelId` pattern. 모양이 다른 값은 화면에 싣지 않는다. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

function rowFromWire(value: unknown): TeamDefaultAiRow | null | undefined {
  if (value === null) return null;
  const body = record(value);
  if (!body) return undefined;
  const position = num(body, "linkPosition");
  const label = str(body, "endpointLabel");
  const resolved = bool(body, "linkResolved");
  if (position === undefined || !Number.isInteger(position) || position < 0) return undefined;
  if (label === undefined || resolved === undefined) return undefined;
  if (str(body, "source") !== "team_link") return undefined;
  const model = body.modelId;
  if (model !== null && !isModelId(model)) return undefined;
  return { linkPosition: position, endpointLabel: label, linkResolved: resolved, modelId: model };
}

/**
 * 응답 → 두 줄. 읽을 수 없는 모양이면 null(화면은 오류 칸을 그린다): 프록시나 다른
 * 버전의 200 을 「고르지 않음」으로 읽으면 저장된 선택을 없다고 단정하게 된다.
 */
export function defaultAiFromWire(value: unknown): ProviderDefaultAi | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.provider.default_ai.v0") return null;
  const teamAgent = rowFromWire(body.teamAgent);
  const summary = rowFromWire(body.summary);
  if (teamAgent === undefined || summary === undefined) return null;
  return { teamAgent, summary };
}

export function fetchProviderDefaultAi(): Promise<ProviderDefaultAi | null> {
  return settingsRequest<unknown>("/v1/provider/default-ai").then(defaultAiFromWire);
}

/** 한 줄의 새 값. null = 지우기(서버가 정함). */
export interface TeamDefaultAiInput {
  readonly linkPosition: number;
  readonly modelId: string | null;
}

/** PUT 본문. 행 단위 patch: 이 줄만 싣고 다른 줄은 생략(= 유지)한다. */
export function defaultAiPutBody(
  rowId: TeamDefaultRowId,
  input: TeamDefaultAiInput | null
): Record<string, unknown> {
  return {
    [rowId]:
      input === null
        ? null
        : { source: "team_link", linkPosition: input.linkPosition, modelId: input.modelId },
  };
}

export function putProviderDefaultAi(
  rowId: TeamDefaultRowId,
  input: TeamDefaultAiInput | null
): Promise<ProviderDefaultAi | null> {
  return settingsRequest<unknown>("/v1/provider/default-ai", {
    method: "PUT",
    body: JSON.stringify(defaultAiPutBody(rowId, input)),
  }).then(defaultAiFromWire);
}

// ---- 연결 확인이 알려 준 모델 -------------------------------------------------

/** 연결 하나와 그 연결 확인이 돌려준 모델 id. */
export interface TeamLinkModels {
  readonly position: number;
  /** 가린 주소(`endpointLabel`). */
  readonly label: string;
  /** null = 이 확인은 모델 목록을 싣지 않았다(OpenRouter `/key`, 실패, 옛 서버). */
  readonly modelIds: readonly string[] | null;
  readonly truncated: boolean;
}

/**
 * `POST /v1/provider/link/test` 응답의 `entries[]` → 연결마다 모델 목록. 모양이
 * 틀린 칸은 버린다. 확인 전이거나 `entries`가 없는 옛 서버면 빈 목록이다.
 */
export function probeModelLists(probe: unknown): TeamLinkModels[] {
  const entries = arrayField(probe, "entries");
  if (entries === null) return [];
  const out: TeamLinkModels[] = [];
  for (const entry of entries) {
    const position = num(entry, "position");
    const label = str(entry, "endpointLabel");
    if (position === undefined || !Number.isInteger(position) || position < 0 || label === undefined) continue;
    if (out.some((link) => link.position === position)) continue;
    const detail = record(record(entry)?.probe);
    const raw = detail ? arrayField(detail, "modelIds") : null;
    const ids = raw === null ? null : [...new Set(raw.filter(isModelId))];
    out.push({
      position,
      label,
      modelIds: ids,
      truncated: detail?.modelIdsTruncated === true,
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

// ---- 선택지 ----------------------------------------------------------------------

/** 고르지 않음 = 줄을 지운다. 그때 무엇이 정하는지를 말한다(PR #3039 우선순위). */
export const TEAM_DEFAULT_UNSET_LABEL: Record<TeamDefaultRowId, string> = {
  teamAgent: "고르지 않음 · 에이전트마다 정함",
  summary: "고르지 않음 · 서버가 정함",
};

export const DEFAULT_MODEL_LABEL = "기본 모델";

export interface TeamDefaultOption {
  readonly key: string;
  readonly text: string;
  readonly input: TeamDefaultAiInput | null;
}

export function teamOptionKey(input: TeamDefaultAiInput | null): string {
  return input === null ? "" : `link:${input.linkPosition}:${input.modelId ?? ""}`;
}

function optionText(label: string, modelId: string | null): string {
  return `${teamKeyHost(label)} · ${modelId ?? DEFAULT_MODEL_LABEL}`;
}

/**
 * 팀 줄의 선택지. 연결마다 「기본 모델」과 그 연결 확인이 돌려준 모델 id뿐이다.
 * 저장된 값이 목록에 없으면(확인 전·목록 밖) 그 값을 이유와 함께 남긴다: 칸이
 * 다른 값을 가리키는 척하지 않게.
 */
export function teamOptions(
  rowId: TeamDefaultRowId,
  saved: TeamDefaultAiRow | null,
  links: readonly TeamLinkModels[]
): TeamDefaultOption[] {
  const out: TeamDefaultOption[] = [{ key: "", text: TEAM_DEFAULT_UNSET_LABEL[rowId], input: null }];
  for (const link of links) {
    const models: (string | null)[] = [null, ...(link.modelIds ?? [])];
    for (const modelId of models) {
      const input = { linkPosition: link.position, modelId };
      out.push({ key: teamOptionKey(input), text: optionText(link.label, modelId), input });
    }
  }
  if (saved) {
    const input = { linkPosition: saved.linkPosition, modelId: saved.modelId };
    const key = teamOptionKey(input);
    if (!out.some((option) => option.key === key)) {
      const why = saved.linkResolved ? "목록 확인 전" : "연결이 바뀜";
      out.push({ key, text: `${optionText(saved.endpointLabel, saved.modelId)} (${why})`, input });
    }
  }
  return out;
}

/** 저장된 값을 읽기 전용 칸에 쓸 때. */
export function teamChoiceText(rowId: TeamDefaultRowId, saved: TeamDefaultAiRow | null): string {
  if (saved === null) return TEAM_DEFAULT_UNSET_LABEL[rowId];
  // 선택 칸의 목록 밖 값과 같은 표지(확인 전후로 값 글자가 바뀌지 않게).
  const text = optionText(saved.endpointLabel, saved.modelId);
  return saved.linkResolved ? text : `${text} (연결이 바뀜)`;
}

// ---- 문장 ------------------------------------------------------------------------

/**
 * 팀 줄의 적용 규칙(#3147, 서버 #3146). 에이전트가 자기 모델을 고르면 그 모델이 먼저이고,
 * 고르지 않은 에이전트의 대답과 첫 인사는 이 선택을 따른다. 채널 요약을 만드는 워커 경로는
 * 아직 없어 요약 줄은 첫 인사에만 적용된다: 요약도 따른다고 말하지 않는다.
 */
export const TEAM_DEFAULTS_APPLIED =
  "모델을 직접 고른 에이전트는 자기 모델을 써요. 고르지 않은 에이전트의 대답은 팀 에이전트 줄을, 첫 인사는 채널 요약 줄을 따라요. 채널 요약 자체는 아직 이 선택을 따르지 않아요.";

export const TEAM_DEFAULTS_CHECK_FIRST = "연결 확인을 하면 고를 수 있는 모델이 보여요.";

/**
 * 저장된 연결이 바뀌었다. 고를 칸이 없는 확인 전에는 할 일(연결 확인)을 같은 문장에
 * 순서대로 넣는다: 「다시 골라 주세요」 옆에 고를 칸이 없으면 문장이 거짓이 된다.
 */
export function linkUnresolvedSentence(saved: TeamDefaultAiRow, canPick = true): string {
  const head = `고른 연결(${teamKeyHost(saved.endpointLabel)})이 연결 순서에서 바뀌었거나 빠졌어요.`;
  return canPick ? `${head} 다시 골라 주세요.` : `${head} 연결 확인을 한 뒤 다시 골라 주세요.`;
}

export const TEAM_DEFAULTS_OFFLINE = "연결이 끊겨 지금은 바꿀 수 없어요.";

/** 고른 연결의 목록 사정. 말할 것이 없으면 null. */
export function teamModelNote(
  selected: TeamDefaultAiInput | null,
  links: readonly TeamLinkModels[]
): string | null {
  if (selected === null) return null;
  const link = links.find((candidate) => candidate.position === selected.linkPosition);
  if (!link) return null;
  if (link.modelIds === null || link.modelIds.length === 0) {
    return "이 연결은 모델 목록을 알려 주지 않아요. 기본 모델만 고를 수 있어요.";
  }
  if (link.truncated) {
    return `모델이 많아 앞의 ${link.modelIds.length}개만 보여요.`;
  }
  return null;
}

export function teamDefaultSaveMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "팀 줄은 이 서버의 운영자만 바꿀 수 있어요.";
    if (error.status === 400) {
      return `서버가 이 선택을 받지 않았어요. 연결 확인을 다시 한 뒤 골라 주세요. 서버가 보고한 사유: ${error.message}`;
    }
    if (error.status === 404) return "이 서버는 아직 팀 줄을 저장할 수 없어요. 서버를 업데이트한 뒤 다시 시도해 주세요.";
  }
  return "저장하지 못했어요. 잠시 뒤에 다시 시도해 주세요.";
}
