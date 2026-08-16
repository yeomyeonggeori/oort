import { payloadDetail, type PayloadDetail } from "./agentCardModel";

// =============================================================================
// 작업 완료 리포트 카드 (UXC-A / 커서 웹 ADE 벤치마크 §3-A)
//
// 에이전트가 긴 작업을 끝내고 **자기가 무엇을 했는지 설명하는** 카드다. 커서의
// 클라우드 에이전트가 24분짜리 셋업을 마치면 채팅 안에 ①한 문단 요약 ②"무엇을
// 했는가" 불릿(왜까지) ③표면×게이트 결과 표를 남긴다 — 24분의 산출이 스크롤로
// 흘러가 버리는 대신 **감사 가능한 문서**가 된다. 이 카드가 그 자리다.
//
// 채팅 원장이 정본(Postgres=SoT)이라 이 카드는 채널에 영속한다 — 커서(세션 로컬)
// 대비 우리 쪽 우위는 팀 전체가 나중에도 그 리포트를 그대로 본다는 데 있다.
//
// ## 새 카드 체계가 아니다 (LIVE-4 로그인 핸드오프 카드와 같은 재사용)
//
// `loginHandoffCard.ts` 머리말이 세운 패턴을 그대로 잇는다: 갈라지는 것은
// `props.kind` 하나뿐이다. 로그인 핸드오프가 승인 카드 가족 안에서 `kind` 로
// 갈라졌듯, 완료 리포트는 **평범한 에이전트 턴 메시지** 안에서 `kind` 로 갈라진다.
// 그래서:
//
//   * `message_type` enum 에 값을 더하지 않는다 (schema_v0 불가침). 에이전트는
//     평범한 메시지(기본 타입)를 쓰되 `props.kind = "completion_report"` 를 싣고,
//     `agentCardModel` 의 기본(턴) 갈래가 그것을 먼저 알아본다.
//   * 마이그레이션이 없다. 새 열도, 새 원장도 없다 — 턴 레코드가 이미 `usage` 를
//     싣는 그 봉투에 요약·불릿·게이트 표가 얹힐 뿐이다.
//
// ## 이 카드가 그리지 않는 것
//
// 결정이 없다. 완료 리포트는 **끝난 일의 기록**이라 승인·거부 같은 컨트롤이 서지
// 않는다(로그인 핸드오프와 다른 점이 이것이다). 그래서 이 파일에는 판정이 아니라
// **표시 규칙**만 있다: 무엇을 어떤 격으로 그리는가.
//
// ## 정직 규율 (design-taste-web §9 · ADR-0132)
//
// 커서의 표는 초록 일색이었지만(전 게이트 그린), 우리 표는 실패도 침묵도 정직하게
// 말해야 한다. 그래서 게이트 결과 어휘가 넷이고 색이 따로 논다:
//
//   pass     통과.  ok.
//   fail     실패.  danger — 실제 실패는 붉게. 숨기지 않는다.
//   skip     건너뜀. muted — **실패가 아니다**. 안 돌린 것을 붉게 칠하면 침묵을
//            실패로 승격하는 것이고, 그것이 ADR-0132 가 막는 거짓 서사다.
//   pending  진행 중. warn — 아직 답이 없다. 사람이 볼 자리라는 뜻의 색이지
//            실패색이 아니다.
//
// 그리고 없는 숫자를 짓지 않는다: `detail` 이 없는 셀은 낱말만 서고, 카드는
// 자기가 못 읽은 키의 **개수**를 `payloadDetail` 로 정직하게 센다.
// =============================================================================

/**
 * 이 카드를 세우는 `props.kind`. 로그인 핸드오프의 `login_handoff`, 재개 제안의
 * `resume_offer` 와 같은 자리다.
 */
export const COMPLETION_REPORT_KIND = "completion_report";

// ---- 게이트 결과 어휘 --------------------------------------------------------

/**
 * 게이트 한 칸의 결과. 색이 서로 달라야 하기 때문에 따로 있다
 * (모듈 머리말 §정직 규율). 특히 `skip` 과 `pending` 을 `fail` 로 접으면 안 돌린
 * 것과 아직 안 끝난 것이 실패로 읽힌다.
 *
 * `unknown` 은 「카드가 못 읽은 칸」이다: 결과 문자열이 실렸으나 아는 어휘로도
 * 동의어로도 접을 수 없을 때다(M1). 버리지 않고 이 격으로 표에 **남긴다** — 버리면
 * 실패 동의어 하나가 조용히 사라져 표가 실제보다 깨끗해진다. 추측으로 통과/실패를
 * 짓지 않으므로 색은 danger 가 아니라 warn(사람이 볼 자리)이다.
 */
