// =============================================================================
// 모델·추론 강도 라우팅의 순수 로직 (ADR-0134 D1·D2·D3).
//
// 계약 정본:
//   GET  /v1/provider/effort-table                     (ADR-0134 D2, MOMO-621)
//   POST /v1/workspaces/:ws/channels/:ch/agent-runs     routing{model,effort}
//   GET/PUT /v1/workspaces/:ws/agents/:agent/profile    modelPref / effortPref
//
// 이 파일에는 React도 네트워크도 없다. 계약 픽스처(routingFixtures.json)로
// 상속·오버라이드·무효 클리어 세 경로를 단위 테스트로 고정해 두었기 때문에,
// 엔진층이 아직 붙지 않은 서버 앞에서도 규칙 자체는 검증된 상태로 남는다.
//
// 이 파일이 지키는 세 가지 사실:
//   - effort의 유효값은 전역 어휘가 아니라 provider×model 표다(D2). 표는
//     서버가 정본이고, 클라이언트는 표에 없는 값을 만들어내지 않는다.
//   - 빈 값은 "상속"이다. 상속은 실제로 적용될 값을 함께 보여줄 때만 정직하다
//     (D3 "상속 (실제값 병기)").
//   - 모델이 바뀌어 현재 effort가 유효값에서 벗어나면 자동으로 비우고 그 사실을
//     말한다. 조용한 리셋은 금지다(D3, t3.chat 반면교사).
//
// 워크스페이스 기본 티어(D3의 1층)는 아직 저장소가 없다. 서버도 그 자리를
// 에이전트 자신의 `agent.model`로 채우므로(RunRoutingResolution), 여기서도
// 없는 층을 있는 것처럼 그리지 않는다.
// =============================================================================

import { attachParticle } from "@/lib/koreanParticle";

/** 서버 표의 한 행: 이 provider의 이 모델이 받는 effort 값들. */
export interface EffortModelEntry {
  provider: string;
  model: string;
  /** 오름차순. 서버가 준 순서를 그대로 쓴다. */
  efforts: string[];
  /** 서버가 이 모델의 기본값이라고 적어 둔 값. 서버가 스스로 적용하지는 않는다. */
  defaultEffort: string;
}

export interface EffortTable {
  schema: string;
  /** 전체 상위집합. 여기 없는 토큰은 어떤 모델에서도 유효하지 않다. */
  levels: string[];
  /** 표에 없는 모델이 받는 보수적인 기본 집합. */
  fallback: { efforts: string[]; defaultEffort: string };
  entries: EffortModelEntry[];
}

/**
 * 서버 응답을 표로 옮긴다. 모르는 모양이면 null이다.
 *
 * 부분적으로 추측해서 채우지 않는 이유는 이 표가 곧 "사용자에게 보여도 되는
 * 선택지"이기 때문이다. 반쪽짜리 표는 서버가 400으로 거절할 값을 피커에
 * 올려놓는 것과 같다.
 */
export function parseEffortTable(raw: unknown): EffortTable | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const schema = typeof body.schema === "string" ? body.schema : null;
  const levels = stringArray(body.levels);
  const fallbackRaw = body.fallback;
  if (schema === null || levels === null || typeof fallbackRaw !== "object" || fallbackRaw === null) {
    return null;
  }
  const fallbackBody = fallbackRaw as Record<string, unknown>;
  const fallbackEfforts = stringArray(fallbackBody.efforts);
  const fallbackDefault = fallbackBody.defaultEffort;
  if (fallbackEfforts === null || typeof fallbackDefault !== "string") return null;

  const providers = body.providers;
  if (!Array.isArray(providers)) return null;
  const entries: EffortModelEntry[] = [];
  for (const providerRaw of providers) {
    if (typeof providerRaw !== "object" || providerRaw === null) return null;
    const providerBody = providerRaw as Record<string, unknown>;
    const provider = providerBody.provider;
    const models = providerBody.models;
    if (typeof provider !== "string" || !Array.isArray(models)) return null;
    for (const modelRaw of models) {
      if (typeof modelRaw !== "object" || modelRaw === null) return null;
      const modelBody = modelRaw as Record<string, unknown>;
      const model = modelBody.model;
      const efforts = stringArray(modelBody.efforts);
      const defaultEffort = modelBody.defaultEffort;
      if (typeof model !== "string" || efforts === null || typeof defaultEffort !== "string") {
        return null;
      }
      entries.push({ provider, model, efforts, defaultEffort });
    }
  }
  return {
    schema,
    levels,
    fallback: { efforts: fallbackEfforts, defaultEffort: fallbackDefault },
    entries,
  };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** 이 모델이 받는 effort 값들. 표에 없는 모델은 fallback 집합을 쓴다. */
