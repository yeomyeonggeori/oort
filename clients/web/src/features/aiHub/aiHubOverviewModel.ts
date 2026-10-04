import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import type { HostedAgentConnection } from "@momo/core/features/hostedAgents/model";
import type { RosterMember } from "@momo/core/lib/api";
import {
  AI_EXTERNAL_SUBSECTIONS,
  AI_HUB_OVERVIEW_COPY as COPY,
  HARNESS_LABEL,
  aiHubSection,
  classifyAiAgent,
  glossaryEntry,
  teamKeyOperatorOnlyNotice,
  type AiGlossaryId,
  type AiHubSectionId,
} from "@momo/core/features/ai/aiHubModel";

// =============================================================================
// 허브 개요 카드의 상태 문장 (AIH-3, #3393).
//
// 카드는 지금 읽을 수 있는 값만 말한다. 못 읽은 값은 0으로 채우지 않고 못 읽었다고
// 말한다(구독으로 쓰는 에이전트의 「맥 꺼짐」처럼 서버가 아직 안 주는 값은 칩 자체를 만들지
// 않는다). 문구는 전부 코어 `aiHubModel`에서 온다. 이 파일은 조합만 한다.
// =============================================================================

export type ChipTone = "ok" | "warn" | "neutral" | "signal";

export interface HubChip {
  text: string;
  tone: ChipTone;
}

export interface HubCardView {
  id: AiHubSectionId;
  /** 용어집 이름. */
  title: string;
  /** 용어집 한 줄. */
  meaning: string;
  /** 제목 오른쪽의 작은 글자(「나만 써요」, 「4명」). 없으면 null. */
  badge: string | null;
  chips: HubChip[];
  /** 칩으로 못 담는 사실 한 줄(권한, 읽기 실패). */
  note: string | null;
  to: string;
  linkLabel: string;
}

/** 한 번의 읽기 결과. 숫자가 없을 때 이유가 남는다. */
export type Read<T> =
  | { state: "loading" }
  | { state: "denied" }
  | { state: "error" }
  | { state: "ok"; value: T };

const loading = { state: "loading" } as const;
export const READ_LOADING: Read<never> = loading;

function head(id: AiHubSectionId, glossaryId: AiGlossaryId) {
  const section = aiHubSection(id);
  const entry = glossaryEntry(glossaryId);
  return { id, title: entry.term, meaning: entry.meaning, to: section.path };
}

// ---- 내 AI 계정 ---------------------------------------------------------------

export type AccountsInput =
  | { kind: "web" }
  | { kind: "desktop"; probes: readonly LocalHarnessProbe[] | null };

const HARNESS_BY_PROBE = { claude: "claude_code", codex: "codex" } as const;

export function accountsCard(input: AccountsInput): HubCardView {
  const base = {
    ...head("accounts", "myAiAccount"),
    badge: COPY.cardBadge.accounts,
    linkLabel: COPY.openLink.accounts,
  };
  if (input.kind === "web") {
    return { ...base, chips: [{ text: COPY.chip.desktopOnly, tone: "neutral" }], note: null };
  }
  if (input.probes === null) {
    return { ...base, chips: [{ text: COPY.chip.checking, tone: "neutral" }], note: null };
  }
  const chips = input.probes.map((probe): HubChip => {
    const name = HARNESS_LABEL[HARNESS_BY_PROBE[probe.id]];
    if (!probe.installed) return { text: `${name} ${COPY.chip.notInstalled}`, tone: "neutral" };
    if (probe.auth === "logged_in") return { text: `${name} ${COPY.chip.ready}`, tone: "ok" };
    if (probe.auth === "needs_login") return { text: `${name} ${COPY.chip.loginNeeded}`, tone: "warn" };
    return { text: `${name} ${COPY.chip.unknown}`, tone: "neutral" };
  });
  return { ...base, chips, note: null };
}

/** 다음 행동 띠: 설치돼 있는데 로그인이 필요한 줄이 있을 때만. */
export function loginNudge(input: AccountsInput): boolean {
  return (
    input.kind === "desktop" &&
    input.probes !== null &&
    input.probes.some((probe) => probe.installed && probe.auth === "needs_login")
  );
}

// ---- 팀 AI 키 -----------------------------------------------------------------

export interface TeamKeyFacts {
  configured: boolean;
  /** 서버가 말한 와이어 이름(`anthropic` | `openai`). 모르면 null. */
  format: string | null;
}

export function teamKeysCard(read: Read<TeamKeyFacts>): HubCardView {
  const base = {
    ...head("teamKeys", "teamAiKey"),
    badge: COPY.cardBadge.teamKeys,
    linkLabel: COPY.openLink.teamKeys,
  };
  if (read.state === "loading") {
    return { ...base, chips: [{ text: COPY.chip.checking, tone: "neutral" }], note: null };
  }
  if (read.state === "denied") {
    return { ...base, chips: [], note: teamKeyOperatorOnlyNotice() };
  }
  if (read.state === "error") {
    return { ...base, chips: [{ text: COPY.chip.readFailed, tone: "warn" }], note: null };
  }
  if (!read.value.configured) {
    return { ...base, chips: [{ text: COPY.chip.notConnected, tone: "neutral" }], note: null };
  }
  const provider =
    read.value.format === "anthropic"
      ? COPY.providerLabel.anthropic
      : read.value.format === "openai"
        ? COPY.providerLabel.openai
        : null;
  return {
    ...base,
    chips: [{ text: `${provider ? `${provider} ` : ""}${COPY.chip.connected}`, tone: "ok" }],
    note: null,
  };
}

