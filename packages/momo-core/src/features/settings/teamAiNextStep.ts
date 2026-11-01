// =============================================================================
// 팀 AI 키를 넣은 뒤의 다음 단계 카드 (ADR-0201 증보 v2 H8, #3893).
//
//   1. 이 키를 팀 AI 기본으로 쓰기 — 기본 AI 표의 「팀 에이전트의 답」 줄(`teamAgent`)이
//      저장된 키로 풀려야 도우미가 모델을 부를 수 있다(ADR-0201 D4).
//   2. 팀 AI(oort 도우미) 켜기 — `PATCH …/settings {team_ai_fast_path: true}`(#3837).
//   3. #채널에서 @oort 불러 보기 — 채널을 열고 작성창에 이름을 채운다. 보내지 않는다.
//
// **카드는 확인된 뒤에만 선다** (`TeamAiSetting` 과 같은 규율). 운영자 가방을 못 읽거나,
// 서버가 스위치를 모르거나, 키 행이 없거나, 이미 켜져 있으면 null 이다. 그래서 옛 서버와
// 구성원 화면에는 카드가 없다.
//
// 별칭 상태(H2-3)는 서버만 쓰는 설정 키 `team_ai_alias_status` 다. S1 이전 서버는 이 키를
// 쓰지 않으므로, 그때 3단계는 `@oort` 가 아니라 도우미 핸들(`@oort-helper`)을 채운다.
// 부르지 못하는 이름을 채우는 버튼은 만들지 않는다.
//
// 순수 모듈이다(DOM·fetch·React 없음).
// =============================================================================

import type { RosterMember } from "../../lib/api";
import { attachParticle } from "../../lib/koreanParticle";
import { aiDefaultFeatureRow } from "../ai/aiHubModel";
import { normalizeAlias, preferredMentionName } from "../routing/helperAliases";
import { TEAM_AI_DEFAULT_HANDLE } from "../timeline/teamAi";
import type { ProviderDefaultAi } from "./defaultAi";
import { TEAM_AI_DEFAULT_NAME, type TeamAiSupport, type TeamAiSwitchState } from "./teamAiSwitch";

export const TEAM_AI_ALIAS_STATUS_KEY = "team_ai_alias_status";

/**
 * 도우미를 처음 켤 때 서버가 심는 기본 별칭 셋(H2-2). 이 순서로 먼저 보인다. 관리자가 이름을
 * 바꾸면 새 이름의 별칭이 이 뒤에 더해지고(B10-3, 최대 4개) 넘으면 오래된 것부터 지워진다.
 */
export const TEAM_AI_ALIASES = ["oort", "오르트", "claude"] as const;

/**
 * 별칭 상태 키의 모양(서버 `member_handle_alias` CHECK와 같다: 소문자·숫자·`_`·`-`·한글, 2~16자).
 * 도우미 표시 이름이 별칭이 못 된 까닭을 싣는 `@name` 키는 이 모양이 아니라서 별칭으로 읽히지 않는다.
 */
const ALIAS_KEY = /^[a-z0-9_\-가-힣]{2,16}$/u;

/**
 * 별칭 하나의 상태. `registered` = 부를 수 있음, `taken` = 실제 멤버의 핸들과 겹쳐 등록하지
 * 않음, `display_name_match` = 등록했지만 같은 표시 이름의 멤버가 있음(경고).
 */
export type TeamAiAliasState = "registered" | "taken" | "display_name_match";

export interface TeamAiAliasStatus {
  alias: string;
  state: TeamAiAliasState;
}

function bagRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const STATES: ReadonlySet<string> = new Set(["registered", "taken", "display_name_match"]);

/**
 * 가방의 `team_ai_alias_status` 를 읽는다. 키가 없으면(S1 이전 서버, 아직 안 켬) null.
 * 알 수 없는 상태 값과 별칭 모양이 아닌 키는 버린다. 순서: 기본 셋(`TEAM_AI_ALIASES`) 먼저,
 * 이름을 바꾸며 더해진 별칭은 그 뒤에 글자 순이다(JSON 객체는 등록 순서를 싣지 못한다).
 */