export function effortsForModel(
  table: EffortTable,
  model: string
): { efforts: string[]; defaultEffort: string; listed: boolean } {
  const entry = table.entries.find((e) => e.model === model);
  if (entry) {
    return { efforts: entry.efforts, defaultEffort: entry.defaultEffort, listed: true };
  }
  return {
    efforts: table.fallback.efforts,
    defaultEffort: table.fallback.defaultEffort,
    listed: false,
  };
}

/** 이 모델에서 이 effort가 유효한가. 서버 gate와 같은 판정이다. */
export function supportsEffort(
  table: EffortTable,
  model: string,
  effort: string
): boolean {
  return effortsForModel(table, model).efforts.includes(effort);
}

/**
 * 피커에 올릴 모델 목록.
 *
 * 워크스페이스 허용목록(`workspace.settings.allowed_agent_models`, ADR-0131 D2)은
 * 읽을 수 있는 REST가 없다. 그래서 사전 필터는 우리가 실제로 아는 모델 이름의
 * 합집합이고, 허용목록 밖 모델은 서버가 400으로 답하며 그 문장을 그대로 필드 옆에
 * 붙인다. 여기서 없는 목록을 있는 척 좁히면, 고를 수 있어야 할 모델이 이유 없이
 * 사라진다.
 *
 * 표가 `null`일 수 있는 것이 이 함수의 요점이다(R1 B2). 모델 축은 ADR-0131 D2라
 * 모든 세대의 서버가 가지고 있는데, effort 표는 ADR-0134 D2라 아직 없는 서버가
 * 있다. 표를 목록의 유일한 출처로 두면 표가 없는 서버에서 모델 편집이 통째로
 * 사라진다. 그래서 두 번째 출처를 함께 받는다: `known`은 이 워크스페이스의
 * 에이전트들이 실제로 도는 모델 이름들이고(로스터에서 읽는다), 그것은 표 없이도
 * 참인 사실이다.
 */
export function modelOptions(
  table: EffortTable | null,
  agentModel: string,
  known: readonly string[] = []
): string[] {
  const out: string[] = [];
  const push = (model: string) => {
    if (model === "" || out.includes(model)) return;
    out.push(model);
  };
  for (const entry of table?.entries ?? []) push(entry.model);
  for (const model of known) push(model);
  push(agentModel);
  return out;
}

/**
 * 이 워크스페이스의 에이전트들이 실제로 도는 모델 이름들.
 *
 * 허용목록 REST가 없는 서버에서 모델 피커가 기댈 수 있는 두 번째 출처다. 로스터가
 * 이미 손에 있고, 거기 적힌 `agentModel`은 서버가 그 에이전트에게 실제로 쓰는
 * 값이므로 지어낸 이름이 아니다. 등장 순서를 유지해 목록이 렌더마다 흔들리지 않게
 * 한다.
 */
export function knownAgentModels(
  members: readonly { kind: string; agentModel?: string | null }[]
): string[] {
  const out: string[] = [];
  for (const member of members) {
    if (member.kind !== "agent") continue;
    const model = member.agentModel?.trim();
    if (!model || out.includes(model)) continue;
    out.push(model);
  }
  return out;
}

/**
 * "지금 적용" 줄에 쓰는 모델 이름.
 *
 * 로스터가 `agentModel`을 비워 보내는 경우가 있다(사람 멤버, 아직 모델이 정해지지
 * 않은 에이전트). 그 빈 문자열을 그대로 문장에 끼우면 "모델 , 추론 강도 …"가 되어
 * 화면이 값을 잃어버린 것처럼 보인다. 상속 라벨은 이미 이 경우를 처리하므로
 * (`agentModelInheritLabel`) 적용 줄도 같은 말을 해야 한다(R1 M4).
 */
export function appliedModelLabel(model: string): string {
  return model.trim() === "" ? "지정 없음" : model;
}

/** effort 토큰의 한국어 라벨. 모르는 토큰은 서버가 준 그대로 보여준다. */
const EFFORT_LABELS: Record<string, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

// ---- 상속 체인 (D3) ---------------------------------------------------------

/** 프로필 REST가 돌려주는 라우팅 관련 필드만. 나머지는 이 화면의 관심사가 아니다. */
export interface RoutingProfile {
  modelPref?: string;
  /** ADR-0134 D3 신설. 이 필드를 아직 모르는 서버는 아예 보내지 않는다. */
  effortPref?: string;
}

export type ModelSource = "agent" | "profile";
export type EffortSource = "none" | "profile";

