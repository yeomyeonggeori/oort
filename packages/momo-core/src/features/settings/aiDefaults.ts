import type { LocalHarnessAuth, LocalHarnessId } from "../hostedAgents/detect";
import { LOCAL_HARNESS_IDS } from "../hostedAgents/detect";
import { ACCOUNT_LABEL } from "./harnessProfiles";

// =============================================================================
// 설정 › AI 연결 › 기본 AI 표 (#2881 AA-8, 시안 §5, brief §4.1·§4.2·§4.5).
//
// 규칙은 하나다: **결과를 나만 보면 내 구독도 되고, 팀이 보면 팀 키만.** 이 파일은
// 표의 행과 그 행이 고를 수 있는 자격, 저장된 선택이 지금 쓸 수 없을 때 무엇으로
// 넘어가는지를 **판정**만 한다(순수 함수와 문장). 화면은 `AiDefaultsTable`이다.
//
// - 행의 `audience`가 자격을 정한다. `team` 행의 `sources`에는 구독(`profile`)이
//   없다. 선택지는 `sources`로만 거른다(편집 가능 여부와 따로): 팀 행에 개인 구독이
//   끼어드는 길은 이 목록 하나뿐이고, 시험이 그것을 고정한다(brief §4.5-2·3).
// - 개인 행의 선택은 **이 기기에만** 저장한다(brief §4.5-4). 저장 값은 하네스 id와
//   라벨뿐이다: 경로·토큰·폴더 이름이 없다(ADR-0191 D1·D2). 저장 형식은 닫힌 모양이고
//   모르는 필드는 읽을 때 버린다.
// - 저장한 선택을 지금 쓸 수 없으면(로그인 필요·목록에서 사라짐·팀 키 없음) 저장
//   값을 조용히 바꾸지 않고, 행이 「무엇으로 넘어가는지」를 문장으로 말한다.
// - 모델 이름은 지어내지 않는다. 공식 CLI 상태 명령은 모델 목록을 알려 주지 않고,
//   서버 확인 호출은 모델 **개수**만 준다(`ProviderProbeDetail.modelCount`). 그래서
//   구독은 「CLI 기본 모델」, 팀 키는 「서버가 정한 모델」과 확인한 개수만 말한다.
// - 팀 행(팀 에이전트 대답·요약·가드레일)은 운영자 서버 설정이다. 지금 서버에는 그
//   값을 저장하는 경로가 없어서(#2881 이탈표) 모두 읽기 전용이다.
// =============================================================================

/** 표의 행 id. 순서는 시안 §5 그대로. */
export const AI_DEFAULT_ROW_IDS = [
  "appCommand",
  "localTerminal",
  "remoteWork",
  "teamAgent",
  "summary",
  "guardrail",
] as const;
export type AiDefaultRowId = (typeof AI_DEFAULT_ROW_IDS)[number];

/** 개인 행(이 기기 저장)만. */
export const PERSONAL_ROW_IDS = ["appCommand", "localTerminal", "remoteWork"] as const;
export type PersonalRowId = (typeof PERSONAL_ROW_IDS)[number];

/** 자격의 종류. `profile` = 이 맥의 공식 CLI 구독, `teamKey` = 서버의 팀 API 키. */
export type AiCredentialSource = "profile" | "teamKey";

export interface AiDefaultRow {
  readonly id: AiDefaultRowId;
  readonly title: string;
  readonly hint: string;
  /** 결과를 누가 보는가(brief §4.1). `team` 행은 운영자 서버 설정이다. */
  readonly audience: "me" | "team";
  /** 이 행이 부를 수 있는 자격. 선택지는 이것으로만 거른다. */
  readonly sources: readonly AiCredentialSource[];
}

export const AI_DEFAULT_ROWS: readonly AiDefaultRow[] = [
  {
    id: "appCommand",
    title: "앱 명령",
    hint: "「테마 바꿔 줘」「알림 꺼 줘」 · 결과는 이 기기에만",
    audience: "me",
    // 목표는 내 구독(로컬 실행기, Q4 B)인데 ADR 증보 전이라 아직 팀 키만 연다.
    sources: ["teamKey"],
  },
  {
    id: "localTerminal",
    title: "로컬 터미널 새 세션",
    hint: "새 세션을 열 때 먼저 고를 계정",
    audience: "me",
    sources: ["profile"],
  },
  {
    id: "remoteWork",
    title: "원격 작업 기본 계정",
    hint: "폰에서 시작하는 작업",
    audience: "me",
    sources: ["profile"],
  },
  {
    id: "teamAgent",
    title: "팀 에이전트 대답",
    hint: "멘션·DM, 팀이 봄",
    audience: "team",
    sources: ["teamKey"],
  },
  {
    id: "summary",
    title: "채널 요약 · 첫 인사",
    hint: "서버에서 돌고 팀이 봄",
    audience: "team",
    sources: ["teamKey"],
  },
  {
    id: "guardrail",
    title: "가드레일 · 결정",
    hint: "승인을 더 요구할지 판정",
    audience: "team",
    // 결정 칸의 별도 키(Jev, OpenRouter)만 쓴다. 채팅 자격은 하나도 아니다(brief §4.5-5).
    sources: [],
  },
];

