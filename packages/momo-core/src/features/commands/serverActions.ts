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
