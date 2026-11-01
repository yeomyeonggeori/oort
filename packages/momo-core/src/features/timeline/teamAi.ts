// =============================================================================
// 팀 AI(「oort 도우미」)가 타임라인에 남기는 두 가지 (ADR-0201, #3836).
//
//   ① 도우미가 올린 승인 카드: `props.proposed_via = {kind:"team_ai", requester_id,
//      requester_name}` (D6-3). 카드는 ADR-0186 승인 카드 그대로이고, 달라지는 것은
//      「누가 제안했고 누가 부탁했는가」 한 줄과, 사유가 AI가 쓴 글이라는 표시뿐이다.
//   ② 도우미가 넘기는 줄: 평범한 텍스트 메시지이고 본문이 서버가 쓴 이유 한 문장이다.
//      `props.kind = "team_ai.delegate.v1"`, `props.reason`, `props.delegate.candidates`
//      (D5). 화면은 그 아래 「○○에게 맡기기」 버튼을 세운다.
//
// 둘 다 **모르면 null** 이다. 이 키를 보내지 않는 서버(#3837 이전)에서는 아무 것도
// 그리지 않고, 승인 카드와 텍스트 줄은 한 글자도 달라지지 않는다. 그것이 기능 감지다.
//
// 순수 모듈이다: DOM·fetch·React 없음. 웹과 폰이 같은 함수를 부른다.
// =============================================================================

import type { Message, RosterMember } from "../../lib/api";
import { memberAliases } from "../routing/helperAliases";
import { attachRecipient } from "../../lib/koreanParticle";

type Props = Record<string, unknown> | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// ---- ① 승인 카드의 제안자 표기 ------------------------------------------------

/** 도우미가 올린 승인 카드의 출처. `kind` 가 `team_ai` 가 아니면 만들지 않는다. */
export interface TeamAiProposal {
  kind: "team_ai";
  /** 부탁한 사람. 없으면 이름만 쓴다. */
  requesterId: string | null;
  /** 서버가 카드에 박은 이름(무해화됨). 디렉터리에서 못 찾을 때만 쓴다. */
  requesterName: string | null;
}

/**
 * `props.proposed_via` 를 읽는다. 닫힌 세계다: `kind` 가 정확히 `team_ai` 일 때만
 * 값이고, 다른 종류(아직 없는 미래의 제안자)는 null 이라 카드에 아무 줄도 서지 않는다.
 * 모르는 출처를 「도우미 제안」으로 부르면 승인자가 잘못된 사실로 판단한다.
 */
export function parseTeamAiProposal(value: unknown): TeamAiProposal | null {
  const raw = record(value);
  if (raw === null || raw["kind"] !== "team_ai") return null;
  return {
    kind: "team_ai",
    requesterId: nonEmpty(raw["requester_id"]),
    requesterName: nonEmpty(raw["requester_name"]),
  };
}

/** 카드 맨 위 사실 줄의 이름표. */
export const TEAM_AI_PROPOSAL_LABEL = "제안";

/**
 * 「도우미 제안 · 요청: 김하늘」. 이름을 모르면 「요청한 사람을 확인하지 못했어요」로
 * 말한다. 이름을 지어내지 않는다.
 */
export function teamAiProposalLine(requesterName: string | null): string {
  return requesterName === null
    ? "도우미 제안 · 요청한 사람을 확인하지 못했어요"
    : `도우미 제안 · 요청: ${requesterName}`;
}

/** D6-3 의 뒷부분. 실행은 도우미가 아니라 승인한 사람의 권한이다. */
export const TEAM_AI_PROPOSAL_AUTHORITY =
  "승인하면 승인한 사람의 권한으로 실행돼요.";

/**
 * 도우미 카드의 사유 줄 이름표. 사유는 모델이 쓴 글이라 「사유」만 쓰면 서버가 확인한
 * 사실처럼 읽힌다. 위의 행(서버가 검증한 값)과 다른 층이라는 것을 이름에서 말한다.
 */
export const TEAM_AI_RATIONALE_LABEL = "도우미가 쓴 사유";

/** 사유 아래 한 줄. 판단의 근거는 사유가 아니라 위의 행이다. */
export const TEAM_AI_RATIONALE_NOTE =
  "AI가 쓴 글이에요. 실제로 바뀌는 내용은 위 칸을 보세요.";

// ---- ② 넘기는 줄과 「○○에게 맡기기」 -------------------------------------------

export const TEAM_AI_DELEGATE_KIND = "team_ai.delegate.v1";

/** 서버 `FallbackReason::as_str` 의 다섯 값. 모르는 값은 `null` 이다. */
export type TeamAiFallbackReason =
  | "out_of_scope"
  | "slow"
  | "over_budget"
  | "could_not_propose"
  | "rate_limited";

const REASON_LABEL: ReadonlyMap<string, string> = new Map([
  ["out_of_scope", "도우미가 바로 하기엔 큰 일"],
  ["slow", "도우미가 제때 답하지 못함"],
  // `props.limit` 가 없는 줄(한도가 하루 하나뿐이던 서버)의 말. 있으면 아래 `OVER_BUDGET_LIMIT_LABEL` 이 고른다.
  ["over_budget", "오늘 도우미 사용량을 다 씀"],
  ["could_not_propose", "승인 카드로 만들지 못함"],
  ["rate_limited", "요청이 너무 잦음"],
]);

