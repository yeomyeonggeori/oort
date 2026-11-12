// =============================================================================
// 도우미가 Hermes에 맡겨 끝낸 답의 화면 모델 (ADR-0201 증보 v4 P8·P15-A15, 화면 #5375 = P14-S7).
//
// 와이어는 `teamAiDelegation.ts`(칩 칸)와 `lib/api.ts`의 `AgentRunSpent`(run이 쓴 양)가 읽는다. 여기는 그 두 사실을
// **화면이 그릴 모양**으로만 바꾼다. 새 판정은 없다:
//   - 칩·그림 자리·쓴 양 줄은 모두 **서버 소유 칩 칸**(`team_ai_delegated`, 사람·웹훅이 보내면 서버가 벗긴다)이 있는
//     에이전트의 도우미 답에서만 선다(`teamAiDelegationsFor`). 칩이 없으면 아무것도 새로 보이지 않는다(운영 꺼짐·묶음
//     꺼짐·맡기지 않은 답·맡겼다 실패한 답).
//   - 쓴 양의 숫자는 run의 `spent` 그대로다. 크레딧 토큰은 도우미 행만의 합(프롬프트 + 답)이고, Hermes 횟수는
//     `spent.delegations` 그대로다(P7: 두 출처를 섞지 않는다). 금액은 말하지 않는다(단가 계산은 이 줄의 몫이 아니다).
//   - 어림(`estimated`)이면 그렇다고 말한다(ADR-0147 D3).
//
// 이 파일에는 사용자 문구가 없다. 문구는 사전 `teamAi.delegation.*`에 있다.
// =============================================================================

import type { AgentRunProgress, AgentRunSpent, Message } from "../../lib/api";
import type { AuthorKind } from "./serverResultAuthor";
import {
  teamAiDelegationsFor,
  type TeamAiDelegation,
  type TeamAiDelegationKind,
} from "./teamAiDelegation";

/**
 * 토큰 수를 짧게: 999 → 「999」, 12,345 → 「12.3k」, 1,234,567 → 「1.2M」. 언어와 상관없이 같은 모양이다(증보 v4 P8의
 * 「크레딧 토큰 12.3k」). 소수 한 자리는 버림이다 — 올림하면 쓴 양을 부풀린다. 음수·소수·무한은 0으로 읽는다.
 */
export function compactTokenText(count: number): string {
  const value = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (value < 1_000) return String(value);
  const [unit, divisor] = value < 1_000_000 ? ["k", 1_000] : ["M", 1_000_000];
  const tenths = Math.floor((value * 10) / divisor);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? `${whole}${unit}` : `${whole}.${fraction}${unit}`;
}

/** 쓴 양 줄에 들어갈 사실. */
export interface TeamAiSpentLine {
  /** 크레딧 토큰(도우미 행만, 프롬프트 + 답)의 짧은 글자. */
  tokens: string;
  /** 토큰 일부가 oort의 어림이다. 그러면 「약 …(일부는 어림)」 문구를 쓴다. */
  estimated: boolean;
  /** 이 run이 Hermes에 맡긴 횟수(`spent.delegations` 그대로). 0이면 Hermes 조각을 그리지 않는다. */
  delegations: number;
}

/** run의 `spent`를 줄의 사실로. `spent`가 없으면(옛 서버·목록 밖으로 밀린 run) `null` — 숫자를 지어내지 않는다. */
export function teamAiSpentLineOf(spent: AgentRunSpent | undefined): TeamAiSpentLine | null {
  if (spent === undefined) return null;
  return {
    tokens: compactTokenText(spent.promptTokens + spent.completionTokens),
    estimated: spent.estimated,
    delegations: spent.delegations,
  };
}

/**
 * 줄의 자리를 미리 잡는 데 쓰는 **가장 넓은** 사실. 쓴 양은 답이 뜬 뒤 진행 읽기로 오므로, 그 줄이 늦게 서며 행 높이를
 * 바꾸지 않게 화면은 이 값으로 그린 보이지 않는 글을 같은 칸에 둔다(줄바꿈까지 같은 자리). 「888.8k」는 짧은 토큰
 * 글자 중 가장 넓은 모양이고(숫자는 고정폭으로 그린다), 횟수 한 자리·어림 문구가 가장 긴 갈래다.
 */
export const TEAM_AI_SPENT_LINE_SIZER: TeamAiSpentLine = Object.freeze({
  tokens: "888.8k",
  estimated: true,
  delegations: 8,
});

/** 도우미 답의 「Hermes 도움」 묶음: 칩과, 쓴 양을 읽을 run id. 칩이 없으면 `null`. */
export interface TeamAiDelegatedAnswer {
  delegations: TeamAiDelegation[];
  /** 답 `props.run_id`(서버가 `team_ai_finish`에서 늘 싣는다). 없으면 쓴 양 줄은 서지 않는다. */
  runId: string | null;
  /** 맡긴 일 중에 그림이 있다: 답의 첨부 그림 자리를 미리 잡는다. */
  picture: boolean;
}

/**
 * 행이 부르는 입구. 서버 소유 칩 칸이 있는 에이전트의 도우미 답만 묶음을 낸다(`teamAiDelegationsFor`의 닫힌 세계:
 * `source === "team_ai"` · 작성자 종류가 에이전트 · 지워지지 않음).
 */