// ---- 에이전트 -----------------------------------------------------------------

export function agentsCard(input: {
  /** 명부를 읽은 결과. 값은 에이전트 멤버만. */
  roster: Read<readonly RosterMember[]>;
  /** 호스티드 연결 목록. 못 읽으면 쓰는 AI를 모른다. */
  connections: Read<readonly HostedAgentConnection[]>;
}): HubCardView {
  const base = { ...head("agents", "agent"), linkLabel: COPY.openLink.agents };
  if (input.roster.state === "loading") {
    return { ...base, badge: null, chips: [{ text: COPY.chip.checking, tone: "neutral" }], note: null };
  }
  if (input.roster.state !== "ok") {
    return { ...base, badge: null, chips: [{ text: COPY.chip.readFailed, tone: "warn" }], note: null };
  }
  const agents = input.roster.value;
  const badge = COPY.count.people(agents.length);
  if (input.connections.state === "loading") {
    return { ...base, badge, chips: [{ text: COPY.chip.checking, tone: "neutral" }], note: null };
  }
  const byAgent = new Map<string, HostedAgentConnection>();
  const connectionsKnown = input.connections.state === "ok";
  if (input.connections.state === "ok") {
    for (const conn of input.connections.value) byAgent.set(conn.agentMemberId.toLowerCase(), conn);
  }
  let onlyMe = 0;
  let everyone = 0;
  let unknown = 0;
  for (const agent of agents) {
    const conn = byAgent.get(agent.id.toLowerCase());
    const c = classifyAiAgent({
      ownerHumanId: agent.ownerHumanId,
      invocationScope: conn?.invocationScope,
      subscriptionHarness: conn?.subscriptionHarness,
      // 목록을 읽었고 연결이 없으면 팀 키, 목록을 못 읽었으면 모른다.
      hostedConnection: connectionsKnown ? conn !== undefined : undefined,
    });
    if (c.callableBy === "owner") onlyMe += 1;
    else if (c.callableBy === "everyone") everyone += 1;
    else unknown += 1;
  }
  const chips: HubChip[] = [];
  if (onlyMe > 0) chips.push({ text: `${COPY.chip.onlyMe} ${onlyMe}`, tone: "signal" });
  if (everyone > 0) chips.push({ text: `${COPY.chip.everyone} ${everyone}`, tone: "neutral" });
  if (unknown > 0) chips.push({ text: `${COPY.chip.kindUnknown} ${unknown}`, tone: "neutral" });
  return { ...base, badge, chips, note: null };
}

// ---- 외부 연결 ----------------------------------------------------------------

export interface ExternalInput {
  apps: Read<number>;
  incoming: Read<number>;
  outgoing: Read<number>;
  externalAgents: Read<number>;
}

const EXTERNAL_KEYS: ReadonlyArray<[keyof ExternalInput, string]> = [
  ["apps", AI_EXTERNAL_SUBSECTIONS.apps],
  ["incoming", AI_EXTERNAL_SUBSECTIONS.incoming],
  ["outgoing", AI_EXTERNAL_SUBSECTIONS.outgoing],
  ["externalAgents", AI_EXTERNAL_SUBSECTIONS.externalAgents],
];

export function externalCard(input: ExternalInput): HubCardView {
  const base = { ...head("external", "externalConnection"), linkLabel: COPY.openLink.external };
  const chips: HubChip[] = EXTERNAL_KEYS.map(([key, name]): HubChip => {
    const read = input[key];
    if (read.state === "ok") return { text: `${name} ${read.value}`, tone: "neutral" };
    if (read.state === "denied") return { text: `${name} ${COPY.chip.operatorOnly}`, tone: "neutral" };
    if (read.state === "error") return { text: `${name} ${COPY.chip.readFailed}`, tone: "warn" };
    return { text: `${name} ${COPY.chip.checking}`, tone: "neutral" };
  });
  const known = EXTERNAL_KEYS.map(([key]) => input[key]).filter(
    (read): read is { state: "ok"; value: number } => read.state === "ok"
  );
  const complete = known.length === EXTERNAL_KEYS.length;
  const badge = complete ? COPY.count.items(known.reduce((sum, read) => sum + read.value, 0)) : null;
  return { ...base, badge, chips, note: null };
}

/**
 * 호스티드 연결 중 「외부 에이전트」로 셀 것: 소유자 전용(내 구독) 연결은 빼고, 이미 끝났거나
 * 정리 중인 연결(만료·정리 대기)도 뺀다.
 */
export function externalAgentCount(connections: readonly HostedAgentConnection[]): number {
  return connections.filter(
    (conn) =>
      (conn.status === "active" || conn.status === "pairing_pending" || conn.status === "detected") &&
      classifyAiAgent({ invocationScope: conn.invocationScope, subscriptionHarness: conn.subscriptionHarness, hostedConnection: true }).brain === "external"
  ).length;
}