export type CompletionCheckOutcome =
  | "pass"
  | "fail"
  | "skip"
  | "pending"
  | "unknown";

/**
 * 와이어 결과 문자열 -> 아는 어휘. 대소문자를 접고 알려진 동의어를 정규화한다.
 *
 * 여기 없는 값은 `parseCompletionCheckOutcome` 이 `null` 을 내고, `parseCheck` 이
 * 그것을 `unknown` 으로 표에 남긴다 — **추측으로 pass 를 짓지 않는다**(M1). 실패
 * 동의어(`failed`/`error`/`FAIL`)를 통과 옆에서 버리던 것이 이 표가 막는 정직
 * 결함이다. 오브젝트가 아니라 `Map` 인 이유는 `agentCardModel` 의 FAILURE_GUIDANCE
 * 와 같다: 키가 와이어에서 오므로 `__proto__` 조회가 프로토타입 멤버를 돌려주면
 * 안 된다.
 */
const CHECK_OUTCOME_SYNONYMS: ReadonlyMap<string, CompletionCheckOutcome> =
  new Map([
    ["pass", "pass"],
    ["passed", "pass"],
    ["passing", "pass"],
    ["ok", "pass"],
    ["green", "pass"],
    ["success", "pass"],
    ["successful", "pass"],
    ["succeeded", "pass"],
    ["fail", "fail"],
    ["failed", "fail"],
    ["failing", "fail"],
    ["failure", "fail"],
    ["error", "fail"],
    ["errored", "fail"],
    ["red", "fail"],
    ["broken", "fail"],
    ["skip", "skip"],
    ["skipped", "skip"],
    ["ignored", "skip"],
    ["n/a", "skip"],
    ["na", "skip"],
    ["pending", "pending"],
    ["running", "pending"],
    ["in_progress", "pending"],
    ["in-progress", "pending"],
    ["inprogress", "pending"],
    ["queued", "pending"],
    ["waiting", "pending"],
  ]);

/** 결과의 이름. 칩·셀에 서는 한 낱말. */
export const COMPLETION_CHECK_OUTCOME_LABEL: Readonly<
  Record<CompletionCheckOutcome, string>
> = {
  pass: "통과",
  fail: "실패",
  skip: "건너뜀",
  pending: "진행 중",
  unknown: "미상 결과",
};

/**
 * 결과가 지는 **역할**. 값이 아니라 역할이다 — 어느 토큰이 이 역할을 지는지는 각
 * 클라의 팔레트가 정하고(`divider.ts` 의 `DIVIDER_TONE` 과 같은 계약), 그 매핑이
 * 옳은지는 클라의 계약 테스트가 잰다.
 *
 * `fail` 만 `danger` 이고 `skip`/`pending` 은 아닌 것이 이 표의 심장이다: 안 돌린
 * 게이트와 아직 안 끝난 게이트를 실패색으로 칠하는 것이 정확히 ADR-0132 가 막는
 * 일이다. `pending` 이 `warn` 인 것은 「사람이 볼 자리」라는 뜻이지 사고가 아니다.
 */
export type CompletionTone = "ok" | "danger" | "warn" | "muted";

export const COMPLETION_CHECK_TONE: Readonly<
  Record<CompletionCheckOutcome, CompletionTone>
> = {
  pass: "ok",
  fail: "danger",
  skip: "muted",
  pending: "warn",
  // 못 읽은 칸은 danger 가 아니다(실패라고 추측하지 않는다) — warn 으로 「여기를
  // 보라」만 말한다. pending 과 색을 나눠 쓰는 것은 둘 다 「아직 정착 안 됨」이라
  // 사람이 볼 자리라는 같은 뜻이기 때문이다.
  unknown: "warn",
};

/**
 * 한 (표면, 라벨) 셀에 여러 칸이 겹칠 때 **먼저 그릴 순서**. 낮을수록 앞이다.
 * 실패가 맨 앞이라 절대 접히지 않는다(H1 — 매트릭스가 한 라벨의 첫 칸만 그려
 * 실패를 숨기던 결함을 막는다). 웹 매트릭스가 이 순위로 한 셀의 겹친 칸을 정렬한다.
 */