export function teamAiDelegatedAnswerOf(
  message: Pick<Message, "props" | "state">,
  authorKind?: AuthorKind | null
): TeamAiDelegatedAnswer | null {
  const delegations = teamAiDelegationsFor(message, authorKind);
  if (delegations.length === 0) return null;
  const runId = message.props?.["run_id"];
  return {
    delegations,
    runId: typeof runId === "string" && runId !== "" ? runId.toLowerCase() : null,
    picture: delegations.some((item) => item.kind === "image"),
  };
}

// ---- 위임을 기다리는 동안의 진행 줄 (planner 2026-11-10 답 ②) -------------------------------------------
//
// 서버는 위임 걸음의 stage(「위임: {이름} · 그림」)를 걸음을 시작할 때 한 번 쓰고, Hermes를 기다리는 동안에는 원장에 행을
// 쓰지 않는다(`delegate.rs`). 그래서 90초 「N분째 소식 없음」 규칙이 그림 위임(길면 2분)의 한가운데서 stage 글을 지운다.
// 화면은 서버를 다시 판정하지 않고 **서버가 정한 마감**을 알려 준다: 마지막 stage가 위임 걸음의 것이고 그 시각부터 종류별
// 마감 안이면 stage 글을 그대로 두고 「그림은 2분까지 걸릴 수 있어요」를 붙인다. 마감을 넘기면 원래 규칙으로 돌아간다.

/**
 * Hermes 호출 마감(ADR-0201 증보 v4 P4 「그림 120초 / 검색 60초」, v4.2 `WorkerConfig::hermes_deadlines`의 기본값).
 * 서버 값을 화면이 읽을 길은 없다 — 증보가 바뀌면 이 표를 함께 고친다.
 */
export const TEAM_AI_DELEGATION_DEADLINE_MS = {
  image: 120_000,
  web_search: 60_000,
} as const satisfies Record<TeamAiDelegationKind, number>;

/** 마감을 알리는 한 줄의 사전 키(`{minutes}` = 마감의 분). */
export const TEAM_AI_DELEGATION_WAIT_COPY = {
  image: "teamAi.delegation.waitImage",
  web_search: "teamAi.delegation.waitSearch",
} as const satisfies Record<TeamAiDelegationKind, string>;

/**
 * 좁은 자리(스레드 패널 320·폭 390)의 짧은 안내(`{minutes}` = 마감의 분, #5375 수리 1회차). 긴 문장은 그 폭에서 이름까지 밀어내
 * 줄임표 하나만 남기므로, 그 폭에서는 같은 사실(종류·마감)을 짧게 말한다.
 */
export const TEAM_AI_DELEGATION_WAIT_SHORT_COPY = {
  image: "teamAi.delegation.waitImageShort",
  web_search: "teamAi.delegation.waitSearchShort",
} as const satisfies Record<TeamAiDelegationKind, string>;

/**
 * 서버가 닫힌 낱말로 조립하는 위임 stage(`momo_agent::team_ai_task::delegation_stage_label`, 받기 전 갈래):
 * 「위임: {이름} · 그림」 / 「위임: {이름} · 검색」. 받은 뒤의 「위임 결과 수신: …」과 규칙이 거절해 쓰인 머리 「위임 중」은
 * 기다림이 아니다(종류를 모른다).
 */
const DELEGATION_STAGE = /^위임: .+ · (그림|검색)$/u;

/** 위임을 기다리는 중이라는 화면 사실: 종류와 그 마감 시각. */
export interface TeamAiDelegationWait {
  kind: TeamAiDelegationKind;
  /** stage 시각 + 종류별 마감. 이 시각이 지나면 기다림이 아니다. */
  untilMs: number;
  /** 마감의 분(문구의 `{minutes}`). */
  minutes: number;
}

/**
 * 이 run이 지금 Hermes를 기다리는 중인가(마감 안). 도우미 작업 run(서버가 `spent`를 싣는 run — 그 stage는 워커가 닫힌 낱말로
 * 쓴다)의 마지막 stage가 위임 걸음이고, 그 stage 시각(`lastEventAtMs`)부터 종류별 마감 안일 때만 값이 있다. 다른 에이전트가
 * 스스로 쓴 「위임: …」 stage는 작업 run이 아니어서 여기 오지 않는다.
 */
export function teamAiDelegationWait(
  run: Pick<AgentRunProgress, "latestStage" | "lastEventAtMs" | "spent">,
  nowMs: number
): TeamAiDelegationWait | null {
  if (run.spent === undefined || run.lastEventAtMs === undefined) return null;
  const match = DELEGATION_STAGE.exec(run.latestStage?.trim() ?? "");
  if (match === null) return null;
  const kind: TeamAiDelegationKind = match[1] === "그림" ? "image" : "web_search";
  const deadline = TEAM_AI_DELEGATION_DEADLINE_MS[kind];
  const untilMs = run.lastEventAtMs + deadline;
  if (nowMs >= untilMs) return null;
  return { kind, untilMs, minutes: Math.round(deadline / 60_000) };
}
