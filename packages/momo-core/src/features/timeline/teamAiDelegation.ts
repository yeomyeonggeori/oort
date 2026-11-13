// =============================================================================
// 도우미 답의 「Hermes 도움」 칩을 읽는 와이어 (ADR-0201 증보 v4 P8·P15-A15, 서버 #5370·#5372 / 코어 #5374).
//
// 서버 쪽 사실:
//   - 도우미가 팀 Hermes에 맡겨(`ask_hermes`) 끝까지 해낸 답(위임이 `done`)의 `props`에 서버가 한 칸을 더한다:
//       team_ai_delegated: [{ kind: "image" | "web_search", agent_member_id: <Hermes 멤버 id> }]
//     같은 답에는 늘 `source: "team_ai"`와 `run_id`가 있다(`team_ai_finish`). 실패·시간 초과로 끝난 답에는 없다.
//   - **서버 소유 키다.** 사람이나 웹훅이 같은 키를 보내면 서버가 벗긴다(`is_server_owned_props_key`). 그래서
//     칩은 이 키에서만 그린다 — 본문 글이나 다른 칸에서 짐작하지 않는다(A15).
//   - 칩에 보이는 이름은 그 Hermes 멤버의 **지금** 표시 이름이다(P1, B10-7: 이름을 글자로 박지 않는다). 그래서
//     이 모듈은 멤버 id만 돌려주고, 화면이 멤버 목록으로 이름을 찾아 사전 키(`teamAi.delegation.chip*`)에 넣는다.
//
// 이 모듈에는 사용자 문구가 없다. 읽기는 총 함수다: 모양이 다르면 그 항목을 버리고 던지지 않는다.
// 닫힌 세계: `source === "team_ai"`인 메시지에서만, 아는 종류(`image`·`web_search`)와 UUID 모양의 id만 읽는다.
// =============================================================================

import type { Message } from "../../lib/api";
import { isAgentAuthored, type AuthorKind } from "./serverResultAuthor";

/** 서버가 답에 다는 칩 칸의 키(`momo_agent::team_ai_task::DELEGATED_PROPS_KEY`). */
export const TEAM_AI_DELEGATED_PROPS_KEY = "team_ai_delegated";

/** 맡긴 일의 종류(P1의 닫힌 열거, `ask_hermes`의 `kind`). */
export const TEAM_AI_DELEGATION_KINDS = ["image", "web_search"] as const;

export type TeamAiDelegationKind = (typeof TEAM_AI_DELEGATION_KINDS)[number];

/** 칩 하나: 무엇을 누구에게 맡겼는가. */
export interface TeamAiDelegation {
  kind: TeamAiDelegationKind;
  /** 맡은 Hermes 멤버의 id(소문자). 화면이 지금 표시 이름을 찾는 열쇠다. */
  agentMemberId: string;
}

/**
 * 한 답이 실을 수 있는 칩의 상한. 서버는 지금 한 요청에 한 번만 맡긴다(P2-R R10). 「작업당 ≤3」(P18 열어 두는 것)이
 * 오더라도 칩 줄이 끝없이 늘지 않게 막는다.
 */
export const MAX_TEAM_AI_DELEGATIONS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: ReadonlySet<string> = new Set(TEAM_AI_DELEGATION_KINDS);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 답 `props`에서 「Hermes 도움」 칩을 읽는다. 칩이 없으면 빈 배열이다(옛 서버, 맡기지 않은 답, 위임이 실패한 답,
 * 도우미가 아닌 메시지). 같은 종류·같은 Hermes는 한 번만, 서버가 쓴 순서대로, 많아야 `MAX_TEAM_AI_DELEGATIONS`개.
 *
 * `authorKind` 는 멤버 목록의 작성자 종류다. 칩은 **에이전트가 쓴 도우미 답에만** 선다(#5577,
 * `serverResultAuthor.ts`): 모르면 빈 배열이다.
 */
export function teamAiDelegationsOf(
  props: Record<string, unknown> | undefined,
  authorKind?: AuthorKind | null
): TeamAiDelegation[] {
  if (!isAgentAuthored(authorKind)) return [];
  if (!props || props["source"] !== "team_ai") return [];
  const raw = props[TEAM_AI_DELEGATED_PROPS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: TeamAiDelegation[] = [];
  const seen = new Set<string>();
  for (const value of raw as unknown[]) {
    const item = record(value);
    if (item === null) continue;
    const kind = item["kind"];
    const agent = item["agent_member_id"];
    if (typeof kind !== "string" || !KINDS.has(kind)) continue;
    if (typeof agent !== "string" || !UUID.test(agent)) continue;
    const agentMemberId = agent.toLowerCase();
    const key = `${kind}:${agentMemberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: kind as TeamAiDelegationKind, agentMemberId });
    if (out.length >= MAX_TEAM_AI_DELEGATIONS) break;
  }
  return out;
}

/** 행이 부르는 입구. 지워진 메시지에는 칩이 없다. */
export function teamAiDelegationsFor(
  message: Pick<Message, "props" | "state">,
  authorKind?: AuthorKind | null
): TeamAiDelegation[] {
  if (message.state === "deleted") return [];
  return teamAiDelegationsOf(message.props, authorKind);
}
