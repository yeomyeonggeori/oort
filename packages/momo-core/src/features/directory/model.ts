import {
  ApiError,
  uuidEq,
  type Channel,
  type MembershipRole,
  type RosterMember,
} from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { customStatusAccessibleText } from "../presence/customStatus";
import { humanPresenceDot } from "../presence/statusDot";

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

const ALL_ROLES: readonly RoleKey[] = ROLE_KEYS;
const ADMIN_GRANTABLE: readonly RoleKey[] = ["member", "guest"];
const NO_ROLES: readonly RoleKey[] = [];

/**
 * 멤버 프로필의 역할 고르개에 내밀 역할 (#5780). 서버 사다리의 **UX 거울**이고 권위는 서버다:
 * `membership_lifecycle.rs` 의 `require_can_manage`(자기 자신 금지 → `can_change_role_of` →
 * `can_grant_role`)와 `workspace_authorization.rs` 의 서열표가 같은 문장을 판정한다. 틀리면 서버가
 * 403·409로 거절하므로, 이 함수는 「늘 거절될 선택지를 안 내미는 것」만 맡는다.
 *
 * - 보는 사람은 소유자나 관리자이고, 대상은 **사람**이고, 자기 자신이 아니다(에이전트 역할은 상수 member, ADR-0004).
 * - 소유자는 소유자가 아닌 사람에게 네 역할 모두(소유자 승격 포함). 소유자끼리는 서로 못 바꾼다.
 * - 관리자는 멤버·게스트에게 멤버·게스트만. 관리자·소유자는 못 바꾸고, 관리자·소유자로 올리지도 못한다.
 *
 * 역할을 모르는 대상(명부 투영이 `role` 을 못 실은 옛 서버)은 소유자에게만 열린다 — `canIssuePasswordReset`
 * 과 같은 규칙이다. 관리자는 대상이 멤버·게스트라고 **알 때만** 연다. 모름이 열림이 되지 않게 한다.
 * 마지막 소유자(409)는 서버가 지킨다: 대상이 소유자면 애초에 여기서 비어 있다.
 */
export function assignableWorkspaceRoles(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role">
): readonly RoleKey[] {
  if (viewerRole !== "owner" && viewerRole !== "admin") return NO_ROLES;
  if (target.kind !== "human") return NO_ROLES;
  if (uuidEq(viewerMemberId, target.id)) return NO_ROLES;
  if (viewerRole === "owner") return target.role === "owner" ? NO_ROLES : ALL_ROLES;
  return target.role === "member" || target.role === "guest" ? ADMIN_GRANTABLE : NO_ROLES;
}

/**
 * 역할 고르개를 그릴지: 줄 수 있는 역할이 하나라도 있으면. `assignableWorkspaceRoles` 의 짧은 말이다.
 */
export function canChangeWorkspaceRole(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role">
): boolean {
  return assignableWorkspaceRoles(viewerRole, viewerMemberId, target).length > 0;
}

const ROLE_RANK: Readonly<Record<RoleKey, number>> = { owner: 0, admin: 1, member: 2, guest: 3 };

/**
 * 멤버를 정지하거나 워크스페이스에서 내보낼 수 있는 대상인가 (#5781). `canChangeWorkspaceRole` 과 같은 모양의 서버
 * 사다리 **UX 거울**이고 권위는 서버다: `membership_lifecycle.rs` 의 `require_can_manage`(자기 자신 금지 →
 * `can_suspend` && `can_remove`)와 `workspace_authorization.rs` 의 서열표가 같은 문장을 판정한다.
 *
 * - 보는 사람은 소유자나 관리자이고, 대상은 **사람**이고, 자기 자신이 아니다.
 * - 대상의 역할이 보는 사람보다 **엄격히 낮다**: 소유자 → 관리자·멤버·게스트, 관리자 → 멤버·게스트. 소유자끼리·관리자끼리는 안 된다.
 * - 마지막 소유자 보호(409)는 이 거울에서 저절로 지켜진다: 소유자는 누구의 대상도 되지 않는다.
 * - 역할을 모르는 대상은 열지 않는다(모름이 열림이 되지 않게). 되돌리기 어려운 일이라 역할 고르개보다 좁다.
 *
 * 에이전트는 열지 않는다: 에이전트를 끄고 거두는 일은 에이전트 관리의 길을 따르고, 프로필의 관리 묶음 자체가 사람에게만
 * 선다(`canSeeMemberManagement`).
 */
export function canManageWorkspaceMembership(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role">
): boolean {
  if (viewerRole !== "owner" && viewerRole !== "admin") return false;
  if (target.kind !== "human") return false;
  if (uuidEq(viewerMemberId, target.id)) return false;
  if (target.role === undefined) return false;
  return ROLE_RANK[target.role] > ROLE_RANK[viewerRole];
}

