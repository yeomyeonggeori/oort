// =============================================================================
// 서버 행동 카탈로그의 **읽는 쪽** — `GET /v1/workspaces/{ws}/actions` (ADR-0186 부록 E).
//
// 워크스페이스를 바꾸는 행동(초대·웹훅·채널·역할)의 정본은 Rust
// `momo-agent/src/actions.rs`다(ADR-0186 D1). 팔레트는 그 표를 런타임에 읽어
// 사람의 명령 옆에 세운다. 이 티켓(AX-2)이 세우는 것은 **인터페이스뿐**이다:
// 파서와 「없으면 숨긴다」는 규칙. 실제 fetch·병합·승인 카드는 AX-4(#2510)다.
//
// ## 왜 `null`이 있고 `[]`와 다른가
//
// - `[]` — 서버가 답했고, 이 워크스페이스에서 **할 수 있는 행동이 없다**.
// - `null` — 서버가 그 경로를 싣지 않았거나(404/405, 지금의 Rust 서버가 그렇다)
//   답의 모양이 계약과 다르다. 아직 모른다는 뜻이다.
//
// 모를 때는 **그리지 않는다**(fail-closed). 사람이 보는 행동 목록은 「누르면
// 되는 것」의 목록이라, 확신 없는 줄을 세우면 팔레트가 없는 능력을 약속한다.
// 반쯤 읽은 카탈로그도 같은 거짓말이므로, **한 항목이라도 모양이 어긋나면 전체가
// `null`이다**. 부분 파싱은 서버가 필드를 하나 바꾼 날 조용히 절반짜리 목록을
// 그리고, 그 절반이 무엇이었는지는 아무도 모른다.
// =============================================================================

import { fetchWithDeadline, type HttpResponse } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";

/** ADR-0186 D3의 위험 등급. 레지스트리가 정하고 에이전트는 못 바꾼다. */
export type ActionRisk = "none" | "approval";

export interface ActionCatalogEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly risk: ActionRisk;
  /** 이 행동을 승인할 수 있는 역할. 없으면 `null`. */
  readonly requiredRole: string | null;
  /** 지금 이 서버에서 실행기가 붙어 있는가(`DECLARED_NOT_EXECUTABLE`이면 거짓). */
  readonly executable: boolean;
  /** 실행할 수 없을 때 사람에게 할 말. 없으면 `null`. */
  readonly unavailableReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function parseEntry(value: unknown): ActionCatalogEntry | null {
  if (!isRecord(value)) return null;

  const id = requiredString(value.id);
  const title = requiredString(value.title);
  if (id === null || title === null) return null;

  const summary = typeof value.summary === "string" ? value.summary : null;
  if (summary === null) return null;

  const risk = value.risk;
  if (risk !== "none" && risk !== "approval") return null;

  if (typeof value.executable !== "boolean") return null;

  const requiredRole = nullableString(value.requiredRole);
  if (requiredRole === undefined) return null;
  const unavailableReason = nullableString(value.unavailableReason);
  if (unavailableReason === undefined) return null;

  return {
    id,
    title,
    summary,
    risk,
    requiredRole,
    executable: value.executable,
    unavailableReason,
  };
}

/**
 * 응답 본문을 카탈로그로 읽는다. **총 파싱**: 던지지 않고, 모르면 `null`이다.
 *
 * 받는 것은 `{"actions": [...]}` 한 모양뿐이다(부록 E). 배열을 그대로 주는
 * 서버는 계약 밖이므로 `null`로 떨어진다 — 관대한 파서는 계약이 갈라진 날을
 * 숨긴다.
 */
export function parseActionsCatalog(input: unknown): ActionCatalogEntry[] | null {
  if (!isRecord(input)) return null;
  const actions = input.actions;
  if (!Array.isArray(actions)) return null;

  const parsed: ActionCatalogEntry[] = [];
  for (const raw of actions) {
    const entry = parseEntry(raw);
    if (entry === null) return null;
    parsed.push(entry);
  }
  return parsed;
}