export interface RoutingInheritance {
  /** 지금 이 에이전트에 실제로 걸려 있는 모델과 그것을 정한 층. */
  model: { value: string; source: ModelSource };
  /**
   * 실제로 걸려 있는 effort. `null`은 아무 층도 지정하지 않았다는 뜻이고,
   * 그때 서버는 effort를 아예 보내지 않는다(RunRoutingResolution). 표의
   * 기본값을 대신 적어 넣으면 서버가 하지 않는 일을 했다고 말하는 셈이다.
   */
  effort: { value: string | null; source: EffortSource };
  /**
   * 서버 표가 적어 둔 이 모델의 기본값. 안내용이며 적용값이 아니다.
   * 표를 못 받은 서버에서는 null이고, 그때는 모른다고 말한다.
   */
  modelDefaultEffort: string | null;
  /**
   * 프로필이 지정했지만 지금 모델이 받지 않아 서버가 조용히 버릴 effort.
   * 서버는 이것을 감사행 `ignored_effort_pref`로만 남기므로, 화면에서 말해
   * 주지 않으면 사용자는 자기가 저장한 값이 죽어 있는 줄 모른다.
   */
  ignoredEffortPref: string | null;
}

/**
 * 표가 없어도 모델 층은 계산된다.
 *
 * 표는 effort의 유효값을 재는 자에 지나지 않는다. 어떤 모델이 걸려 있는지는
 * 프로필과 로스터만으로 알 수 있는 사실이므로, 표가 없다는 이유로 "상속값을
 * 확인하지 못했습니다"라고 답하면 아는 것까지 모른다고 말하는 셈이 된다
 * (엔진층이 없는 서버에서 이 줄이 항상 그렇게 나왔다).
 */
export function resolveInheritance(
  table: EffortTable | null,
  agentModel: string,
  profile: RoutingProfile | null
): RoutingInheritance {
  const modelPref = trimmed(profile?.modelPref);
  const model = modelPref ?? agentModel;
  const modelSource: ModelSource = modelPref === null ? "agent" : "profile";

  const effortPref = trimmed(profile?.effortPref);
  if (table === null) {
    // 유효값을 잴 자가 없으니 유효성 판정을 하지 않는다. 프로필이 값을 들고
    // 있으면 그 값이 걸려 있다고만 말하고, 버려질지 여부는 주장하지 않는다.
    return {
      model: { value: model, source: modelSource },
      effort:
        effortPref === null
          ? { value: null, source: "none" }
          : { value: effortPref, source: "profile" },
      modelDefaultEffort: null,
      ignoredEffortPref: null,
    };
  }

  const usable = effortPref !== null && supportsEffort(table, model, effortPref);
  return {
    model: { value: model, source: modelSource },
    effort: usable
      ? { value: effortPref, source: "profile" }
      : { value: null, source: "none" },
    modelDefaultEffort: effortsForModel(table, model).defaultEffort,
    ignoredEffortPref: effortPref !== null && !usable ? effortPref : null,
  };
}

function trimmed(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next === "" ? null : next;
}

// ---- 초안: 상속이 곧 빈 값 --------------------------------------------------

/** `null`은 "상속". 프로필 편집과 1회 오버라이드가 같은 모양을 쓴다. */
export interface RoutingDraft {
  model: string | null;
  effort: string | null;
}

export const INHERIT_DRAFT: RoutingDraft = { model: null, effort: null };

/** 프로필 편집 폼의 시작값: 저장된 선호가 곧 초안이다. */
export function draftFromProfile(profile: RoutingProfile | null): RoutingDraft {
  return {
    model: trimmed(profile?.modelPref),
    effort: trimmed(profile?.effortPref),
  };
}

export function isOverride(draft: RoutingDraft): boolean {
  return draft.model !== null || draft.effort !== null;
}

export function draftEquals(a: RoutingDraft, b: RoutingDraft): boolean {
  return a.model === b.model && a.effort === b.effort;
}

/** 초안이 상속을 뚫고 실제로 적용될 모델. */
export function effectiveModel(draft: RoutingDraft, inheritedModel: string): string {
  return draft.model ?? inheritedModel;
}

/**
 * 요청에 실을 `routing` 블록. 상속뿐이면 키 자체가 없다.
 *
 * 빈 객체를 보내지 않는 것은 서버 계약이기도 하다: `RunRoutingInput.validate`는
 * 전부 nil인 블록을 nil로 접어 버리므로, 보내나 마나인 키를 실어 보내면 저장된
 * 입력 JSON에만 잡음이 남는다.
 */
export function routingPayload(
  draft: RoutingDraft
): { model?: string; effort?: string } | undefined {
  const payload: { model?: string; effort?: string } = {};
  if (draft.model !== null) payload.model = draft.model;
  if (draft.effort !== null) payload.effort = draft.effort;
  return payload.model === undefined && payload.effort === undefined
    ? undefined
    : payload;
}