/** 정지 줄이 무엇을 하는가: 활성이면 정지, 정지된 멤버면 정지 풀기(서버 `StatusTransition` 의 기대 상태와 같다). */
export type SuspensionAction = "suspend" | "reinstate";

/**
 * 프로필 관리 묶음의 정지 줄 (#5781). 서열은 `canManageWorkspaceMembership`, 상태는 서버의 기대 상태(정지 = 활성만,
 * 풀기 = 정지된 멤버만, 그 밖은 409)를 따른다. 초대 대기·삭제된 멤버에게는 줄이 없다.
 */
export function suspensionAction(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role" | "status">
): SuspensionAction | null {
  if (!canManageWorkspaceMembership(viewerRole, viewerMemberId, target)) return null;
  if (target.status === "active") return "suspend";
  if (target.status === "suspended") return "reinstate";
  return null;
}

/**
 * 「워크스페이스에서 내보내기」 줄 (#5781). 활성·정지된 멤버에게만 선다: 확인 문장이 말하는 일(채널·DM 에서 빠지고
 * 로그아웃)이 그 둘의 일이다.
 */
export function canRemoveWorkspaceMember(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role" | "status">
): boolean {
  if (!canManageWorkspaceMembership(viewerRole, viewerMemberId, target)) return false;
  return target.status === "active" || target.status === "suspended";
}

/** 정지·풀기·내보내기 중 하나. */
export type MemberLifecycleAction = SuspensionAction | "remove";

/**
 * 정지·풀기·내보내기가 거절된 까닭의 **종류** (#5781). 문장은 사전이 진다(`directory.lifecycle.error*`) — 여기는
 * 서버의 상태 코드와 문장(`MembershipLifecycleError::as_swift_message`)을 종류로만 접는다.
 *
 * 이 길의 409 는 대개 「그사이 상태가 바뀌었다」다(다른 운영자가 먼저 정지했거나 풀었다). 마지막 소유자 409 는 거울이
 * 소유자에게 줄을 세우지 않으므로 오래된 명부에서만 닿는다. 그래서 역할 바꾸기처럼 「409 = 마지막 소유자」로 접지 않고
 * 서버 문장으로 가른다.
 */
export type MemberLifecycleFailure =
  | "notActive"
  | "notSuspended"
  | "lastOwner"
  | "rank"
  | "self"
  | "forbidden"
  | "notFound"
  | "rateLimited"
  | "network"
  | "unknown";

export function memberLifecycleFailure(error: unknown): MemberLifecycleFailure {
  if (error instanceof ApiError) {
    const wire = error.message;
    if (wire.includes("must retain at least one owner")) return "lastOwner";
    if (wire.includes("status must be suspended")) return "notSuspended";
    if (wire.includes("status must be active")) return "notActive";
    if (wire.includes("cannot manage themselves")) return "self";
    if (wire.includes("equal or higher")) return "rank";
    if (error.status === 404) return "notFound";
    if (error.status === 403) return "forbidden";
    if (error.status === 429) return "rateLimited";
    return "unknown";
  }
  if (error instanceof NetworkError) return "network";
  return "unknown";
}

/**
 * 프로필의 「관리」 묶음을 그릴지 (#5780): 보는 사람이 소유자·관리자이고 대상이 자기 아닌 사람이면. 묶음 안에서
 * 역할 줄은 고르개(줄 수 있는 역할이 있을 때) 또는 글 + 잠긴 이유(`workspaceRoleLock`)이고, 비밀번호 줄은
 * `canIssuePasswordReset` 이 따로 정한다. 정지·내보내기 줄(#5781)도 이 묶음에 선다.
 */
export function canSeeMemberManagement(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind">
): boolean {
  if (viewerRole !== "owner" && viewerRole !== "admin") return false;
  if (target.kind !== "human") return false;
  return !uuidEq(viewerMemberId, target.id);
}

/**
 * 운영자가 역할을 **글로만** 보게 되는 까닭 (#5780). 「못 고르는 선택지는 이유와 함께 보인다」 규칙의 이 자리 판이다.
 *
 * - `ownerPeer`: 소유자가 다른 소유자를 본다(서버 403 「같거나 높은 역할」).
 * - `adminCeiling`: 관리자가 관리자·소유자를 본다(서버 403).
 * - `null`: 고를 수 있거나, 운영자가 아니거나, 까닭을 말할 근거가 없다(역할을 모름).
 */
export type WorkspaceRoleLock = "ownerPeer" | "adminCeiling";

export function workspaceRoleLock(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "role">
): WorkspaceRoleLock | null {
  if (!canSeeMemberManagement(viewerRole, viewerMemberId, target)) return null;
  if (canChangeWorkspaceRole(viewerRole, viewerMemberId, target)) return null;
  if (viewerRole === "owner") return target.role === "owner" ? "ownerPeer" : null;
  return target.role === "owner" || target.role === "admin" ? "adminCeiling" : null;
}