/**
 * `over_budget` 줄이 싣는 `props.limit = {source, window}` (서버 `limit_fallback_props`, #4944, ADR-0201 증보 v3 B9).
 * 누구의 한도인지(`team` 관리자 / `operator` 서버 운영자)와 어느 창인지(`day` / `month` / `off` = 운영자의 끔 스위치)가
 * 이 넷으로만 짝지어진다. 「오늘」이라고만 말하면 월 한도와 운영자 끔에는 틀린 말이다.
 */
const OVER_BUDGET_LIMIT_LABEL: ReadonlyMap<string, string> = new Map([
  ["team:day", "오늘 도우미 사용량을 다 씀"],
  ["team:month", "이번 달 도우미 사용량을 다 씀"],
  ["operator:day", "서버 운영자가 정한 오늘 사용량을 다 씀"],
  ["operator:off", "서버 운영자가 도우미를 멈춰 둠"],
]);

/** `limit` 은 있는데 이 클라이언트가 모르는 짝(앞으로 생길 한도): 창을 지어내지 않고 어느 창에도 맞는 말만 한다. */
const OVER_BUDGET_UNKNOWN_LIMIT_LABEL = "도우미 사용량 한도에 닿음";

function overBudgetLabel(limit: unknown): string {
  // 없는 `limit`(옛 서버, null)은 옛 줄이다. 한도가 하루 하나뿐이던 때의 `over_budget` 은 늘 「오늘」이었다.
  if (limit === undefined || limit === null) return REASON_LABEL.get("over_budget") as string;
  const raw = record(limit);
  const source = raw !== null ? raw["source"] : undefined;
  const window = raw !== null ? raw["window"] : undefined;
  if (typeof source !== "string" || typeof window !== "string") return OVER_BUDGET_UNKNOWN_LIMIT_LABEL;
  return OVER_BUDGET_LIMIT_LABEL.get(`${source}:${window}`) ?? OVER_BUDGET_UNKNOWN_LIMIT_LABEL;
}

export interface TeamAiDelegateCandidate {
  memberId: string;
  handle: string;
  displayName: string;
  /** 서버가 정한 멱등 키. 두 번 눌러도 메시지는 하나다(D5, 수용 4). */
  clientMsgId: string;
}

export interface TeamAiDelegate {
  reason: TeamAiFallbackReason | null;
  /** 「넘긴 이유: …」 한 줄. 모르는 이유면 null(줄을 세우지 않는다). */
  reasonLine: string | null;
  /** 도우미 자신(멘션을 지울 대상). */
  teamAiMemberId: string | null;
  /** 이 줄을 받을 사람(요청자). 버튼은 이 사람에게만 선다. */
  requesterId: string | null;
  /** 원래 요청 메시지. 같은 채널이다. */
  sourceMessageId: string | null;
  candidates: TeamAiDelegateCandidate[];
}

/** 버튼 상한. 서버가 다섯까지 보낸다(`delegation_candidates_in_tx` LIMIT 5). */
export const MAX_DELEGATE_CANDIDATES = 5;

function parseCandidate(value: unknown): TeamAiDelegateCandidate | null {
  const raw = record(value);
  if (raw === null) return null;
  const memberId = nonEmpty(raw["member_id"]);
  const handle = nonEmpty(raw["handle"]);
  const clientMsgId = nonEmpty(raw["client_msg_id"]);
  // 멱등 키가 없는 후보는 버튼이 아니다: 두 번 누르면 요청이 둘이 된다.
  if (memberId === null || handle === null || clientMsgId === null) return null;
  return {
    memberId,
    handle,
    displayName: nonEmpty(raw["display_name"]) ?? handle,
    clientMsgId,
  };
}

/** `props.kind === "team_ai.delegate.v1"` 인 줄만 읽는다. 총 파싱, 던지지 않는다. */
export function parseTeamAiDelegate(props: Props): TeamAiDelegate | null {
  if (!props || props["kind"] !== TEAM_AI_DELEGATE_KIND) return null;
  const rawReason = props["reason"];
  const baseLabel =
    typeof rawReason === "string" ? REASON_LABEL.get(rawReason) : undefined;
  // 한도에 닿은 줄은 이유 코드가 같아도 누구의 한도·어느 창인지에 따라 말이 다르다(`props.limit`).
  const reasonLabel =
    baseLabel !== undefined && rawReason === "over_budget"
      ? overBudgetLabel(props["limit"])
      : baseLabel;
  const reason =
    reasonLabel !== undefined ? (rawReason as TeamAiFallbackReason) : null;
  const delegate = record(props["delegate"]);
  const candidates: TeamAiDelegateCandidate[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(delegate?.["candidates"])
    ? (delegate["candidates"] as unknown[])
    : []) {
    const candidate = parseCandidate(value);
    if (candidate === null) continue;
    const key = candidate.memberId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidates.length >= MAX_DELEGATE_CANDIDATES) break;
    candidates.push(candidate);
  }
  return {
    reason,
    reasonLine: reasonLabel !== undefined ? `넘긴 이유: ${reasonLabel}` : null,
    teamAiMemberId: nonEmpty(props["agent_member_id"]),
    requesterId: nonEmpty(props["notice_for_member_id"]),
    sourceMessageId: nonEmpty(delegate?.["source_message_id"]),
    candidates,
  };
}