/**
 * 모델을 바꾼 결과. 새 모델이 현재 effort를 받지 않으면 effort를 상속으로
 * 비우고, 무엇을 비웠는지 함께 돌려준다(D3 자동 클리어 + 인라인 안내).
 *
 * `nextModel`이 `null`이면 모델을 상속으로 되돌린 것이고, 그때 유효값을 재는
 * 기준은 상속된 모델이다. 상속으로 되돌리는 것도 모델 변경이므로 같은 검사를
 * 받는다: 상속 모델이 xhigh를 못 받는데 오버라이드만 사라지면 서버가 400을
 * 답할 조합이 화면에 남는다.
 */
export interface ModelChangeResult {
  draft: RoutingDraft;
  /** 비워진 effort 토큰. 비운 적이 없으면 null. */
  clearedEffort: string | null;
}

export function applyModelChange(
  table: EffortTable,
  draft: RoutingDraft,
  nextModel: string | null,
  inheritedModel: string
): ModelChangeResult {
  const next: RoutingDraft = { model: nextModel, effort: draft.effort };
  if (next.effort === null) return { draft: next, clearedEffort: null };
  const model = effectiveModel(next, inheritedModel);
  if (supportsEffort(table, model, next.effort)) {
    return { draft: next, clearedEffort: null };
  }
  return {
    draft: { model: nextModel, effort: null },
    clearedEffort: draft.effort,
  };
}

/**
 * 자동 클리어 안내 문구. 무엇이 왜 비워졌는지, 사과 없이.
 *
 * 조사는 계산한다. 모델 핸들은 라틴 문자로 끝나고("hermes-fast는") 강도 라벨은
 * 한글로 끝나므로("최대를"), 둘을 한 문장에 넣으면서 "은(는)"으로 도망가면
 * 화면에 기계가 보인다(koreanParticle의 이식 사유와 같다).
 */
export function clearedEffortNotice(model: string, clearedEffort: string): string {
  const label = effortLabel(clearedEffort);
  return `${attachParticle(model, "topic")} 추론 강도 ${attachParticle(
    label,
    "object"
  )} 지원하지 않아 상속으로 되돌렸습니다.`;
}

// ---- 상속 옵션의 라벨 (D3 "상속 (실제값 병기)") ------------------------------

/**
 * 모델 피커의 상속 옵션 문구. 상속된 값이 어디서 왔는지까지 적는다.
 *
 * `surface`가 프로필 편집이면 상속의 상대는 에이전트 자신의 모델 하나뿐이고,
 * 컴포저면 프로필이 한 층 더 있다.
 */
export function inheritedModelLabel(inheritance: RoutingInheritance): string {
  const where = inheritance.model.source === "profile" ? "프로필" : "에이전트 기본";
  return `상속 (${where}: ${inheritance.model.value})`;
}

/**
 * 강도 피커의 상속 옵션 문구.
 *
 * 아무 층도 지정하지 않았을 때 표의 기본값을 적용값처럼 쓰지 않는다. 서버는
 * 그 경우 effort를 보내지 않고 프로바이더가 자기 기본값으로 처리하므로,
 * "지정 없음"이 실제값이고 표의 값은 괄호 안 참고다.
 */
export function inheritedEffortLabel(inheritance: RoutingInheritance): string {
  if (inheritance.effort.value !== null) {
    return `상속 (프로필: ${effortLabel(inheritance.effort.value)})`;
  }
  return agentEffortInheritLabel(inheritance.modelDefaultEffort);
}

/** 프로필 편집 화면의 상속 옵션: 상대는 에이전트 자신의 모델 하나다. */
export function agentModelInheritLabel(agentModel: string): string {
  return agentModel === ""
    ? "상속 (에이전트 기본)"
    : `상속 (에이전트 기본: ${agentModel})`;
}

/**
 * 표를 못 받았으면 괄호 안 참고값도 없다. 그럴 때 "모델 기본 보통"을 적으면
 * 서버가 말한 적 없는 값을 화면이 지어내는 것이 된다.
 */
export function agentEffortInheritLabel(defaultEffort: string | null): string {
  return defaultEffort === null
    ? "상속 (지정 없음)"
    : `상속 (지정 없음, 모델 기본 ${effortLabel(defaultEffort)})`;
}

/** 프로필이 저장해 둔 effort가 지금 모델에서 죽어 있다는 안내. */
export function ignoredEffortNotice(model: string, ignored: string): string {
  return `프로필에 저장된 추론 강도 ${attachParticle(
    effortLabel(ignored),
    "topic"
  )} ${model}에서 쓸 수 없어 적용되지 않습니다.`;
}
