import { ApiError } from "../../lib/api";
import { settingsRequest, type ProviderFormat } from "../settings/api";

// =============================================================================
// 개인 API 키 클라이언트와 문구 (#3469, 서버 #3415 / ADR-0147 증보 2026-10-03).
//
// 운영자(소유자·관리자)가 한 사람에게 API 키를 발급한다. 그 사람의 본인 전용 에이전트만 쓴다.
// 키는 **쓰기 전용**이다: 발급 요청에만 실리고, 어떤 응답에도 값이 없다. 그래서 이 파일의
// `PersonalKey` 타입에는 키 필드가 없고, `issuePersonalKey`만 `apiKey`를 함수 인자로 받는다.
// 그 값을 어디에도 저장하지 않는다(호출부가 칸에서 읽어 바로 넘기고 칸을 비운다).
// =============================================================================

export interface PersonalKey {
  id: string;
  ownerMemberId: string;
  format: ProviderFormat;
  /** 서버가 가린 주소 이름. 키와 무관하다. */
  endpointLabel: string;
  label: string | null;
  status: "active" | "revoked";
  issuedAtMs: number;
  revokedAtMs: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 서버 한 줄을 읽는다. 모르는 모양은 버린다(키가 있더라도 읽지 않는다). */
export function parsePersonalKey(value: unknown): PersonalKey | null {
  const row = record(value);
  if (!row) return null;
  const { id, ownerMemberId, format, endpointLabel, label, status, issuedAtMs, revokedAtMs } = row;
  if (typeof id !== "string" || typeof ownerMemberId !== "string" || typeof endpointLabel !== "string") return null;
  if (status !== "active" && status !== "revoked") return null;
  if (typeof issuedAtMs !== "number") return null;
  return {
    id: id.toLowerCase(),
    ownerMemberId: ownerMemberId.toLowerCase(),
    format: format === "anthropic" ? "anthropic" : "openai",
    endpointLabel,
    label: typeof label === "string" && label !== "" ? label : null,
    status,
    issuedAtMs,
    revokedAtMs: typeof revokedAtMs === "number" ? revokedAtMs : null,
  };
}

export function parsePersonalKeyList(value: unknown): PersonalKey[] {
  const keys = record(value)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.map(parsePersonalKey).filter((key): key is PersonalKey => key !== null);
}

const base = (workspaceId: string) => `/v1/workspaces/${encodeURIComponent(workspaceId)}/personal-keys`;

/** 운영자: 워크스페이스의 모든 개인 키(회수된 것 포함). */
export async function listPersonalKeys(workspaceId: string): Promise<PersonalKey[]> {
  return parsePersonalKeyList(await settingsRequest<unknown>(base(workspaceId)));
}

/** 본인: 내가 받은 키만. */
export async function listMyPersonalKeys(workspaceId: string): Promise<PersonalKey[]> {
  return parsePersonalKeyList(await settingsRequest<unknown>(`${base(workspaceId)}/mine`));
}

export interface IssuePersonalKeyInput {
  ownerMemberId: string;
  /** 쓰기 전용. 이 함수의 인자로만 지나간다. */
  apiKey: string;
  format: ProviderFormat;
  baseUrl: string;
  label?: string;
}

export async function issuePersonalKey(workspaceId: string, input: IssuePersonalKeyInput): Promise<PersonalKey> {
  const body = await settingsRequest<unknown>(base(workspaceId), { method: "POST", body: JSON.stringify(input) });
  const key = parsePersonalKey(record(body)?.key ?? body);
  if (!key) throw new ApiError(502, "서버 답을 읽지 못했어요.");
  return key;
}

export async function revokePersonalKey(workspaceId: string, keyId: string): Promise<PersonalKey> {
  const body = await settingsRequest<unknown>(`${base(workspaceId)}/${encodeURIComponent(keyId)}/revoke`, { method: "POST" });
  const key = parsePersonalKey(record(body)?.key ?? body);
  if (!key) throw new ApiError(502, "서버 답을 읽지 못했어요.");
  return key;
}

export interface CreatePersonalKeyAgentInput {
  displayName: string;
  handle: string;
  model: string;
}

export async function createPersonalKeyAgent(
  workspaceId: string,
  keyId: string,
  input: CreatePersonalKeyAgentInput
): Promise<{ id: string; handle: string; displayName: string }> {
  const body = record(
    await settingsRequest<unknown>(`${base(workspaceId)}/${encodeURIComponent(keyId)}/agent`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  );
  const agent = record(body?.agent);
  if (!agent || typeof agent.id !== "string" || typeof agent.handle !== "string" || typeof agent.displayName !== "string") {
    throw new ApiError(502, "서버 답을 읽지 못했어요.");
  }
  return { id: agent.id.toLowerCase(), handle: agent.handle, displayName: agent.displayName };
}

// ---------------------------------------------------------------------------
// 문구 (한 곳). 용어: 「개인 키 · 나만」(용어집 personalKey).
// ---------------------------------------------------------------------------

export const PERSONAL_KEYS_COPY = {
  heading: "개인 API 키",
  /** 운영자 구획 머리 옆 한 줄. */
  operatorScope: "운영자만 발급하고 회수해요",
  operatorBody:
    "사람마다 하나씩 발급해요. 발급받은 사람의 본인 전용 에이전트만 이 키로 대답하고, 팀 키로 대신 대답하지 않아요.",
  issue: "개인 키 발급",
  columns: { holder: "받는 사람", company: "AI 회사", issuedAt: "발급일", status: "상태" },
  status: { active: "사용 중", revoked: "회수됨" },
  revokedAt: (date: string) => `${date} 회수`,
  empty: "아직 발급한 개인 키가 없어요. 사람마다 한 개씩 줄 수 있어요.",
  loadFailed: "개인 키를 불러오지 못했어요.",
  retry: "다시 시도",
  holderGone: "나간 멤버",
  revoke: "회수",
  form: {
    title: "개인 키 발급",
    holder: "받는 사람",
    holderPlaceholder: "사람 고르기",
    noHolder: "발급할 수 있는 멤버가 없어요. 이미 키가 있는 사람은 먼저 회수해야 해요.",
    provider: "AI 회사",
    noProviders: "이 서버는 AI 회사 목록을 주지 않아요. 팀 AI 키 설정을 먼저 확인하세요.",
    key: "API 키",
    keyPlaceholder: "키를 붙여 넣으세요",
    keyHint: "발급하면 다시 볼 수 없어요. 키 값은 이 화면에도 남지 않아요.",
    keyRequired: "키를 붙여 넣으세요. 저장된 키는 다시 내려오지 않아서 매번 새로 넣어요.",
    label: "메모",
    labelHint: "선택. 어디에 쓰는 키인지 적어 두세요.",
    submit: "발급하기",
    submitting: "발급 중",
    cancel: "취소",
    holderRequired: "받는 사람을 고르세요.",
    addressFixed: "주소는 발급한 뒤 바꿀 수 없어요. 바꾸려면 회수하고 새로 발급해요.",
    keyCleared: "키는 칸에서 지웠으니 다시 붙여 넣어 주세요.",
    offline: "연결이 끊겨 지금은 발급할 수 없어요.",
  },
  revokeDialog: {
    title: (holder: string, company: string) => `${holder} 님의 ${company} 키를 회수할까요?`,
    body: (holder: string) =>
      `${holder} 님의 에이전트는 다음 대답부터 멈춰요. 팀 키로 대신 대답하지 않아요. 회수한 키는 되살릴 수 없고, 다시 쓰려면 새로 발급해야 해요.`,
    confirm: "키 회수",
    confirming: "회수 중",
    cancel: "취소",
    offline: "연결이 끊겨 지금은 회수할 수 없어요.",
  },
  mine: {
    heading: "받은 개인 키",
    scope: "나만 써요",
    body: "운영자가 나에게 발급한 API 키예요. 이 키로 만든 내 에이전트만 대답하고, 다른 사람은 부를 수 없어요.",
    empty: "받은 개인 키가 없어요. 필요하면 운영자에게 요청하세요.",
    loadFailed: "받은 개인 키를 불러오지 못했어요.",
    createAgent: "이 키로 에이전트 만들기",
    hasAgent: (handle: string) => `에이전트 @${handle}가 이 키를 써요`,
    hasAgentUnnamed: "내 에이전트가 이 키를 써요",
    revoke: "회수",
    issuedOn: (date: string) => `${date} 받음`,
  },
  agentDialog: {
    title: "이 키로 에이전트 만들기",
    body: "만든 에이전트는 나만 부를 수 있어요. 답할 때 이 키를 쓰고, 한 사람에 하나만 만들 수 있어요.",
    displayName: "표시 이름",
    handle: "핸들",
    handleHint: "멘션에 쓰는 이름이에요. 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내.",
    model: "모델",
    modelHint: "이 키의 AI 회사가 제공하는 모델 이름이에요.",
    modelPlaceholder: { anthropic: "예: claude-sonnet-5", openai: "예: gpt-5" },
    submit: "에이전트 만들기",
    submitting: "만드는 중",
    cancel: "취소",
    created: (handle: string) => `@${handle}를 만들었어요. 채널에 넣으면 그 채널에서 불러요.`,
    handleInvalid: "핸들은 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내여야 해요.",
    nameRequired: "표시 이름을 입력하세요.",
    modelRequired: "모델 이름을 입력하세요.",
  },
} as const;

/** 서버 거절 코드를 사람 말로. 모르는 코드는 서버 문장을 그대로. */
export function personalKeyErrorMessage(error: unknown, action: "issue" | "revoke" | "agent" | "list"): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "personal_key_owner_has_active_key":
        return "이 사람은 이미 사용 중인 개인 키가 있어요. 먼저 그 키를 회수하세요.";
      case "personal_key_already_attached":
        return "이 키는 이미 다른 곳에 붙어 있어요. 새 키를 발급받아 넣으세요.";
      case "personal_agent_exists":
        return "이 사람은 이미 개인 키 에이전트가 있어요. 새 키가 그 에이전트를 이어서 써요.";
      case "personal_key_revoked":
        return "회수된 키로는 에이전트를 만들 수 없어요.";
      default:
    }
    if (error.status === 503) return "이 서버에는 개인 키를 보관할 설정이 없어요. 서버 운영자에게 알려 주세요.";
    if (error.status === 403) {
      return action === "agent" ? "이 멤버는 게스트라서 에이전트를 만들 수 없어요." : "운영자만 할 수 있어요.";
    }
    if (error.status === 404) return "이 키를 찾지 못했어요. 이미 사라졌을 수 있어요.";
    if (error.status === 409 && action === "agent") return "지금은 에이전트를 만들 수 없어요. 핸들이 이미 쓰이고 있을 수 있어요.";
    if (error.status === 400 && action === "issue") {
      return `${error.message} 키와 주소를 확인하고 다시 붙여 넣어 주세요.`;
    }
    return error.message;
  }
  return "연결을 확인하고 다시 시도하세요.";
}

const HANDLE_RE = /^[a-z0-9_-]{2,32}$/;

export function personalAgentHandleValid(handle: string): boolean {
  return HANDLE_RE.test(handle.trim().toLowerCase());
}

/**
 * 「이 키로 에이전트 만들기」의 처음 값. 표시 이름은 `<이름>-<회사>`, 핸들은 소유자 핸들과
 * 회사에서 만든다(한글 이름은 핸들 문자가 아니다). 모델은 지어내지 않는다.
 */
export function personalAgentDefaults(input: {
  memberName: string;
  memberHandle: string;
  company: string;
  format: ProviderFormat;
}): { displayName: string; handle: string } {
  const displayName = `${input.memberName}-${input.company}`.slice(0, 100);
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const tail = input.format === "anthropic" ? "claude" : "gpt";
  const head = clean(input.memberHandle).slice(0, 32 - tail.length - 1);
  const handle = head === "" ? `my-${tail}` : `${head}-${tail}`;
  return { displayName, handle };
}