/**
 * 이 사람에게 버튼을 세우는가. 요청자 본인만이다: 맡기는 메시지는 누른 사람 명의로
 * 나가므로(D5 「요청자 명의」), 다른 사람이 누르면 부탁하지 않은 일을 그 사람 이름으로
 * 시키게 된다. 요청자를 모르는 줄에는 아무에게도 세우지 않는다.
 */
export function canDelegate(
  delegate: TeamAiDelegate,
  viewerMemberId: string | undefined
): boolean {
  if (delegate.candidates.length === 0) return false;
  if (viewerMemberId === undefined || delegate.requesterId === null) {
    return false;
  }
  return delegate.requesterId.toLowerCase() === viewerMemberId.toLowerCase();
}

export function delegateButtonLabel(candidate: TeamAiDelegateCandidate): string {
  return `${attachRecipient(candidate.displayName, "person")} 맡기기`;
}

/** 누른 뒤 버튼 자리에 서는 한 줄. */
export function delegateSentLine(displayName: string): string {
  return `${attachRecipient(displayName, "person")} 맡겼어요. 답은 이 채널에 와요.`;
}

/**
 * 행이 부르는 입구. 지워진 행에는 없다. 클라이언트는 `message.props` 를 스스로 읽지
 * 않고 이 함수만 부른다(폰의 「모델 소비 단일점」 규칙).
 */
export function teamAiDelegateFor(
  message: Pick<Message, "props" | "state">
): TeamAiDelegate | null {
  if (message.state === "deleted") return null;
  return parseTeamAiDelegate(message.props);
}

/** 도우미의 기본 handle (서버 `TEAM_AI_HANDLE`). 디렉터리에서 못 찾을 때의 안전망이다. */
export const TEAM_AI_DEFAULT_HANDLE = "oort-helper";

const HANGUL = /[\uAC00-\uD7A3]/u;

/**
 * 도우미를 부르는 모든 이름: 핸들 + 서버가 등록한 별칭 (ADR-0201 v2 H2). 맡기는 메시지에서
 * 지울 이름들이다. 멤버를 모르면 빈 목록(기본 핸들은 `delegateMessageBody`가 늘 더한다).
 */
export function teamAiCallNames(
  member: Pick<RosterMember, "kind" | "status" | "aliases" | "handle"> | undefined | null
): string[] {
  if (!member) return [];
  return [member.handle, ...memberAliases(member)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 맡기는 메시지의 본문. `@대상 원래 요청` 이다.
 *
 * 원래 요청에 들어 있던 도우미 멘션은 **지운다**. 남겨 두면 이 메시지가 도우미를 다시
 * 불러(D1 ①) 같은 요청에 run이 둘이 되고, D5가 막으려던 「카드 두 장」이 생긴다.
 * 원래 요청을 화면이 들고 있지 않으면 문장을 지어내지 않고, 인용(`replyToId`)이 가리키는
 * 원문을 보라고 말한다.
 */
export function delegateMessageBody({
  targetHandle,
  sourceBody,
  teamAiHandles,
}: {
  targetHandle: string;
  sourceBody: string | null | undefined;
  teamAiHandles: readonly string[];
}): string {
  let text = typeof sourceBody === "string" ? sourceBody : "";
  const handles = new Set(
    [...teamAiHandles, TEAM_AI_DEFAULT_HANDLE]
      .map((handle) => handle.trim())
      .filter((handle) => handle !== "")
  );
  // handle 은 `[a-z0-9_-]` 이다(서버 `is_valid_handle`). 그 밖의 글자(마침표·쉼표·한글)가
  // 경계라서 「@oort-helper.」도 지워지고 「@oort-helper2」는 남는다.
  // 한글 별칭(`오르트`, ADR-0201 v2 H2)은 한글 음절도 이름의 글자다: 서버 경계 규칙
  // (`is_mention_boundary` = 영숫자가 아님)대로 「@오르트에게」는 부른 것이 아니라서 남긴다.
  for (const handle of handles) {
    const word = HANGUL.test(handle)
      ? "A-Za-z0-9_\\-\\uAC00-\\uD7A3"
      : "A-Za-z0-9_-";
    const pattern = new RegExp(
      `(^|[^${word}])@${escapeRegExp(handle)}(?![${word}])`,
      "giu"
    );
    text = text.replace(pattern, "$1");
  }
  text = text.replace(/[ \t]+/g, " ").trim();
  const mention = `@${targetHandle}`;
  if (text === "") return `${mention} 인용한 요청을 맡아 주세요.`;
  return `${mention} ${text}`;
}
