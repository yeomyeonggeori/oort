import {
  ApiError,
  uuidEq,
  type Channel,
  type MembershipRole,
  type RosterMember,
} from "@/lib/api";
import { NetworkError } from "@/lib/http";

// =============================================================================
// 멤버 디렉터리 model (parity G-3/G-4). Everything on this surface that can be
// decided without React lives here, so the row rendering has no branching logic
// of its own and every rule below is under test.
//
// The vocabulary is the one the roster already speaks (useWorkspace/Directory,
// MessageRow, FeedRow): humans and agents are both members, an agent is named
// by its handle and attributed to the human who is accountable for it, and the
// only thing that separates the two is the --agent token. Nothing new is
// invented here.
// =============================================================================

const ROLE_LABEL: Readonly<Record<MembershipRole, string>> = {
  owner: "소유자",
  admin: "관리자",
  member: "멤버",
  guest: "게스트",
};

/**
 * Workspace role, for humans. Agents carry `member` on the wire like everyone
 * else, and repeating it under the 에이전트 heading would be noise, so an agent
 * row shows its owner attribution instead.
 */
export function roleLabel(member: RosterMember): string | null {
  if (member.kind === "agent") return null;
  const role = member.role;
  if (role === undefined) return null;
  return ROLE_LABEL[role] ?? null;
}

/**
 * Membership status, when it is worth saying. `active` is the normal case and
 * is left unlabelled: a chip on every row would carry no information.
 */
export function statusLabel(member: RosterMember): string | null {
  switch (member.status) {
    case "invited":
      return "초대됨";
    case "suspended":
      return "정지됨";
    case "deleted":
      return "삭제됨";
    default:
      return null;
  }
}

/** Search text, normalised once so every comparison below is the same shape. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Name OR handle. The handle is not decoration here: this workspace really has
 * two members displayed as "김인턴" (a human, @intern-kim, and an agent,
 * @kim-intern), and the handle is the only thing that tells them apart.
 */
export function matchesQuery(member: RosterMember, rawQuery: string): boolean {
  // Normalises its own argument: a helper that quietly requires pre-normalised
  // input is a helper that will one day be handed "KIM" and answer no.
  const query = normalizeQuery(rawQuery);
  if (query === "") return true;
  return (
    member.displayName.toLowerCase().includes(query) ||
    member.handle.toLowerCase().includes(query)
  );
}

/**
 * Name order, Korean-aware: `ko` collation puts Hangul ahead of Latin, so a
 * roster of 곽성재 / 김인턴 / Hermes reads in the order a Korean team expects
 * rather than in code-point order. The handle breaks ties between the duplicate
 * display names this workspace really has.
 */
function byName(a: RosterMember, b: RosterMember): number {
  const byDisplay = a.displayName.localeCompare(b.displayName, "ko");
  if (byDisplay !== 0) return byDisplay;
  return a.handle.localeCompare(b.handle, "ko");
}

export interface DirectoryGroups {
  /** Human members matching the query, in name order. */
  people: RosterMember[];
  /** Agent members matching the query, in name order (agents are members). */
  agents: RosterMember[];
  /** Members matching the query, both kinds. */
  matched: number;
  /** Members in the roster, before the query narrowed it. */
  total: number;
}

export function groupDirectory(
  members: RosterMember[],
  rawQuery: string
): DirectoryGroups {
  const query = normalizeQuery(rawQuery);
  const hit = members.filter((m) => matchesQuery(m, query));
  return {
    people: hit.filter((m) => m.kind !== "agent").sort(byName),
    agents: hit.filter((m) => m.kind === "agent").sort(byName),
    matched: hit.length,
    total: members.length,
  };
}

/** "사람 3 · 에이전트 2", the roster's own split, not an invented metric. */
export function countLabel(groups: DirectoryGroups): string {
  return `사람 ${groups.people.length} · 에이전트 ${groups.agents.length}`;
}

/**
 * Is there anyone here but me? A roster of one is not a directory, so that case
 * gets the invite state rather than a list with a single unclickable row.
 */
export function hasOtherMembers(
  members: RosterMember[],
  selfMemberId: string
): boolean {
  return members.some((m) => !uuidEq(m.id, selfMemberId));
}

/**
 * Whether a DM can be opened with this member, and why not when it cannot.
 * The server refuses both of these cases (400 for self, 404 for a member that
 * is not active), so the row says so up front instead of offering an action
 * that is going to fail.
 */
export type DmAvailability =
  | { kind: "self" }
  | { kind: "inactive"; label: string }
  | { kind: "ready" };

export function dmAvailability(
  member: RosterMember,
  selfMemberId: string
): DmAvailability {
  // UUIDs cross the wire in mixed case (Swift upper, PG lower): comparing them
  // with === would show a DM button on your own row half the time.
  if (uuidEq(member.id, selfMemberId)) return { kind: "self" };
  if (member.status !== "active") {
    return { kind: "inactive", label: statusLabel(member) ?? "비활성" };
  }
  return { kind: "ready" };
}

/**
 * Put an opened DM into a cached channel list. Case-insensitive on the id for
 * the same reason as above: an existing DM comes back from the server in
 * whatever case the server writes, and matching it with === would append a
 * duplicate row to the sidebar for a channel that is already there.
 */
export function upsertChannel(channels: Channel[], next: Channel): Channel[] {
  const index = channels.findIndex((c) => uuidEq(c.id, next.id));
  if (index < 0) return [...channels, next];
  const merged = channels.slice();
  merged[index] = next;
  return merged;
}

/**
 * What went wrong opening a DM, in the reader's terms: what happened, then the
 * next step. Never an apology, never "알 수 없는 오류".
 */
export function openDmErrorMessage(error: unknown, name: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return `${name}님은 이 워크스페이스의 활성 멤버가 아닙니다. 명부를 새로 고친 뒤 다시 시도하세요.`;
    }
    if (error.status === 403) {
      return "이 워크스페이스에서 다이렉트 메시지를 열 권한이 없습니다. 워크스페이스 관리자에게 문의하세요.";
    }
    if (error.status === 400) {
      return "자기 자신과는 다이렉트 메시지를 열 수 없습니다.";
    }
    if (error.status === 429) {
      return "요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.";
    }
  }
  if (error instanceof NetworkError) {
    // The transport already writes measured copy for "nothing answered"
    // (timeout vs unreachable, with the deadline in seconds). Reuse it rather
    // than inventing a second vocabulary for the same failure.
    return `${name}님과의 대화를 열지 못했습니다. ${error.message}`;
  }
  return `${name}님과의 다이렉트 메시지를 열지 못했습니다. 다시 시도하세요.`;
}