export function aiDefaultRow(id: AiDefaultRowId): AiDefaultRow {
  const row = AI_DEFAULT_ROWS.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`unknown ai default row ${id}`);
  return row;
}

// ---- 자격 ----------------------------------------------------------------------

/** 선택된 자격. `label: null` = 이 맥의 기본 로그인(oort 프로필 아님). */
export type AiCredentialRef =
  | { kind: "profile"; harness: LocalHarnessId; label: string | null }
  | { kind: "teamKey" };

/** 이 맥의 구독 계정 하나(내 계정 절의 줄과 같은 것). */
export interface AiDefaultsAccount {
  readonly harness: LocalHarnessId;
  readonly label: string | null;
  /** 모르면(확인 전) `unknown`. */
  readonly auth: LocalHarnessAuth;
}

/**
 * 팀 키에 대해 이 화면이 아는 것.
 * - `present`: 서버에 팀 키가 있다(운영자라 읽었다).
 * - `absent`: 운영자가 읽었고 없다.
 * - `mock`: 저장된 키가 없고 서버가 모의 응답으로만 대답한다(팀 연결 절과 같은 말).
 * - `hidden`: 운영자가 아니라 읽을 수 없다(서버 403). 있다고도 없다고도 하지 않는다.
 * - `loading`: 아직 모른다.
 * - `error`: 403이 아닌 오류로 읽지 못했다.
 *
 * `name`은 서버 `endpointLabel`(주소)이다. 화면에는 `teamKeyHost`로 줄여 보인다.
 */
export type AiDefaultsTeamKey =
  | { status: "present"; name: string; failed: boolean; modelCount: number | null }
  | { status: "absent" }
  | { status: "mock" }
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "error" };

/**
 * 서버 `endpointLabel`은 제품 이름이 아니라 주소다(`https://api.openai.com/v1`). 폭이
 * 고정된 선택 칸에 넣을 이름은 호스트만(`api.openai.com`). 주소가 아니면 그대로.
 */
export function teamKeyHost(label: string): string {
  const trimmed = label.trim();
  try {
    const host = new URL(trimmed).host;
    return host === "" ? trimmed : host;
  } catch {
    return trimmed;
  }
}

export interface AiDefaultsInput {
  /** 이 맥의 구독 계정. 브라우저 탭이면 빈 목록이다. */
  readonly accounts: readonly AiDefaultsAccount[];
  readonly teamKey: AiDefaultsTeamKey;
  /** 브라우저 탭: 이 맥의 CLI가 없다. */
  readonly browserTab: boolean;
}

export function sameCredential(a: AiCredentialRef, b: AiCredentialRef): boolean {
  if (a.kind === "teamKey" || b.kind === "teamKey") return a.kind === b.kind;
  return a.harness === b.harness && a.label === b.label;
}

/** 선택 칸 값(문자열). `<select>`의 option value. */
export function credentialKey(ref: AiCredentialRef): string {
  return ref.kind === "teamKey" ? "teamKey" : `profile:${ref.harness}:${ref.label ?? ""}`;
}

/**
 * 자격 이름: 「Claude · 개인」, 기본 로그인은 「Claude · 이 맥 기본 로그인」, 팀 키는
 * 「팀 API 키 · api.openai.com」(호스트만, 선택 칸 폭 안에 들게).
 */
export function credentialName(ref: AiCredentialRef, teamKey: AiDefaultsTeamKey): string {
  if (ref.kind === "teamKey") {
    return teamKey.status === "present" ? `팀 API 키 · ${teamKeyHost(teamKey.name)}` : "팀 API 키";
  }
  const account = ACCOUNT_LABEL[ref.harness];
  return ref.label === null ? `${account} · 이 맥 기본 로그인` : `${account} · ${ref.label}`;
}

/**
 * 출처 글자(시안 `.sel-box small`). 팀 키는 이름이 이미 「팀 API 키」라 붙이지 않는다
 * (「팀 API 키 · API 키」 반복을 피함).
 */
