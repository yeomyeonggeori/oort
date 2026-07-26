import type { RosterMember } from "@/lib/api";

// =============================================================================
// 이 메시지가 부르는 에이전트가 누구인가 (ADR-0134 D1, 컴포저 1회 오버라이드).
//
// 1회 오버라이드는 "이번 요청"에 붙는 값인데, 한 메시지가 만들어 내는 요청의
// 개수는 그 메시지가 부른 에이전트의 수와 같다. 그래서 오버라이드를 붙일 수
// 있는지는 먼저 이 함수가 답한다. 에이전트가 둘 이상이면 화면은 하나의 모델·
// 강도를 두 요청에 붙이는 대신, 그럴 수 없다고 말한다(§5 오류는 무엇이 왜인지).
//
// 매칭은 사람 이름이 아니라 핸들로만 한다. 이 워크스페이스에는 김인턴이 둘
// (사람 @intern-kim, 에이전트 @kim-intern) 있으므로, 표시 이름으로 고르면
// 사람에게 라우팅을 붙이거나 엉뚱한 에이전트를 고르게 된다.
// =============================================================================

/** 핸들 문자에 쓰이는 글자. 서버 핸들 규칙(소문자/숫자/하이픈)의 상위집합이다. */
const MENTION_PATTERN = /(^|\s)@([A-Za-z0-9_.-]+)/g;

/** 텍스트에 실제로 적힌 @핸들들, 등장 순서대로, 중복 없이. */
export function mentionedHandles(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

/**
 * 이 텍스트가 부르는 활성 에이전트들. 사람 멘션과 존재하지 않는 핸들은 뺀다.
 *
 * 존재하지 않는 핸들을 빼는 이유는 서버도 그것으로 run을 만들지 않기 때문이다.
 * 오타 하나가 "에이전트가 여러 명입니다"로 읽히면, 사람은 자기가 고른 값이
 * 왜 막혔는지 알 수 없다.
 */
export function mentionedAgents(
  text: string,
  members: RosterMember[]
): RosterMember[] {
  const handles = mentionedHandles(text);
  if (handles.length === 0) return [];
  const byHandle = new Map<string, RosterMember>();
  for (const member of members) {
    if (member.kind !== "agent" || member.status !== "active") continue;
    byHandle.set(member.handle.toLowerCase(), member);
  }
  const out: RosterMember[] = [];
  for (const handle of handles) {
    const member = byHandle.get(handle);
    if (member) out.push(member);
  }
  return out;
}

export type MentionRoutingTarget =
  | { kind: "none" }
  | { kind: "one"; agent: RosterMember }
  | { kind: "many"; agents: RosterMember[] };

export function mentionRoutingTarget(
  text: string,
  members: RosterMember[]
): MentionRoutingTarget {
  const agents = mentionedAgents(text, members);
  if (agents.length === 0) return { kind: "none" };
  if (agents.length === 1) return { kind: "one", agent: agents[0] };
  return { kind: "many", agents };
}
