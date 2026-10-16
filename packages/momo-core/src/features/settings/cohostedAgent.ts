// =============================================================================
// 같은 서버 에이전트(Hermes) 감지·연결 (#3883 서버 / ADR-0203).
//
// Wire contract: `GET /v1/workspaces/{ws}/cohosted-agent` (네트워크 없음),
// `POST …/probe` (선언된 호스트에 고정 GET 두 번, 요청하면 세 번째 `/v1/toolsets`),
// `POST …/connect` (에이전트 멤버 생성 + `operator_env` 핀, 채널·도구 권한 없음).
//
// Rules this file holds:
//   1. 보이지 않는 것이 기본이다. 403(운영자 아님)·404(이 서버에 길이 없음)·선언 없음은
//      모두 `hidden` 이고, 화면은 아무것도 그리지 않는다(ADR-0203 D1·D3).
//   2. 잠금 확인 전에는 「연결할 수 있다」고 암시하지 않는다(Q2 (b)): 체크리스트 안내만.
//   3. 도구 잠금은 운영자의 선언이다. 문장은 oort가 확인했다고 말하지 않는다(D6-5).
//   4. `/v1/toolsets` 는 주의 신호일 뿐 증명이 아니다(`proof:false`).
//   5. 서버 답에서 키·본문은 오지 않는다. 이 파일은 분류 낱말과 숫자만 읽는다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { bool, num, record, str } from "../../lib/wire";
import { settingsRequest } from "./api";

export type Declaration = "not_declared" | "key_missing" | "url_refused" | "ready";
export type ProbeState =
  | "not_declared"
  | "key_missing"
  | "url_refused"
  | "ok"
  | "rejected"
  | "unreachable"
  | "rate_limited"
  | "unknown";
export type ToolsetsSignal =
  | "not_checked"
  | "unavailable"
  | "unreadable"
  | "none_listed"
  | "dangerous_listed";

export interface CohostedStatus {
  readonly declaration: Declaration;
  readonly endpointLabel: string | null;
  /** 운영자 본인의 선언. oort가 확인한 값이 아니다. */
  readonly toolsLockAttested: boolean;
  readonly connectable: boolean;
  readonly connectedAgentId: string | null;
}

export interface CohostedProbe {
  readonly state: ProbeState;
  readonly endpointLabel: string | null;
  readonly requestsSent: number;
  readonly modelCount: number | null;
  readonly toolsLockAttested: boolean;
  readonly toolsets: ToolsetsSignal;
  readonly toolsetsListed: readonly string[];
  readonly connectable: boolean;
  readonly connectedAgentId: string | null;
}

export interface CohostedConnected {
  readonly agentId: string;
  readonly displayName: string;
  readonly handle: string;
}

const DECLARATIONS: readonly Declaration[] = ["not_declared", "key_missing", "url_refused", "ready"];
const STATES: readonly ProbeState[] = [
  "not_declared",
  "key_missing",
  "url_refused",
  "ok",
  "rejected",
  "unreachable",
  "rate_limited",
  "unknown",
];
const SIGNALS: readonly ToolsetsSignal[] = [
  "not_checked",
  "unavailable",
  "unreadable",
  "none_listed",
  "dangerous_listed",
];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

export function statusFromWire(value: unknown): CohostedStatus | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.cohosted_agent.status.v0") return null;
  const declaration = oneOf(str(body, "declaration"), DECLARATIONS);
  const attested = bool(body, "toolsLockAttested");
  const connectable = bool(body, "connectable");
  if (declaration === null || attested === undefined || connectable === undefined) return null;
  return {
    declaration,
    endpointLabel: str(body, "endpointLabel") ?? null,
    toolsLockAttested: attested,
    connectable,
    connectedAgentId: str(body, "connectedAgentId") ?? null,
  };
}