export function credentialSource(ref: AiCredentialRef): string | null {
  return ref.kind === "teamKey" ? null : "구독";
}

export interface AiDefaultOption {
  readonly ref: AiCredentialRef;
  readonly key: string;
  readonly name: string;
  readonly source: string | null;
  /** 지금 부를 수 없는 선택지(로그인 필요 등). 목록에는 남고 이유가 붙는다. */
  readonly unavailable: string | null;
}

function accountUnavailable(auth: LocalHarnessAuth): string | null {
  if (auth === "logged_in") return null;
  return auth === "needs_login" ? "로그인 필요" : "확인 전";
}

/**
 * 이 행이 고를 수 있는 선택지. `row.sources`로만 거른다: `team` 행에는 구독이 한
 * 줄도 오지 않는다(#2881 수용 기준).
 */
export function optionsFor(rowId: AiDefaultRowId, input: AiDefaultsInput): AiDefaultOption[] {
  const row = aiDefaultRow(rowId);
  const out: AiDefaultOption[] = [];
  if (row.sources.includes("profile") && !input.browserTab) {
    for (const harness of LOCAL_HARNESS_IDS) {
      const mine = input.accounts
        .filter((account) => account.harness === harness)
        .sort((a, b) => {
          if (a.label === null) return -1;
          if (b.label === null) return 1;
          return a.label.localeCompare(b.label, "ko");
        });
      for (const account of mine) {
        const ref: AiCredentialRef = { kind: "profile", harness, label: account.label };
        out.push({
          ref,
          key: credentialKey(ref),
          name: credentialName(ref, input.teamKey),
          source: credentialSource(ref),
          unavailable: accountUnavailable(account.auth),
        });
      }
    }
  }
  // 팀 키가 있다고 읽은 때만 선택지다. 없음·모의·운영자 아님·로딩·오류에서는 있다고
  // 단정하지 않는다(화면은 이유를 적은 읽기 전용 칸을 그린다).
  if (row.sources.includes("teamKey") && input.teamKey.status === "present") {
    const ref: AiCredentialRef = { kind: "teamKey" };
    out.push({
      ref,
      key: credentialKey(ref),
      name: credentialName(ref, input.teamKey),
      source: credentialSource(ref),
      unavailable:
        input.teamKey.status === "present" && input.teamKey.failed ? "확인 실패" : null,
    });
  }
  return out;
}

/**
 * 이 자격으로 부를 모델에 대해 말할 수 있는 것. 이름을 지어내지 않는다: 구독은 CLI가
 * 목록을 주지 않고, 팀 키는 서버가 개수만 준다.
 */
export function modelLine(ref: AiCredentialRef, teamKey: AiDefaultsTeamKey): string {
  if (ref.kind === "profile") return "모델은 CLI 기본값";
  if (teamKey.status === "present" && teamKey.modelCount !== null) {
    return `모델은 서버가 정함 · 이 키로 쓸 수 있는 모델 ${teamKey.modelCount}개`;
  }
  return "모델은 서버가 정함";
}

// ---- 저장(이 기기) ----------------------------------------------------------------

export const AI_DEFAULTS_LOCAL_SLOT = "oort.aiDefaults.v1";

/** 이 기기에 저장된 개인 행 선택. 없는 행은 「기본값」이다. */
export type AiDefaultsPrefs = Partial<Record<PersonalRowId, AiCredentialRef>>;

function readRef(value: unknown): AiCredentialRef | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.kind === "teamKey") return { kind: "teamKey" };
  if (body.kind !== "profile") return null;
  if (!(LOCAL_HARNESS_IDS as readonly unknown[]).includes(body.harness)) return null;
  if (body.label !== null && typeof body.label !== "string") return null;
  return {
    kind: "profile",
    harness: body.harness as LocalHarnessId,
    label: body.label as string | null,
  };
}

/** 저장 값 → 선택. 모르는 행·모양·필드는 버린다(닫힌 형식). */
export function parseAiDefaults(raw: string | null): AiDefaultsPrefs {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const out: AiDefaultsPrefs = {};
  for (const id of PERSONAL_ROW_IDS) {
    const ref = readRef(body[id]);
    if (ref && aiDefaultRow(id).sources.includes(ref.kind === "teamKey" ? "teamKey" : "profile")) {
      out[id] = ref;
    }
  }
  return out;
}

/** 선택 → 저장 값. 필드는 `kind`·`harness`·`label`뿐이다. */
export function serializeAiDefaults(prefs: AiDefaultsPrefs): string {
  const out: Record<string, unknown> = {};
  for (const id of PERSONAL_ROW_IDS) {
    const ref = prefs[id];
    if (!ref) continue;
    out[id] =
      ref.kind === "teamKey"
        ? { kind: "teamKey" }
        : { kind: "profile", harness: ref.harness, label: ref.label };
  }
  return JSON.stringify(out);
}