export const COMPLETION_CHECK_SEVERITY: Readonly<
  Record<CompletionCheckOutcome, number>
> = {
  fail: 0,
  unknown: 1,
  pending: 2,
  pass: 3,
  skip: 4,
};

/**
 * 와이어 문자열 -> 아는 결과. 대소문자를 접고 동의어를 정규화한다. 어휘 밖 값은
 * `null`(추측 금지) — 부르는 쪽(`parseCheck`)이 그것을 `unknown` 으로 표에 남긴다.
 */
export function parseCompletionCheckOutcome(
  value: unknown
): CompletionCheckOutcome | null {
  if (typeof value !== "string") return null;
  return CHECK_OUTCOME_SYNONYMS.get(value.trim().toLowerCase()) ?? null;
}

// ---- 카드 전체의 상태 --------------------------------------------------------

/**
 * 카드 머리의 상태. `attention` 은 게이트 중 하나라도 `fail` 일 때다.
 *
 * `pending` 이 있어도 `attention` 이 아닌 이유: 아직 안 끝난 것은 사람을 부르는
 * 일이 아니다. 실패만이 「여기를 보라」이고, 그 실패 셀은 표 안에서 이미 붉게 서
 * 있다. 머리의 칩은 **그것이 하나라도 있는가**만 말한다.
 *
 * `unknown`(미상 결과)도 머리를 뒤집지 않는다: 못 읽은 칸을 실패로 추측하지 않기
 * 때문이다(M1). 대신 그 칸은 표 안에서 warn 으로 서고 집계에 잡혀, 「완료」 칩
 * 아래에서도 스스로 눈에 띈다.
 */
export type CompletionOutcome = "clean" | "attention";

export const COMPLETION_OUTCOME_LABEL: Readonly<
  Record<CompletionOutcome, string>
> = {
  clean: "완료",
  attention: "확인 필요",
};

/**
 * 머리 칩의 역할. `attention` 이 `danger` 가 아니라 `warn` 인 이유: 리포트를 만든
 * 턴 자체는 성공했다(실패한 것은 게이트다). 칩은 「여기 볼 것이 있다」를 말하고,
 * 진짜 실패의 붉은색은 그 셀 하나에만 있다 — 카드 전체를 붉게 칠하면 통과한
 * 게이트까지 실패로 물든다.
 */
export const COMPLETION_OUTCOME_TONE: Readonly<
  Record<CompletionOutcome, CompletionTone>
> = {
  clean: "ok",
  attention: "warn",
};

// ---- 카드 모델 --------------------------------------------------------------

/** 표의 한 셀. 게이트 하나의 결과. */
export interface CompletionCheck {
  /** 게이트 이름. 에이전트가 쓴 그대로(예: "테스트", "린트", "빌드", "실행"). */
  label: string;
  outcome: CompletionCheckOutcome;
  /** 정직한 세부(예: "896 통과", "경고 0"). 없으면 낱말만 선다. */
  detail?: string;
}

/** 표의 한 줄. 한 표면과 그 게이트들. */
export interface CompletionGateRow {
  /** 표면 이름. 에이전트가 쓴 그대로(예: "웹", "엔진", "compose"). */
  surface: string;
  checks: CompletionCheck[];
}

/** "무엇을 했는가" 불릿 하나. */
export interface CompletionAction {
  /** 한 일. */
  text: string;
  /** 왜. 커서가 "pinned 1.83 couldn't build it" 을 붙인 그 자리다. 없을 수 있다. */
  note?: string;
}

/**
 * 상한 때문에 **그리지 않고 개수만 남긴** 것들 (M3). 적대·버그 에이전트가 불릿·표를
 * 수천 개 실어 DOM 을 터뜨리는 것을 막되, 조용히 자르지 않는다 — 아티팩트의
 * `omittedFileCount` 규율 동형: 화면은 「그 밖에 N개 더」로 잘렸음을 정직하게 말한다.
 */