export function probeFromWire(value: unknown): CohostedProbe | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.cohosted_agent.probe.v0") return null;
  const state = oneOf(str(body, "state"), STATES);
  const requests = num(body, "requestsSent");
  const attested = bool(body, "toolsLockAttested");
  const connectable = bool(body, "connectable");
  const toolsets = record(body.toolsets);
  const signal = oneOf(str(toolsets, "signal"), SIGNALS);
  if (state === null || requests === undefined || attested === undefined || connectable === undefined) {
    return null;
  }
  const listed = Array.isArray(toolsets?.listed)
    ? toolsets.listed.filter((name): name is string => typeof name === "string")
    : [];
  return {
    state,
    endpointLabel: str(body, "endpointLabel") ?? null,
    requestsSent: requests,
    modelCount: num(body, "modelCount") ?? null,
    toolsLockAttested: attested,
    toolsets: signal ?? "not_checked",
    toolsetsListed: listed,
    connectable,
    connectedAgentId: str(body, "connectedAgentId") ?? null,
  };
}

/** 읽기 결과. `hidden` 이면 카드를 그리지 않는다. */
export type CohostedRead =
  | { readonly kind: "ready"; readonly status: CohostedStatus }
  | { readonly kind: "hidden" }
  | { readonly kind: "unknown" };