/** 한 행의 선택을 바꾼다. `null`이면 기본값으로 되돌린다. */
export function withChoice(
  prefs: AiDefaultsPrefs,
  rowId: PersonalRowId,
  ref: AiCredentialRef | null
): AiDefaultsPrefs {
  const next: AiDefaultsPrefs = { ...prefs };
  if (ref === null) delete next[rowId];
  else next[rowId] = ref;
  return next;
}

// ---- 폴백(조용히 넘어가지 않음) -----------------------------------------------------

/** 행마다 「선택이 없거나 쓸 수 없을 때」 가는 곳(brief §4.2 폴백 열). */
export const AI_DEFAULT_FALLBACK: Record<AiDefaultRowId, string> = {
  appCommand: "쓸 수 없음",
  localTerminal: "셸",
  remoteWork: "매번 묻기",
  teamAgent: "대답할 수 없음",
  summary: "정적 문구",
  guardrail: "기존 승인 규칙",
};

/** 개인 행의 「고르지 않음」 선택지 글자. */
export const AI_DEFAULT_UNSET_LABEL: Record<PersonalRowId, string> = {
  appCommand: "팀 API 키",
  localTerminal: "마지막에 쓴 계정",
  remoteWork: "매번 묻기",
};

export type AiDefaultResolution =
  /** 저장한 선택(또는 기본값)을 그대로 쓴다. */
  | { state: "ok"; using: string; note: string | null }
  /** 저장한 선택을 지금 못 써서 폴백으로 간다. 문장이 그것을 말한다. */
  | { state: "fallback"; using: string; sentence: string }
  /** 이 행은 지금 아무것도 부를 수 없다. */
  | { state: "blocked"; using: string; sentence: string };

/** 팀 키를 모를 때의 칸 글자. 알면 null. */
function teamKeyUnknown(teamKey: AiDefaultsTeamKey): string | null {
  switch (teamKey.status) {
    case "hidden":
      // 멤버가 모르는 것은 키의 정체다. 앱 명령을 쓸 수 없다는 말이 아니다(2차 M1').
      return "팀 API 키 · 운영자 설정";
    case "loading":
      return "팀 연결을 확인하고 있어요";
    case "error":
      return "팀 연결을 불러오지 못했어요";
    default:
      return null;
  }
}

function accountOf(input: AiDefaultsInput, ref: AiCredentialRef & { kind: "profile" }) {
  return input.accounts.find(
    (account) => account.harness === ref.harness && account.label === ref.label
  );
}

/**
 * 한 행이 지금 무엇을 부르는가. 저장 값은 바꾸지 않는다: 쓸 수 없으면 그 사실과
 * 넘어가는 곳을 문장으로 돌려준다.
 */