export function readTeamAiAliasStatus(bag: unknown): TeamAiAliasStatus[] | null {
  const raw = bagRecord(bagRecord(bag)[TEAM_AI_ALIAS_STATUS_KEY]);
  const entries = new Map<string, TeamAiAliasState>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !STATES.has(value)) continue;
    const alias = normalizeAlias(key);
    if (!ALIAS_KEY.test(alias)) continue;
    entries.set(alias, value as TeamAiAliasState);
  }
  if (entries.size === 0) return null;
  const out: TeamAiAliasStatus[] = [];
  for (const alias of TEAM_AI_ALIASES) {
    const state = entries.get(alias);
    if (state !== undefined) {
      out.push({ alias, state });
      entries.delete(alias);
    }
  }
  for (const alias of [...entries.keys()].sort()) {
    out.push({ alias, state: entries.get(alias) as TeamAiAliasState });
  }
  return out.length > 0 ? out : null;
}

/** 현재 표시 이름이 부르는 이름(별칭)이 못 된 까닭(#4966: `@name` 키). 별칭이 만들어졌으면 null. */
export type TeamAiNameStatus = "not_derivable" | "reserved";

const NAME_STATUS_KEY = "@name";

export function readTeamAiNameStatus(bag: unknown): TeamAiNameStatus | null {
  const raw = bagRecord(bagRecord(bag)[TEAM_AI_ALIAS_STATUS_KEY]);
  const value = raw[NAME_STATUS_KEY];
  return value === "not_derivable" || value === "reserved" ? value : null;
}

/** 부를 수 있는 별칭(등록됨 + 이름 겹침 경고). */
export function callableAliases(status: readonly TeamAiAliasStatus[] | null): string[] {
  return (status ?? [])
    .filter((entry) => entry.state !== "taken")
    .map((entry) => entry.alias);
}

const ASCII = /^[a-z0-9_-]+$/;

/**
 * 3단계가 작성창에 채울 이름(`@` 없이). 순서: 가방의 등록된 ASCII 별칭(켠 직후의 사실) →
 * 로스터 별칭(`preferredMentionName`) → 도우미 핸들 → 서버 기본 핸들. 한글 별칭은 멘션
 * 문법이 다시 읽지 못해 채우지 않는다(`helperAliases` 머리말).
 */
export function teamAiSeedName(
  status: readonly TeamAiAliasStatus[] | null,
  helper: RosterMember | null | undefined
): string {
  const fromBag = callableAliases(status).find((alias) => ASCII.test(alias));
  if (fromBag !== undefined) return fromBag;
  if (helper) return preferredMentionName(helper);
  return TEAM_AI_DEFAULT_HANDLE;
}

export function teamAiSeedText(name: string): string {
  return `@${name} `;
}

// ---- 보이는 조건과 단계 --------------------------------------------------------

export type TeamAiNextStepView =
  | { kind: "hidden" }
  | {
      kind: "steps";
      /** 1단계: 기본 AI 「팀 에이전트의 답」 줄이 저장된 키로 풀렸는가. */
      defaultReady: boolean;
      /** 1단계 줄이 저장돼 있지만 키가 바뀌어 안 풀렸는가(문장이 다르다). */
      defaultStale: boolean;
    };

export interface TeamAiNextStepInput {
  /** 운영자 가방을 읽었는가(구성원은 403). */
  bag: unknown;
  /** `readTeamAiSwitch(bag)`. 가방이 없으면 null. */
  state: TeamAiSwitchState | null;
  /** 가방에 키가 없을 때의 물음 결과. */
  support: TeamAiSupport | undefined;
  /** 팀 AI 키 행이 저장돼 있는가(`link.configured`). */
  keySaved: boolean;
  /** 기본 AI 표. 못 읽었으면 null. */
  defaultAi: ProviderDefaultAi | null | undefined;
}

export function teamAiNextStepView(input: TeamAiNextStepInput): TeamAiNextStepView {
  const { state, support, keySaved, defaultAi } = input;
  if (state === null || !keySaved) return { kind: "hidden" };
  const supported = state.known || support === "ready";
  if (!supported || state.enabled) return { kind: "hidden" };
  // 기본 AI 표를 못 읽으면(운영자 아님·오류) 1단계 사실을 지어내지 않고 숨긴다.
  if (defaultAi === undefined || defaultAi === null) return { kind: "hidden" };
  const row = defaultAi.teamAgent;
  return {
    kind: "steps",
    defaultReady: row !== null && row.linkResolved,
    defaultStale: row !== null && !row.linkResolved,
  };
}

// ---- 문구 (해요체) ---------------------------------------------------------------