function path(workspaceId: string, tail = ""): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/cohosted-agent${tail}`;
}

export async function fetchCohostedStatus(workspaceId: string): Promise<CohostedRead> {
  try {
    const status = statusFromWire(await settingsRequest<unknown>(path(workspaceId)));
    if (status === null) return { kind: "unknown" };
    return status.declaration === "not_declared" ? { kind: "hidden" } : { kind: "ready", status };
  } catch (error) {
    // 403: 운영자가 아니다. 404/405: 이 서버에는 길이 없다. 둘 다 「없음」이다.
    if (error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 405)) {
      return { kind: "hidden" };
    }
    // 서버가 답하지 못한 경우(연결 끊김·시간 초과)는 이 카드의 일이 아니다: 페이지의 다른 절이 말한다.
    // 서버가 답했는데 읽을 수 없거나 5xx 이면 운영자에게 보이는 오류다.
    return error instanceof ApiError ? { kind: "unknown" } : { kind: "hidden" };
  }
}

export async function probeCohosted(workspaceId: string, checkToolsets: boolean): Promise<CohostedProbe> {
  const parsed = probeFromWire(
    await settingsRequest<unknown>(path(workspaceId, "/probe"), {
      method: "POST",
      body: JSON.stringify({ checkToolsets }),
    })
  );
  if (parsed === null) throw new ApiError(502, "unreadable probe answer");
  return parsed;
}

export async function connectCohosted(workspaceId: string): Promise<CohostedConnected> {
  const body = record(
    await settingsRequest<unknown>(path(workspaceId, "/connect"), { method: "POST", body: "{}" })
  );
  const agentId = str(body, "agentId");
  if (!body || str(body, "schema") !== "momo.cohosted_agent.connect.v0" || agentId === undefined) {
    throw new ApiError(502, "unreadable connect answer");
  }
  return {
    agentId,
    displayName: str(body, "displayName") ?? "Hermes",
    handle: str(body, "handle") ?? "hermes",
  };
}

// ---- 문장 ------------------------------------------------------------------------

export const COHOSTED_COPY = {
  title: "같은 서버의 Hermes",
  /** 잠금 확인 전: 연결할 수 있다는 암시 없이 체크리스트만. */
  checklistLead:
    "같은 서버에 Hermes를 올렸다면, 먼저 도구 잠금 체크리스트를 따라 주세요. 터미널·코드 실행·브라우저 도구를 끄고, oort 비밀값을 주지 않고, 공개 주소를 열지 않는 것이 조건이에요.",
  checklistLink: "체크리스트 보기",
  checklistAfter: "체크리스트를 따랐다면 서버에 OORT_COHOSTED_AGENT_TOOLS_LOCKED=1을 넣어 선언해 주세요.",
  found: "같은 서버의 Hermes를 찾았어요, 연결할까요?",
  foundDetail: "연결하면 Hermes 에이전트가 생겨요. 채널에는 넣지 않고 도구 권한도 주지 않아요. 평소처럼 채널에 초대해 쓰세요.",
  connect: "Hermes 연결하기",
  connecting: "연결 중",
  attestNote:
    "도구 잠금은 운영자님이 서버에 직접 선언한 값이에요. oort가 Hermes의 도구를 확인한 것이 아니에요.",
  volumeNote: "Hermes의 대화 기록은 Hermes 쪽 볼륨에 남아요. 지우려면 Railway에서 Hermes 서비스를 삭제해 주세요.",
  finding: "같은 서버의 Hermes를 찾는 중이에요.",
  retry: "다시 찾기",
  connected: "Hermes가 연결돼 있어요.",
  openAgent: "에이전트 보기",
  toolsetsWarn:
    "Hermes가 터미널·코드 실행·브라우저 중 켜진 도구가 있다고 답했어요. 참고용 신호예요. 체크리스트대로 꺼졌는지 다시 확인해 주세요.",
  toolsetsNone: "Hermes가 위 세 도구를 목록에 올리지 않았어요. 참고용이에요. 꺼졌다는 증명은 아니에요.",
  offline: "연결이 끊긴 동안에는 찾거나 연결할 수 없어요.",
} as const;

export function probeLine(state: ProbeState, status: CohostedStatus | null): string | null {
  switch (state) {
    case "ok":
      return null;
    case "rejected":
      return "Hermes가 키를 받아 주지 않았어요. 서버의 HERMES_API_KEY가 Hermes의 API_SERVER_KEY와 같은지 확인해 주세요.";
    case "unreachable":
      return "Hermes에 닿지 않았어요. 주소(HERMES_BASE_URL)와 Hermes 서비스가 켜져 있는지 확인해 주세요.";
    case "rate_limited":
      return "너무 자주 찾았어요. 잠시 뒤에 다시 찾아 주세요.";
    case "key_missing":
      return "서버에 HERMES_API_KEY가 없어요. Hermes의 API_SERVER_KEY와 같은 값을 넣어 주세요.";
    case "url_refused":
      return `HERMES_BASE_URL${status?.endpointLabel ? ` (${status.endpointLabel})` : ""}를 이 서버가 부를 수 없어요. 내부 주소는 AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1과 AGENT_PROVIDER_LOCAL_HOSTS에 호스트 이름이 필요해요.`;
    case "unknown":
      return "Hermes가 예상과 다르게 답했어요. 주소 끝이 /v1인지 확인해 주세요.";
    case "not_declared":
      return null;
  }
}

export function connectErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "cohosted_tools_lock_not_attested":
        return "도구 잠금 선언(OORT_COHOSTED_AGENT_TOOLS_LOCKED)이 서버에 없어 연결하지 않았어요.";
      case "cohosted_agent_not_reachable":
        return "Hermes가 지금 답하지 않아 연결하지 않았어요. 다시 찾은 뒤 시도해 주세요.";
      case "cohosted_agent_already_connected":
        return "이 워크스페이스에는 이미 Hermes가 연결돼 있어요.";
      case "cohosted_agent_handle_taken":
        return "hermes라는 핸들을 쓰는 멤버가 이미 있어요. 그 멤버 이름을 바꾼 뒤 다시 시도해 주세요.";
      case "cohosted_agent_not_ready":
        return "서버의 Hermes 설정이 아직 준비되지 않았어요.";
      default:
        break;
    }
    if (error.status === 403) return "같은 서버의 Hermes는 이 서버의 운영자만 연결할 수 있어요.";
    if (error.status === 429) return "너무 자주 시도했어요. 잠시 뒤에 다시 시도해 주세요.";
  }
  return "연결하지 못했어요. 잠시 뒤에 다시 시도해 주세요.";
}