export function resolveRow(
  rowId: AiDefaultRowId,
  prefs: AiDefaultsPrefs,
  input: AiDefaultsInput
): AiDefaultResolution {
  const teamKey = input.teamKey;
  const teamName = credentialName({ kind: "teamKey" }, teamKey);
  switch (rowId) {
    case "appCommand": {
      const unknown = teamKeyUnknown(teamKey);
      if (unknown) return { state: "ok", using: unknown, note: null };
      if (teamKey.status === "absent" || teamKey.status === "mock") {
        return {
          state: "blocked",
          using: AI_DEFAULT_FALLBACK.appCommand,
          sentence: "팀 API 키가 없어 앱 명령을 쓸 수 없어요. AI 계정을 연결하면 쓸 수 있어요.",
        };
      }
      if (teamKey.status === "present" && teamKey.failed) {
        return {
          state: "blocked",
          using: teamName,
          sentence: "팀 API 키 확인이 실패했어요. 키가 다시 확인될 때까지 앱 명령은 대답하지 못해요.",
        };
      }
      return { state: "ok", using: teamName, note: "내 구독으로 부르기는 준비 중이에요" };
    }
    case "localTerminal":
    case "remoteWork": {
      const saved = prefs[rowId];
      const fallback = AI_DEFAULT_FALLBACK[rowId];
      if (input.browserTab) {
        return { state: "ok", using: AI_DEFAULT_UNSET_LABEL[rowId], note: null };
      }
      if (!saved || saved.kind !== "profile") {
        return { state: "ok", using: AI_DEFAULT_UNSET_LABEL[rowId], note: null };
      }
      const name = credentialName(saved, teamKey);
      const account = accountOf(input, saved);
      const where = `이 칸은 「${fallback}」로 넘어가요`;
      if (!account) {
        return {
          state: "fallback",
          using: fallback,
          sentence: `「${name}」 계정이 이 맥 목록에 없어 ${where}.`,
        };
      }
      if (account.auth === "needs_login") {
        return {
          state: "fallback",
          using: fallback,
          sentence: `「${name}」 계정이 로그인 필요라 ${where}. 다시 로그인하면 돌아와요.`,
        };
      }
      return { state: "ok", using: name, note: null };
    }
    case "teamAgent": {
      const unknown = teamKeyUnknown(teamKey);
      if (unknown) return { state: "ok", using: `팀 키만 · ${unknown}`, note: null };
      if (teamKey.status === "mock") {
        return {
          state: "fallback",
          using: "모의 응답",
          sentence: "저장된 팀 API 키가 없어 팀 에이전트는 모의 응답으로만 대답해요. 내 구독으로 넘어가지 않아요.",
        };
      }
      if (teamKey.status === "absent") {
        return {
          state: "blocked",
          using: AI_DEFAULT_FALLBACK.teamAgent,
          sentence: "팀 API 키가 없어 팀 에이전트는 대답할 수 없어요. 내 구독으로 넘어가지 않아요.",
        };
      }
      return { state: "ok", using: "에이전트마다 정함 · 팀 키만", note: null };
    }
    case "summary": {
      const unknown = teamKeyUnknown(teamKey);
      if (unknown) return { state: "ok", using: unknown, note: null };
      if (teamKey.status === "absent" || teamKey.status === "mock") {
        return {
          state: "fallback",
          using: AI_DEFAULT_FALLBACK.summary,
          sentence: "팀 API 키가 없어 요약은 쉬고, 첫 인사는 정해진 문구로 해요.",
        };
      }
      return { state: "ok", using: teamName, note: null };
    }
    case "guardrail":
      return { state: "ok", using: "꺼짐 · 결정 모델 칸 준비 중", note: null };
  }
}

// ---- 계정 해제의 영향(#2878 해제 창이 기다리던 목록) ------------------------------

export interface AiDefaultImpact {
  readonly rowId: PersonalRowId;
  readonly title: string;
  readonly fallback: string;
}

/**
 * 이 계정을 기본으로 고른 개인 행과, 해제하면 넘어갈 곳. 팀 행은 구독을 고를 수
 * 없으므로 이 목록에 오지 않는다.
 */
export function rowsUsingAccount(
  prefs: AiDefaultsPrefs,
  account: { harness: LocalHarnessId; label: string | null }
): AiDefaultImpact[] {
  const target: AiCredentialRef = { kind: "profile", harness: account.harness, label: account.label };
  const out: AiDefaultImpact[] = [];
  for (const id of PERSONAL_ROW_IDS) {
    const saved = prefs[id];
    if (!saved || !sameCredential(saved, target)) continue;
    // 해제가 끝나면 `forgetAccount`가 선택을 지워 이 칸은 「고르지 않음」으로 돌아간다.
    // 창은 표가 그 뒤에 보일 글자를 그대로 말한다.
    out.push({ rowId: id, title: aiDefaultRow(id).title, fallback: AI_DEFAULT_UNSET_LABEL[id] });
  }
  return out;
}

/** 해제 창의 한 줄. 영향이 없으면 null(아무 줄도 그리지 않는다). */
export function unlinkImpactLead(impact: readonly AiDefaultImpact[]): string | null {
  return impact.length === 0 ? null : "기본 AI에서 이 계정을 고른 칸은 이렇게 돌아가요.";
}

/**
 * 개인 줄의 선택을 읽어 쓰는 곳(로컬 터미널 새 세션·원격 작업·⌘K 앱 명령)은 아직
 * 없다(#2881 이탈표: AA-9 등 후속). 표가 이미 적용되는 것처럼 말하지 않게 한 줄로 적는다.
 */
export const AI_DEFAULTS_NOT_APPLIED =
  "내 설정은 이 기기에만 저장돼요. 터미널 새 세션과 원격 작업이 이 선택을 따르는 것은 준비 중이에요.";

export function impactLine(item: AiDefaultImpact): string {
  return `${item.title}: ${item.fallback}`;
}

/** 해제가 끝났을 때 그 계정을 가리키던 선택을 지운다(창이 이미 알렸다). */
export function forgetAccount(
  prefs: AiDefaultsPrefs,
  account: { harness: LocalHarnessId; label: string | null }
): AiDefaultsPrefs {
  let next = prefs;
  for (const item of rowsUsingAccount(prefs, account)) next = withChoice(next, item.rowId, null);
  return next;
}