// =============================================================================
// AX-4: 읽는 쪽에 **요청**을 붙인다 (ADR-0186 부록 E).
//
// AX-2 는 파서만 세웠고, 그래서 제품의 팔레트에는 행동 줄이 0개였다. 여기서
// 요청이 붙는다. 규칙은 파서가 이미 정한 그대로다 — 모르면 그리지 않는다.
// =============================================================================

/**
 * 카탈로그를 한 번 읽는다. **던지지 않는다**: 못 읽으면 `null` 이고, `null` 이면
 * 그룹이 통째로 없다(fail-closed).
 *
 * 오류를 문장으로 만들지 않는 것이 의도다. 이 목록은 사람이 요청한 화면이 아니라
 * ⌘K 를 열었을 때 **곁들여 서는** 줄이고, 곁들임이 실패했다고 팔레트에 붉은 줄을
 * 세우면 사람이 하려던 일(이동·검색)이 사고 보고에 밀린다. 없으면 없는 대로
 * 조용하다 — 그것이 이 표면에서 「아직 모른다」의 올바른 모양이다.
 */
export async function fetchActionsCatalog(
  workspaceId: string
): Promise<ActionCatalogEntry[] | null> {
  let response: HttpResponse;
  try {
    const headers = new Headers({ Accept: "application/json" });
    const token = coreSession().getAccessToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    response = await fetchWithDeadline(
      `${apiBase()}/v1/workspaces/${encodeURIComponent(workspaceId)}/actions`,
      { method: "GET", headers }
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return parseActionsCatalog(response.jsonOrNull());
}

/**
 * 이 행동을 사람이 **직접** 하러 갈 수 있는 설정 표면 (v1).
 *
 * v1 에서 팔레트 줄이 하는 일은 제안이 아니라 **이동**이다. 이유는 ADR-0186 D2
 * 에 있다: 워크스페이스 행동은 제안 → 승인 → 실행이고, 제안하는 쪽은 에이전트다
 * (사람은 채널에서 멘션으로 부른다). 그래서 팔레트에서 Enter 를 눌러 승인 카드를
 * 스스로에게 띄우는 동선은 존재하지 않고, 사람이 그 자리에서 실제로 할 수 있는
 * 일은 자기 손으로 하러 가는 것뿐이다.
 *
 * **id 를 모르면 `null` 이고, `null` 이면 그 줄은 눌리지 않는다.** 경로를
 * 짐작하면(`invite.*` 는 초대일 테니 어딘가 초대 화면으로) 언젠가 사람을 엉뚱한
 * 섹션에 내려놓고, 설정 라우트는 모르는 섹션 이름을 조용히 프로필로 접는다 —
 * 아무 말 없이 잘못된 화면에 도착하는 것이 이 표에서 가장 나쁜 실패다.
 *
 * 표에 있는 두 줄은 이 클라이언트에 **실물 화면이 있는** 것들이다
 * (`settingsNav.ts`: `members` = 「멤버와 초대」, `webhooks` = 「웹훅」).
 */
const ACTION_DESTINATION: Readonly<Record<string, string>> = {
  "invite.create": "/settings?section=members",
  "webhook.create": "/settings?section=webhooks",
};

export function actionDestination(actionId: string): string | null {
  return Object.prototype.hasOwnProperty.call(ACTION_DESTINATION, actionId)
    ? ACTION_DESTINATION[actionId]
    : null;
}

/**
 * 갈 수 있는 줄이 자기 옆에 다는 작은 글씨.
 *
 * 「승인 필요」가 아니다. AX-2 에서는 줄이 눌리지 않았으므로 그 낱말이 참이었지만,
 * 지금 Enter 는 설정으로 데려간다 — 그 줄 옆에 「승인 필요」가 서 있으면 사람은
 * 누르면 승인 카드가 뜨는 줄이라고 읽는다. 작은 글씨는 **누르면 일어나는 일**을
 * 말한다.
 */
export const ACTION_DESTINATION_META = "설정에서 직접 하기";