export interface CompletionOmitted {
  /** 상한을 넘겨 그리지 않은 「한 일」 불릿 수. */
  actions: number;
  /** 상한을 넘겨 그리지 않은 표면(줄) 수. */
  gates: number;
  /** 그린 줄들 안에서 상한을 넘겨 그리지 않은 게이트 칸 수(합). */
  checks: number;
}

export interface CompletionReportCard {
  kind: "completion_report";
  title: string;
  /** 한 문단 요약. 에이전트가 자기 말로 쓴 것만, 쓰인 그대로. */
  summary?: string;
  actions: CompletionAction[];
  gates: CompletionGateRow[];
  /** 경과 시간. "24분 28초" 같은 성과의 단위(벤치마크 차용 C). 없을 수 있다. */
  elapsedMs?: number;
  outcome: CompletionOutcome;
  /** 상한에 걸려 그리지 않은 것들의 개수(M3). 전부 0이면 자른 것이 없다. */
  omitted: CompletionOmitted;
  detail: PayloadDetail;
}

// ---- copy -------------------------------------------------------------------

export const COMPLETION_REPORT_TITLE = "작업 완료 리포트";

/** 게이트 표 위에 서는 열 제목(표면 열). */
export const COMPLETION_GATE_SURFACE_LABEL = "표면";

// ---- 상한 (M3) --------------------------------------------------------------
//
// 적대·버그 에이전트가 불릿·표를 수천 개 실으면 카드 하나가 채널의 DOM 을
// 터뜨린다. 아티팩트의 `truncateForDisplay` 규율 동형으로, 파서에서 잘라 개수를
// 남긴다(화면은 「그 밖에 N개 더」로 정직 표기). 상한은 진짜 리포트가 걸리지 않을
// 만큼 넉넉하다 — 실제 셋업 리포트는 표면 서넛·게이트 여남은이다.

/** 「한 일」 불릿의 상한. */
export const MAX_COMPLETION_ACTIONS = 100;

/** 표면(줄)의 상한. */
export const MAX_COMPLETION_GATE_ROWS = 60;

/** 한 줄(표면) 안 게이트 칸의 상한. */
export const MAX_COMPLETION_CHECKS_PER_ROW = 40;

// ---- 집계 -------------------------------------------------------------------

/**
 * 표 전체에서 카드의 상태를 정한다. 실패가 하나라도 있으면 `attention`.
 *
 * 순수 집계라 클라가 각자 세지 않는다 — 두 클라가 같은 표에서 다른 칩을 그리면
 * 안 되고, 「실패가 있는가」의 답은 이 함수 하나여야 한다.
 */
export function completionOutcome(
  gates: readonly CompletionGateRow[]
): CompletionOutcome {
  for (const row of gates) {
    for (const check of row.checks) {
      if (check.outcome === "fail") return "attention";
    }
  }
  return "clean";
}

/** 결과별 게이트 수. 표 밑의 한 줄 집계(예: "통과 12 · 실패 1")를 위한 것. */
export function completionCheckCounts(
  gates: readonly CompletionGateRow[]
): Readonly<Record<CompletionCheckOutcome, number>> {
  const counts: Record<CompletionCheckOutcome, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    pending: 0,
    unknown: 0,
  };
  for (const row of gates) {
    for (const check of row.checks) {
      counts[check.outcome] += 1;
    }
  }
  return counts;
}

/**
 * 매트릭스의 열. **처음 본 순서**의 게이트 이름 합집합이다. 웹은 표면×게이트
 * 매트릭스라 열이 하나 필요하고, 폰은 표면별 묶음이라 필요 없다 — 그래서 이
 * 판정은 코어가 지고 웹이 소비한다(웹이 자기 안에서 다시 짜면 폰과 갈라진다).
 */
export function completionGateColumns(
  gates: readonly CompletionGateRow[]
): string[] {
  const columns: string[] = [];
  for (const row of gates) {
    for (const check of row.checks) {
      if (!columns.includes(check.label)) columns.push(check.label);
    }
  }
  return columns;
}

/**
 * 한 (표면 줄, 열 라벨) 셀에 그릴 칸들. **전부** 돌려주되 최악 톤이 앞이다
 * (`COMPLETION_CHECK_SEVERITY`).
 *
 * H1 의 심장이다: 한 표면에 같은 라벨이 둘이면(통과 「896 통과」+실패 「1 실패」)
 * 매트릭스가 `find` 로 첫 칸만 그려 초록만 남고 실패가 사라졌다. `filter` 로 전부
 * 돌려주고 실패를 앞에 세워, 웹 표가 폰·집계와 **같은 칸 집합**을 그리게 한다.
 * 정렬은 안정적이라 같은 톤끼리는 에이전트가 쓴 순서를 지킨다.
 */
