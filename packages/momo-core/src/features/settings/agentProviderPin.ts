// =============================================================================
// 에이전트별 AI 연결 고정 (#3875, 서버 #3873 / ADR-0147 증보 2026-10-16).
//
// Wire contract: `GET/PUT /v1/workspaces/{ws}/agents/{agent}/provider-pin`.
//   body  { kind: "default" | "operator_env" | "team_link", linkPosition? }  (닫힌 본문)
//   reply { schema, agentId, pin: null | { kind, linkPosition?, endpointLabel?,
//           linkResolved, pinnedBy?, updatedAtMs } }
//
// Rules this file holds:
//   1. 서버 답이 판정이다. 403 = 운영자가 아니다(선택기를 그리지 않는다), 404 = 이 서버에 길이
//      없다(옛 서버, 그리지 않는다). 둘 다 「없음」이지 오류 칸이 아니다.
//   2. 핀은 참조다. 이 파일이 만드는 본문에는 주소·키·경로 칸이 없다.
//   3. `linkResolved:false` 는 조용히 다른 연결로 넘어가지 않는다는 문장으로 말한다.
//   4. 모양이 틀린 200 은 「핀 없음」으로 읽지 않는다(null → 오류 칸): 저장된 고정을 없다고 단정하게 된다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { bool, num, record, str } from "../../lib/wire";
import { settingsRequest } from "./api";
import type { ProviderChain } from "./api";

export type AgentPinKind = "operator_env" | "team_link";

export interface AgentProviderPin {
  readonly kind: AgentPinKind;
  readonly linkPosition: number | null;
  /** 가린 주소 라벨. 주소 자체가 아니다. */
  readonly endpointLabel: string | null;
  /** false = 고른 연결이 사라졌거나 바뀌었다. 사람이 다시 고를 때까지 이 에이전트의 차례는 멈춘다. */
  readonly linkResolved: boolean;
  readonly updatedAtMs: number;
}

export type PinChoice =
  | { readonly kind: "default" }
  | { readonly kind: "operator_env" }
  | { readonly kind: "team_link"; readonly linkPosition: number };

/** 읽기 결과. `absent`/`forbidden` 은 화면이 선택기를 그리지 않는 두 경우다. */
export type AgentPinRead =
  | { readonly kind: "ready"; readonly pin: AgentProviderPin | null }
  | { readonly kind: "forbidden" }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly message: string };

export function agentPinFromWire(value: unknown): { pin: AgentProviderPin | null } | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.agent.provider_pin.v0") return null;
  const raw = body.pin;
  if (raw === null) return { pin: null };
  const pin = record(raw);
  if (!pin) return null;
  const kind = str(pin, "kind");
  if (kind !== "operator_env" && kind !== "team_link") return null;
  const resolved = bool(pin, "linkResolved");
  const updated = num(pin, "updatedAtMs");
  if (resolved === undefined || updated === undefined) return null;
  const position = num(pin, "linkPosition");
  if (kind === "team_link" && (position === undefined || !Number.isInteger(position) || position < 0)) {
    return null;
  }
  return {
    pin: {
      kind,
      linkPosition: kind === "team_link" ? (position as number) : null,
      endpointLabel: str(pin, "endpointLabel") ?? null,
      linkResolved: resolved,
      updatedAtMs: updated,
    },
  };
}

const UNREADABLE = "서버 답을 읽지 못했어요. 잠시 뒤에 다시 시도해 주세요.";

