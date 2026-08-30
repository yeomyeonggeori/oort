import {
  ApiError,
  uuidEq,
  type Channel,
  type MembershipRole,
  type RosterMember,
} from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { customStatusAccessibleText } from "../presence/customStatus";

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

/** Wire roles that may carry a display override. Agent is never stored. */
export const ROLE_KEYS = ["owner", "admin", "member", "guest"] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/** Display-only overrides. Missing or empty key = the Korean default. */
export type RoleLabels = Partial<Record<RoleKey, string>>;

export const DEFAULT_ROLE_LABELS: Readonly<Record<RoleKey, string>> = {
  owner: "소유자",
  admin: "관리자",
  member: "멤버",
  guest: "게스트",
};

const EMPTY_ROLE_LABELS: RoleLabels = {};

function trimmedOverride(
  labels: RoleLabels | null | undefined,
  role: RoleKey
): string | undefined {
  const raw = labels?.[role];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/**
 * Workspace role, for humans. Agents carry `member` on the wire like everyone
 * else, and repeating it under the 에이전트 heading would be noise, so an agent
 * row shows its owner attribution instead.
 *
 * `labels` is the workspace identity projection (`roleLabels`). A non-empty
 * override wins; an absent, empty, or whitespace value falls back to the
 * Korean default so a workspace without overrides paints the same pixels.
 * Agent rows stay null even when a `member` override exists: the heading
 * already said 에이전트, and the server does not store an agent label.
 */
export function roleLabel(
  member: RosterMember,
  labels?: RoleLabels | null
): string | null {
  if (member.kind === "agent") return null;
  const role = member.role;
  if (role === undefined) return null;
  return trimmedOverride(labels, role) ?? DEFAULT_ROLE_LABELS[role] ?? null;
}

/**
 * Display name for a role key. Override wins; empty/absent falls back to the
 * Korean default. Unlike `roleLabel`, this does not hide agent rows: a select
 * option is a catalog entry, not a roster heading.
 */
export function roleKeyLabel(
  role: RoleKey,
  labels?: RoleLabels | null
): string {
  return trimmedOverride(labels, role) ?? DEFAULT_ROLE_LABELS[role];
}

/**
 * The only client gates for the workspace-role control: viewer is an operator
 * on the roster projection, the target is a human, and the target is not the
 * viewer. Hierarchy and last-owner stay on the server.
 *
 * 에이전트 역할은 상수 member(ADR-0004) — 서버 게이트는 #1857.
 */
export function canChangeWorkspaceRole(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind">
): boolean {
  if (viewerRole !== "owner" && viewerRole !== "admin") return false;
  if (target.kind !== "human") return false;
  return !uuidEq(viewerMemberId, target.id);
}

/**
 * Identity GET `roleLabels`: object whose keys ⊂ {owner,admin,member,guest}.
 * Missing, null, or a non-object is `{}`. Unknown keys and empty values are
 * dropped so a stale or partial projection cannot invent a label.
 */
export function parseRoleLabels(value: unknown): RoleLabels {
  if (value == null) return EMPTY_ROLE_LABELS;
  if (typeof value !== "object" || Array.isArray(value)) return EMPTY_ROLE_LABELS;
  const out: RoleLabels = {};
  for (const key of ROLE_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    out[key] = trimmed;
  }
  return out;
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

/** What this client knows about the roster, which is not always "it". */
export interface RosterLoadState {
  /**
   * No roster has arrived yet. This is react-query's `isPending`, not
   * `isLoading`: on the very first render a fresh query is pending with
   * fetchStatus `idle`, so `isLoading` is false for one frame, and a surface
   * that branches on it paints "there is nobody here" before it has asked.
   */
  pending: boolean;
  /** The roster request failed. */
  failed: boolean;
}

/**
 * "사람 3 · 에이전트 2" for the header, or null when this client has no roster
 * to count.
 *
 * A count is an assertion about who is in this workspace, and the two moments
 * the client does not know are exactly the two where "사람 0 · 에이전트 0"
 * would be read as the answer: the request is still out, or it failed. Beside a
 * skeleton or a "명부를 불러오지 못했습니다" banner that zero is not a smaller
 * truth, it is a different and false one, and one screen must not say both
 * (design-taste-web §5: an error states what happened, §9: absence is never
 * promoted to a story).
 *
 * The numbers count `groups`, which the search box has already narrowed, so the
 * header counts what is on screen rather than a roster the list is not showing.
 * A roster already in hand keeps counting through a background refetch or a
 * failed refresh: cached content stays readable (P15) and the count beside it
 * is still true.
 */
export function countLabel(
  groups: DirectoryGroups,
  state: RosterLoadState
): string | null {
  if (groups.total === 0 && (state.pending || state.failed)) return null;
  return `사람 ${groups.people.length} · 에이전트 ${groups.agents.length}`;
}

/**
 * The accessible name of a directory row's DM button.
 *
 * `aria-label` REPLACES the subtree, so a label carrying displayName alone is
 * not a shorter name for the row, it is a different one: this workspace holds
 * two members displayed as 김인턴 (a human @intern-kim and an agent
 * @kim-intern), and a screen reader that reads the same sentence for both rows
 * turns the list back into the coin toss the handle exists to settle. So
 * everything the eye gets from the row is in the label as well, in the order it
 * is rendered, and the action comes last.
 *
 * `ownerName` is the human an agent is attributed to, resolved by the caller
 * from the roster, or null when the roster has no row for it.
 */
export function memberRowLabel(
  member: RosterMember,
  ownerName: string | null,
  labels?: RoleLabels | null,
  nowMs: number = Date.now()
): string {
  const parts = [`${member.displayName} @${member.handle}`];
  const role = roleLabel(member, labels);
  if (role) parts.push(role);
  if (member.kind === "agent") {
    // On screen "agent" is the --agent token on the avatar and the name. Colour
    // reaches no screen reader, so here it is a word, followed by the same
    // "{owner} 님이 관리" attribution the row prints (WCAG 2.5.3: the visible
    // text is inside the accessible name).
    parts.push(ownerName ? `에이전트, ${ownerName} 님이 관리` : "에이전트");
  }
  const status = statusLabel(member);
  if (status) parts.push(status);
  const custom = customStatusAccessibleText(member, nowMs);
  if (custom) parts.push(custom);
  return `${parts.join(", ")}, 다이렉트 메시지 열기`;
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

/** One row of the ⌘K 사람 section. */
export interface SwitcherPerson {
  member: RosterMember;
  /** Can Enter open a DM with this person? */
  selectable: boolean;
  /** Why not, in the directory's words ("초대됨"), or null when it can. */
  reason: string | null;
}

/**
 * The 사람 section of the palette, decided by the SAME dmAvailability the
 * directory row uses. Two surfaces offering the same action must not disagree
 * about who it is available for: a name the directory refuses to open a DM with
 * cannot be a name ⌘K offers, or the palette is teaching the person to expect a
 * conversation the server is about to refuse.
 *
 * An inactive member stays visible and unselectable rather than vanishing:
 * disappearing from search would read as "not in this workspace", which is a
 * different and untrue statement. The row says 초대됨/정지됨, exactly as the
 * directory does.
 */
export function switcherPeople(
  members: RosterMember[],
  selfMemberId: string,
  /**
   * Members already listed above as a 다이렉트 메시지 row. That row IS the
   * conversation this section would open, so listing them twice offers one
   * destination under two headings, and the second one costs a POST to learn
   * what the first already knew.
   */
  membersWithDm: string[] = []
): SwitcherPerson[] {
  const rows: SwitcherPerson[] = [];
  for (const member of members) {
    const availability = dmAvailability(member, selfMemberId);
    // Yourself is dropped instead of shown unselectable: the palette lists
    // places to go and you are not one of them. The directory keeps that row
    // because it is the roster, and a roster missing you is wrong.
    if (availability.kind === "self") continue;
    // uuidEq, not ===: these ids come from two different responses (/roster and
    // /dms) and the wire case is not guaranteed to match.
    if (membersWithDm.some((id) => uuidEq(id, member.id))) continue;
    rows.push({
      member,
      selectable: availability.kind === "ready",
      reason: availability.kind === "inactive" ? availability.label : null,
    });
  }
  return rows;
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
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
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

/**
 * What went wrong changing a workspace role. The server is the authority; this
 * only turns 400/403/409 (and transport absence) into a sentence. It does not
 * pre-empt the hierarchy rules.
 */
export function changeWorkspaceRoleErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const wire = error.message;
    if (
      error.status === 409 ||
      wire.includes("at least one owner")
    ) {
      return "마지막 소유자의 역할은 내릴 수 없습니다. 다른 멤버를 소유자로 지정한 뒤 다시 시도하세요.";
    }
    if (wire.includes("cannot manage themselves")) {
      return "자기 자신의 역할은 바꿀 수 없습니다.";
    }
    if (wire.includes("equal or higher")) {
      return "같거나 높은 역할의 멤버는 바꿀 수 없습니다.";
    }
    if (wire.includes("cannot grant admin or owner")) {
      return "관리자는 관리자나 소유자 역할을 부여할 수 없습니다.";
    }
    if (error.status === 403) {
      return "이 워크스페이스에서 역할을 바꿀 권한이 없습니다.";
    }
    if (error.status === 400) {
      return "역할을 바꿀 수 없습니다. 다른 역할을 고른 뒤 다시 시도하세요.";
    }
    if (error.status === 404) {
      return "이 멤버를 명부에서 찾지 못했습니다. 명부를 새로 고친 뒤 다시 시도하세요.";
    }
    if (error.status === 429) {
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    }
  }
  if (error instanceof NetworkError) {
    return `역할을 바꾸지 못했습니다. ${error.message}`;
  }
  return "역할을 바꾸지 못했습니다. 다시 시도하세요.";
}