export function completionCellChecks(
  row: CompletionGateRow,
  label: string
): CompletionCheck[] {
  return row.checks
    .filter((check) => check.label === label)
    .sort(
      (a, b) =>
        COMPLETION_CHECK_SEVERITY[a.outcome] -
        COMPLETION_CHECK_SEVERITY[b.outcome]
    );
}

/**
 * 한 표면 줄의 칸들을 **읽는 순서대로** 편 것. 폰은 매트릭스 대신 표면별 묶음으로
 * 그리므로(열이 없다) 이 평평한 목록을 쓴다.
 *
 * 서로 다른 라벨은 에이전트가 처음 쓴 순서를 지키고(웹의 열 순서와 같은 규율),
 * 같은 라벨이 겹친 칸들만 그 안에서 최악 톤을 앞에 세운다 — 웹 셀이 겹친 칸을
 * 쌓는 것과 같은 순서다(design-review Medium: 폰에서 실패가 통과 아래로 밀리지
 * 않게). 겹치지 않는 흔한 경우에는 순서가 그대로다.
 */
export function completionRowChecks(row: CompletionGateRow): CompletionCheck[] {
  const labelOrder: string[] = [];
  for (const check of row.checks) {
    if (!labelOrder.includes(check.label)) labelOrder.push(check.label);
  }
  const ordered: CompletionCheck[] = [];
  for (const label of labelOrder) ordered.push(...completionCellChecks(row, label));
  return ordered;
}

/**
 * 경과 시간을 사람의 낱말로. **가장 큰 두 단위까지만** — "24분 28초", "1시간 3분",
 * "12초". 세 단위를 늘어놓으면 성과의 단위가 아니라 스톱워치 눈금이 된다.
 *
 * 데이터에 없는 정밀도를 짓지 않는다: 0 은 "1초 미만"으로, 음수·비수는 빈 문자열로
 * (부르는 쪽이 그리지 않는다). 숫자와 한글 단위가 섞이므로 화면은 이 문자열에
 * 자릿폭 고정(`data-numeric`)을 걸지 않는다 — 걸면 음절 사이가 벌어진다
 * (`divider.ts` 가 같은 이유로 날짜와 시각을 가른다).
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds === 0) return "1초 미만";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  if (seconds > 0) parts.push(`${seconds}초`);
  return parts.slice(0, 2).join(" ");
}

// ---- parsing ----------------------------------------------------------------

type Props = Record<string, unknown> | undefined;

function readString(props: Props, key: string): string | undefined {
  const value = props?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readMs(props: Props, key: string): number | undefined {
  const value = props?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * 불릿 배열을 읽는다. **글자 없는 항목은 버린다** — `text` 가 불릿의 전부이므로,
 * 그것이 없으면 그릴 것이 없다. `note` 는 있으면 싣고 없으면 만다.
 *
 * 배열이 아니면 빈 배열이다(추측도 예외도 없다). 모르는 모양의 항목 하나가 전체
 * 카드를 못 그리게 하지 않는다 — 봉투는 가산적이라는 이 레포의 규율(payload.rs).
 */
export function parseCompletionActions(value: unknown): CompletionAction[] {
  if (!Array.isArray(value)) return [];
  const actions: CompletionAction[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const text = readString(entry, "text");
    if (text === undefined) continue;
    const action: CompletionAction = { text };
    const note = readString(entry, "note");
    if (note !== undefined) action.note = note;
    actions.push(action);
  }
  return actions;
}

/**
 * 셀 하나를 읽는다. `label` 은 반드시 있어야 하고, 결과는 세 갈래다:
 *
 *   1. 아는 어휘·동의어(대소문자 접음) → 그 결과로(`parseCompletionCheckOutcome`).
 *   2. 결과 문자열이 실렸으나 접을 수 없음 → `unknown` 으로 **표에 남긴다**(M1).
 *      버리면 `failed`/`error`/`FAIL` 같은 실패 동의어가 통과 옆에서 조용히 사라져
 *      표가 실제보다 깨끗해진다. 추측으로 통과/실패를 짓지 않으므로 격을 따로 둔다.
 *   3. 결과가 아예 없음(문자열 아님·빈 문자열) → 셀이 아니다(버린다).
 */