/**
 * 역할 바꾸기 확인 단계가 무엇을 더 말하는가 (#5780). 낱말은 사전이 진다(`directory.role.*`) — 여기는 종류만.
 *
 * - `promoteOwner`: 소유자로 올린다. 소유자끼리는 서로 못 바꾸므로 **되돌릴 수 없다**(위험 단추).
 * - `grantAdmin`: 관리자로 올린다(채널 만들기·채널 멤버 넣고 빼기가 열린다).
 * - `revokeAdmin`: 관리자에서 멤버·게스트로 내린다(그 둘이 닫힌다).
 * - `plain`: 멤버 ↔ 게스트. 덧붙일 말이 없다.
 *
 * 채널을 만들고 채널에 멤버를 넣고 빼는 일이 워크스페이스 소유자·관리자 몫이라는 것은 서버
 * `routes/channels.rs`(만들기·멤버 추가·내보내기의 `is_admin` 판정)가 정한다.
 */
export type RoleChangeKind = "promoteOwner" | "grantAdmin" | "revokeAdmin" | "plain";

export function roleChangeKind(from: RoleKey | undefined, to: RoleKey): RoleChangeKind {
  if (to === "owner") return "promoteOwner";
  if (to === "admin") return "grantAdmin";
  if (from === "admin" || from === "owner") return "revokeAdmin";
  return "plain";
}

/**
 * 프로필에 보일 이메일 (#5780). 사람에게만 있고, **게스트 시점에서는 보이지 않는다**(owner 2026-11-14 승인:
 * 워크스페이스 멤버 모두에게, 게스트 제외). 보는 사람의 역할을 모르면 보이지 않는다 — 모름이 열림이 되지 않게.
 *
 * 이것은 화면의 가림이다. 서버 명부는 지금 게스트에게도 `email` 을 싣는다(ADR-0219 D3 의 미구현 조각) —
 * 게스트에게서 칸을 빼는 일은 서버가 해야 진짜 경계가 된다.
 */
export function profileEmail(
  viewerRole: MembershipRole | undefined,
  member: Pick<RosterMember, "kind" | "email">
): string | null {
  if (viewerRole === undefined || viewerRole === "guest") return null;
  if (member.kind !== "human") return null;
  const raw: unknown = member.email;
  if (typeof raw !== "string") return null;
  const email = raw.trim();
  return email === "" ? null : email;
}

/**
 * 멤버 프로필의 「재설정 링크 만들기」를 보일지 (ADR-0215 D6, #4603). 서버 사다리의 **UX 거울**이고
 * 권위는 서버다: 같은 문장을 `workspace_authorization.rs`의 `can_issue_password_reset_for`
 * (`password_reset_ladder_matches_adr_0128_d2` 표)와 `owner_claim.rs`가 판정한다. 틀리면 서버가
 * 403·409로 거절하므로, 이 함수는 「늘 거절될 단추를 안 그리는 것」만 맡는다.
 *
 * - 보는 사람은 소유자나 관리자다.
 * - 대상은 **사람**이고 **활성**이다(서버: 사람·활성 멤버만, 정지·초대 대기·삭제는 409).
 * - 자기 자신은 아니다(서버: 자기 자신은 403 — 본인은 설정에서 비밀번호를 바꾼다).
 * - 소유자는 자기 외 누구나(다른 소유자 포함), 관리자는 멤버·게스트만.
 *
 * 역할을 모르는 대상(명부 투영이 `role`을 못 실은 옛 서버)은 소유자에게만 열린다: 관리자는
 * 대상이 멤버·게스트라고 **알 때만** 연다. 모름이 열림이 되지 않게 한다.
 */
export function canIssuePasswordReset(
  viewerRole: MembershipRole | undefined,
  viewerMemberId: string,
  target: Pick<RosterMember, "id" | "kind" | "status" | "role">
): boolean {
  if (viewerRole !== "owner" && viewerRole !== "admin") return false;
  if (target.kind !== "human") return false;
  if (target.status !== "active") return false;
  if (uuidEq(viewerMemberId, target.id)) return false;
  if (viewerRole === "owner") return true;
  return target.role === "member" || target.role === "guest";
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
 * roster of 구민수 / 김인턴 / Hermes reads in the order a Korean team expects
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
  // 사람의 점이 눈에 말하는 것(온라인·오프라인·자리 비움·방해 금지)을 접근 가능한 이름이 이어 말한다. 색과 모양만으로
  // 말하지 않는다(#4692). 에이전트의 생존감은 행의 생존 칩과 그 곁 낱말이 말하므로 여기서 더하지 않는다.
  const presence = member.kind === "human" ? humanPresenceDot(member, nowMs) : null;
  if (presence) parts.push(presence.label);
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