/** 기본 AI 표에 실제로 보이는 줄 이름. 같은 화면에서 한 줄을 두 이름으로 부르지 않게 표에서 읽는다. */
const TEAM_AGENT_ROW = aiDefaultFeatureRow("teamAgent").feature;

export const TEAM_AI_NEXT_STEP_COPY = {
  // 도우미 이름이 든 문구는 멤버의 표시 이름으로 채운다(ADR-0201 증보 v3 B10-7). 이름을 글자로 쓰지 않는다.
  title: (helperName: string) => `다음 단계: 팀 AI(${helperName}) 켜기`,
  lead: (helperName: string) =>
    `켜면 채팅에서 ${attachParticle(helperName, "object")} 불러 이 키로 물어보고, 바꿀 일은 승인 카드로 받을 수 있어요.`,
  step1Title: "이 키를 팀 AI 기본으로 쓰기",
  step1Done: `기본 AI의 「${TEAM_AGENT_ROW}」 줄이 이 키를 써요.`,
  step1Todo: `아래 기본 AI 표의 「${TEAM_AGENT_ROW}」 줄에서 이 키를 골라 주세요. 고를 모델이 안 보이면 위 키 줄에서 「연결 확인」을 먼저 눌러 주세요.`,
  step1Stale: `「${TEAM_AGENT_ROW}」 줄이 예전 연결을 가리켜요. 아래 표에서 이 키로 다시 골라 주세요.`,
  step1Action: "기본 AI 표로 가기",
  step2Title: (helperName: string) => `팀 AI(${helperName}) 켜기`,
  step2Action: (helperName: string) => `${helperName} 켜기`,
  step2Busy: "도우미 켜는 중",
  step2Blocked: "1단계를 마치면 켤 수 있어요.",
  step3Title: "채널에서 불러 보기",
  enabled: (helperName: string) => `${attachParticle(helperName, "object")} 켰어요.`,
  channelLabel: "불러 볼 채널",
  noChannel: "들어가 있는 채널이 없어요. 채널을 만든 뒤 불러 보세요.",
  capLine: "하루 사용량에는 상한이 있어요. 다 쓰면 다음 날 다시 쓸 수 있어요.",
  sendsTitle: "모델에 보내는 것",
  sendsLine:
    "부른 사람의 메시지, 채널·멤버 이름, 그리고 답에 필요할 때 부른 사람이 볼 수 있는 범위 안에서 찾아본 내용이에요. 바꾸는 일은 승인 카드를 거쳐요.",
  offline: "연결이 끊겨 지금은 켤 수 없어요.",
  stepDone: "완료",
} as const;

/** 「#일반에서 @oort 불러 보기」. 채널 이름을 모르면 「채널에서」. */
export function teamAiTryLabel(channelName: string | null, name: string): string {
  const where = channelName ? `#${channelName}에서` : "채널에서";
  return `${where} @${name} 불러 보기`;
}

/** 등록된 별칭 줄. 없으면 null. */
export function teamAiCallableLine(status: readonly TeamAiAliasStatus[] | null): string | null {
  const names = callableAliases(status);
  if (names.length === 0) return null;
  return `부르는 이름: ${names.map((alias) => `@${alias}`).join(" · ")}`;
}

/**
 * 연결하지 않은 별칭과 이름이 겹치는 별칭의 문장들. `holderName` 은 그 핸들을 쓰는 멤버의
 * 표시 이름(디렉터리), 모르면 null.
 */
export function teamAiAliasNotices(
  status: readonly TeamAiAliasStatus[] | null,
  holderName: (alias: string) => string | null,
  helperName: string = TEAM_AI_DEFAULT_NAME
): string[] {
  const out: string[] = [];
  for (const entry of status ?? []) {
    if (entry.state === "taken") {
      const holder = holderName(entry.alias);
      out.push(
        holder === null
          ? `@${attachParticle(entry.alias, "topic")} 이미 다른 멤버가 쓰고 있어서 연결하지 않았어요.`
          : `@${attachParticle(entry.alias, "topic")} 이미 ${attachParticle(holder, "subject")} 쓰고 있어서 연결하지 않았어요.`
      );
    } else if (entry.state === "display_name_match") {
      out.push(
        `표시 이름이 「${entry.alias}」인 멤버가 있어요. @${attachParticle(entry.alias, "topic")} ${attachParticle(helperName, "object")} 불러요.`
      );
    }
  }
  return out;
}