function parseCheck(raw: unknown): CompletionCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const label = readString(entry, "label");
  if (label === undefined) return null;
  const rawOutcome = entry["outcome"];
  const outcome = parseCompletionCheckOutcome(rawOutcome);
  const detail = readString(entry, "detail");
  if (outcome !== null) {
    const check: CompletionCheck = { label, outcome };
    if (detail !== undefined) check.detail = detail;
    return check;
  }
  if (typeof rawOutcome === "string" && rawOutcome.trim() !== "") {
    const check: CompletionCheck = { label, outcome: "unknown" };
    if (detail !== undefined) check.detail = detail;
    return check;
  }
  return null;
}

/**
 * 게이트 표를 읽는다. 표면 이름과 **최소 한 칸**이 있어야 줄이다: 셀 없는 표면
 * 줄은 아무것도 말하지 않으므로 버린다(빈 띠만 남기지 않는다는 규율).
 */
export function parseCompletionGates(value: unknown): CompletionGateRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CompletionGateRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const surface = readString(entry, "surface");
    if (surface === undefined) continue;
    const rawChecks = entry["checks"];
    if (!Array.isArray(rawChecks)) continue;
    const checks: CompletionCheck[] = [];
    for (const rawCheck of rawChecks) {
      const check = parseCheck(rawCheck);
      if (check !== null) checks.push(check);
    }
    if (checks.length === 0) continue;
    rows.push({ surface, checks });
  }
  return rows;
}

/**
 * 이 메시지가 완료 리포트 카드인가, 그렇다면 무엇을 그리는가.
 *
 * `agentCardModel` 의 기본(턴) 갈래가 `turnCard` 보다 **먼저** 이 함수를 부른다.
 * 요약도 불릿도 표도 없는 봉투는 `kind` 표식뿐이지 카드가 아니므로 `null` 이고,
 * 그때 호출부는 평범한 턴 카드로 떨어진다.
 */
export function completionReportCard(props: Props): CompletionReportCard | null {
  if (!props || props["kind"] !== COMPLETION_REPORT_KIND) return null;
  const summary = readString(props, "summary");
  const allActions = parseCompletionActions(props["actions"]);
  const allGates = parseCompletionGates(props["gates"]);
  // 내용이 하나도 없으면 카드가 아니다. `kind` 만 실린 봉투는 평범한 턴이 처리한다.
  if (
    summary === undefined &&
    allActions.length === 0 &&
    allGates.length === 0
  ) {
    return null;
  }

  // 상한 (M3). 자르되 개수를 남긴다. `outcome` 은 **자르기 전 전체**로 잰다 —
  // 상한에 걸려 그리지 않은 꼬리에 실패가 있어도 머리 칩이 「완료」로 거짓말하지
  // 않게 하기 위해서다.
  const actions = allActions.slice(0, MAX_COMPLETION_ACTIONS);
  let omittedChecks = 0;
  const gates = allGates.slice(0, MAX_COMPLETION_GATE_ROWS).map((row) => {
    if (row.checks.length <= MAX_COMPLETION_CHECKS_PER_ROW) return row;
    omittedChecks += row.checks.length - MAX_COMPLETION_CHECKS_PER_ROW;
    return {
      ...row,
      checks: row.checks.slice(0, MAX_COMPLETION_CHECKS_PER_ROW),
    };
  });
  const omitted: CompletionOmitted = {
    actions: allActions.length - actions.length,
    gates: allGates.length - gates.length,
    checks: omittedChecks,
  };

  const card: CompletionReportCard = {
    kind: "completion_report",
    title: readString(props, "title") ?? COMPLETION_REPORT_TITLE,
    actions,
    gates,
    outcome: completionOutcome(allGates),
    omitted,
    detail: payloadDetail(props),
  };
  if (summary !== undefined) card.summary = summary;
  const elapsedMs = readMs(props, "elapsed_ms");
  // 음수 경과는 시계가 어긋난 봉투다. 「12초」 대신 아무것도 그리지 않는다.
  if (elapsedMs !== undefined && elapsedMs >= 0) card.elapsedMs = elapsedMs;
  return card;
}