function pinPath(workspaceId: string, agentId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/provider-pin`;
}

function readOutcome(error: unknown): AgentPinRead {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: "forbidden" };
    if (error.status === 404) return { kind: "absent" };
  }
  return { kind: "unknown", message: UNREADABLE };
}

export async function fetchAgentProviderPin(workspaceId: string, agentId: string): Promise<AgentPinRead> {
  try {
    const parsed = agentPinFromWire(await settingsRequest<unknown>(pinPath(workspaceId, agentId)));
    return parsed === null ? { kind: "unknown", message: UNREADABLE } : { kind: "ready", pin: parsed.pin };
  } catch (error) {
    return readOutcome(error);
  }
}

/** PUT 본문. 닫힌 모양: `default` 는 풀기, 나머지는 참조뿐. */
export function pinChoiceBody(choice: PinChoice): Record<string, unknown> {
  return choice.kind === "team_link"
    ? { kind: "team_link", linkPosition: choice.linkPosition }
    : { kind: choice.kind };
}

export async function putAgentProviderPin(
  workspaceId: string,
  agentId: string,
  choice: PinChoice
): Promise<AgentProviderPin | null> {
  const parsed = agentPinFromWire(
    await settingsRequest<unknown>(pinPath(workspaceId, agentId), {
      method: "PUT",
      body: JSON.stringify(pinChoiceBody(choice)),
    })
  );
  if (parsed === null) throw new ApiError(502, UNREADABLE);
  return parsed.pin;
}

// ---- 선택지 ----------------------------------------------------------------------

export const PIN_COPY = {
  title: "이 에이전트가 쓸 AI",
  lead: "고르지 않으면 기본 AI를 따라요. 고르면 이 에이전트는 그 연결로만 대답하고, 연결이 사라져도 다른 연결로 몰래 넘어가지 않아요.",
  followDefault: "기본 AI 따르기",
  sameServer: "같은 서버의 Hermes",
  sameServerHint: "이 서버 운영자가 환경값으로 정한 연결이에요. 팀 AI 키와 따로 써요.",
  loading: "이 에이전트의 AI를 확인하는 중이에요.",
  readError: "이 에이전트의 AI를 불러오지 못했어요.",
  retry: "다시 시도",
  offline: "연결이 끊긴 동안에는 바꿀 수 없어요.",
  save: "이 에이전트의 AI 저장",
  saving: "저장 중",
  saved: "저장했어요.",
  unchanged: "바꿀 내용이 없어요.",
  ownModelFirst: "이 에이전트가 자기 모델을 정한 뒤에 팀 AI 키 연결을 고를 수 있어요.",
  noTeamLinks: "고를 수 있는 팀 AI 키가 없어요. 설정 › AI에서 팀 AI 키를 먼저 넣어 주세요.",
} as const;

/** 고정이 풀리지 않을 때(`linkResolved:false`)의 문장. 몰래 넘어가지 않음을 말한다. */
export function pinUnresolvedSentence(pin: AgentProviderPin): string {
  const where =
    pin.kind === "operator_env"
      ? "같은 서버의 Hermes 연결"
      : `연결 ${(pin.linkPosition ?? 0) + 1}${pin.endpointLabel ? ` (${pin.endpointLabel})` : ""}`;
  return `고른 ${where}이 바뀌었거나 사라졌어요. 다시 골라 주세요. 그동안 이 에이전트는 다른 연결로 넘어가지 않고 멈춰 있어요.`;
}

export interface PinOption {
  readonly key: string;
  readonly label: string;
  readonly hint: string | null;
  readonly choice: PinChoice;
  readonly disabled: boolean;
}

export function choiceKey(choice: PinChoice): string {
  return choice.kind === "team_link" ? `team_link:${choice.linkPosition}` : choice.kind;
}

export function pinChoiceOf(pin: AgentProviderPin | null): PinChoice {
  if (pin === null) return { kind: "default" };
  return pin.kind === "team_link"
    ? { kind: "team_link", linkPosition: pin.linkPosition ?? 0 }
    : { kind: "operator_env" };
}

export interface PinOptionInput {
  readonly pin: AgentProviderPin | null;
  readonly chain: ProviderChain | null;
  /** 이 서버에 운영자 env 링크(Hermes)가 있는가. 같은 서버 카드의 선언 상태에서 온다. */
  readonly envLinkAvailable: boolean;
  /** false = 이 에이전트는 팀 기본 모델을 따른다(연결 고르기는 자기 모델이 먼저). */
  readonly ownsModel: boolean;
}

/**
 * 고를 수 있는 것: 기본 AI 따르기, (있으면) 같은 서버의 Hermes, 켜진 팀 연결.
 * 저장된 고정이 목록에 없으면(연결이 사라짐) 그 값을 이유와 함께 남긴다.
 */
export function pinOptions(input: PinOptionInput): PinOption[] {
  const out: PinOption[] = [
    { key: "default", label: PIN_COPY.followDefault, hint: null, choice: { kind: "default" }, disabled: false },
  ];
  if (input.envLinkAvailable || input.pin?.kind === "operator_env") {
    out.push({
      key: "operator_env",
      label: PIN_COPY.sameServer,
      hint: PIN_COPY.sameServerHint,
      choice: { kind: "operator_env" },
      disabled: false,
    });
  }
  for (const entry of input.chain?.entries ?? []) {
    // 위치 0 은 저장된 팀 링크 그 자체다. 환경값 머리는 위 「같은 서버」 선택지가 맡는다.
    if (!entry.enabled || entry.source === "environment") continue;
    const choice: PinChoice = { kind: "team_link", linkPosition: entry.position };
    out.push({
      key: choiceKey(choice),
      label: `연결 ${entry.position + 1}: ${entry.endpointLabel}`,
      hint: input.ownsModel ? null : PIN_COPY.ownModelFirst,
      choice,
      disabled: !input.ownsModel,
    });
  }
  const pin = input.pin;
  if (pin?.kind === "team_link") {
    const key = choiceKey(pinChoiceOf(pin));
    if (!out.some((option) => option.key === key)) {
      out.push({
        key,
        label: `연결 ${(pin.linkPosition ?? 0) + 1}: ${pin.endpointLabel ?? "알 수 없음"} (바뀜)`,
        hint: null,
        choice: pinChoiceOf(pin),
        disabled: true,
      });
    }
  }
  return out;
}

export function sameChoice(a: PinChoice, b: PinChoice): boolean {
  return choiceKey(a) === choiceKey(b);
}

/** 이 에이전트가 고정 대상이 될 수 있는가(개인·구독 에이전트는 아니다). */
export function pinnableAgent(facts: { callableBy?: string; brain?: string }): boolean {
  if (facts.callableBy === "owner_only" || facts.callableBy === "owner") return false;
  return facts.brain !== "subscription" && facts.brain !== "personal_key";
}

/** 에이전트가 자기 모델을 정했는가(`instance_default` 는 팀 기본 모델을 따른다). */
export function agentOwnsModel(facts: { brain?: string }): boolean {
  return facts.brain !== "instance_default";
}

export function pinSaveMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "에이전트별 AI는 이 서버의 운영자만 바꿀 수 있어요.";
    if (error.status === 404) return "이 서버는 아직 에이전트별 AI 고르기를 받지 않아요. 서버를 업데이트한 뒤 다시 시도해 주세요.";
    if (error.status === 409 && error.code === "owner_only_agent_cannot_be_pinned") {
      return "개인 에이전트는 자기 구독이나 개인 키로만 대답해서 연결을 고정할 수 없어요.";
    }
    if (error.status === 409 && error.code === "agent_own_model_required") {
      return PIN_COPY.ownModelFirst;
    }
    if (error.status === 400) {
      return "그 연결은 지금 고를 수 없어요. 연결 목록을 새로 고친 뒤 다시 골라 주세요.";
    }
  }
  return "저장하지 못했어요. 잠시 뒤에 다시 시도해 주세요.";
}
