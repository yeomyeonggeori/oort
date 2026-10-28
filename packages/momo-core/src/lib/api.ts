// =============================================================================
// REST client for the canonical web UI (ADR-0133 §1; originated in the MOMO-595
// P0 spike against momowebqa).
//
// Contract source of truth: server Routes + docs/api/openapi.yaml, mirrored by
// the ADR-0119 client at f399e417:clients/web-legacy/src/api. Quirks preserved on purpose:
//   - message ordering authority is `seq` (gapless per channel);
//   - `?before=<seq>` reads OLDER history DESCENDING; `?after=<seq>` backfill is
//     ASCENDING (used to heal realtime gaps);
//   - UUID casing crosses the wire mixed (Swift = UPPER, PG JSON = lower):
//     compare case-insensitively (uuidEq);
//   - the realtime WS URL is authoritative from login, never derived.
//
// Token policy (M9): the access token is kept in memory only and the refresh
// token rotates single-use through POST /v1/auth/refresh. Storage, the XSS
// bound and the deferred Tauri keychain path are documented in ./session.ts,
// ported from f399e417:clients/web-legacy/src/api/client.ts.
//
// Base address (P2, MOMO-604): every path below is relative to `apiBase()`,
// read at call time rather than captured at import. Same-origin stays the
// default (empty base = the existing web deployment and dev proxy); the connect
// screen can point this device at another server, and the Tauri shell must.
// =============================================================================

import {
  fetchWithDeadline,
  NetworkError,
  REQUEST_TIMEOUT_MS,
  type HttpResponse,
} from "./http";
import { apiBase, coreSession, type RefreshDeviceProof } from "../runtime/host";
import { parseExecutionPlan, type SpawnExecutionPlan } from "./executionPlan";
import { restoredLoginResponse } from "./sessionModel";
import {
  isUnfurlImagePath,
  messageUnfurlFromWire,
  type MessageUnfurl,
  type WorkspaceUnfurlSettings,
} from "../features/timeline/unfurl";
import {
  presenceWriteBody,
  type PresenceSnapshot,
  type PresenceWrite,
} from "../features/presence/customStatus";
// PresenceSnapshot / PresenceWrite are the GET/PUT shapes of the same surface.
import {
  inboxQueryString,
  isInboxAbsentStatus,
  parseInboxItemRead,
  parseInboxPage,
  parseInboxReadAll,
  type InboxItemReadResult,
  type InboxQuery,
  type InboxReadAllResult,
  type ServerInboxPage,
} from "../features/inbox/serverInbox";
import {
  arrayField,
  bool,
  num,
  record,
  responseRecord,
  str,
  stringArrayField,
  WireShapeError,
} from "./wire";
import {
  parseAgentToolCatalog,
  type AgentToolCatalogEntry,
} from "../features/agents/toolCatalog";
import { normalizeWorkRunInput, type WorkRunDraft } from "../features/agents/workRunRequest";
import { APPROVAL_AVATAR_PREVIEW_PATH } from "../features/approvals/avatarPreview";
import { parseAliases } from "../features/routing/helperAliases";

export type { AgentToolCatalogEntry };

export type { PresenceSnapshot, PresenceWrite } from "../features/presence/customStatus";

export interface Member {
  id: string;
  workspaceId: string;
  kind: "human" | "agent";
  displayName: string;
  handle: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  member: Member;
  realtimeWebSocketUrl: string;
}

/** POST /v1/join: a session plus whether this call created the member row. */
export type JoinResponse = LoginResponse & { createdMember: boolean };

/** Workspace membership role (openapi MembershipRole). Absent on older rows. */
export type MembershipRole = "owner" | "admin" | "member" | "guest";

/**
 * Declared presence status ③ (ADR-0160). The **durable intent**, not the dot on
 * screen: `auto` means "no manual override" and resolves to online/offline by
 * availability, `away`/`dnd` are the two manual overrides. The effective dot is
 * `f(this, availability)`, computed at the render edge and never stored — the
 * wire carries only this intent. Human only; an agent's liveness is its
 * `agent_run`, so its roster row omits the field entirely.
 */
export type PresenceStatus = "auto" | "away" | "dnd";

/** The three labels a client may send, for a runtime membership test. */
export const PRESENCE_STATUSES: readonly PresenceStatus[] = ["auto", "away", "dnd"];

export function isPresenceStatus(value: unknown): value is PresenceStatus {
  return (
    value === "auto" || value === "away" || value === "dnd"
  );
}

/**
 * Roster entry (GET /roster). Superset of `Member`: adds the agent/human split
 * fields the sidebar and timeline need to attribute a message to a real member
 * (display name, handle, owner) instead of a raw uuid prefix.
 */
export interface RosterMember {
  id: string;
  workspaceId: string;
  kind: "human" | "agent";
  status: "active" | "invited" | "suspended" | "deleted";
  displayName: string;
  handle: string;
  avatarUrl?: string;
  /** Workspace role, as the roster projection reports it. */
  role?: MembershipRole;
  channelCount: number;
  channelIds: string[];
  capabilities: string[];
  /** Agents only: the human accountable for this agent (ADR-0131). */
  ownerHumanId?: string;
  agentModel?: string;
  /**
   * AI 허브 읽기 계약(AIH-2, #3392). 에이전트 행에만 실린다. 값은 서버 문자열을 그대로 받고,
   * 해석은 코어 `classifyAiAgent` 가 한다(모르는 값은 부재와 같다). 구서버는 보내지 않는다.
   */
  /** `subscription` | `team_key` | `external` | `personal_key` | `instance_default`. */
  brain?: string;
  /** `owner_only` | `everyone`. */
  callableBy?: string;
  /** 구독으로 쓰는 에이전트의 소유자. 손님에게는 명부에 없는 소유자가 빠진다. */
  owner?: { id: string; displayName: string };
  /** 에이전트 자격이 최근 10분 안에 Agent Port 에 닿았는가(추정). 손님에게는 없다. */
  hostOnline?: boolean;
  /** 이 에이전트의 brain 이 이 서버에서 지금 쓸 수 없는 이유(`claude_subscription_agent_paused`). */
  brainUnavailableReason?: string;
  /**
   * Agents only: is this agent asleep (goal SRV-R2)?
   *
   * ABSENT is a real answer here, not a default waiting to be filled in. The
   * server carries the column only for `kind === "agent"` — `CASE WHEN m.kind =
   * 'agent' THEN COALESCE(ap.paused, false) END` — so a human has no such fact
   * at all, and a server that predates that projection sends it for nobody.
   *
   * Reading a missing field as `false` is exactly how every agent on an older
   * server would be reported awake, which is the lie the server side went out of
   * its way to avoid (its own red proof was a stray `COALESCE` leaking
   * `paused: false` onto humans). Optional here for the same reason, and every
   * consumer goes through `rosterPaused` rather than touching it directly.
   */
  paused?: boolean;
  /**
   * Declared presence status ③ (ADR-0160), human only.
   *
   * ABSENT is a real answer, exactly like `paused`: the server carries the
   * column only for `kind === "human"`, and a server that predates the projection
   * sends it for nobody. So `undefined` means "no declared status to show" — the
   * effective dot then falls back to availability alone — and is never read as a
   * default. Consumers go through `effectivePresence` rather than touching this.
   */
  presenceStatus?: PresenceStatus;
  /**
   * Availability ② (ADR-0160, #4692), human only: does this person have a live
   * connection to the workspace right now? The second input of the dot
   * (`f(presenceStatus, online)`), never stored and never the effective value.
   *
   * **ABSENT is not `false`.** The server omits the key for agents and for every
   * row of a response whose availability it could not establish (no broker
   * credential, broker slow or down), and an older server never sends it. So
   * `undefined` means "unknown": draw no dot. Only `false` means the broker
   * answered and there is no connection. Reading absence as `false` would paint
   * every colleague offline whenever Centrifugo hiccups. Consumers go through
   * `humanPresenceDot` rather than touching this.
   */
  online?: boolean;
  /**
   * ADR-0124 증보 2: when a running DND ends (epoch ms). Present only while
   * `presenceStatus` is `dnd` with an expiry ahead; past it, treat the member
   * as `auto` (the server sends no event at expiry).
   */
  dndUntilMs?: number;
  /**
   * Custom status (ADR-0176), human only. Orthogonal to `presenceStatus`.
   * ABSENT means there is nothing to show (unset, expired on the server, or
   * an older projection). Consumers go through `visibleCustomStatus`.
   */
  statusEmoji?: string;
  statusText?: string;
  statusExpiresAtMs?: number;
  /**
   * Agents only (ADR-0186 증보 v3 V3-2): the agent's one-line intro. Plain
   * text: never auto-link, mention-parse or render markdown in it.
   */
  tagline?: string;
  /** Agents only (V3-2): the agent's own role label, plain text. */
  roleLabel?: string;
  /** Agents only (V3-2a): a server avatar preset id. An uploaded image wins. */
  avatarPreset?: string;
  /**
   * Agents only (ADR-0201 증보 v2 H2): the other names this member answers to,
   * e.g. the team AI's `oort`·`오르트`·`claude`. Only aliases the server actually
   * registered (a real member's handle always wins). Normalised (NFC, lower case)
   * by `parseAliases`; absent on servers that predate the alias table, and every
   * consumer goes through `features/routing/helperAliases`.
   */
  aliases?: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Drop a `paused` that is not a boolean, and keep the row.
 *
 * The field is one optional column on a row that also carries the member's
 * identity, their channels and their role. Refusing the whole row over it — the
 * first cut of goal RN-C1 did exactly that — trades a small lie for a much
 * bigger one: the agent vanishes from the roster, the 에이전트 목록 says
 * 「아직 에이전트가 없습니다」, and the sidebar loses a member who is right there.
 * "Cannot read one column" and "does not exist" are not the same statement.
 *
 * Dropping it lands the row in the arm that already exists for exactly this
 * situation: `paused === undefined` means the list did not carry the fact, and
 * the row reads 상태를 볼 수 없음. What must never happen is `"false"` (a string)
 * surviving as a truthy value on the one screen whose job is to say whether an
 * agent is asleep.
 */
function sanitizeRosterMember(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  let row = value as Record<string, unknown>;
  // A `paused` that is not a boolean drops out (see the doc above), keeping the
  // member on the roster rather than deleting them over one unreadable column.
  if ("paused" in row && typeof row.paused !== "boolean") {
    const { paused: _unreadable, ...rest } = row;
    row = rest;
  }
  // Same treatment for a `presenceStatus` the enum does not name: a status this
  // client cannot render is dropped to `undefined` (no declared status) rather
  // than surfaced as a value the effective-dot logic would then have to guess at.
  if ("presenceStatus" in row && !isPresenceStatus(row.presenceStatus)) {
    const { presenceStatus: _unknown, ...rest } = row;
    row = rest;
  }
  // Availability ② (#4692): only a boolean is a statement. Anything else (a string
  // `"false"`, a number, null) drops the column and so reads as unknown, which is
  // the honest reading of a value this client cannot interpret; it must never
  // survive as a truthy value that draws a green dot.
  if ("online" in row && typeof row.online !== "boolean") {
    const { online: _unreadable, ...rest } = row;
    row = rest;
  }
  // Custom-status columns follow the same drop-the-column rule: a bad value
  // must not delete the member. Empty strings stay and `visibleCustomStatus`
  // treats them as absence.
  if ("statusEmoji" in row && typeof row.statusEmoji !== "string") {
    const { statusEmoji: _bad, ...rest } = row;
    row = rest;
  }
  if ("statusText" in row && typeof row.statusText !== "string") {
    const { statusText: _bad, ...rest } = row;
    row = rest;
  }
  // v3 agent profile text: a non-string drops the column, never the member.
  for (const key of ["tagline", "roleLabel", "avatarPreset"] as const) {
    if (key in row && typeof row[key] !== "string") {
      const { [key]: _bad, ...rest } = row;
      row = rest;
    }
  }
  // Aliases (ADR-0201 v2 H2): keep only the grammar the server writes; an
  // unreadable list drops the column, never the member.
  if ("aliases" in row) {
    const aliases = parseAliases(row.aliases);
    const { aliases: _raw, ...rest } = row;
    row = aliases === null ? rest : { ...rest, aliases };
  }
  if (
    "dndUntilMs" in row &&
    (typeof row.dndUntilMs !== "number" || !Number.isFinite(row.dndUntilMs))
  ) {
    const { dndUntilMs: _bad, ...rest } = row;
    row = rest;
  }
  if (
    "statusExpiresAtMs" in row &&
    (typeof row.statusExpiresAtMs !== "number" ||
      !Number.isFinite(row.statusExpiresAtMs))
  ) {
    const { statusExpiresAtMs: _bad, ...rest } = row;
    row = rest;
  }
  return row;
}

function isRosterMember(value: unknown): value is RosterMember {
  const kind = str(value, "kind");
  const status = str(value, "status");
  const channelIds = arrayField(value, "channelIds");
  const capabilities = arrayField(value, "capabilities");
  return (
    str(value, "id") !== undefined &&
    str(value, "workspaceId") !== undefined &&
    (kind === "human" || kind === "agent") &&
    (status === "active" || status === "invited" || status === "suspended" || status === "deleted") &&
    str(value, "displayName") !== undefined &&
    str(value, "handle") !== undefined &&
    num(value, "channelCount") !== undefined &&
    num(value, "createdAtMs") !== undefined &&
    num(value, "updatedAtMs") !== undefined &&
    channelIds !== null && channelIds.every((id) => typeof id === "string") &&
    capabilities !== null && capabilities.every((capability) => typeof capability === "string")
  );
}

export interface Channel {
  id: string;
  workspaceId: string;
  kind: "public" | "private" | "dm";
  name?: string;
  topic?: string;
  dmKey?: string;
  memberIds?: string[];
  muted: boolean;
  archivedAtMs?: number;
}

/**
 * Read-state projection (ADR-0109 / P7). Unread is SERVER truth, never a local
 * guess: the sidebar renders a count only when this projection supplies one.
 * Wire shape is snake_case here (unlike the camelCase message/channel bodies),
 * so it is normalised on the way in.
 */
export interface ReadState {
  channelId: string;
  lastReadSeq: number;
  latestSeq: number;
  unreadCount: number;
  mentionCount: number;
  /**
   * ADR-0178 D2. Inclusive seq from which this channel is unread. Wire name
   * `marked_unread_before_seq` (always present on a current server, JSON
   * `null` when unmarked). Missing on an older server is treated as unmarked.
   * Do not compose this field here — `effectiveUnreadStartSeq` in
   * `features/readState/model.ts` is the only composition point.
   */
  markedUnreadBeforeSeq: number | null;
  /**
   * ADR-0177 D9 (#4227). The newest seq worth reading (tool calls, system lines and work-session
   * cards do not count; `latestSeq` counts everything). Wire name `latest_readable_seq`.
   *
   * **`undefined` means "this response did not say"**, not zero: an older server, the `PUT
   * read-state` response and the realtime `read_state` frame (ADR-0177 D10: no closure event) all
   * omit it. Only a `GET read-state` row from a server with migration 146 carries it. A merge that
   * replaces a cached row with a response lacking the field must keep the value it already had.
   */
  latestReadableSeq?: number;
  /**
   * ADR-0177 D6/D8 (#4227). The **requesting member's own** DM-closure watermark ("closed having
   * seen up to here"). Wire name `closed_at_seq`. Three distinct states, and the difference between
   * the last two is the point:
   *
   * - `number`: the caller closed this DM at that seq;
   * - `null`: a `GET read-state` row said the caller has NOT closed it (and for every non-DM);
   * - `undefined`: this response did not say (older server, `PUT read-state` response, realtime
   *   frame). Keep what you had — never turn it into `null`, which would reopen a closed DM.
   *
   * Nothing is stored when a DM revives: whether it shows is the comparison of this with
   * `latestReadableSeq` (the shared decision function lands with #4228).
   */
  closedAtSeq?: number | null;
}

/** ADR-0178 D6. Only `"explicit_open"` is sent; absence means background. */
export type ReadIntent = "explicit_open" | "background";

export interface UpdateReadStateOptions {
  /** D5. Set the mark-unread signal to this existing channel seq. */
  markUnreadBeforeSeq?: number;
  /**
   * D6. Send only `"explicit_open"`. Do not send `"background"` — omitting
   * the field is the wire form of background.
   */
  readIntent?: "explicit_open";
}

/** Thread rollup embedded in a message page (snake_case on the wire). */
export interface ThreadRollup {
  replyCount: number;
  lastReplySeq: number;
  lastReplyAtMs: number;
}

/**
 * 인용된 메시지, 서버가 **읽을 때마다** 다시 만들어 페이지에 동봉한 것
 * (ADR-0148 규칙 3, openapi `QuotedMessage`).
 *
 * 사본이 아니라 참조라서 두 성질이 따라온다: 원본이 수정되면 다음 페이지에서 이
 * 값이 따라 바뀌고, 삭제되면 `body` 없이 `state: "deleted"`로 온다. 그래서 클라가
 * 이것을 저장하면 기록이 아니라 **렌더를 캐시**하는 것이다.
 *
 * 저자는 id로만 온다. 다른 모든 행과 같은 규칙이고(이름은 클라가 이미 들고 있는
 * 명부에서 푼다), 인용 한 줄 때문에 rename에 상하는 두 번째 신원 경로를 만들지
 * 않기 위한 것이다.
 */
export interface QuotedMessage {
  id: string;
  seq: number;
  authorMemberId: string;
  type: Message["type"];
  /** tombstone에는 없다. 삭제는 빠진 본문이 나르고, 플래그가 나르지 않는다. */
  body?: string;
  state: "sent" | "edited" | "deleted" | "failed";
  editedAtMs?: number;
  deletedAtMs?: number;
  /** 규칙 4 — 이 원본이 또 무언가를 인용했다. **표시뿐**이고 대상 id는 없다. */
  quotesAnother?: boolean;
  /**
   * 원본의 `props.kind` 하나. 원본의 props에서 **이것 말고는 오지 않는다**(#1510).
   *
   * 카드 메시지는 평범한 행을 탄다 — `type: "text"`, 본문 없음, 카드는 `props`
   * 안(#1454 완료 리포트). 그래서 위의 어느 칸으로도 묘비와 구별되지 않고,
   * 「본문 없는 text는 지워진 것」이라는 판정이 그 카드를 「삭제된 메시지」로
   * 세운다. 그 둘을 가르는 유일한 신호가 이 필드이고, 서버가 실어 주지 않으면
   * 클라가 단독으로 알아낼 방법이 없다.
   *
   * 카드의 **내용**은 오지 않는다: 요약·불릿·게이트 표는 원본의 것이고, 인용은
   * 두 줄을 그린 뒤 원본으로 보내는 표지판이다(미결 2와 같은 답). 묘비에도 없다 —
   * 지워진 행은 props를 그대로 갖고 있지만, 삭제가 남기는 것은 삭제됐다는 사실
   * 하나뿐이어야 한다(규칙 3).
   */
  propsKind?: string;
}

export interface Message {
  id: string;
  channelId: string;
  rootId?: string;
  /**
   * ADR-0148 — 이 메시지가 **가리키는** 메시지의 id. `rootId`(소속)와 독립이고,
   * 한 메시지가 둘 다 가질 수 있다(규칙 1).
   *
   * 모든 투영에 실린다: 전송 응답, 히스토리, 답글, 그리고 실시간 프레임까지.
   * 아래 `replyTo`와 달리 이쪽이 **영속하는 사실**이다.
   */
  replyToId?: string;
  /**
   * 풀린 인용. 히스토리·답글 페이지에만 있고 전송 응답과 `message.new`에는 없다
   * (서버가 그 둘에서 일부러 뺀다 — 쓰기 경로 안에서 읽기를 한 번 더 하지 않기
   * 위해서다). 그래서 실시간으로 온 인용 답글은 이 값이 없고, 클라가 화면에 이미
   * 들고 있는 행에서 푼다 (`features/timeline/quote.ts` resolveQuote).
   *
   * `message.edited` 프레임과 `PATCH` 응답에도 없다(서버: 「the quote id rides along, the
   * rendered quote comes from the next read」). 거기서 없다는 것은 「인용 없음」이 아니라 「말하지
   * 않음」이므로, `reconcileMessages`가 이미 든 행의 풀린 인용을 잇는다(#4450, `keepHeldProjection`).
   */
  replyTo?: QuotedMessage;
  seq: number;
  hlcTs: number;
  hlcCount: number;
  authorMemberId: string;
  type:
    | "text"
    | "tool_call"
    | "tool_result"
    | "diff"
    | "artifact"
    | "approval_request"
    | "system";
  body?: string;
  state?: "sent" | "edited" | "deleted" | "failed";
  props?: Record<string, unknown>;
  createdAtMs: number;
  editedAtMs?: number;
  deletedAtMs?: number;
  /**
   * ADR-0151 — 이 메시지에 묶인 첨부. 완료된 것만, 만들어진 순서로.
   *
   * **편집이 내는 두 투영만 빼고 모든 투영에 실린다**: 전송 응답, 히스토리, 답글,
   * `message.new` 프레임까지(`message_dto` 주석: 실시간 프레임에서만 첨부를 배우는
   * 클라는 새로고침 한 번에 파일 없는 메시지를 그린다). 그래서 `replyTo`와 달리 이
   * 배열은 그 경로들로 들어온 행에는 있고, 거기서 비어 있다는 것은 첨부가 없다는
   * 뜻이다.
   *
   * **예외는 편집이다**(#4441): `PATCH` 응답과 `message.edited` 프레임은 첨부를 싣지
   * 않는다(편집은 묶인 첨부를 바꾸지 못한다). 거기서 없다는 것은 「없음」이 아니라
   * 「말하지 않음」이므로, `reconcileMessages`가 이미 든 행의 첨부를 잇는다. 이 읽기는
   * 서버에 살아 있는 메시지에서 첨부를 떼는 길이 없다는 사실에 서 있다 — 그런 길이
   * 생기면 명시 신호가 필요하다(`keepHeldProjection` 주석).
   *
   * 업로드 capability URL도 Drive file id도 여기 없다. 바이트로 가는 유일한 길은
   * 인가 프록시(`GET …/attachments/{id}/content`)다.
   */
  attachments?: MessageAttachment[];
  /**
   * 2-hop closure: the reply rollup rides the page, no extra round trip.
   *
   * 편집 투영(`message.edited` 프레임·`PATCH` 응답)에는 없다. 거기서 없다는 것은 「답글 없음」이
   * 아니라 「말하지 않음」이므로, `reconcileMessages`가 이미 든 행의 롤업을 잇는다(#4450,
   * `keepHeldProjection`). 서버는 답글마다 `thread.updated` 를 발행하지만 TS 클라는 그것을 소비하지
   * 않는다(폰은 `threadContext` 가 본 답글 수를 따로 세어 렌더에서 합친다). 그래서 `message.thread`
   * 는 페이지 읽기에서만 바뀐다.
   */
  thread?: {
    reply_count: number;
    last_reply_seq: number;
    last_reply_at: number;
  };
  /**
   * #1166 — 이 반쪽 답을 쓴 run 이 **끝났다**고 서버가 말한 것.
   *
   * 페이지 읽기(히스토리·답글)에만, 그리고 `true` 일 때만 실린다. 없다는 것은
   * 세 가지 침묵을 한꺼번에 뜻하므로(스트리밍한 적 없음 · 이미 닫혀서
   * 자기서술적임 · run 이 아직 안 끝남) **없음을 종결로 읽으면 안 된다** —
   * `endedRuns.ts` 가 서 있는 바로 그 규칙이다.
   *
   * 이 값은 화면에 직접 쓰이지 않는다. `features/timeline/streamStop.ts`
   * (`endedStreamRunIds`)가 여기서 run id 를 거두어 호스트의 종결 기록에
   * 심고, 꼬리 판정은 예전처럼 그 기록 하나에 대고 묻는다. 그래야 같은 run 이
   * 쓴 다른 행 — 실시간으로 뒤늦게 도착한 행까지 — 이 같은 답을 받는다.
   */
  runEnded?: boolean;
}

function isMessage(value: unknown): value is Message {
  const type = str(value, "type");
  return (
    str(value, "id") !== undefined &&
    str(value, "channelId") !== undefined &&
    str(value, "authorMemberId") !== undefined &&
    num(value, "seq") !== undefined &&
    num(value, "hlcTs") !== undefined &&
    num(value, "hlcCount") !== undefined &&
    num(value, "createdAtMs") !== undefined &&
    (type === "text" || type === "tool_call" || type === "tool_result" || type === "diff" ||
      type === "artifact" || type === "approval_request" || type === "system")
  );
}

/** Normalised reply rollup, or null when the message has no replies. */
export function threadRollup(message: Message): ThreadRollup | null {
  const raw = message.thread;
  if (!raw || !raw.reply_count) return null;
  return {
    replyCount: raw.reply_count,
    lastReplySeq: raw.last_reply_seq,
    lastReplyAtMs: raw.last_reply_at,
  };
}

export interface MessagePage {
  messages: Message[];
  nextBefore?: number;
}

export interface RealtimeTokenResponse {
  token: string;
  tokenType: string;
  expiresAtMs: number;
  ttlSeconds: number;
  workspaceId: string;
  memberId: string;
}

export class ApiError extends Error {
  readonly status: number;
  /**
   * `error.code` of the envelope when the server named the refusal (openapi
   * `ErrorResponse`: the message may be reworded, the code is not). Absent for
   * every error older than ADR-0188 R0 and for bodies without one.
   */
  readonly code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** UUIDs cross the wire in mixed case by design; always compare this way. */
export function uuidEq(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

// ---- Huddles: channel-bound, temporary LiveKit audio rooms -----------------
// GET  /v1/workspaces/{ws}/channels/{channel}/huddles/active
// POST /v1/workspaces/{ws}/channels/{channel}/huddles
// POST /v1/workspaces/{ws}/huddles/{huddle}/join
// POST /v1/workspaces/{ws}/huddles/{huddle}/leave
//
// The join response is the only authority for the LiveKit address. It must not
// be derived from apiBase(), the page origin, or the realtime URL (ADR-0122 and
// the same address-authority boundary as ADR-0110).

export interface HuddleParticipant {
  memberId: string;
  displayName: string;
  joinedAtMs: number;
}

export interface Huddle {
  id: string;
  workspaceId: string;
  channelId: string;
  startedBy: string;
  startedAtMs: number;
  endedAtMs?: number;
  participants: HuddleParticipant[];
}

export interface JoinedHuddle {
  huddle: Huddle;
  livekitUrl: string;
  token: string;
  expiresAtMs: number;
  ttlSeconds: number;
}

export interface LeftHuddle {
  huddle: Huddle;
  ended: boolean;
}

function huddleParticipantFromWire(value: unknown): HuddleParticipant {
  const memberId = str(value, "memberId");
  const displayName = str(value, "displayName");
  const joinedAtMs = num(value, "joinedAtMs");
  if (
    memberId === undefined ||
    displayName === undefined ||
    joinedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return { memberId, displayName, joinedAtMs };
}

/** Defensive huddle decoder shared by all four REST projections. */
export function huddleFromWire(value: unknown): Huddle {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const channelId = str(source, "channelId");
  const startedBy = str(source, "startedBy");
  const startedAtMs = num(source, "startedAtMs");
  const endedAtMs = num(source, "endedAtMs");
  const participants = arrayField(source, "participants");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    startedBy === undefined ||
    startedAtMs === undefined ||
    participants === null ||
    (source.endedAtMs !== undefined &&
      source.endedAtMs !== null &&
      typeof source.endedAtMs !== "number")
  ) {
    throw new WireShapeError();
  }
  return {
    id,
    workspaceId,
    channelId,
    startedBy,
    startedAtMs,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
    participants: participants.map(huddleParticipantFromWire),
  };
}

function huddleResponse(value: unknown): Huddle {
  const source = responseRecord(value);
  return huddleFromWire(source.huddle);
}

/**
 * GET …/huddles/active envelope. OpenAPI omits `huddle` when idle
 * ("otherwise the optional field is omitted"); older clients sent
 * `huddle: null`. Both mean no active huddle. A present field still
 * has to be a huddle DTO.
 */
export function activeHuddleFromWire(value: unknown): Huddle | null {
  const source = responseRecord(value);
  if (source.huddle == null) return null;
  return huddleFromWire(source.huddle);
}

export async function fetchActiveHuddle(
  workspaceId: string,
  channelId: string
): Promise<Huddle | null> {
  return activeHuddleFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/huddles/active`
    )
  );
}

export async function startHuddle(
  workspaceId: string,
  channelId: string
): Promise<Huddle> {
  const source = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/huddles`,
    { method: "POST", body: "{}" }
  );
  return huddleResponse(source);
}

export async function joinHuddle(
  workspaceId: string,
  huddleId: string
): Promise<JoinedHuddle> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/huddles/${encodeURIComponent(huddleId)}/join`,
      { method: "POST", body: "{}" }
    )
  );
  const livekitUrl = str(source, "livekitUrl");
  const token = str(source, "token");
  const expiresAtMs = num(source, "expiresAtMs");
  const ttlSeconds = num(source, "ttlSeconds");
  let livekitAddress: URL;
  try {
    livekitAddress = new URL(livekitUrl ?? "");
  } catch {
    throw new WireShapeError();
  }
  if (
    token === undefined ||
    expiresAtMs === undefined ||
    ttlSeconds === undefined ||
    !["ws:", "wss:", "http:", "https:"].includes(livekitAddress.protocol)
  ) {
    throw new WireShapeError();
  }
  return {
    huddle: huddleFromWire(source.huddle),
    livekitUrl: livekitAddress.toString(),
    token,
    expiresAtMs,
    ttlSeconds,
  };
}

export async function leaveHuddle(
  workspaceId: string,
  huddleId: string
): Promise<LeftHuddle> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/huddles/${encodeURIComponent(huddleId)}/leave`,
      { method: "POST", body: "{}" }
    )
  );
  const ended = bool(source, "ended");
  if (ended === undefined) throw new WireShapeError();
  return { huddle: huddleFromWire(source.huddle), ended };
}

/**
 * Page/Tauri-webview teardown cannot await React cleanup. A keepalive fetch is
 * the browser primitive that lets the authenticated leave finish after the
 * document starts unloading. The normal awaited leave remains the primary
 * path; this is its last-chance duplicate and the server transition is safe to
 * observe twice (the second request can answer conflict after the first won).
 */
export function leaveHuddleOnPageExit(
  workspaceId: string,
  huddleId: string
): void {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  void fetch(
    `${apiBase()}/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/huddles/${encodeURIComponent(huddleId)}/leave`,
    { method: "POST", headers, body: "{}", keepalive: true }
  ).catch(() => {
    // The document is leaving and cannot present a retry. The durable path is
    // attempted above; the next active projection heals any missed departure.
  });
}

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

// Every call below goes through `fetchWithDeadline` (./http.ts): a request that
// cannot reach the server fails as a `NetworkError` within seconds instead of
// pending forever, which is what made a `.local` address look like a hung app
// rather than a wrong address (MOMO-609 / G-1).
function rawRequest(
  path: string,
  init: RequestInit,
  token: string | null
): Promise<HttpResponse> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
}

function parseError(res: HttpResponse): ApiError {
  const body = res.jsonOrNull<{ error?: { message?: string; code?: unknown } }>();
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  const code = body?.error?.code;
  return new ApiError(res.status, message, typeof code === "string" && code !== "" ? code : undefined);
}

// ---- refresh rotation (single flight) ---------------------------------------
// The refresh token is single-use (MOMO-300): the server revokes the presented
// token as it issues the new pair. Concurrent 401s must therefore funnel into
// ONE rotation, because a second concurrent call would present an
// already-revoked token and end the session. That single flight is per JS
// context; across tabs and desktop windows the host's `exclusiveRotation`
// serialises rotations and re-reads the shared store first (#3067).

/**
 * Why a rotation attempt ended. The distinction is load-bearing: **only
 * `rejected` means the session is actually over.**
 *
 * Before this type existed, `refreshSession()` collapsed `rejected` and
 * `unreachable` into one `false`, and `restoreSession()` read that `false` as
 * "session dead" and wiped the refresh token — so **one launch with no network
 * signed the user out for good**, on web and on mobile alike. The comment in the
 * catch branch below already said the session must not be declared dead there;
 * the caller simply had no way to honour it.
 *
 * `unreachable` is every answer that decided nothing: no connection, a blown
 * deadline, a lock that never came free, and a server that says it could not or
 * would not look at the token — a **5xx** (a deploy, a database blip), a **429**
 * (rate limited, which `docs/api/openapi.yaml` lists for this route) or a **408**
 * (#3993). None of those is "the session is over" any more than a dropped
 * connection is. The server says that with a 401 (refused, spent, reused, proof
 * refused) or a 403 (the member is gone), and those stay `rejected`.
 */
export type RefreshOutcome = "rotated" | "rejected" | "unreachable";

/**
 * One rotation, as the single flight carries it. `pair` is what the server
 * minted, kept even when the store dropped it — a `logout()` that wiped the
 * session while the request was in the air has to revoke THIS pair, because
 * the one it captured was spent by the rotation (#2677 review M1).
 */
interface Rotation {
  outcome: RefreshOutcome;
  pair: RefreshResponse | null;
  /**
   * The pair's refresh token is the host's handle, not a token (#3106): the
   * desktop shell holds the real one. Revoke with the access half only, or
   * through the host.
   */
  handle?: boolean;
}

// ---- refresh proof (#3106, ADR-0146 D-7 증보 #3079) ----------------------------
//
// A native client (phone, desktop) signs every refresh with its refresh key
// (`momo.human.refresh_proof.v1`). The server answers a key-bound lineage's
// unproven or mis-proven refresh with one of four codes; two of them mean
// "sign again", never "signed out". One policy for both hosts:
//
//   refresh_proof_stale      re-sign with the server's clock (response `Date`)
//   refresh_proof_replayed   re-sign (a fresh nonce comes with every proof)
//   refresh_proof_required   sign out (as before)
//   refresh_proof_invalid    sign out (as before)
//   any other 401 on a       re-sign ONCE, then sign out — two recoveries of the
//   proved refresh           same device racing: the loser gets a plain 401
//                            (client contract MUST 2)
//   5xx, 429, 408            keep the session, give this rotation up (#3993): a
//                            server that is failing, busy or too slow has
//                            decided nothing about it
//   any other status         sign out (as before; 403 is the server's "the member
//                            is gone")
//
// A lost answer (timeout, app killed) needs nothing here: the stored token is
// kept, and the next rotation presents it with a fresh proof — the server
// recovers the lineage however long ago the token was spent.

export const REFRESH_PROOF_CODES = [
  "refresh_proof_required",
  "refresh_proof_invalid",
  "refresh_proof_stale",
  "refresh_proof_replayed",
] as const;

/** At most this many refresh POSTs per rotation (1 + retries). */
export const MAX_REFRESH_ATTEMPTS = 3;

/**
 * What one refused refresh attempt means for the next one. `keep` is not a
 * retry: the rotation ends without a verdict and the session stays as it is.
 */
export type RefreshRetry = "sign-out" | "re-sign" | "re-sign-with-server-time" | "keep";

/**
 * A status that says the server did not look at the refresh token: it is failing
 * (5xx), busy (429) or too slow (408). Not a verdict on the session (#3993).
 */
function undecided(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * The retry policy, pure. `plainRetried`: a plain 401 on a proved refresh
 * already had its one retry in this rotation.
 */
export function refreshRetry(
  status: number,
  code: string | undefined,
  proved: boolean,
  plainRetried: boolean
): RefreshRetry {
  // These used to fall through to the line below, so a deploy or a database blip
  // during a refresh signed the person out — and `restoreSession()` wiped the
  // stored token for good. Every other status keeps its old reading: 401 and 403
  // are the server's own verdicts, and the rest was never a case this route
  // answered.
  if (undecided(status)) return "keep";
  if (status !== 401) return "sign-out";
  if (code === "refresh_proof_stale") return "re-sign-with-server-time";
  if (code === "refresh_proof_replayed") return "re-sign";
  if (code === "refresh_proof_required" || code === "refresh_proof_invalid") return "sign-out";
  return proved && !plainRetried ? "re-sign" : "sign-out";
}

/** Server time minus local time from a `Date` header, or null. */
export function serverSkewMs(date: string | null | undefined, localNowMs: number): number | null {
  if (!date) return null;
  const server = Date.parse(date);
  return Number.isFinite(server) ? server - localNowMs : null;
}

/** One refresh attempt's answer, whoever carried it. */
interface RefreshAttempt {
  status: number;
  code?: string;
  date?: string | null;
  pair: RefreshResponse | null;
  proved: boolean;
  handle: boolean;
}

/**
 * One POST: through the host when it carries the refresh (desktop shell), else
 * here, with the host's proof when it has a refresh key (phone). Throws when
 * nothing answered.
 */
async function refreshAttempt(
  refreshToken: string,
  identity: { workspaceId: string; memberId: string } | null,
  skewMs: number,
  bind = false
): Promise<RefreshAttempt> {
  const session = coreSession();
  if (identity && session.refreshThroughHost) {
    const answer = await session.refreshThroughHost({ ...identity, skewMs, ...(bind ? { bind } : {}) });
    if (answer) {
      const pair =
        answer.status === 200 && answer.accessToken && answer.refreshToken
          ? { accessToken: answer.accessToken, refreshToken: answer.refreshToken }
          : null;
      if (answer.status === 200 && !pair) throw new WireShapeError();
      return {
        status: answer.status,
        code: answer.code,
        date: answer.date,
        pair,
        proved: answer.proved,
        handle: true,
      };
    }
  }
  let deviceProof: RefreshDeviceProof | null = null;
  if (identity && session.signRefreshProof) {
    try {
      deviceProof = await session.signRefreshProof({
        refreshToken,
        ...identity,
        signedAtMs: Date.now() + skewMs,
      });
    } catch {
      // No proof is still a refresh: `observe` rotates it as before, and
      // `require` answers `refresh_proof_required` — a sign-out either way
      // the key could not have prevented.
      deviceProof = null;
    }
  }
  const res = await rawRequest(
    "/v1/auth/refresh",
    {
      method: "POST",
      body: JSON.stringify(deviceProof ? { refreshToken, deviceProof } : { refreshToken }),
    },
    null
  );
  if (res.ok) {
    return {
      status: res.status,
      pair: refreshResponseFromWire(res.json<unknown>()),
      proved: deviceProof !== null,
      handle: false,
    };
  }
  return {
    status: res.status,
    code: parseError(res).code,
    date: res.date ?? null,
    pair: null,
    proved: deviceProof !== null,
    handle: false,
  };
}

/**
 * Attempts until a pair, a sign-out, or `MAX_REFRESH_ATTEMPTS`. Returns the
 * pair (and whether it is a handle), or null for a sign-out. Throws when
 * nothing answered, or when all the server could say was that it is failing
 * (`keep`, #3993): the caller reads a throw as `unreachable`, never as a
 * sign-out.
 */
async function refreshWithRetries(
  refreshToken: string,
  identity: { workspaceId: string; memberId: string } | null,
  bind = false
): Promise<{ pair: RefreshResponse; handle: boolean } | null> {
  let skewMs = 0;
  let plainRetried = false;
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    const answer = await refreshAttempt(refreshToken, identity, skewMs, bind);
    if (answer.pair) return { pair: answer.pair, handle: answer.handle };
    const retry = refreshRetry(answer.status, answer.code, answer.proved, plainRetried);
    if (retry === "sign-out") return null;
    if (retry === "keep") throw new Error(`refresh answered ${answer.status}`);
    if (retry === "re-sign-with-server-time") {
      skewMs = serverSkewMs(answer.date, Date.now()) ?? skewMs;
    } else if (answer.code !== "refresh_proof_replayed") {
      // A plain 401 — or one with a code this client does not know — gets
      // its one retry, no more.
      plainRetried = true;
    }
  }
  // Out of attempts while the server still said "sign again" (stale or
  // replayed): that is never a sign-out (#3079). Nothing is proven about the
  // session; keep it and let the next rotation try again.
  throw new Error("refresh proof retries exhausted");
}

function identityOf(): { workspaceId: string; memberId: string } | null {
  const member = coreSession().getPersistedSession()?.member;
  return member ? { workspaceId: member.workspaceId, memberId: member.id } : null;
}

let rotationInFlight: Promise<Rotation> | null = null;
/**
 * The in-flight rotation's refresh POST has left (#3067). Before that, the
 * rotation may still be queued behind another tab's lock and has spent nothing,
 * so `logout()` does not wait for it — the wait bought nothing and delayed the
 * server revocation by up to the lock wait.
 */
let rotationPosted = false;
/** `logout()` joined the in-flight rotation and will revoke the pair it mints. */
let rotationJoinedByLogout = false;

function rotateSession(): Promise<Rotation> {
  rotationInFlight ??= (async (): Promise<Rotation> => {
    try {
      const session = coreSession();
      return session.exclusiveRotation
        ? await session.exclusiveRotation(rotateOnce)
        : await rotateOnce();
    } catch {
      // Offline, unreachable server, a blown deadline, a cross-context lock that
      // never came free, or a server that said it could not look at the token
      // (5xx, 429, 408): the caller keeps rendering cached content (P15) and the
      // session is not declared dead, because nothing answered to say it is.
      return { outcome: "unreachable", pair: null };
    } finally {
      rotationInFlight = null;
      rotationPosted = false;
      rotationJoinedByLogout = false;
    }
  })();
  return rotationInFlight;
}

/**
 * The rotation itself. Reads the refresh token only here — inside the host's
 * exclusive section, after its re-read — so a token another tab already spent
 * is never the one presented.
 */
async function rotateOnce(): Promise<Rotation> {
  const refreshToken = coreSession().getRefreshToken();
  // Having no token to present is not a network problem: there is nothing
  // to rotate and nothing to keep waiting for.
  if (!refreshToken) return { outcome: "rejected", pair: null };
  rotationPosted = true;
  const bind = nextRotationBinds;
  nextRotationBinds = false;
  const rotated = await refreshWithRetries(refreshToken, identityOf(), bind);
  if (!rotated) {
    coreSession().markAuthExpired();
    return { outcome: "rejected", pair: null };
  }
  const { pair, handle } = rotated;
  // The store may have moved on while the request was in the air: a logout
  // (here or in another tab) emptied it, or another tab signed a DIFFERENT
  // account in and this tab adopted that record. The minted pair belongs to the
  // session that was presented, so it is applied only if that session is still
  // the stored one — otherwise it would land under someone else's identity
  // (#3072 review H1: `{member: Y, refreshToken: X's}`).
  if (coreSession().getRefreshToken() !== refreshToken) {
    // Nobody will hold this pair. A logout that joined this rotation revokes it
    // itself; otherwise end it here so it does not live on the server for 30
    // days (#3072 review M1).
    if (!rotationJoinedByLogout) void revokePair(pair, handle);
    // Nothing is proven about the session now in the store — it is not ours.
    return { outcome: "unreachable", pair, handle };
  }
  coreSession().applyRotation(pair.accessToken, pair.refreshToken);
  return { outcome: "rotated", pair, handle };
}

/**
 * Best effort: end a pair nobody will hold. Never rejects. A handle is not a
 * token: the server would refuse the whole logout over it (it validates the
 * refresh half first), so only the access half goes.
 */
async function revokePair(pair: RefreshResponse, handle = false): Promise<void> {
  try {
    await rawRequest(
      "/v1/auth/logout",
      {
        method: "POST",
        body: JSON.stringify(handle ? {} : { refreshToken: pair.refreshToken }),
      },
      pair.accessToken
    );
  } catch {
    // The pair expires on its own; there is no one to tell.
  }
}

/** The detailed rotation. Use this wherever the *reason* changes what you do. */
export function refreshSessionOutcome(): Promise<RefreshOutcome> {
  return rotateSession().then((rotation) => rotation.outcome);
}

/** Boolean view, for callers that only need "did I end up with a usable token". */
export function refreshSession(): Promise<boolean> {
  return refreshSessionOutcome().then((outcome) => outcome === "rotated");
}

/** How long to wait before retrying a bind refresh nothing answered. */
export const BIND_RETRY_MS = 30_000;
/** Bind retries after the first attempt; all land well inside 10 minutes. */
export const BIND_RETRIES = 3;

/**
 * Adopt a fresh sign-in and, on a host with a refresh key, refresh ONCE right
 * away with a proof (#3106, client contract MUST 1): the server binds the key
 * to the sign-in only on its first refresh token and only within 10 minutes,
 * so a later first refresh would leave this sign-in unbound — and without
 * `require`'s protection — until the next sign-in. A bind that nothing
 * answered is retried a few times while the first token is still the stored
 * one. A browser (no key) is unchanged: no extra refresh.
 */
function adoptSignIn(response: LoginResponse): void {
  coreSession().applyLogin(response);
  bindRefreshKey(0);
}

function hostProvesRefresh(): boolean {
  const session = coreSession();
  return Boolean(session.signRefreshProof || session.refreshThroughHost);
}

/** The next rotation is a sign-in's bind refresh (see `HostRefreshRequest.bind`). */
let nextRotationBinds = false;

function bindRefreshKey(retry: number): void {
  if (!hostProvesRefresh()) return;
  nextRotationBinds = true;
  void refreshSessionOutcome().then((outcome) => {
    nextRotationBinds = false;
    if (outcome !== "unreachable" || retry >= BIND_RETRIES) return;
    // Nothing answered, so what is stored now is still the sign-in's first
    // token (or the desktop shell's handle for it).
    const first = coreSession().getRefreshToken();
    setTimeout(() => {
      // Only while that is still what is stored: once anything rotated it,
      // the bind window has been used (or has passed).
      if (first && coreSession().getRefreshToken() === first) bindRefreshKey(retry + 1);
    }, BIND_RETRY_MS);
  });
}

/**
 * The one rotation a 401 gets, read for what it proved about the session
 * (#3993). Every request helper that meets a 401 with a refresh token in hand
 * goes through here, so "is the session over" has one answer.
 *
 * Exported for a host whose own transport meets the 401 — the phone's native file
 * downloads, which cannot go through `authedResponse` — so that the rule is not
 * written a second time there (#3997).
 *
 *   rotated      → true: send the request again with the new token.
 *   rejected     → false: the server looked at the refresh token and ended the
 *                  session (refused, spent, reused, the member is gone). The
 *                  caller still holds the 401 and declares the end with its own
 *                  `markAuthExpired()` right there — not behind a retry or a
 *                  timer, and not after the network comes back. (A refusal the
 *                  server gave has already been declared by the rotation itself;
 *                  the caller's declaration is idempotent and covers what the
 *                  rotation cannot see: nothing was left to present, or the new
 *                  token met a 401 again.)
 *   unreachable  → throws a `NetworkError`. The connection dropped between the
 *                  401 and the rotation (a subway, a lift, a radio still waking
 *                  after the lock screen), the deadline blew, or the server could
 *                  only answer 5xx, 429 or 408: nothing decided anything, so
 *                  the session is not declared over — the rule `restoreSession()`
 *                  and the phone's boot gate already keep. The 401 is not the
 *                  answer either: it described an expired access token, and
 *                  every caller that reads a 401 as "log in again" would lie. A
 *                  `NetworkError` is the failure they already render ("could not
 *                  reach the server, check the connection and try again"); the
 *                  next request, or the reconnect, rotates again.
 */
export async function rotateAfterUnauthorized(): Promise<boolean> {
  const outcome = await refreshSessionOutcome();
  if (outcome === "unreachable") {
    throw new NetworkError("unreachable", REQUEST_TIMEOUT_MS);
  }
  return outcome === "rotated";
}

/**
 * Authenticated exchange with exactly one 401 rotation, answering with the
 * response **whatever its status** (#3926). A 401 that survives a rotation the
 * server refused, or that the new token meets again, ends the session
 * (`markAuthExpired`); only that owner may declare expiry. A rotation that never
 * reached the server declares nothing and fails the request as a `NetworkError`
 * (see `rotateAfterUnauthorized`, #3993).
 * `init.body` is always a string here, so replaying it on the retry is safe,
 * and it is the SAME string: a body that carries an idempotency key carries the
 * same key on the retry, so the server replays instead of recording twice.
 *
 * This is the half of `authedRequest` for callers whose non-2xx answers ARE the
 * contract. The approval decision answers 403/404/409 with the same receipt
 * schema as 200, and `authedRequest` would throw that body away
 * (`features/timeline/approvalDecision.ts`). Before this existed that caller
 * made a private raw fetch, which skipped the rotation: a phone that had been in
 * the background past the access token's life lost the decision with a 401.
 *
 * There is one rotation and no loop. A rotation the server refused leaves the
 * first 401 as the answer, and a second 401 after a rotation is the answer too;
 * neither starts another rotation.
 */
export async function authedResponse(
  path: string,
  init: RequestInit = {}
): Promise<HttpResponse> {
  let res = await rawRequest(path, init, coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await rotateAfterUnauthorized()) {
      res = await rawRequest(path, init, coreSession().getAccessToken());
    }
  }
  if (res.status === 401) coreSession().markAuthExpired();
  return res;
}

/**
 * `authedResponse` that throws the server's error for any non-2xx answer.
 *
 * Exported so sibling modules (linked devices, …) reuse this path instead of
 * growing a private fetch wrapper that skips rotation.
 */
export async function authedRequest(
  path: string,
  init: RequestInit = {}
): Promise<HttpResponse> {
  const res = await authedResponse(path, init);
  if (!res.ok) throw parseError(res);
  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedRequest(path, init);
  return responseRecord(res.json<unknown>()) as T;
}

/** Login / join / PATCH members/me `member` object. */
export function memberFromWire(value: unknown): Member {
  const kind = str(value, "kind");
  const id = str(value, "id");
  const workspaceId = str(value, "workspaceId");
  const displayName = str(value, "displayName");
  const handle = str(value, "handle");
  if (
    id === undefined ||
    workspaceId === undefined ||
    (kind !== "human" && kind !== "agent") ||
    displayName === undefined ||
    handle === undefined
  ) {
    throw new WireShapeError();
  }
  return { id, workspaceId, kind, displayName, handle };
}

function loginResponseFromWire(value: unknown): LoginResponse {
  const source = responseRecord(value);
  if (
    typeof source.accessToken !== "string" ||
    typeof source.refreshToken !== "string" ||
    typeof source.realtimeWebSocketUrl !== "string"
  ) {
    throw new WireShapeError();
  }
  return {
    accessToken: source.accessToken,
    refreshToken: source.refreshToken,
    realtimeWebSocketUrl: source.realtimeWebSocketUrl,
    member: memberFromWire(source.member),
  };
}

function joinResponseFromWire(value: unknown): JoinResponse {
  const login = loginResponseFromWire(value);
  const createdMember = bool(responseRecord(value), "createdMember");
  if (createdMember === undefined) throw new WireShapeError();
  return { ...login, createdMember };
}

function refreshResponseFromWire(value: unknown): RefreshResponse {
  const source = responseRecord(value);
  if (typeof source.accessToken !== "string" || typeof source.refreshToken !== "string") {
    throw new WireShapeError();
  }
  return { accessToken: source.accessToken, refreshToken: source.refreshToken };
}

/**
 * The address as the server will store it: trimmed and lowercased.
 *
 * This is a courtesy, not the comparison. Since #1234/#1248 every server-side
 * email lookup folds its own argument with SQL's `lower(btrim(...))`, so an
 * un-normalised address already resolves correctly — what this fixes is the
 * client sending one spelling while the account holds another, which shows up
 * the moment any surface echoes "signed in as …".
 *
 * It is deliberately no cleverer than trim+lowercase. The client must not try to
 * *replace* the server's normalisation (that is the mistake #1234 was about);
 * it only sends the address in the form the server would have written anyway.
 * JS `trim()` also removes the non-space whitespace that Postgres `btrim` leaves
 * alone, so a pasted address with a stray tab now lands instead of 401-ing.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export async function login(
  email: string,
  password: string,
  workspace?: string
): Promise<LoginResponse> {
  const body: Record<string, string> = { email: normalizeEmail(email), password };
  if (workspace && workspace.trim()) body.workspace = workspace.trim();
  const res = await rawRequest(
    "/v1/auth/login",
    { method: "POST", body: JSON.stringify(body) },
    null
  );
  if (!res.ok) throw parseError(res);
  const loginResponse = loginResponseFromWire(res.json<unknown>());
  adoptSignIn(loginResponse);
  return loginResponse;
}

// ---- invite self-signup (POST /v1/join) -------------------------------------
// Public route, mounted outside AuthMiddleware: the invite code IS the only
// credential, and it leaves the client only inside this request body. Success
// returns a full session token pair (openapi.yaml JoinResponse), so applying it
// here is the spec'd join-login path, not an invented auto-login.

/** Display name from the email local part, same derivation as the mac client. */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(".")
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Handle from the email local part: a-z, 0-9 and hyphen, never empty. */
export function handleFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? email).toLowerCase();
  const mapped = Array.from(local)
    .map((ch) => (/[a-z0-9-]/.test(ch) ? ch : "-"))
    .join("");
  const trimmed = mapped.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed === "" ? "oort-user" : trimmed;
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Redeem an invite code and land in the workspace it belongs to. The person
 * supplies an email and a password: the handle is derived from the email
 * exactly as the mac chooser derives it, so the same person joining from either
 * client gets the same identity.
 *
 * `displayName` is the name the invite screen asks for (「팀에서 보일 이름」,
 * ADR-0193 D7 초대 1화면). Blank or absent falls back to the email derivation,
 * because the server rejects an empty `displayName`.
 */
export async function joinWithInvite(
  code: string,
  email: string,
  password: string,
  displayName?: string
): Promise<JoinResponse> {
  // Normalised rather than merely trimmed, and the derivations read the same
  // value: the row this creates will hold `lower(btrim(...))`, so deriving the
  // display name from any other spelling would name the account after a string
  // it does not contain (`ADA@…` had been shouting "ADA" back at people).
  const normalizedEmail = normalizeEmail(email);
  const res = await rawRequest(
    "/v1/join",
    {
      method: "POST",
      body: JSON.stringify({
        code: code.trim(),
        email: normalizedEmail,
        displayName:
          displayName !== undefined && displayName.trim() !== ""
            ? displayName.trim()
            : displayNameFromEmail(normalizedEmail),
        handle: handleFromEmail(normalizedEmail),
        password,
        timeZone: browserTimeZone(),
      }),
    },
    null
  );
  if (!res.ok) throw parseError(res);
  const joinResponse = joinResponseFromWire(res.json<unknown>());
  adoptSignIn(joinResponse);
  return joinResponse;
}

/**
 * Consume a first-owner claim token and land signed in. Public route, mounted
 * outside AuthMiddleware: the token IS the only credential. Success returns a
 * LoginResponse, so applying it here is the spec'd claim-login path.
 */
export async function claimOwnerPassword(
  token: string,
  password: string
): Promise<LoginResponse> {
  const res = await rawRequest(
    "/v1/claim",
    {
      method: "POST",
      body: JSON.stringify({ token: token.trim(), password }),
    },
    null
  );
  if (!res.ok) throw parseError(res);
  const claimResponse = loginResponseFromWire(res.json<unknown>());
  adoptSignIn(claimResponse);
  return claimResponse;
}

// ---- device-link redeem (POST /v1/auth/device-link/redeem, ADR-0180 D3) -----
// Public, like /v1/join: the phone holds a one-time voucher and no bearer.
// LoginResponse plus `pendingSas`. The session is applied here only when the
// SAS hold is off; public-origin mode keeps tokens in the caller until the
// issuer confirms and a probe returns 200.

export interface DeviceLinkRedeemResult {
  session: LoginResponse;
  pendingSas: boolean;
  /** Four-digit SAS when the server sent one. Null when omitted (OpenAPI). */
  sas: string | null;
}

export type DeviceLinkProbe = "active" | "pending" | "unreachable";

function fourDigitSas(value: string | undefined): string | null {
  return value !== undefined && /^\d{4}$/.test(value) ? value : null;
}

function deviceLinkRedeemFromWire(value: unknown): DeviceLinkRedeemResult {
  const source = responseRecord(value);
  const pendingSas = bool(source, "pendingSas");
  if (pendingSas === undefined) throw new WireShapeError();
  return {
    session: loginResponseFromWire(source),
    pendingSas,
    sas: fourDigitSas(str(source, "sas")),
  };
}

export async function redeemDeviceLink(
  token: string,
  device: { name: string; platform: string }
): Promise<DeviceLinkRedeemResult> {
  const res = await rawRequest(
    "/v1/auth/device-link/redeem",
    {
      method: "POST",
      body: JSON.stringify({
        token: token.trim(),
        device: {
          name: device.name.trim(),
          platform: device.platform.trim(),
        },
      }),
    },
    null
  );
  if (!res.ok) throw parseError(res);
  const result = deviceLinkRedeemFromWire(res.json<unknown>());
  if (!result.pendingSas) {
    adoptSignIn(result.session);
  }
  return result;
}

/** Land the redeemed session after SAS confirm (or immediately if no hold). */
export function activateDeviceLinkSession(session: LoginResponse): void {
  adoptSignIn(session);
}

/**
 * Ask whether a redeemed access token is usable yet. Does not touch the
 * session store and does not treat 401 as "signed out" — pending SAS is 401
 * until the issuer confirms.
 */
export async function probeDeviceLinkAccess(
  accessToken: string,
  workspaceId: string
): Promise<DeviceLinkProbe> {
  try {
    const res = await rawRequest(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`,
      { method: "GET" },
      accessToken
    );
    if (res.ok) return "active";
    if (res.status === 401) return "pending";
    return "pending";
  } catch {
    return "unreachable";
  }
}

/**
 * Resume a stored session after a reload or a webview restart (M9). The access
 * token was never persisted, so resuming IS one refresh rotation; identity and
 * the websocket address come from the stored login response.
 *
 * Returns null when there is nothing to resume or the stored refresh token is
 * dead, and wipes local state in that case so the login screen is not shown
 * beside a token that still looks valid.
 */
export async function restoreSession(): Promise<LoginResponse | null> {
  if (!coreSession().getPersistedSession()) return null;
  const outcome = await refreshSessionOutcome();
  // **Nothing answered ⇒ nothing is proven.** Keep the credentials and let the
  // caller render cached content (P15); the next launch with a network can still
  // rotate. Wiping here is what signed people out after one offline start.
  if (outcome === "unreachable") return null;
  const persisted = coreSession().getPersistedSession();
  const token = coreSession().getAccessToken();
  if (outcome !== "rotated" || !persisted || !token) {
    coreSession().clearSession();
    return null;
  }
  return restoredLoginResponse(persisted, token);
}

export interface LogoutOptions {
  /**
   * Host cleanup that needs the leaving session one last time — the phone
   * revoking its push registration (#2677, ADR-0120 D4). Runs AFTER the local
   * wipe (the person is already out) and BEFORE the server revocation (the last
   * moment the leaving access token still authenticates), with that token: the
   * captured one, or the one a rotation in flight minted. Awaited — the
   * revocation waits until it settles, so its request is answered before the
   * token dies; bound its own deadline accordingly. A rejection is swallowed —
   * it never stops the revocation.
   */
  beforeRevoke?: (accessToken: string) => Promise<unknown>;
}

/**
 * Log out completely. The local wipe happens FIRST and unconditionally, so a
 * slow or failing network can never leave a usable token on the device; the
 * server revocation then runs as a best effort with the leaving pair.
 *
 * The leaving pair is the captured one — unless a refresh rotation is in the
 * air. Then the captured pair is already spent: the server revoked its refresh
 * half when the request arrived, and the pair it minted comes back to a store
 * this function has just wiped (the host's `applyRotation` drops it). Revoking
 * the spent pair ends nothing (`revokedRefresh:false`) and the minted pair would
 * live on the server for 30 days; a QR-linked rotation has also killed the
 * captured access half, so `beforeRevoke` would be refused too. So the network
 * half joins the rotation and uses what it minted (#2677 review M1). When the
 * rotation fails, the captured pair is all there is, as before.
 */
export async function logout(options: LogoutOptions = {}): Promise<void> {
  // Join only a rotation that has actually presented its token. One still
  // waiting for another tab's lock has spent nothing: once the store is wiped
  // below it finds no token and never posts (#3072 review M1).
  const rotation = rotationPosted ? rotationInFlight : null;
  if (rotation) rotationJoinedByLogout = true;
  let access = coreSession().getAccessToken();
  let refresh = coreSession().getRefreshToken();
  // Captured before the wipe: the proof and the host's revocation name them.
  const identity = identityOf();
  coreSession().clearSession();
  if (rotation) {
    // Never rejects: the rotation turns its own failures into an outcome.
    const { pair } = await rotation;
    if (pair) {
      access = pair.accessToken;
      refresh = pair.refreshToken;
    }
  }
  if (!access) return; // nothing the server will accept a revocation for
  if (options.beforeRevoke) {
    try {
      await options.beforeRevoke(access);
    } catch {
      // Best effort by contract: the session still has to end.
    }
  }
  // The desktop shell holds the refresh token (#3106): it revokes with it,
  // and rotates it with a proof first when the access token has expired.
  const session = coreSession();
  if (session.revokeThroughHost && identity) {
    try {
      if (await session.revokeThroughHost({ accessToken: access, refreshToken: refresh, ...identity }))
        return;
    } catch {
      // Best effort, like every revocation here.
      return;
    }
  }
  const revoke = (accessToken: string, refreshToken: string | null) =>
    rawRequest(
      "/v1/auth/logout",
      {
        method: "POST",
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      },
      accessToken
    );
  try {
    const res = await revoke(access, refresh);
    if (res.status === 401 && refresh) {
      // The access token expired before the server revoked anything, while the
      // refresh token is alive for 30 days. Rotate that pair once and revoke
      // the result, otherwise the session stays valid on the server. The store
      // is already wiped, so this rotation is carried by locals only — with
      // the refresh key's proof like every refresh (#3106): under `require`
      // an unproven one would be refused and the lineage would live on.
      const rotated = await refreshWithRetries(refresh, identity);
      if (rotated && !rotated.handle) {
        await revoke(rotated.pair.accessToken, rotated.pair.refreshToken);
      }
    }
  } catch {
    // A network failure must not trap the user inside the session; the local
    // wipe above already happened and the tokens expire on their own. With a
    // deadline on every call this now also ENDS: before, a logout aimed at an
    // unreachable server left a promise pending for the life of the app.
  }
}

export async function fetchRealtimeToken(): Promise<string> {
  const res = await request<RealtimeTokenResponse>("/v1/auth/realtime-token", {
    method: "POST",
  });
  return res.token;
}

export async function listChannels(workspaceId: string): Promise<Channel[]> {
  const res = await request<{ channels: Channel[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`
  );
  return arrayField<Channel>(res, "channels") ?? [];
}

/** Channel membership row, as the write endpoints return it. */
export interface ChannelMembership {
  id: string;
  workspaceId: string;
  channelId: string;
  memberId: string;
  role: MembershipRole;
  joinedAtMs: number;
  leftAtMs?: number;
}

/**
 * Result of POST /v1/workspaces/{ws}/channels (server CreateChannelResponse).
 * The creator is inserted as `owner` of the new channel in the same
 * transaction, so the caller is already a member when this resolves.
 */
export interface CreatedChannel {
  channel: Channel;
  creatorMembership: ChannelMembership;
}

export interface CreateChannelInput {
  kind: "public" | "private";
  /**
   * Already trimmed and lowercased by the caller. The server normalises again
   * and rejects anything outside `[a-z0-9]` plus hyphen/underscore, so the
   * client applies the same rule up front instead of showing an English 400.
   */
  name: string;
  /** Optional; omitted rather than sent empty, which the server reads as null. */
  topic?: string;
}

/**
 * Create a channel. Requires workspace owner/admin (ChannelRoutes guards it),
 * answers 409 when an unarchived non-DM channel already carries the name
 * case-insensitively, and 201 with the created row otherwise.
 */
export function createChannel(
  workspaceId: string,
  input: CreateChannelInput
): Promise<CreatedChannel> {
  return request<CreatedChannel>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

/**
 * Result of POST /v1/workspaces/{ws}/dms. The call is idempotent per participant
 * pair: it creates the channel on the first call (201) and returns the existing
 * one afterwards (200). `created` tells the two apart; `channel.id` is the
 * SERVER's answer to "which DM is this", so a client never has to match a pair
 * against its own channel list to find out.
 */
export interface OpenedDirectMessage {
  channel: Channel;
  created: boolean;
}

/** Open (or reuse) the 1:1 DM channel with another member. */
export function openDirectMessage(
  workspaceId: string,
  memberId: string
): Promise<OpenedDirectMessage> {
  return request<OpenedDirectMessage>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/dms`,
    { method: "POST", body: JSON.stringify({ memberId }) }
  );
}

/** Active workspace members, humans and agents alike (agents are members). */
export async function fetchRoster(workspaceId: string): Promise<RosterMember[]> {
  const res = await request<{ members: RosterMember[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/roster`
  );
  return (arrayField(res, "members") ?? [])
    .map(sanitizeRosterMember)
    .filter(isRosterMember);
}

// ---- Presence (ADR-0160, 사용자 프레즌스 6b) -------------------------------
//   GET /v1/workspaces/{ws}/presence   — the caller's own declared status
//   PUT /v1/workspaces/{ws}/presence   — set it (single write path)
//
// This is the durable ③ half. Availability ② never comes back through THIS API:
// it arrives as `online` on each roster row (read from the transport by the
// server, #4692), and the connection ① fact is the client's own `connStatus`.
// The effective dot is composed on the client via `effectivePresence` /
// `humanPresenceDot`.

/**
 * The four values that actually get rendered — `f(declared, available)`
 * (ADR-0160 D3). Never stored anywhere; computed at the render edge from the
 * durable declared status and a live availability boolean.
 *
 *   * `dnd` wins outright (it means "do not ping me", true even while connected);
 *   * `away` next;
 *   * `auto` resolves by availability: online when available, offline otherwise.
 *
 * `declared` may be `undefined` (a server too old to carry it, or a member with
 * none), in which case only availability decides — online vs offline.
 */
export type EffectivePresence = "online" | "away" | "dnd" | "offline";

export function effectivePresence(
  declared: PresenceStatus | undefined,
  available: boolean
): EffectivePresence {
  if (declared === "dnd") return "dnd";
  if (declared === "away") return "away";
  return available ? "online" : "offline";
}

function parsePresenceSnapshot(
  value: unknown,
  fallbackStatus: PresenceStatus
): PresenceSnapshot {
  const source = record(value) ?? {};
  const status = isPresenceStatus(source.status) ? source.status : fallbackStatus;
  const snapshot: PresenceSnapshot = { status };
  const emoji = str(source, "statusEmoji");
  const text = str(source, "statusText");
  const expires = num(source, "statusExpiresAtMs");
  const dndUntil = num(source, "dndUntilMs");
  if (status === "dnd" && dndUntil !== undefined) snapshot.dndUntilMs = dndUntil;
  if (emoji !== undefined && emoji.trim() !== "") snapshot.statusEmoji = emoji;
  if (text !== undefined && text.trim() !== "") snapshot.statusText = text;
  if (expires !== undefined) snapshot.statusExpiresAtMs = expires;
  return snapshot;
}

/** Read the caller's own declared status (auto/away/dnd) plus custom fields. */
export async function fetchPresenceStatus(
  workspaceId: string
): Promise<PresenceSnapshot> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId.toLowerCase())}/presence`
  );
  return parsePresenceSnapshot(res, "auto");
}

/**
 * Set the caller's own declared status and optional custom status.
 * Untouched custom keys must be omitted so a declared-status write cannot
 * clear emoji/text/expiry. JSON null clears a key. Broadcasts on the existing
 * `type: presence` rail.
 */
export async function setPresenceStatus(
  workspaceId: string,
  write: PresenceWrite
): Promise<PresenceSnapshot> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId.toLowerCase())}/presence`,
    { method: "PUT", body: JSON.stringify(presenceWriteBody(write)) }
  );
  return parsePresenceSnapshot(res, write.status);
}

// ---- 에이전트 만들기 · 채널 배치 -------------------------------------------
// POST   /v1/workspaces/{ws}/agents                        (AgentRoutes.create)
// POST   /v1/workspaces/{ws}/channels/{ch}/members         (ChannelRoutes.addMember)
// DELETE /v1/workspaces/{ws}/channels/{ch}/members/{member} (ChannelRoutes.removeMember)
//
// There is no bot to install (ADR-0004, invariant #5): creating an agent creates
// a `member` with `kind='agent'`, which is why the answer below is a roster row
// and not an installation receipt. Creation stops at the identity boundary on
// purpose, so the agent is mentionable only once it is added to a channel; that
// second half is the membership pair, and it is why the two live together here.
//
// No credential crosses this surface in either direction. The create body is
// closed-world server side and every key whose normalized spelling looks like a
// credential is refused at any depth, so a client that tries to be helpful by
// forwarding a key gets a 400 rather than a stored secret.

/** `POST …/agents` body (server `CreateAgentRequest`, camelCase on the wire). */
export interface CreateAgentInput {
  displayName: string;
  handle: string;
  model: string;
  baseUrl: string;
  /** Blank means absent: the server stores `null`, never an empty section. */
  systemPrompt?: string;
  /** The human accountable for this agent. Defaults to the caller. */
  ownerHumanId?: string;
  /** Optional initial profile. `instructions` is the only field this form sets. */
  profile?: { instructions: string };
}

/** What `POST …/agents` answers with (server `AgentMemberDTO`). */
export interface CreatedAgent {
  id: string;
  handle: string;
  displayName: string;
}

export function createdAgentFromWire(value: unknown): CreatedAgent {
  const source = responseRecord(value);
  const agent = record(source.agent);
  const id = agent === null ? undefined : str(agent, "id");
  const handle = agent === null ? undefined : str(agent, "handle");
  const displayName = agent === null ? undefined : str(agent, "displayName");
  if (id === undefined || handle === undefined || displayName === undefined) {
    throw new WireShapeError();
  }
  return { id: id.toLowerCase(), handle, displayName };
}

/**
 * Create an agent member. Requires a HUMAN workspace owner/admin: minting an
 * identity that can post into channels is not a member-level act, so the server
 * answers 403 for anyone else and 409 when the handle is taken.
 */
export async function createAgent(
  workspaceId: string,
  input: CreateAgentInput
): Promise<CreatedAgent> {
  return createdAgentFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`,
      { method: "POST", body: JSON.stringify(input) }
    )
  );
}

export function channelMembershipFromWire(value: unknown): ChannelMembership {
  const source = responseRecord(value);
  const membership = record(source.membership);
  if (membership === null) throw new WireShapeError();
  const id = str(membership, "id");
  const workspaceId = str(membership, "workspaceId");
  const channelId = str(membership, "channelId");
  const memberId = str(membership, "memberId");
  const role = str(membership, "role");
  const joinedAtMs = num(membership, "joinedAtMs");
  const leftAtMs = num(membership, "leftAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    memberId === undefined ||
    joinedAtMs === undefined ||
    (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest")
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    memberId: memberId.toLowerCase(),
    role,
    joinedAtMs,
    ...(leftAtMs === undefined ? {} : { leftAtMs }),
  };
}

/**
 * Put a member (person or agent) into a channel. Upsert by `(channel, member)`:
 * re-adding someone who left clears `left_at` rather than creating a second row,
 * so the button is safe to press twice. Requires workspace owner/admin, and the
 * target channel must be a public/private channel that is not archived, which is
 * why a DM answers 404 rather than silently succeeding.
 */
export async function addChannelMember(
  workspaceId: string,
  channelId: string,
  memberId: string,
  role: MembershipRole = "member"
): Promise<ChannelMembership> {
  return channelMembershipFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/members`,
      { method: "POST", body: JSON.stringify({ memberId, role }) }
    )
  );
}

/**
 * Take a member out of a channel. The row is marked `left_at`, not deleted, so
 * the history that member wrote keeps its author. 404 means there was no active
 * membership to end.
 */
export async function removeChannelMember(
  workspaceId: string,
  channelId: string,
  memberId: string
): Promise<ChannelMembership> {
  return channelMembershipFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(
        memberId
      )}`,
      { method: "DELETE" }
    )
  );
}

/**
 * Decode the `{ muted }` body the notification-pref write answers with. Pulled
 * out so the wire shape is asserted in one place rather than only inside the
 * async wrapper (same split as `channelMembershipFromWire`).
 */
export function notificationPrefFromWire(value: unknown): boolean {
  const source = responseRecord(value);
  const muted = bool(source, "muted");
  if (muted === undefined) throw new WireShapeError();
  return muted;
}

/**
 * Mute or unmute this channel FOR THE CALLING MEMBER
 * (`PUT …/channels/{ch}/notification-pref`, ADR-0124). The body carries only the
 * flag: the preference's owner is the authenticated principal, so no `memberId`
 * is sent and one member cannot silence another. Requires an active channel
 * membership (not ownership); the server answers with the flag it stored.
 */
export async function setChannelNotificationPref(
  workspaceId: string,
  channelId: string,
  muted: boolean
): Promise<boolean> {
  return notificationPrefFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/channels/${encodeURIComponent(channelId)}/notification-pref`,
      { method: "PUT", body: JSON.stringify({ muted }) }
    )
  );
}

// ---- Plugin registry: catalog, manifest and caller-owned grants ------------
//
// `PluginRoutes` deliberately separates these projections. The catalog carries
// only installation state plus the calling member's effective tool policy;
// declared scopes and publisher metadata stay in the manifest detail. Keep
// that split here instead of inferring a grant from an installation.

/**
 * 앱 카탈로그 `category`의 닫힌 목록(ADR-0113 증보 3 F1). 서버 검증기(`ALLOWED_CATEGORIES`)와 같은 다섯이다.
 * 새 서버가 여섯째를 더해도 이 클라이언트는 그 값을 읽지 않는다(`undefined`) - 모르는 분류로 화면이 갈라지지 않게.
 */
export type PluginCategory = "communication" | "productivity" | "developer" | "files" | "project";

const PLUGIN_CATEGORIES: readonly PluginCategory[] = [
  "communication",
  "productivity",
  "developer",
  "files",
  "project",
];

/**
 * 앱 상세의 예시 카드 한 장(ADR-0113 증보 3 F1·F7). `tool`은 같은 매니페스트의 읽기(R)·승인 필요 쓰기(A) 도구다.
 * 텍스트로만 그린다: 마크다운도 링크도 아니다.
 */
export interface PluginStarterPrompt {
  text: string;
  tool: string;
}

export interface PluginCatalogItem {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  official: boolean;
  recommended: boolean;
  egressDomains: string[];
  recommendedFor: string[];
  installed: boolean;
  enabled: boolean;
  termsURL?: string;
  privacyPolicyURL?: string;
  iconText?: string;
  /**
   * 매니페스트 `plugin.publisher.name` - 「개발자」 칸의 유일한 출처(ADR-0113 증보 3 F1: 칸을 따로 두지 않는다).
   * 필드가 없는 옛 서버는 `undefined`.
   */
  publisherName?: string;
  /**
   * 클라이언트 번들 로고 자산의 이름(`[a-z0-9-]{1,32}`, ADR-0113 증보 3 F1·F2). URL도 경로도 아니다: 번들에서
   * 이 이름으로 찾고, 없으면 `iconText`/이름의 첫 글자 타일로 돌아간다. 모양이 어긋난 값은 읽지 않는다.
   */
  logoKey?: string;
  /** 닫힌 목록 중 하나(위 `PluginCategory`). 모르는 값은 `undefined`. */
  category?: PluginCategory;
  /** 예시 카드 0~3장. 없으면 키 자체가 없다(빈 배열을 만들지 않는다). */
  starterPrompts?: PluginStarterPrompt[];
  /** 개발자 웹사이트(https만, 이동 전용). */
  websiteURL?: string;
}

export interface PluginPolicyTool {
  name: string;
  risk: string;
  approvalTier: string;
}

export interface PluginCatalog {
  plugins: PluginCatalogItem[];
  /** Present only for scopes this calling member currently has. */
  toolsByPlugin: Map<string, PluginPolicyTool[]>;
}

export interface PluginManifestTool {
  name: string;
  description?: string;
  scopes: string[];
  risk?: string;
  approvalTier?: string;
  /**
   * 매니페스트 도구의 `approvalPolicy`(`none` · `require_approval` · `always`). 등급 R·A·B(ADR-0113
   * 증보 2 E4)는 `risk`와 이 값으로 정해진다: 승인 단계(`approvalTier`)는 A와 B가 둘 다
   * `network_write`라서 둘을 가르지 못한다. 서버의 정책 목록(`PluginPolicyTool`)에는 이 값이 없다.
   */
  approvalPolicy?: string;
}

export interface PluginDetail {
  pluginId: string;
  name: string;
  version: string;
  description: string;
  official: boolean;
  egressDomains: string[];
  recommendedFor: string[];
  installed: boolean;
  enabled: boolean;
  termsURL?: string;
  privacyPolicyURL?: string;
  iconText?: string;
  /** 목록과 같은 표시 필드(ADR-0113 증보 3 F1). 뜻은 `PluginCatalogItem`의 같은 이름과 같다. */
  logoKey?: string;
  category?: PluginCategory;
  starterPrompts?: PluginStarterPrompt[];
  websiteURL?: string;
  /** DTO의 `publisherName`, 없으면(옛 서버) 매니페스트 `plugin.publisher.name`. */
  publisherName?: string;
  publisherVerified?: boolean;
  license?: string;
  provenanceURL?: string;
  /**
   * 매니페스트 `momo.hosted`: oort 서버가 이 앱의 연결을 직접 들고 있다(예: 팀 공유 드라이브,
   * 서비스 계정). 그런 앱에는 「토큰은 실행 장소에만 있다」(ADR-0113 D1-A)가 맞지 않는다.
   * 필드가 없는 옛 서버는 `undefined`이고, 그때는 D1-A 앱으로 읽는다.
   */
  hosted?: boolean;
  /**
   * 매니페스트 `momo.preview`(ADR-0113 증보 2 E2): 공급자가 아직 미리보기로 내놓은 앱(Google 세 앱).
   * 목록 응답에는 없고 상세 매니페스트에만 있다. 필드가 없는 옛 서버·앱은 `undefined`.
   */
  preview?: boolean;
  tools: PluginManifestTool[];
}

export interface PluginMutation {
  pluginId: string;
  memberId?: string;
  scope?: string;
  status: string;
  enabled: boolean;
  capabilities: string[];
}

/** Manifest display links are navigation only, and must never become script URLs. */
function httpsURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

// 서버 `plugin_manifest::is_logo_key`와 같다: `^[a-z0-9-]{1,32}$`.
const LOGO_KEY = /^[a-z0-9-]{1,32}$/;
const STARTER_PROMPT_MAX_CHARS = 140;
const STARTER_PROMPT_MAX_COUNT = 3;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function logoKeyOf(value: unknown): string | undefined {
  const key = str(value, "logoKey");
  return key !== undefined && LOGO_KEY.test(key) ? key : undefined;
}

function categoryOf(value: unknown): PluginCategory | undefined {
  const category = str(value, "category");
  return PLUGIN_CATEGORIES.find((known) => known === category);
}

/**
 * 예시 카드. 서버(`optional_starter_prompts`)의 모양 한도만 같은 값으로 걸러 읽는다: 문자열 둘(`text` 1~140자·제어문자
 * 없음, `tool`), 3장까지. 서버 검증기가 더 하는 검사 - `text`에 URL 모양(`://`·`//`·`www.`) 금지, `tool`이 그 매니페스트의
 * R·A 등급 도구인지 - 는 여기서 되풀이하지 않는다(공식 매니페스트는 서버가 이미 거른 값이다). 어긋난 카드는 건너뛴다 -
 * 카드 하나가 틀렸다고 앱 전체를 못 그리지는 않는다. 하나도 남지 않으면 `undefined`(빈 배열을 만들지 않는다).
 */
function starterPromptsOf(value: unknown): PluginStarterPrompt[] | undefined {
  const entries = arrayField(value, "starterPrompts");
  if (entries === null) return undefined;
  const prompts: PluginStarterPrompt[] = [];
  for (const entry of entries.slice(0, STARTER_PROMPT_MAX_COUNT)) {
    const text = str(entry, "text");
    const tool = str(entry, "tool");
    if (text === undefined || tool === undefined || tool === "") continue;
    const length = Array.from(text).length;
    if (length === 0 || length > STARTER_PROMPT_MAX_CHARS || text.trim() !== text) continue;
    if (CONTROL_CHARACTER.test(text)) continue;
    prompts.push({ text, tool });
  }
  return prompts.length > 0 ? prompts : undefined;
}

function requiredPluginItem(value: unknown): PluginCatalogItem | null {
  const pluginId = str(value, "pluginId");
  const name = str(value, "name");
  const version = str(value, "version");
  const description = str(value, "description");
  const official = bool(value, "official");
  const recommended = bool(value, "recommended");
  const egressDomains = stringArrayField(value, "egressDomains");
  const recommendedFor = stringArrayField(value, "recommendedFor");
  const installed = bool(value, "installed");
  const enabled = bool(value, "enabled");
  if (
    pluginId === undefined || name === undefined || version === undefined ||
    description === undefined || official === undefined || recommended === undefined ||
    egressDomains === null || recommendedFor === null || installed === undefined ||
    enabled === undefined
  ) return null;
  return {
    pluginId, name, version, description, official, recommended,
    egressDomains, recommendedFor, installed, enabled,
    termsURL: httpsURL(str(value, "termsURL")),
    privacyPolicyURL: httpsURL(str(value, "privacyPolicyURL")),
    iconText: str(value, "iconText"),
    publisherName: str(value, "publisherName"),
    logoKey: logoKeyOf(value),
    category: categoryOf(value),
    starterPrompts: starterPromptsOf(value),
    websiteURL: httpsURL(str(value, "websiteURL")),
  };
}

function policyTool(value: unknown): PluginPolicyTool | null {
  const name = str(value, "name");
  const risk = str(value, "risk");
  const approvalTier = str(value, "approvalTier");
  return name === undefined || risk === undefined || approvalTier === undefined
    ? null
    : { name, risk, approvalTier };
}

/** Exported for the wire contract test; every field read uses lib/wire helpers. */
export function pluginCatalogFromWire(value: unknown): PluginCatalog {
  const root = responseRecord(value);
  const plugins = arrayField(root, "plugins");
  if (plugins === null) throw new WireShapeError();
  const parsedPlugins = plugins.map(requiredPluginItem);
  if (parsedPlugins.some((plugin) => plugin === null)) throw new WireShapeError();

  const toolsByPlugin = new Map<string, PluginPolicyTool[]>();
  const policy = record(root.toolPolicy);
  const descriptors = policy === null ? null : arrayField(policy, "plugins");
  if (descriptors !== null) {
    for (const descriptor of descriptors) {
      const pluginId = str(descriptor, "pluginId");
      const tools = arrayField(descriptor, "tools");
      if (pluginId === undefined || tools === null) continue;
      const parsedTools = tools.map(policyTool);
      if (parsedTools.some((tool) => tool === null)) continue;
      toolsByPlugin.set(pluginId, parsedTools as PluginPolicyTool[]);
    }
  }
  return { plugins: parsedPlugins as PluginCatalogItem[], toolsByPlugin };
}

function manifestTool(value: unknown, approvalTiers: Record<string, unknown> | null): PluginManifestTool | null {
  const name = str(value, "name");
  const scopes = stringArrayField(value, "scopes");
  if (name === undefined || scopes === null) return null;
  const approvalTier = approvalTiers ? approvalTiers[name] : undefined;
  return {
    name,
    description: str(value, "description"),
    scopes,
    risk: str(value, "risk"),
    approvalTier: typeof approvalTier === "string" ? approvalTier : undefined,
    approvalPolicy: str(value, "approvalPolicy"),
  };
}

/** Parse only the manifest fields the product is allowed to display. */
export function pluginDetailFromWire(value: unknown): PluginDetail {
  const root = responseRecord(value);
  const detail = record(root.plugin);
  // Detail intentionally omits the catalog-only `recommended` bit. Supply no
  // meaning beyond a type placeholder while sharing the required field check.
  const item = detail === null ? null : requiredPluginItem({ ...detail, recommended: false });
  const manifest = record(detail?.manifest);
  if (item === null || manifest === null) throw new WireShapeError();
  const plugin = record(manifest.plugin);
  const publisher = record(plugin?.publisher);
  const license = record(plugin?.license);
  const provenance = record(plugin?.provenance);
  const mcp = record(manifest.mcp);
  const momo = record(manifest.momo);
  const tools = mcp === null ? null : arrayField(mcp, "tools");
  if (tools === null) throw new WireShapeError();
  const approvalTiers = record(momo?.approvalTier);
  const parsedTools = tools.map((tool) => manifestTool(tool, approvalTiers));
  if (parsedTools.some((tool) => tool === null)) throw new WireShapeError();
  return {
    ...item,
    publisherName: item.publisherName ?? str(publisher, "name"),
    publisherVerified: bool(publisher, "verified"),
    license: str(license, "spdx"),
    provenanceURL: httpsURL(str(provenance, "sourceURL")),
    hosted: bool(momo, "hosted"),
    preview: bool(momo, "preview"),
    tools: parsedTools as PluginManifestTool[],
  };
}

function pluginMutationFromWire(value: unknown): PluginMutation {
  const root = responseRecord(value);
  const pluginId = str(root, "pluginId");
  const status = str(root, "status");
  const enabled = bool(root, "enabled");
  const capabilities = stringArrayField(root, "capabilities");
  if (pluginId === undefined || status === undefined || enabled === undefined || capabilities === null) {
    throw new WireShapeError();
  }
  return {
    pluginId,
    status,
    enabled,
    capabilities,
    memberId: str(root, "memberId"),
    scope: str(root, "scope"),
  };
}

/** GET /plugins: catalog plus this caller's effective, credential-free policy. */
export async function listPlugins(workspaceId: string): Promise<PluginCatalog> {
  return pluginCatalogFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins`
  ));
}

/** GET /plugins/:plugin: registry manifest, never a credential. */
export async function getPlugin(workspaceId: string, pluginId: string): Promise<PluginDetail> {
  return pluginDetailFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}`
  ));
}

// ---- 내 앱 실행 장소: GET …/members/me/app-runtimes (ADR-0113 증보 3 F8) -----------------
//
// 컴포저의 앱 칩이 보내기 전에 묻는 읽기다: 내 에이전트 가운데 내 앱이 도는 곳이 어디이고, 지금 그곳에 보내면
// 배달되는가. 요청자 본인 소유 에이전트만 오고(남의 에이전트·남의 grant는 응답에 없다), 로스터·에이전트 DTO에는
// 싣지 않는다. 최상위는 다른 읽기 API처럼 **객체** `{ runtimes: [...] }`다(항목마다 이미 `apps`가 있어 키 이름은
// `runtimes`; ADR의 모양 그대로, planner 결정 1).

/** 실행 장소의 얼굴. 모르는 값(새 서버의 새 경로)은 항목째 읽지 않는다 - 그 경로의 규칙을 이 클라이언트는 모른다. */
export type AppRuntimePath = "hermes_trial" | "hosted_vendor";

/**
 * 지금 배달되지 않는 이유 - 배달 관문의 에이전트 단 단계 중 **처음 막히는 하나**. `null`이면 배달된다.
 * `unknown`은 이 클라이언트가 모르는 이유(새 서버)이고, 모르는 이유도 **막힘**이다(배달된다고 읽지 않는다).
 */
export type AppRuntimeBlocked =
  | "hosted_off"
  | "connection"
  | "attest"
  | "members"
  | "apps"
  | "paused"
  | "unknown";

export interface AppRuntime {
  agentId: string;
  path: AppRuntimePath;
  /** 요청자 본인의 활성 grant의 부분집합인 플러그인 id들(Hermes 시험은 운영자가 켠 앱과의 교집합). */
  apps: string[];
  /** `true`면 oort가 그 목록을 강제한다(Hermes 시험). `false`면 허용 기록만 남긴다(호스팅 벤더). */
  enforced: boolean;
  blocked: AppRuntimeBlocked | null;
}

const APP_RUNTIME_PATHS: readonly AppRuntimePath[] = ["hermes_trial", "hosted_vendor"];
const APP_RUNTIME_BLOCKED: readonly AppRuntimeBlocked[] = [
  "hosted_off",
  "connection",
  "attest",
  "members",
  "apps",
  "paused",
];

function appRuntimeFromWire(value: unknown): AppRuntime | null {
  const agentId = str(value, "agentId");
  const path = APP_RUNTIME_PATHS.find((known) => known === str(value, "path"));
  const apps = stringArrayField(value, "apps");
  const enforced = bool(value, "enforced");
  if (agentId === undefined || path === undefined || apps === null || enforced === undefined) {
    return null;
  }
  const source = record(value);
  // `blocked`는 **키가 있어야** 한다: `null`(배달됨)과 키 없음(모르는 모양)은 다른 말이다.
  if (source === null || !("blocked" in source)) return null;
  const rawBlocked = source.blocked;
  let blocked: AppRuntimeBlocked | null;
  if (rawBlocked === null) blocked = null;
  else if (typeof rawBlocked === "string") {
    blocked = APP_RUNTIME_BLOCKED.find((known) => known === rawBlocked) ?? "unknown";
  } else return null;
  return { agentId, path, apps, enforced, blocked };
}

/**
 * 와이어를 읽는다. 최상위가 객체가 아니거나 `runtimes`가 배열이 아니면 `WireShapeError`(옛 최상위 배열도 모양
 * 오류다). 항목이 어긋나면(필수 키 없음·모르는 경로) **그 항목만** 건너뛴다 - 읽지 못한 에이전트는 칩 후보가
 * 아닐 뿐 다른 에이전트까지 막지 않는다.
 */
export function appRuntimesFromWire(value: unknown): AppRuntime[] {
  const raws = arrayField(responseRecord(value), "runtimes");
  if (raws === null) throw new WireShapeError();
  const runtimes: AppRuntime[] = [];
  for (const raw of raws) {
    const runtime = appRuntimeFromWire(raw);
    if (runtime !== null) runtimes.push(runtime);
  }
  return runtimes;
}

/** GET …/members/me/app-runtimes: 요청자 본인의 앱 실행 장소들(없으면 빈 배열). */
export async function listAppRuntimes(workspaceId: string): Promise<AppRuntime[]> {
  return appRuntimesFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/me/app-runtimes`
  ));
}

export async function installPlugin(workspaceId: string, pluginId: string): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/install`,
    { method: "POST", body: JSON.stringify({ enabled: true }) }
  ));
}

export async function revokePluginInstall(workspaceId: string, pluginId: string): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/install`,
    { method: "DELETE" }
  ));
}

export async function grantPluginScope(
  workspaceId: string,
  pluginId: string,
  scope: string
): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/grants`,
    { method: "POST", body: JSON.stringify({ scope }) }
  ));
}

export async function revokePluginScope(
  workspaceId: string,
  pluginId: string,
  scope: string
): Promise<PluginMutation> {
  return pluginMutationFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}/grants/${encodeURIComponent(scope)}`,
    { method: "DELETE" }
  ));
}

/**
 * 「앱 설치」 탐지: 설치·권한 경로가 이 서버에 서 있는지 **바꾸는 것 없이** 묻는다
 * (ADR-0113 증보 P3, #3860).
 *
 * 두 경로(`…/install`, `…/grants`)에 GET을 보내고 상태 코드만 돌려준다. 두 경로는
 * POST·DELETE로만 등록되므로, 서 있으면 라우터가 핸들러를 부르기 전에 405를 돌려주고
 * 없으면 404다. GET이어야 한다: 쓰기 동사로 물으면 서 있는 경로가 실제로 실행된다.
 * 읽는 법(405가 「있다」)과 엔진 랜딩 시 재확인은 `pluginInstallVerdict`가 갖고 있다.
 *
 * 경로에 실리는 `pluginId`는 카탈로그가 준 실제 앱이어야 한다. 앞에 앱 조회 층이 서도
 * 같은 답이 오게 하려는 것이다.
 *
 * `ApiError`는 상태 코드로 접는다(그것이 이 함수의 답이다). 네트워크 실패는 그대로
 * 던진다: 아무도 답하지 않은 것은 경로에 대한 진술이 아니다.
 */
export async function probePluginWriteRoutes(
  workspaceId: string,
  pluginId: string,
  signal?: AbortSignal
): Promise<number[]> {
  const root = `/v1/workspaces/${encodeURIComponent(workspaceId)}/plugins/${encodeURIComponent(pluginId)}`;
  return Promise.all(
    ["install", "grants"].map(async (leaf) => {
      try {
        return (await authedRequest(`${root}/${leaf}`, { signal })).status;
      } catch (error) {
        if (error instanceof ApiError) return error.status;
        throw error;
      }
    })
  );
}

interface WireReadState {
  channel_id: string;
  last_read_seq: number;
  latest_seq: number;
  unread_count: number;
  mention_count: number;
  marked_unread_before_seq?: number | null;
  /** ADR-0177 D9. Absent on an older server and on a `PUT read-state` response. */
  latest_readable_seq?: number;
  /** ADR-0177 D6/D8. `null` = not closed (GET), absent = the response did not say. */
  closed_at_seq?: number | null;
}

function markedUnreadBeforeSeqFromWire(
  wire: WireReadState
): number | null {
  const value = wire.marked_unread_before_seq;
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

/** A non-negative integer seq, or `undefined` for anything else (including absent). */
function seqFromWire(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * ADR-0177 D6/D8: keeps `undefined` ("did not say"), `null` ("not closed") and a number
 * ("closed at") apart. A malformed value is "did not say" - neither a claim that the DM is closed
 * nor one that it is open.
 */
function closedAtSeqFromWire(wire: WireReadState): number | null | undefined {
  const value = wire.closed_at_seq;
  if (value === null) return null;
  return seqFromWire(value);
}

function toReadState(wire: WireReadState): ReadState {
  const state: ReadState = {
    channelId: wire.channel_id,
    lastReadSeq: wire.last_read_seq,
    latestSeq: wire.latest_seq,
    unreadCount: wire.unread_count,
    mentionCount: wire.mention_count,
    markedUnreadBeforeSeq: markedUnreadBeforeSeqFromWire(wire),
  };
  // Present only when the response said something: an absent key stays absent so a caller can tell
  // "not closed" (`null`) from "not told" (no key).
  const latestReadableSeq = seqFromWire(wire.latest_readable_seq);
  if (latestReadableSeq !== undefined) state.latestReadableSeq = latestReadableSeq;
  const closedAtSeq = closedAtSeqFromWire(wire);
  if (closedAtSeq !== undefined) state.closedAtSeq = closedAtSeq;
  return state;
}

/** Bulk read-state, one entry per membership (P7 server single truth). */
export async function fetchReadStates(
  workspaceId: string
): Promise<ReadState[]> {
  const res = await request<{ read_states: WireReadState[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/read-state`
  );
  const states = arrayField(res, "read_states");
  return states === null ? [] : states.filter((state): state is WireReadState => {
    return typeof state === "object" && state !== null &&
      typeof (state as Record<string, unknown>).channel_id === "string" &&
      typeof (state as Record<string, unknown>).last_read_seq === "number" &&
      typeof (state as Record<string, unknown>).latest_seq === "number" &&
      typeof (state as Record<string, unknown>).unread_count === "number" &&
      typeof (state as Record<string, unknown>).mention_count === "number";
  }).map(toReadState);
}

/**
 * 이 DM 을 닫는다 (ADR-0177 증보 D7, #4227). `seenSeq` 는 **화면이 본** 마지막 seq(읽음 투영의 `latestSeq`)다.
 * 서버는 `GREATEST(기존 값, LEAST(seenSeq, 채널의 마지막 seq))` 로 저장해서, 투영과 이 호출 사이에 온 메시지는 묻히지
 * 않고 같은 호출의 재전송은 결과가 같다. 204 - 본문이 없다. 참여자가 아니거나 보관된 DM 이면 404.
 */
export async function closeDm(
  workspaceId: string,
  channelId: string,
  seenSeq: number
): Promise<void> {
  await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/closure`,
    { method: "PUT", body: JSON.stringify({ seenSeq }) }
  );
}

/** 닫은 DM 을 다시 연다 (D7·D8). 행이 없어도 204, 참여자가 아니거나 보관된 DM 이면 404. */
export async function reopenDm(workspaceId: string, channelId: string): Promise<void> {
  await authedRequest(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(channelId)}/closure`,
    { method: "DELETE" }
  );
}

/**
 * Advance the caller's read cursor. The server clamps to
 * `max(current, min(requested, latestSeq))`, so it can never regress.
 *
 * Optional `markUnreadBeforeSeq` / `readIntent` are ADR-0178 D5/D6.
 * `readIntent` is sent only as `"explicit_open"`; omitting the field is
 * background. Product code must go through `advertiseReadState` so the
 * reason is classified in one place.
 */
export async function updateReadState(
  workspaceId: string,
  channelId: string,
  lastReadSeq: number,
  options?: UpdateReadStateOptions
): Promise<ReadState> {
  const body: Record<string, unknown> = { last_read_seq: lastReadSeq };
  if (options?.markUnreadBeforeSeq !== undefined) {
    body.mark_unread_before_seq = options.markUnreadBeforeSeq;
  }
  if (options?.readIntent === "explicit_open") {
    body.read_intent = "explicit_open";
  }
  const res = await request<WireReadState>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/read-state`,
    { method: "PUT", body: JSON.stringify(body) }
  );
  return toReadState(res);
}

/**
 * 「이 채널을 화면에 띄워 두고 있어요」 존재 신호 (ADR-0204 증보 3, #4018/#4063).
 * `PUT /v1/workspaces/{ws}/channels/{ch}/viewing` - 본문 없음, 204. 주기·멈춤은
 * `features/readState/viewingBeat.ts`가 정하고 이 함수는 한 번 보내기만 한다.
 * 옛 서버는 404·405를 준다 - 호출자가 `ApiError.status`로 가려 읽는다.
 */
export async function touchChannelViewing(
  workspaceId: string,
  channelId: string
): Promise<void> {
  await authedRequest(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/viewing`,
    { method: "PUT" }
  );
}

export interface MessageQuery {
  limit?: number;
  /** Older history: seq strictly BELOW this (descending page). */
  before?: number;
  /** Realtime-gap backfill: seq strictly ABOVE this (ascending page). */
  after?: number;
}

export async function fetchMessages(
  workspaceId: string,
  channelId: string,
  query: MessageQuery = {}
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.before !== undefined) params.set("before", String(query.before));
  if (query.after !== undefined) params.set("after", String(query.after));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const page = await request<MessagePage>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages${suffix}`
  );
  const messages = arrayField<Message>(page, "messages");
  return { ...page, messages: (messages ?? []).filter(isMessage) };
}

// ---- 링크 언퍼얼 (ADR-0170 D5) ---------------------------------------------
//
// 원격 URL을 읽는 주체는 서버뿐이다. 클라이언트가 받는 것은 정제된 메타데이터와
// 인가가 걸린 same-origin 이미지 프록시 경로뿐이며, failed/blocked 행도 그대로
// 보존해 순수 상태 기계가 둘을 조용한 부재로 판정하게 한다.

function messageUnfurlPath(workspaceId: string, messageId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/messages/${encodeURIComponent(messageId)}/unfurls`;
}

export async function fetchMessageUnfurls(
  workspaceId: string,
  messageId: string
): Promise<MessageUnfurl[]> {
  const source = responseRecord(
    await request<unknown>(messageUnfurlPath(workspaceId, messageId))
  );
  const rows = arrayField(source, "unfurls");
  if (rows === null) throw new WireShapeError();
  return rows
    .map(messageUnfurlFromWire)
    .filter((row): row is MessageUnfurl => row !== null);
}

/** Author-only, idempotent removal. The server tombstones regeneration. */
export async function removeMessageUnfurls(
  workspaceId: string,
  messageId: string
): Promise<{ removed: boolean }> {
  const source = responseRecord(
    await request<unknown>(messageUnfurlPath(workspaceId, messageId), {
      method: "DELETE",
    })
  );
  const removed = bool(source, "removed");
  if (removed === undefined) throw new WireShapeError();
  return { removed };
}

function workspaceUnfurlSettingsFromWire(
  value: unknown
): WorkspaceUnfurlSettings {
  const source = responseRecord(value);
  const enabled = bool(source, "enabled");
  if (enabled === undefined) throw new WireShapeError();
  const updatedAtMs = num(source, "updatedAtMs");
  return {
    enabled,
    ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
  };
}

export async function fetchWorkspaceUnfurlSettings(
  workspaceId: string
): Promise<WorkspaceUnfurlSettings> {
  return workspaceUnfurlSettingsFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/unfurl-settings`
    )
  );
}

export async function updateWorkspaceUnfurlSettings(
  workspaceId: string,
  enabled: boolean
): Promise<WorkspaceUnfurlSettings> {
  return workspaceUnfurlSettingsFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/unfurl-settings`,
      { method: "PUT", body: JSON.stringify({ enabled }) }
    )
  );
}

/**
 * Fetch image bytes through the authenticated server proxy. The strict path
 * gate makes it impossible to attach a bearer to a remote image host.
 */
export async function fetchUnfurlImage(
  imageUrl: string,
  signal?: AbortSignal
): Promise<Blob> {
  if (!isUnfurlImagePath(imageUrl)) {
    throw new ApiError(400, "not an unfurl image proxy path");
  }
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase()}${imageUrl}`, {
      headers,
      ...(signal ? { signal } : {}),
    });
  };
  let res = await send(coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await rotateAfterUnauthorized()) res = await send(coreSession().getAccessToken());
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

// ---- 메시지 검색 (goal B12 H5) ----------------------------------------------
// GET /v1/workspaces/{ws}/search/messages?q=&limit=&cursor=
//
// 서버가 **이미** 싣고 있는 경로다(routes::search::messages, 도메인
// crates/momo-messaging/src/search.rs). 아래 모양은 그 두 파일에서 읽은 것이고
// 추측이 없다:
//
//   q       공백을 걷어낸 뒤 2자 미만이면 서버가 400. 그래서 이 클라이언트도
//           2자 미만은 아예 보내지 않는다(features/search/searchModel.ts).
//   limit   기본 20, 서버가 1..50으로 clamp한다.
//   cursor  불투명 문자열. 깨진 커서는 400이지 1페이지로 조용히 되감기지 않는다.
//
// 응답은 `{ hits: [...], nextCursor?: string }`이고 **마지막 페이지는
// `nextCursor` 키 자체가 없다**(null이 아니다). 서버 테스트가 그 사실을 못으로
// 박아 두었다(`a_last_page_omits_the_cursor_key`), 그래서 여기서도 `undefined`로
// 읽는다.
//
// 범위는 워크스페이스 전체지만 **호출자가 떠나지 않은 채널로 JOIN이 한정**된다.
// 즉 검색은 비공개 채널을 여는 구멍이 될 수 없다. 결과 없음 문구는 그 사실을
// 말해야 한다: 사용자는 "그런 말이 없었다"와 "내가 속하지 않은 채널의 말은 안
// 보인다"를 구분할 수 있어야 한다.
//
// 매칭은 pg_trgm ILIKE 부분일치라 단어 안쪽과 한국어에도 걸리고, `%`/`_`는
// 와일드카드가 아니라 **글자 그대로** 찾는다(서버가 이스케이프한다).

/** 서버 기본 페이지 크기. 서버가 1..50으로 clamp한다. */
export const SEARCH_LIMIT_DEFAULT = 20;

/** 결과 한 건 (서버 `WorkspaceMessageSearchHitDto`). */
export interface MessageSearchHit {
  channelId: string;
  messageId: string;
  seq: number;
  authorMemberId: string;
  /** 에포크 밀리초. 커서는 마이크로초를 들지만 와이어는 늘 ms다. */
  createdAtMs: number;
  /** 첫 일치 주변으로 서버가 잘라 준 본문 조각. */
  snippet: string;
  /** `snippet` 안에서 일치가 시작하는 0-기준 위치. */
  matchOffset: number;
}

export interface MessageSearchPage {
  hits: MessageSearchHit[];
  /** 다음 페이지가 없으면 서버가 이 키를 아예 빼고 보낸다. */
  nextCursor?: string;
}

function searchHitFromWire(value: unknown): MessageSearchHit | null {
  const channelId = str(value, "channelId");
  const messageId = str(value, "messageId");
  const authorMemberId = str(value, "authorMemberId");
  const seq = num(value, "seq");
  const createdAtMs = num(value, "createdAtMs");
  const snippet = str(value, "snippet");
  const matchOffset = num(value, "matchOffset");
  if (
    channelId === undefined ||
    messageId === undefined ||
    authorMemberId === undefined ||
    seq === undefined ||
    createdAtMs === undefined ||
    snippet === undefined
  ) {
    return null;
  }
  return {
    channelId: channelId.toLowerCase(),
    messageId: messageId.toLowerCase(),
    authorMemberId: authorMemberId.toLowerCase(),
    seq,
    createdAtMs,
    snippet,
    // 위치를 못 읽으면 강조만 포기한다. 결과 한 건을 통째로 버릴 이유는 아니다.
    matchOffset: matchOffset ?? 0,
  };
}

/**
 * `channelId` narrows the search to one channel (BT-3 / #1931). It is left OFF
 * the query string when absent rather than sent empty: the server reads `?
 * channel=` as the workspace scope too, but an absent parameter is what this
 * request actually means, and a cursor minted under one scope is refused under
 * the other — so the two spellings must not blur here.
 */
export async function searchMessages(
  workspaceId: string,
  query: string,
  options: {
    limit?: number;
    cursor?: string;
    channelId?: string;
    signal?: AbortSignal;
  } = {}
): Promise<MessageSearchPage> {
  const params = new URLSearchParams({ q: query });
  params.set("limit", String(options.limit ?? SEARCH_LIMIT_DEFAULT));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  if (options.channelId !== undefined) params.set("channel", options.channelId);
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/search/messages?${params.toString()}`,
    options.signal === undefined ? {} : { signal: options.signal }
  );
  const source = responseRecord(res);
  const hits = arrayField<unknown>(source, "hits") ?? [];
  const nextCursor = str(source, "nextCursor");
  return {
    hits: hits
      .map(searchHitFromWire)
      .filter((hit): hit is MessageSearchHit => hit !== null),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/**
 * One oldest-first page of thread replies (ascending channel seq). `limit` is
 * clamped to 1...200 by the server; the work session panel asks for the ceiling
 * because a session thread is an event log, not a conversation.
 */
export function fetchThreadReplies(
  workspaceId: string,
  channelId: string,
  rootId: string,
  cursor?: number,
  limit?: number
): Promise<{ messages: Message[]; nextCursor?: number }> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set("cursor", String(cursor));
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ messages: Message[]; nextCursor?: number }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(
      rootId
    )}/replies${suffix}`
  );
}

/**
 * Per-request model/effort override (ADR-0134 D1 `routing`).
 *
 * Contract of record for THIS surface is the mention tier, MOMO-625: it adds
 * exactly one key to `SendMessageRequest.allowedKeys` and makes that request
 * closed-world in the same commit, so a server that knows the key answers 400
 * for a bad value and a server that does not know it drops the key in silence.
 * Which of the two is on the other end is not guessable from a GET, so the
 * composer never sends this block until `probeSendRouting` has proved the
 * surface (features/routing/capability.ts).
 *
 * Optional on the wire and omitted entirely when nothing is overridden, so a
 * send that inherits carries the exact body it carried before this ticket.
 */
export interface RequestRouting {
  model?: string;
  effort?: string;
}

/**
 * 한 번의 전송에 실을 수 있는 선택들.
 *
 * 위치 인자를 늘리는 대신 객체인 이유: `routing`(ADR-0134)과 `replyToId`(ADR-0148)는
 * 서로 아무 관계가 없고 둘 다 없을 때가 대부분이라, `send(ws, ch, id, body,
 * undefined, quoteId)`처럼 빈 자리를 세는 호출부가 생기면 그 자리를 하나 밀어
 * 쓰는 실수가 조용히 컴파일된다.
 */
export interface SendMessageOptions {
  routing?: RequestRouting;
  /**
   * ADR-0148 — 이 전송이 가리키는 메시지. 같은 채널이어야 하고(규칙 2), 서버가
   * 트랜잭션 안에서 확인한 뒤 아니면 거절한다. `rootId`와 독립이다.
   */
  replyToId?: string;
  /**
   * ADR-0151 — 이 전송에 묶을, **이미 완료된** 첨부의 id들. 서버는 메시지를 쓰는
   * 그 트랜잭션 안에서 묶고, 한 건이라도 거절되면 메시지째 롤백한다
   * (`attachment.rs:399-403`). 그래서 이 배열이 비어 있지 않은 전송은 전부
   * 성공하거나 전부 실패하며, 파일 없이 나간 메시지라는 중간 결과가 없다.
   *
   * 없을 때는 키 자체가 빠진다. 전송 요청은 closed-world라 모르는 키는 400이고,
   * 첨부 없는 전송은 이 티켓 이전과 **바이트 단위로 같은 요청**이어야 한다.
   */
  attachmentIds?: string[];
  /**
   * ADR-0113 증보 3 F5 - 컴포저에서 고른 공식 앱의 id들(앱 칩). 서버가 전송 트랜잭션 안에서 검증한다: 사람이
   * 쓴 메시지, 이 워크스페이스에 설치된 활성 공식 앱, 중복을 뺀 3개 이하. 어기면 코드 달린 400
   * `apps_unavailable`이고, 그때 클라이언트는 칩을 지우고 앱 목록을 새로 받는다(초안 본문은 남긴다).
   * 통과한 목록은 서버 소유 키 `props.requestedApps`로 저장된다(`requestedAppsFromWire`).
   *
   * **표시일 뿐 허가가 아니다** - 배달과 `tool_grants`는 이 필드를 읽지 않는다. 없거나 비어 있으면 키 자체가 빠진다.
   * 옛 서버의 전송 요청은 closed-world라 이 키를 400으로 거절하므로, `listAppRuntimes`가 표면을 확인해 주기 전에는
   * 보내지 않는다.
   */
  apps?: string[];
}

export function sendMessage(
  workspaceId: string,
  channelId: string,
  clientMsgId: string,
  bodyText: string,
  options?: SendMessageOptions
): Promise<Message> {
  // The key is absent, not null, when there is no override: the server's send
  // path is closed-world, so a key it does not know is a 400 whether its value
  // is meaningful or not.
  const body: Record<string, unknown> = {
    clientMsgId,
    type: "text",
    body: bodyText,
  };
  if (options?.routing) body.routing = options.routing;
  if (options?.replyToId !== undefined) body.replyToId = options.replyToId;
  if (options?.attachmentIds !== undefined && options.attachmentIds.length > 0) {
    body.attachmentIds = options.attachmentIds;
  }
  if (options?.apps !== undefined && options.apps.length > 0) {
    body.apps = options.apps;
  }
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

/**
 * Reply inside a thread. The SAME write path as `sendMessage` with `rootId`
 * set (server `SendMessageRequest.rootId`), which is exactly how the mac client
 * shares a work excerpt into a session thread (ChatViewModel.shareWorkExcerpt
 * calls sendReply with the session's root message). There is no dedicated
 * excerpt endpoint on the server, and inventing one client-side would be a
 * second write path into the same ledger.
 */
export function sendThreadReply(
  workspaceId: string,
  channelId: string,
  rootId: string,
  clientMsgId: string,
  bodyText: string,
  options?: Pick<SendMessageOptions, "attachmentIds">
): Promise<Message> {
  const body: Record<string, unknown> = {
    clientMsgId,
    rootId,
    type: "text",
    body: bodyText,
  };
  if (options?.attachmentIds !== undefined && options.attachmentIds.length > 0) {
    body.attachmentIds = options.attachmentIds;
  }
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

// ---- 첨부 3경로 (ADR-0151 D1 / openapi tag `attachments`) --------------------
//
// 비대칭이 이 세 함수의 전부다: **올라갈 때 바이트는 이 서버를 지나지 않고,
// 내려올 때는 반드시 지난다.**
//
//   POST …/attachments/uploads          → Drive 재개 가능 세션 + pending 행
//   PUT  <uploadUrl>                    → 브라우저가 Drive에 직접 (여기 없다)
//   POST …/attachments/{id}/complete    → 크기·mime·file id 대조 후 complete
//   GET  …/attachments/{id}/content     → 멤버십 확인 후 바이트 프록시
//
// 가운데 PUT이 이 파일에 없는 이유는 두 가지다. 첫째, 그것은 **베어러를 실으면
// 안 되는 유일한 요청**이다(capability URL이 곧 인가다 — mac 테스트가 그
// Authorization 부재를 단정한다). 둘째, 진행률을 재려면 `XMLHttpRequest`가
// 필요하고 코어는 그것을 들일 수 없다. 그 절반은
// `clients/web/src/features/attachments/uploadTransport.ts`에 있다.

/** openapi `MessageAttachment` — 메시지에 묶인 첨부 한 건. */
export interface MessageAttachment {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

/** openapi `AttachmentUploadResponse`. `uploadUrl`은 불투명한 capability다. */
export interface AttachmentUpload {
  id: string;
  status: "pending";
  uploadUrl: string;
}

/** openapi `Attachment` — 완료 라우트가 돌려주는 행. */
export interface AttachmentRow {
  id: string;
  channelId: string;
  uploaderMemberId: string;
  messageId?: string;
  name: string;
  mime: string;
  size: number;
  status: "pending" | "complete" | "failed";
  createdAtMs: number;
}

function attachmentPath(workspaceId: string, channelId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/channels/${encodeURIComponent(channelId)}/attachments`;
}

/**
 * 재개 가능 업로드 세션을 연다. 아직 바이트는 한 바이트도 움직이지 않았다.
 *
 * 응답의 `uploadUrl`은 **비밀**이다. 로그에도, 오류 문장에도, 화면에도 남기지
 * 않는다(mac `MomoServerRESTChatBackend.swift:262-264`이 같은 규율을 적는다).
 */
export async function createAttachmentUpload(
  workspaceId: string,
  channelId: string,
  file: { name: string; mime: string; size: number }
): Promise<AttachmentUpload> {
  const source = responseRecord(
    await request<unknown>(`${attachmentPath(workspaceId, channelId)}/uploads`, {
      method: "POST",
      body: JSON.stringify(file),
    })
  );
  const id = str(source, "id");
  const uploadUrl = str(source, "uploadUrl");
  if (id === undefined || uploadUrl === undefined) throw new WireShapeError();
  return { id, status: "pending", uploadUrl };
}

/**
 * Drive가 실제로 들고 있는 것과 사람이 선언한 것을 대조하게 한다.
 *
 * 멱등이다: 이미 complete인 행을 다시 완료하면 그 행이 그대로 돌아온다. 어긋나면
 * 서버는 `failed`를 **커밋한 뒤** 409로 답한다 — 그 순서가 정직한 순서라고
 * 서버가 자기 주석에 적어 뒀다.
 */
export async function completeAttachmentUpload(
  workspaceId: string,
  channelId: string,
  attachmentId: string
): Promise<AttachmentRow> {
  const source = responseRecord(
    await request<unknown>(
      `${attachmentPath(workspaceId, channelId)}/${encodeURIComponent(
        attachmentId
      )}/complete`,
      { method: "POST" }
    )
  );
  const id = str(source, "id");
  const name = str(source, "name");
  const mime = str(source, "mime");
  const size = num(source, "size");
  const status = str(source, "status");
  if (
    id === undefined ||
    name === undefined ||
    mime === undefined ||
    size === undefined ||
    status === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id,
    channelId: str(source, "channelId") ?? channelId,
    uploaderMemberId: str(source, "uploaderMemberId") ?? "",
    ...(str(source, "messageId") === undefined
      ? {}
      : { messageId: str(source, "messageId") as string }),
    name,
    mime,
    size,
    status: status as AttachmentRow["status"],
    createdAtMs: num(source, "createdAtMs") ?? 0,
  };
}

/**
 * 인가 프록시로 바이트를 받는다.
 *
 * `request()`를 쓰지 않는 이유는 그것이 JSON만 아는 문이기 때문이다: `Blob`을
 * 텍스트로 읽어 `JSON.parse`에 넣는 순간 이미지가 파싱 오류가 된다. 401 회전은
 * 여기서 다시 한 번 손으로 적는다 — 세션 만료가 첨부에서만 다르게 보이면 안 된다.
 *
 * 마감도 다르다. 15초는 REST 한 왕복의 인내심이지 8 MB 이미지의 것이 아니다.
 */
export async function fetchAttachmentContent(
  workspaceId: string,
  channelId: string,
  attachmentId: string,
  signal?: AbortSignal,
  onProgress?: AttachmentProgress
): Promise<Blob> {
  const path = `${attachmentPath(workspaceId, channelId)}/${encodeURIComponent(
    attachmentId
  )}/content`;
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase()}${path}`, {
      headers,
      ...(signal ? { signal } : {}),
    });
  };
  let res = await send(coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await rotateAfterUnauthorized()) res = await send(coreSession().getAccessToken());
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return onProgress === undefined ? res.blob() : readBlobWithProgress(res, onProgress);
}

/**
 * 받은 바이트 수(`loaded`)와 전체(`total`). 전체는 서버가 `Content-Length`로 알려 준 값이고,
 * 알려 주지 않았거나(교차 출처 응답은 그 헤더를 노출해야 읽힌다) 압축된 응답이라 헤더가 풀린
 * 바이트 수를 말하지 않으면 `null`이다. 그때는 부르는 쪽이 아는 크기(첨부 메타)로 가늠한다.
 */
export type AttachmentProgress = (loaded: number, total: number | null) => void;

/**
 * 본문을 스트림으로 읽으며 진행을 알린다. `res.blob()`과 같은 값을 돌려주되 바이트가 오는 동안
 * 몇 번째까지 왔는지 말한다 — 잰 값 없이 퍼센트를 만들지 않는다(데스크탑 다운로드 패널, #4587).
 * 스트림이 없는 런타임은 다 받은 뒤 한 번만 알린다.
 */
async function readBlobWithProgress(
  res: Response,
  onProgress: AttachmentProgress
): Promise<Blob> {
  const declared = Number(res.headers.get("content-length"));
  const encoded = (res.headers.get("content-encoding") ?? "").trim() !== "";
  const total = !encoded && Number.isFinite(declared) && declared > 0 ? declared : null;
  const type = res.headers.get("content-type") ?? "";
  const stream = res.body;
  if (stream === null) {
    const blob = await res.blob();
    onProgress(blob.size, total ?? blob.size);
    return blob;
  }
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  return new Blob(chunks, { type });
}

// ---- 워크스페이스 아바타 (ADR-0161 D5) --------------------------------------
//
// 첨부(위)의 세 경로를 워크스페이스에 맞춰 다시 쓴 것이다. 올릴 때 바이트는 이
// 서버를 지나지 않고(Drive capability URL), 내려올 때는 인가 프록시를 지난다 —
// 같은 비대칭. 다른 것은 셋: 채널이 아니라 워크스페이스에 묶이고, content 는
// 워크스페이스 멤버 누구나 읽으며(레일 상시 렌더), 세터는 owner/admin 이다.

/** `AvatarUploadResponse` — `uploadUrl` 은 불투명한 Drive capability다(로그 금지). */
export interface WorkspaceAvatarUpload {
  id: string;
  status: "pending";
  uploadUrl: string;
}

function avatarPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/avatar`;
}

/** 재개 가능 아바타 업로드 세션을 연다(owner/admin 만). `mime` 은 image/* 여야 한다. */
export async function createWorkspaceAvatarUpload(
  workspaceId: string,
  file: { name: string; mime: string; size: number }
): Promise<WorkspaceAvatarUpload> {
  const source = responseRecord(
    await request<unknown>(`${avatarPath(workspaceId)}/uploads`, {
      method: "POST",
      body: JSON.stringify(file),
    })
  );
  const id = str(source, "id");
  const uploadUrl = str(source, "uploadUrl");
  if (id === undefined || uploadUrl === undefined) throw new WireShapeError();
  return { id, status: "pending", uploadUrl };
}

/** Drive 가 실제로 든 것과 선언한 것을 대조하게 하고, 맞으면 워크스페이스 아바타를 교체한다. */
export async function completeWorkspaceAvatarUpload(
  workspaceId: string,
  mediaId: string
): Promise<{ id: string; status: string }> {
  const source = responseRecord(
    await request<unknown>(
      `${avatarPath(workspaceId)}/${encodeURIComponent(mediaId)}/complete`,
      { method: "POST" }
    )
  );
  const id = str(source, "id");
  const status = str(source, "status");
  if (id === undefined || status === undefined) throw new WireShapeError();
  return { id, status };
}

/**
 * 아바타 바이트를 인가 프록시로 받는다(`fetchAttachmentContent` 와 같은 이유로
 * `request()` 를 쓰지 않는다: JSON 문이 이미지를 파싱 오류로 만든다).
 *
 * `avatarUrl` 은 서버 DTO 가 준 same-origin content 경로다(`?v={media}` 로 immutable).
 * 서버가 준 값만 받으므로 그 형태를 확인하고 넘긴다 — 임의 주소를 베어러로 치지
 * 않게 한다.
 */
export async function fetchWorkspaceAvatar(avatarUrl: string): Promise<Blob> {
  return fetchAvatarBlob(
    avatarUrl,
    /^\/v1\/workspaces\/[^/]+\/avatar\/content(\?|$)/,
    "not a workspace avatar content path"
  );
}

async function fetchAvatarBlob(
  avatarUrl: string,
  shape: RegExp,
  refusal: string
): Promise<Blob> {
  if (!shape.test(avatarUrl)) {
    throw new ApiError(400, refusal);
  }
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase()}${avatarUrl}`, { headers });
  };
  let res = await send(coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await rotateAfterUnauthorized()) res = await send(coreSession().getAccessToken());
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

// ---- 멤버 아바타 (ADR-0161 증보 2026-10-01, #3277) ---------------------------
//
// 워크스페이스 아바타(위)를 사람에게 다시 쓴 것. 쓰기는 `members/me` 뿐이다 — 경로에
// 멤버 id 가 없으므로 남의 사진을 바꾸는 요청은 만들 수조차 없다(self-only). 읽기는
// 같은 워크스페이스의 활성 멤버 누구나. 에이전트는 못 바꾼다(사람 전용).
// mime 은 png/jpeg/webp/gif 만(SVG 거절), 크기는 1B~5MiB, 서버가 파일 첫 바이트의
// 매직 넘버까지 대조해 어긋나면 complete 가 409 다.

/** 서버가 받는 멤버 아바타 mime. 클라가 파일 선택 단계에서 미리 거르는 데 쓴다. */
export const MEMBER_AVATAR_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/** 서버 상한(5 MiB). */
export const MEMBER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** `MemberAvatarResponse` — complete 가 돌려주는 완료된 미디어 행. */
export interface MemberAvatarMedia {
  id: string;
  memberId: string;
  status: string;
  /** 이 멤버의 roster `avatarUrl` 이 이제 가질 버전 붙은 content 경로. */
  avatarUrl: string;
}

function myAvatarPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/me/avatar`;
}

/** 내 아바타 업로드 세션을 연다. `uploadUrl` 은 불투명한 Drive capability 다(로그 금지). */
export async function createMyAvatarUpload(
  workspaceId: string,
  file: { name: string; mime: string; size: number }
): Promise<WorkspaceAvatarUpload> {
  const source = responseRecord(
    await request<unknown>(`${myAvatarPath(workspaceId)}/uploads`, {
      method: "POST",
      body: JSON.stringify(file),
    })
  );
  const id = str(source, "id");
  const uploadUrl = str(source, "uploadUrl");
  if (id === undefined || uploadUrl === undefined) throw new WireShapeError();
  return { id, status: "pending", uploadUrl };
}

/** Drive 가 든 바이트를 서버가 대조(크기·mime·매직 넘버)하게 하고, 맞으면 내 아바타로 삼는다. */
export async function completeMyAvatarUpload(
  workspaceId: string,
  mediaId: string
): Promise<MemberAvatarMedia> {
  const source = responseRecord(
    await request<unknown>(
      `${myAvatarPath(workspaceId)}/${encodeURIComponent(mediaId)}/complete`,
      { method: "POST" }
    )
  );
  const id = str(source, "id");
  const memberId = str(source, "memberId");
  const status = str(source, "status");
  const avatarUrl = str(source, "avatarUrl");
  if (
    id === undefined ||
    memberId === undefined ||
    status === undefined ||
    avatarUrl === undefined
  ) {
    throw new WireShapeError();
  }
  return { id, memberId, status, avatarUrl };
}

/** 내 아바타를 지운다(이니셜로 돌아간다). 멱등 — 없어도 성공한다. 204 라 본문이 없다. */
export async function removeMyAvatar(workspaceId: string): Promise<void> {
  await authedRequest(myAvatarPath(workspaceId), { method: "DELETE" });
}

/**
 * 멤버 아바타 바이트를 인가 프록시로 받는다. `avatarUrl` 은 roster 가 준
 * same-origin content 경로(`…/members/{id}/avatar/content?v={media}`)이고, 그 형태가
 * 아니면 베어러를 싣지 않고 거절한다(임의 주소로 토큰이 새지 않게).
 */
export async function fetchMemberAvatar(avatarUrl: string): Promise<Blob> {
  return fetchAvatarBlob(
    avatarUrl,
    /^\/v1\/workspaces\/[^/]+\/members\/[^/]+\/avatar\/content(\?|$)/,
    "not a member avatar content path"
  );
}

/**
 * 승인 카드가 제안하는 사진의 바이트 (`GET …/approvals/{approval}/avatar-preview?v={sha256}`,
 * ADR-0186 증보 v3 V3-2a · v4 V4-2, #4394). 베어러가 있어야 읽히므로 `<img src>` 에 그대로 실을 수
 * 없다 — 호스트가 이 함수로 받아 실을 수 있는 스킴으로 바꾼다. 읽을 수 있는 사람은 서버가 정하고
 * (`member.avatar.set` 은 사진 주인 본인뿐) 나머지는 모두 같은 404 다. 경로가 그 모양이 아니면
 * 베어러를 싣지 않고 거절한다(임의 주소로 토큰이 새지 않게).
 */
export async function fetchApprovalAvatarPreview(previewPath: string): Promise<Blob> {
  return fetchAvatarBlob(
    previewPath,
    APPROVAL_AVATAR_PREVIEW_PATH,
    "not an approval avatar preview path"
  );
}

// ---- 자기 표시 이름 (#1873 / BZ-4e) ----------------------------------------
// PATCH /v1/workspaces/{ws}/members/me `{displayName}` and/or `{handle}`
// 사람 본인만. 표시명 정규화는 join과 같고, 위반은 400 `displayName is required`.
// 핸들은 `normalized_requested_handle`; 형식 400, 점유 409 `handle is already in use`.
// 응답 `{ member }` (login Member 형상). 역할·아바타는 이 표면의 것이 아니다.

/** PATCH /members/me with display name and/or handle in one body. */
export async function changeMyProfile(
  workspaceId: string,
  patch: { displayName?: string; handle?: string }
): Promise<Member> {
  const body: Record<string, string> = {};
  if (patch.displayName !== undefined) body.displayName = patch.displayName;
  if (patch.handle !== undefined) body.handle = patch.handle;
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/me`,
      { method: "PATCH", body: JSON.stringify(body) }
    )
  );
  return memberFromWire(source.member);
}

/**
 * PATCH /v1/workspaces/{ws}/agents/{agent} `{displayName}` (ADR-0186 증보 V4).
 * Human bearer, and the caller must be the agent's owner or a workspace
 * owner/admin. The handle never changes. 400 (empty / too long), 403, 404 and
 * 409 (`display name is already in use`) arrive as `ApiError`.
 */
export async function renameAgent(
  workspaceId: string,
  agentId: string,
  displayName: string
): Promise<Member> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "PATCH", body: JSON.stringify({ displayName }) }
    )
  );
  return memberFromWire(source.member);
}

/** Change the signed-in human member's display name. */
export async function changeMyDisplayName(
  workspaceId: string,
  displayName: string
): Promise<Member> {
  return changeMyProfile(workspaceId, { displayName });
}

/** Change the signed-in human member's handle. Past `@oldhandle` bodies stay. */
export async function changeMyHandle(
  workspaceId: string,
  handle: string
): Promise<Member> {
  return changeMyProfile(workspaceId, { handle });
}

// ---- 워크스페이스 나가기 (ADR-0161 D4) --------------------------------------
// DELETE /v1/workspaces/{ws}/members/me — 마지막 owner 는 409(먼저 이전).
// 채널 나가기(removeChannelMember)와는 다른 상위 개념이다.

/** 자기 워크스페이스 멤버십을 종료한다. 마지막 owner 면 서버가 409 로 거절한다. */
export async function leaveWorkspace(
  workspaceId: string
): Promise<{ memberId: string; status: string }> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/me`,
      { method: "DELETE" }
    )
  );
  const memberId = str(source, "memberId");
  const status = str(source, "status");
  if (memberId === undefined || status === undefined) throw new WireShapeError();
  return { memberId, status };
}

// ---- 워크스페이스 멤버 역할 (#1848 / ADR-0128 D2) ---------------------------
// PATCH /v1/workspaces/{ws}/members/{member}/role
// 채널 sibling(`…/channels/{ch}/members/{member}/role`)은 범위 밖.

function isMembershipRole(value: string | undefined): value is MembershipRole {
  return (
    value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "guest"
  );
}

/** `PATCH …/members/{id}/role` 200 body (openapi `MembershipRoleResponse`). */
export interface WorkspaceMemberRoleChange {
  memberId: string;
  scope: "workspace";
  role: MembershipRole;
}

export function workspaceMemberRoleFromWire(
  value: unknown
): WorkspaceMemberRoleChange {
  const source = responseRecord(value);
  const memberId = str(source, "memberId");
  const scope = str(source, "scope");
  const role = str(source, "role");
  if (
    memberId === undefined ||
    scope !== "workspace" ||
    !isMembershipRole(role)
  ) {
    throw new WireShapeError();
  }
  return {
    memberId: memberId.toLowerCase(),
    scope: "workspace",
    role,
  };
}

/**
 * Change a workspace membership role. The server is the authority on hierarchy,
 * last-owner, and self-management; this client only ships the requested label.
 */
export async function changeWorkspaceMemberRole(
  workspaceId: string,
  memberId: string,
  role: MembershipRole
): Promise<WorkspaceMemberRoleChange> {
  return workspaceMemberRoleFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId
      )}/members/${encodeURIComponent(memberId)}/role`,
      { method: "PATCH", body: JSON.stringify({ role }) }
    )
  );
}

// ---- 휘발 신호: 「작성 중」 (ADR-0149) ---------------------------------------
// POST /v1/workspaces/{ws}/channels/{ch}/typing/grant   ← 멤버십 읽기 1회
// POST /v1/workspaces/{ws}/channels/{ch}/typing         ← 발행, **PG 미접촉**
//
// 두 라우트인 이유는 서버 쪽 문서(`routes/ephemeral.rs`)가 길게 적어 뒀고, 클라가
// 알아야 할 결론은 하나다: **grant를 재사용해라.** 3초 주기로 grant를 다시 받으면
// 분당 20번의 멤버십 SELECT가 되고, 그것이 두 라우트로 나눈 이유를 정확히 되돌린다.
// 만료 판단과 재사용은 `features/chat/typing.ts`의 순수 기계가 한다.

/** `POST …/typing/grant` 응답의 와이어 형상 (server `TypingGrantResponse`). */
export interface TypingGrantResponse {
  grant: string;
  /** 구독할 Centrifugo 채널. 메시지 레일과 **다른** 이름이다(가드 1). */
  channel: string;
  expiresAtMs: number;
  ttlSeconds: number;
  /** 받은 신호가 살아 있는 시간. 클라가 스스로 잊는 근거. */
  signalTtlMs: number;
  /** 아직 치고 있는 클라가 다시 보내는 간격. */
  republishIntervalMs: number;
  /** 몇 명부터 이름을 개수로 뭉치나. 서버는 뭉치지 않는다(상태가 없다). */
  aggregateThreshold: number;
}

/**
 * 60초짜리 발행 자격을 받는다. **이 채널의 멤버인지**를 서버가 여기서 한 번 읽고,
 * 발행 라우트는 그 증명을 HMAC으로만 확인한다.
 *
 * 읽기만 하는 사람은 이것을 부르지 않는다: grant는 「봐도 되나」가 아니라 「보내도
 * 되나」이고, 구독 인가는 realtime 토큰 발급과 subscribe 프록시가 이미 한다.
 */
export function requestTypingGrant(
  workspaceId: string,
  channelId: string
): Promise<TypingGrantResponse> {
  return request<TypingGrantResponse>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/typing/grant`,
    { method: "POST" }
  );
}

/** `POST …/typing` 응답 (202). */
export interface TypingSignalAck {
  channel: string;
  expiresAtMs: number;
  republishAfterMs: number;
}

/**
 * 「작성 중」 한 건을 발행한다. 바디는 grant **하나뿐**이다.
 *
 * 멤버 id도 채널 id도 「시작/정지」 플래그도 싣지 않는다 — 서버 dto가 그 부재를
 * 하나하나 의도로 적어 뒀고, 그중 클라가 지켜야 할 것은 **정지 신호를 만들지 않는
 * 것**이다. 입력이 멈추면 이 함수를 그냥 안 부르고, 소멸은 TTL이 한다.
 */
export function publishTyping(
  workspaceId: string,
  channelId: string,
  grant: string
): Promise<TypingSignalAck> {
  return request<TypingSignalAck>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/typing`,
    { method: "POST", body: JSON.stringify({ grant }) }
  );
}

// ---- Message actions (B11): edit, delete, react ----------------------------
// PATCH  /v1/workspaces/{ws}/messages/{id}
// DELETE /v1/workspaces/{ws}/messages/{id}
// PUT    /v1/workspaces/{ws}/messages/{id}/reactions/{emoji}
// DELETE /v1/workspaces/{ws}/messages/{id}/reactions/{emoji}
// GET    /v1/workspaces/{ws}/channels/{ch}/reactions
//
// Note the shape of the first four: **message-scoped, not channel-scoped**. A
// message id is already unique inside a tenant and its channel is a fact about
// the row, not something the caller asserts — so none of these takes a channel,
// and no client can move a message by naming the wrong one.

/**
 * Rewrite one's own message. The server is the authority on who may — it answers
 * 403 for anyone but the author — and the action bar's visibility rule is only
 * an affordance layered on top of that.
 *
 * Answers with the updated message so the caller applies what was actually stored,
 * rather than what it hoped the edit did. The answer is an edit projection — it
 * says the row, not the attachments, thread rollup, resolved quote or run verdict
 * around it — so the caller updates the row it holds (`applyEditedMessage`), keeps
 * those four, and drops the answer when it holds no such row (#4450).
 */
export function editMessage(
  workspaceId: string,
  messageId: string,
  bodyText: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "PATCH", body: JSON.stringify({ body: bodyText }) }
  );
}

/**
 * Soft-delete one's own message. Answers with the **tombstone** (`state:
 * "deleted"`, no body), not 204: the timeline replaces the row instead of
 * dropping it, because a message that silently vanishes leaves what reads as a
 * hole in `seq`.
 */
export function deleteMessage(
  workspaceId: string,
  messageId: string
): Promise<Message> {
  return request<Message>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" }
  );
}

/** One member's reaction moving one way (server `ReactionDeltaDto`). */
export interface ReactionDelta {
  action: "added" | "removed";
  messageId: string;
  memberId: string;
  emoji: string;
}

/**
 * Toggle one reaction. Idempotent server-side: a duplicate add and a removal of
 * something that was never there both answer 200 having changed nothing, so a
 * double-tap is harmless rather than an error the UI has to explain away.
 *
 * The emoji is a path segment, percent-encoded here — `encodeURIComponent`
 * covers both unicode emoji and the `:shortcode:` form the schema allows.
 */
export function setReaction(
  workspaceId: string,
  messageId: string,
  emoji: string,
  action: "added" | "removed"
): Promise<ReactionDelta> {
  return request<ReactionDelta>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(
      messageId
    )}/reactions/${encodeURIComponent(emoji)}`,
    { method: action === "added" ? "PUT" : "DELETE" }
  );
}

/**
 * The cold-load reaction map for a channel: `message id -> emoji -> member ids`.
 *
 * Encoded as the mapping itself with no wrapper key (the server's
 * `ReactionSnapshotDTO` uses a single-value container), which is why this is the
 * record and not `{ snapshot: … }`.
 *
 * **Ids arrive UPPERCASE here** and lowercase from the message projections — the
 * same mixed-case wire `uuidEq` exists for. `normalizeReactionSnapshot`
 * (`features/timeline/reactions.ts`) is the one place that case is folded.
 */
export type ReactionSnapshotWire = Record<string, Record<string, string[]>>;

export function fetchReactionSnapshot(
  workspaceId: string,
  channelId: string
): Promise<ReactionSnapshotWire> {
  return request<ReactionSnapshotWire>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(
      channelId
    )}/reactions`
  );
}

// ---- Message pin (이슈 #1112) ----------------------------------------------
// PUT    /v1/workspaces/{ws}/messages/{id}/pin
// DELETE /v1/workspaces/{ws}/messages/{id}/pin
// GET    /v1/workspaces/{ws}/channels/{ch}/pins
//
// The reaction shape above, verbatim: message-scoped verbs plus a channel-scoped
// cold load. The one difference is on the server and it shows here as the
// *absence* of a member in the path — a pin is the channel's fact, so there is
// no per-member axis to name and any channel member may undo one.

/** One entry of a channel's pin list (server `PinnedMessageDto`). */
export interface PinnedMessageWire {
  messageId: string;
  channelId: string;
  /** The message's own seq — what a jump scrolls to. Pinning mints none. */
  seq: number;
  authorMemberId: string;
  type: string;
  state: string;
  body: string | null;
  createdAtMs: number;
  pinnedBy: string;
  pinnedAtMs: number;
}

/** A pin moving one way (server `PinDeltaDto`). */
export interface PinDelta {
  action: "pinned" | "unpinned";
  messageId: string;
  channelId: string;
  /** false when it was already in that state. Still a success. */
  changed: boolean;
  /** The list entry, on an effective pin only. */
  pinned?: PinnedMessageWire;
}

/**
 * Pin or unpin a message. Idempotent server-side in both directions, like the
 * reaction toggle: a second pin, and an unpin of something not pinned, both
 * answer 200 having changed nothing.
 *
 * An effective pin answers with the whole list entry, so the caller inserts the
 * row it just created rather than re-reading the list to learn what it did.
 */
export function setPin(
  workspaceId: string,
  messageId: string,
  action: "pinned" | "unpinned"
): Promise<PinDelta> {
  return request<PinDelta>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/messages/${encodeURIComponent(
      messageId
    )}/pin`,
    { method: action === "pinned" ? "PUT" : "DELETE" }
  );
}

/**
 * The cold-load pin list for a channel, newest pin first.
 *
 * Wrapped on the wire (`{ pins: [...] }`) unlike the reaction snapshot, which is
 * bare only because a Swift `singleValueContainer` shipped that way. This
 * unwraps so no caller has to know that.
 */
export function fetchChannelPins(
  workspaceId: string,
  channelId: string
): Promise<PinnedMessageWire[]> {
  return request<{ pins?: PinnedMessageWire[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(
      channelId
    )}/pins`
  ).then((page) => page.pins ?? []);
}

// ---- Work sessions: the ADR-0114 session ledger (AX-3 / MOMO-618) ----------
// GET   /v1/workspaces/{ws}/work-sessions[?active=1]   (WorkSessionRoutes.list)
// PATCH /v1/workspaces/{ws}/work-sessions/{session}     (owner ends it)
//
// camelCase on the wire, ids UPPERCASE (Swift `uuidString`) while the ids
// inside a projected ACP event payload are lowercase Postgres JSON: measured
// against momowebqa on 2026-07-26, which is why every comparison here folds
// case through `uuidEq`.
//
// The list is workspace-wide and already scoped to the caller's channel
// memberships server-side (it JOINs `membership`), so a channel filter is a
// presentation choice, never an access control.

/**
 * `idle` still belongs to the live host and keeps its PTY attached. It is not
 * an ended session: `exitCode` is the last tool result across every state.
 */
export type WorkSessionStatusWire = "running" | "idle" | "orphaned" | "ended";

export interface WorkSession {
  id: string;
  workspaceId: string;
  channelId: string;
  /** The HUMAN who owns the session; only they may end it. */
  memberId: string;
  hostId: string;
  /** The channel card this session hangs under; its thread carries the events. */
  rootMessageId: string;
  tool: string;
  label: string;
  status: WorkSessionStatusWire;
  observation: "open" | "owner_only";
  observerGrantCount: number;
  remoteAttachAvailable: boolean;
  /**
   * The host published a live screen for this session (LIVE-1, ADR-0165).
   *
   * INDEPENDENT of `remoteAttachAvailable`, and the server's own DTO says so in
   * the same words: a session can offer a screen and no terminal, or the
   * reverse. A client that folds the two into one boolean offers the wrong verb
   * on one of them, so nothing here may derive one from the other.
   *
   * The signalling endpoint itself is deliberately NOT in this shape, exactly as
   * `attach_endpoint` is not: a session read is a list a whole channel can
   * fetch, and an endpoint is only ever handed out beside the capability that
   * authorises dialling it (`DisplayAttachGrant`).
   */
  remoteDisplayAvailable: boolean;
  /**
   * Somebody holds this session's keyboard, since that epoch millisecond
   * (LIVE-5a projection).
   *
   * ABSENT means nobody does. It is optional rather than `0` for the reason the
   * server's own DTO gives: a zero renders as 1970, and a surface that draws a
   * date is drawing a fact.
   *
   * THIS IS THE FIELD A RELOAD READS. `work.session.control` says the same thing
   * over Centrifugo, but that is transport: a surface that only heard the
   * envelope forgets it on refresh, and then reports "nobody is holding this"
   * about a window it simply did not hear open. The value here comes from the
   * `display_control_window` ledger, which is the boundary's source of truth.
   *
   * WHO holds it is deliberately absent, matching the broadcast. Control is
   * owner-only, so "somebody has control" is everything a reader or an agent
   * needs, and nothing typed during the window is reachable from here or from
   * anything this links to (ADR-0004 증보 3 D2).
   */
  controlStartedAt?: number;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  endReason?: string;
  resumedFromSessionId?: string;
}

export async function fetchWorkSessions(
  workspaceId: string,
  activeOnly = false
): Promise<WorkSession[]> {
  const suffix = activeOnly ? "?active=1" : "";
  const res = await request<{ workSessions: WorkSession[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions${suffix}`
  );
  return res.workSessions;
}

// ---- 팀 보드 (#2863, ADR-0194 증보 읽기 경로, #3322) ----------------------------
//
// 공유된 세션의 큐레이션 요약. 서버가 **보는 사람이 집 채널의 멤버인 것만** 돌려준다.
// 이 모양에는 터미널 글, 입력, 컨트롤, PTY, 호스트, 커밋 제목 필드가 없다. 클라이언트는
// 받은 줄을 그대로 그린다: 멤버십 거르기를 다시 하지 않는다(서버가 정본이다).

/**
 * `agent_run`은 호스팅 에이전트의 작업 실행 한 건이다(ADR-0162 증보 3 D13, AT-4 #3517).
 * 세션 원장이 아니라 `agent_run` 원장에서 온 줄이라 `sessionId`가 없고 `runId`가 있다.
 */
export type SharedSessionOrigin = "local_pty" | "host" | "agent_run";
export type SharedSessionState =
  | "waiting"
  | "running"
  | "review"
  | "idle"
  | "done"
  | "failed"
  | "stopped";

/** 숫자만. null = 모름(에이전트 레인은 항상 null). 파일 이름은 없다. */
export interface SharedWorkSessionDiff {
  added: number | null;
  deleted: number | null;
  files: number | null;
  ahead: number | null;
  behind: number | null;
  uncommitted: number | null;
}

export interface SharedWorkSession {
  /**
   * 보드 줄의 **한 가지 id**. 세션 줄은 `sessionId`, 실행(run) 줄은 `runId`다(서버는 run
   * 줄에 `sessionId` 키를 내지 않는다). 키·열기·포커스는 모두 이 값 하나로 한다.
   */
  sessionId: string;
  /** 줄의 출처. 없으면(AT-4 이전 서버·옛 시험 줄) `session`이다. */
  source?: SharedBoardSource;
  /** 실행 줄에만. `sessionId`와 같은 값이다. */
  runId?: string | null;
  /** 실행 줄: 시킨 사람. 없거나 null이면 기록이 없는 것이다(푸시도 가지 않는다). */
  requestedBy?: { memberId: string; displayName: string } | null;
  /** 실행 줄: 에이전트가 보고한 단계 수. */
  stepCount?: number | null;
  origin: SharedSessionOrigin;
  /** 세션 줄은 사람이 쓴 이름, 실행 줄은 요청자가 쓴 작업 제목. 둘 다 일반 텍스트로만 그린다. */
  label: string;
  folderLabel: string | null;
  /**
   * 세션 줄은 원장 상태(칩은 `state`를 쓴다). 실행 줄은 보드 어휘다
   * (`waiting|running|done|failed|stopped`).
   */
  status: string;
  /** 세션 줄은 시킨 사람, 실행 줄은 에이전트 멤버다. */
  owner: { memberId: string; displayName: string };
  homeChannel: { id: string; name: string | null };
  startedAtMs: number;
  endedAtMs: number | null;
  sharedAtMs: number | null;
  repo: string | null;
  /** 에이전트가 보고한 문자열일 수 있다(신뢰하지 않는다): 일반 텍스트로만 그린다. */
  branch: string | null;
  /** 로컬은 닫힌 하네스 목록, 에이전트 레인은 도구 키, 실행 줄은 `hosted`. */
  harness: string;
  state: SharedSessionState;
  /** 에이전트가 보고한 단계 표식. 신뢰하지 않는다: 일반 텍스트로만 그린다. */
  stages: string[];
  diff: SharedWorkSessionDiff;
  prUrl: string | null;
  /** 에포크 **초**. 목록 순서의 기준이다. */
  lastActivityAt: number;
  /**
   * `include=jobs` 응답의 run 줄에만(ADR-0202 D3·D4). 무엇이 이 일을 만들었나:
   * `work`(맡긴 일)·`mention`(멘션)·`thread_reply`(스레드 답글 깨우기). 모르는 값·옛 서버는 null.
   */
  trigger?: WorkJobTrigger | null;
  /** `include=jobs` 응답의 run 줄에만: ADR-0200 phase 그대로. 옛 서버는 null(보드 어휘만 있다). */
  phase?: string | null;
  /**
   * `include=jobs` 응답의 run 줄에만: 에이전트가 **스스로 보고한** 코드 결과(ADR-0162 증보 5 C1·C2).
   * 서버는 사실인지 검증하지 않는다. 화면은 항상 「에이전트 보고」 꼬리표와 함께 그린다.
   */
  agentReported?: AgentReportedResult | null;
}

export type SharedBoardSource = "session" | "run";

/** ADR-0202 D3: run 줄을 만든 것. */
export type WorkJobTrigger = "work" | "mention" | "thread_reply";

/** ADR-0162 증보 5 C1의 닫힌 칸. 모르는 값은 null로 비운다(예외 없음). */
export type AgentResultKind = "pr_opened" | "branch_only" | "vm_only" | "no_change";
export type AgentNextAction = "merge_ok" | "please_test" | "blocked" | "none";
/** ADR-0162 증보 5 C2의 닫힌 범주. */
export type AgentToolCountKey = "run" | "edit" | "read" | "search" | "web" | "other";

export interface AgentReportedResult {
  resultKind: AgentResultKind | null;
  tests: { passed: number; failed: number; notRun: number } | null;
  nextAction: AgentNextAction | null;
  /** 소문자 7~40자 hex만. */
  commitSha: string | null;
  /** 있는 범주만. 비면 null. */
  toolCounts: Partial<Record<AgentToolCountKey, number>> | null;
}

export interface SharedWorkSessionPage {
  sessions: SharedWorkSession[];
  nextCursor: string | null;
}

const SHARED_STATES: ReadonlySet<string> = new Set<SharedSessionState>([
  "waiting",
  "running",
  "review",
  "idle",
  "done",
  "failed",
  "stopped",
]);

function sharedCount(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sharedText(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function sharedPerson(
  value: unknown
): { memberId: string; displayName: string } | null {
  const source = record(value);
  if (source === null) return null;
  const memberId = str(source, "memberId");
  const displayName = str(source, "displayName");
  return memberId === undefined || displayName === undefined
    ? null
    : { memberId, displayName };
}

/**
 * 보드 한 줄을 **너그럽게** 읽는다(AT-5 #3518). 모르는 키는 버리고, 빠진 키는 비운다.
 * 줄의 id(`sessionId` 또는 `runId`)가 없으면 그릴 수 없으니 그 줄만 건너뛴다(null).
 *
 * 실행 줄은 두 가지를 세션 줄의 모양에 맞춘다(화면이 한 벌로 그리도록):
 * - 보드 어휘 `waiting`(= 큐에 있고 아직 시작 전)은 **사람의 응답을 기다리는** 세션의
 *   `waiting`과 다른 뜻이다. 그 칸에 섞이면 「응답 필요」로 읽히므로 `idle`로 옮긴다.
 * - `commits`(이 작업이 만든 커밋 수)는 `diff.ahead` 자리에 둔다.
 */
export function sharedWorkSessionFromWire(value: unknown): SharedWorkSession | null {
  const raw = record(value);
  if (raw === null) return null;
  const isRun = raw.source === "run";
  const id = isRun ? str(raw, "runId") : str(raw, "sessionId");
  if (id === undefined) return null;
  const owner = sharedPerson(raw.owner);
  const channel = record(raw.homeChannel);
  const channelId = channel === null ? undefined : str(channel, "id");
  if (owner === null || channel === null || channelId === undefined) return null;
  const diffRaw = record(raw.diff) ?? {};
  const wireState = sharedText(raw, "state") ?? "";
  const known = SHARED_STATES.has(wireState)
    ? (wireState as SharedSessionState)
    : "idle";
  const state: SharedSessionState = isRun && known === "waiting" ? "idle" : known;
  const commits = isRun ? sharedCount(raw, "commits") : null;
  const pr = record(raw.pr);
  const origin: SharedSessionOrigin = isRun
    ? "agent_run"
    : raw.origin === "host"
      ? "host"
      : "local_pty";
  const stages = Array.isArray(raw.stages)
    ? raw.stages.filter((stage): stage is string => typeof stage === "string")
    : [];
  return {
    sessionId: id,
    source: isRun ? "run" : "session",
    runId: isRun ? id : null,
    requestedBy: isRun ? sharedPerson(raw.requestedBy) : null,
    stepCount: isRun ? sharedCount(raw, "stepCount") : null,
    origin,
    label: sharedText(raw, "label") ?? "",
    folderLabel: sharedText(raw, "folderLabel"),
    status: sharedText(raw, "status") ?? "",
    owner,
    homeChannel: { id: channelId, name: sharedText(channel, "name") },
    startedAtMs: sharedCount(raw, "startedAtMs") ?? 0,
    endedAtMs: sharedCount(raw, "endedAtMs"),
    sharedAtMs: sharedCount(raw, "sharedAtMs"),
    repo: sharedText(raw, "repo"),
    branch: sharedText(raw, "branch"),
    harness: sharedText(raw, "harness") ?? "",
    state,
    stages,
    diff: {
      added: sharedCount(diffRaw, "added"),
      deleted: sharedCount(diffRaw, "deleted"),
      files: sharedCount(diffRaw, "files"),
      ahead: sharedCount(diffRaw, "ahead") ?? commits,
      behind: sharedCount(diffRaw, "behind"),
      uncommitted: sharedCount(diffRaw, "uncommitted"),
    },
    // 최상위 `prUrl`이 정본이고, 없으면 run 줄의 `pr.url`을 쓴다. 링크로 그리기 전에
    // 화면이 한 번 더 https·모양을 확인한다(`prFacts`).
    prUrl: sharedText(raw, "prUrl") ?? (pr === null ? null : sharedText(pr, "url")),
    lastActivityAt: sharedCount(raw, "lastActivityAt") ?? 0,
    trigger: isRun ? workJobTriggerOf(raw.trigger) : null,
    phase: isRun ? sharedText(raw, "phase") : null,
    agentReported: isRun ? agentReportedFromWire(raw.agentReported) : null,
  };
}

const WORK_JOB_TRIGGERS: ReadonlySet<string> = new Set<WorkJobTrigger>([
  "work",
  "mention",
  "thread_reply",
]);
const AGENT_RESULT_KINDS: ReadonlySet<string> = new Set<AgentResultKind>([
  "pr_opened",
  "branch_only",
  "vm_only",
  "no_change",
]);
const AGENT_NEXT_ACTIONS: ReadonlySet<string> = new Set<AgentNextAction>([
  "merge_ok",
  "please_test",
  "blocked",
  "none",
]);
const AGENT_TOOL_COUNT_KEYS: readonly AgentToolCountKey[] = [
  "run",
  "edit",
  "read",
  "search",
  "web",
  "other",
];
/** ADR-0162 증보 5 C1·C2의 정수 상한. 넘거나 음수·소수면 그 칸은 모름이다. */
const AGENT_REPORT_COUNT_MAX = 100_000;

function workJobTriggerOf(value: unknown): WorkJobTrigger | null {
  return typeof value === "string" && WORK_JOB_TRIGGERS.has(value)
    ? (value as WorkJobTrigger)
    : null;
}

function reportCount(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= AGENT_REPORT_COUNT_MAX
    ? value
    : null;
}

/**
 * 에이전트 보고 칸을 **너그럽게** 읽는다. 서버가 이미 닫힌 형식으로 검증했지만, 이 클라보다
 * 새 서버가 범주를 늘려도 화면이 깨지지 않게 모르는 값은 그 칸만 비운다. 칸이 하나도
 * 없으면 null이다(「에이전트 보고」 꼬리표를 빈 채로 세우지 않는다).
 */
export function agentReportedFromWire(value: unknown): AgentReportedResult | null {
  const raw = record(value);
  if (raw === null) return null;
  const resultKind =
    typeof raw.resultKind === "string" && AGENT_RESULT_KINDS.has(raw.resultKind)
      ? (raw.resultKind as AgentResultKind)
      : null;
  const nextAction =
    typeof raw.nextAction === "string" && AGENT_NEXT_ACTIONS.has(raw.nextAction)
      ? (raw.nextAction as AgentNextAction)
      : null;
  const testsRaw = record(raw.tests);
  let tests: AgentReportedResult["tests"] = null;
  if (testsRaw !== null) {
    const passed = reportCount(testsRaw, "passed");
    const failed = reportCount(testsRaw, "failed");
    const notRun = reportCount(testsRaw, "notRun");
    if (passed !== null && failed !== null && notRun !== null) {
      tests = { passed, failed, notRun };
    }
  }
  const sha =
    typeof raw.commitSha === "string" && /^[0-9a-fA-F]{7,40}$/.test(raw.commitSha)
      ? raw.commitSha.toLowerCase()
      : null;
  const countsRaw = record(raw.toolCounts);
  let toolCounts: AgentReportedResult["toolCounts"] = null;
  if (countsRaw !== null) {
    const counts: Partial<Record<AgentToolCountKey, number>> = {};
    for (const key of AGENT_TOOL_COUNT_KEYS) {
      const n = reportCount(countsRaw, key);
      if (n !== null) counts[key] = n;
    }
    toolCounts = Object.keys(counts).length > 0 ? counts : null;
  }
  if (
    resultKind === null &&
    tests === null &&
    nextAction === null &&
    sha === null &&
    toolCounts === null
  ) {
    return null;
  }
  return { resultKind, tests, nextAction, commitSha: sha, toolCounts };
}

export function sharedWorkSessionPageFromWire(value: unknown): SharedWorkSessionPage {
  const source = record(value);
  const rows = source === null ? null : arrayField(source, "sessions");
  const sessions = (rows ?? [])
    .map(sharedWorkSessionFromWire)
    .filter((row): row is SharedWorkSession => row !== null);
  const next = source === null ? undefined : source["nextCursor"];
  return {
    sessions,
    nextCursor: typeof next === "string" ? next : null,
  };
}

export async function fetchSharedWorkSessions(
  workspaceId: string,
  opts: {
    cursor?: string | null;
    limit?: number;
    /**
     * `runs`: 호스팅 에이전트의 작업 실행도 같은 목록에 섞어 달라고 한다(AT-4 #3517,
     * opt-in). 이 값을 모르는 서버는 무시하고 세션 줄만 준다.
     */
    include?: "runs";
  } = {}
): Promise<SharedWorkSessionPage> {
  const query = new URLSearchParams();
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  if (opts.cursor) query.set("cursor", opts.cursor);
  if (opts.include) query.set("include", opts.include);
  const text = query.toString();
  const suffix = text === "" ? "" : `?${text}`;
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions/shared${suffix}`
  );
  return sharedWorkSessionPageFromWire(res);
}

// ---- 「작업」 한 화면의 읽기 (ADR-0202 D4, U1 #3842) ------------------------------
//
// 새 서버는 같은 보드 경로에 `include=runs,jobs`·`who=mine|team`을 받는다(E1). 배포된 서버는
// `include`를 **정확히 "runs"일 때만** 알아보고 그 밖의 값은 400 없이 조용히 무시한다
// (`work_board.rs`의 `== Some("runs")`, `who`도 모르는 키라 무시). 그래서 400만 보고 물러서면
// 옛 서버에서 호스팅 에이전트 줄이 소리 없이 사라진다. 판정은 **응답이 `who`를 되울리는가**다:
// 새 서버는 페이지에 `who`를 싣고(E1이 지킬 계약), 옛 서버는 싣지 않는다. 되울리지 않거나 400이면
// 이 워크스페이스는 이번 실행 동안 옛 방식(`include=runs`, 「내 것」은 화면이 고른다)으로 읽고
// 다시 묻지 않는다.

export type WorkJobsWho = "mine" | "team";
/** `jobs` = 새 서버가 D3 줄과 `who`를 맞춰 준다. `legacy` = 옛 보드(호스팅 에이전트 work run만). */
export type WorkJobsMode = "jobs" | "legacy";

export interface WorkJobsPage extends SharedWorkSessionPage {
  mode: WorkJobsMode;
}

const legacyWorkJobsWorkspaces = new Set<string>();

/** 시험용: 기억한 판정을 지운다. */
export function resetWorkJobsDetection(): void {
  legacyWorkJobsWorkspaces.clear();
}

/** 이 워크스페이스를 이미 옛 서버로 판정했나(이번 실행 동안). */
export function workJobsKnownLegacy(workspaceId: string): boolean {
  return legacyWorkJobsWorkspaces.has(workspaceId.toLowerCase());
}

/** 새 서버의 표지: 페이지 머리에 보낸 `who`를 그대로 되울린다. */
export function pageEchoesWho(value: unknown, who: WorkJobsWho): boolean {
  const source = record(value);
  return source !== null && source["who"] === who;
}

export async function fetchWorkJobs(
  workspaceId: string,
  opts: { who: WorkJobsWho; cursor?: string | null; limit?: number }
): Promise<WorkJobsPage> {
  const key = workspaceId.toLowerCase();
  if (!legacyWorkJobsWorkspaces.has(key)) {
    const query = new URLSearchParams();
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.cursor) query.set("cursor", opts.cursor);
    query.set("include", "runs,jobs");
    query.set("who", opts.who);
    let res: unknown;
    let answered = true;
    try {
      res = await request<unknown>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions/shared?${query.toString()}`
      );
    } catch (error) {
      // 400 = `include=jobs`나 `who`를 모르는 서버(ADR-0202 D4의 물러서기). 다른 실패는 그대로 올린다.
      if (!(error instanceof ApiError && error.status === 400)) throw error;
      answered = false;
    }
    if (answered && pageEchoesWho(res, opts.who)) {
      return { ...sharedWorkSessionPageFromWire(res), mode: "jobs" };
    }
    legacyWorkJobsWorkspaces.add(key);
  }
  const page = await fetchSharedWorkSessions(workspaceId, {
    cursor: opts.cursor,
    limit: opts.limit,
    include: "runs",
  });
  return { ...page, mode: "legacy" };
}

/** 단건. 보이지 않는 이유가 무엇이든 404 하나다(보드에서 지우라는 뜻). */
export async function fetchSharedWorkSession(
  workspaceId: string,
  sessionId: string
): Promise<SharedWorkSession> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/shared`
  );
  const session = sharedWorkSessionFromWire(record(res)?.["session"]);
  if (session === null) throw new WireShapeError();
  return session;
}

/**
 * 「채널에 공유」 (#2867, ADR-0190 D4·D4-b, Q5): register one local pane as a
 * shared session. A HUMAN call (the person shares their own pane; a work host
 * never registers one for them). The server does the rest in one transaction:
 * it checks the host is this person's own registered desktop and that the person
 * is an active member of `channelId`, posts the root card into that channel and
 * inserts the ledger row (`origin = local_pty`). The page never publishes.
 *
 * Refusals the caller must tell apart, by `ApiError.code` (not by message):
 * `local_share_requires_registered_host` (403) → the desktop is not registered,
 * `local_share_limit` (409) → too many shared panes. A plain 403 is a channel the
 * person cannot post in.
 *
 * `folderLabel` is the folder's last path element, never a path.
 */
export interface CreateLocalWorkSessionInput {
  channelId: string;
  hostId: string;
  tool: string;
  label: string;
  folderLabel?: string | null;
}

export async function createLocalWorkSession(
  workspaceId: string,
  input: CreateLocalWorkSessionInput
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        origin: "local_pty",
        channelId: input.channelId,
        hostId: input.hostId,
        tool: input.tool,
        label: input.label,
        ...(input.folderLabel ? { folderLabel: input.folderLabel } : {}),
      }),
    }
  );
  return res.workSession;
}

/**
 * End a session. This is the PROCESS side of the ledger (the host stops holding
 * it), not "stop the current turn": the server has no turn-scoped stop for a
 * work session, and the two are deliberately different words in the UI.
 */
export async function endWorkSession(
  workspaceId: string,
  sessionId: string
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ status: "ended" }) }
  );
  return res.workSession;
}

/**
 * 작업 멈추기 응답 (N4a #3628, `WorkKillResponse`). `hostOnline`이 false면 컨트롤은 지워지지
 * 않고 맥이 다시 켜질 때 실행된다 - 화면은 「멈췄다」가 아니라 「켜지면 멈춘다」를 말해야 한다.
 */
export interface WorkKillResult {
  sessionStatus: string;
  hostOnline: boolean;
  /** 새로 쓴 것이 없다(대기 중인 kill이 이미 있거나 세션이 이미 끝났다). */
  replayed: boolean;
}

/**
 * 소유자가 자기 맥의 작업을 멈춘다 (`POST …/work-sessions/{id}/kill`, ADR-0198 「N4 확정」).
 * 본문 없음, **서명 없음**(끄는 쪽은 서명이 필요 없다 - 기기를 잃어도 멈출 수 있어야 한다).
 * `endWorkSession`(PATCH ended)은 원장 정리일 뿐 맥 프로세스를 멈추지 않는다.
 * 거절은 `ApiError.code`: kill_owner_only · kill_member_host_only · local_session_no_control ·
 * work_session_not_running · work_host_revoked.
 */
export async function killWorkSession(
  workspaceId: string,
  sessionId: string
): Promise<WorkKillResult> {
  const res = await request<Record<string, unknown>>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/kill`,
    { method: "POST" }
  );
  const sessionStatus = str(res, "sessionStatus");
  const hostOnline = bool(res, "hostOnline");
  const replayed = bool(res, "replayed");
  if (sessionStatus === undefined || hostOnline === undefined || replayed === undefined) {
    throw new WireShapeError();
  }
  return { sessionStatus, hostOnline, replayed };
}

/**
 * Continue an orphaned git lineage on an explicitly chosen eligible host.
 *
 * `signed` (#3027 → #3028): the successor session id the owner chose and the
 * owner's `momo.human.control.v2` spawn over it. They travel together or not
 * at all (400 `resume_signature_incomplete`); the server creates the new
 * session under exactly that id. Required for a member host when the server
 * requires signed instructions (403 `device_signature_required`).
 */
export async function resumeWorkSession(
  workspaceId: string,
  sessionId: string,
  targetHostId: string,
  signed?: { sessionId: string; humanSignature: HumanSignatureRequest }
): Promise<WorkSession> {
  const body: Record<string, unknown> = { targetHostId };
  if (signed) {
    body.sessionId = signed.sessionId;
    body.humanSignature = humanSignatureRequestBody(signed.humanSignature);
  }
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
  return res.workSession;
}

/**
 * Who may watch this session's terminal (ADR-0126 D1). `open` is the default and
 * matches the fact that the session thread is already public in the channel;
 * `owner_only` is the owner closing it, which also revokes every observer
 * capability already issued (server `updateObservation`).
 */
export async function setWorkSessionObservation(
  workspaceId: string,
  sessionId: string,
  observation: WorkSession["observation"]
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}`,
    { method: "PATCH", body: JSON.stringify({ observation }) }
  );
  return res.workSession;
}

// ---- Permission decision (ADR-0188 D5 §8.6, #3000 / #3013) ------------------
// POST /v1/workspaces/{ws}/work-sessions/{session}/permission-decisions
//
// Golden contract: docs/api/work-permission-decision.golden.json. The body is
// `requestEventId`·`optionId`·`kind`, plus `humanSignature` on a signed allow
// (#3028, ADR-0146 개정 D-8). `instruction` is NEVER sent: 「거부 + 지시」 is a
// plain reject here followed by a signed `input` on the instruction route
// (`sendWorkInstruction`), so the route's 400 `permission_instruction_unsupported`
// stays what it is. Only the session owner
// (= host owner) may decide; the first decision wins (same again → 200 with the
// same row, a different one → 409 `permission_already_decided`), and a lapsed,
// cancelled or withdrawn request answers 409 `permission_request_closed`.

export type WorkPermissionKind = "allow_once" | "reject_once";

export interface WorkPermissionDecisionBody {
  requestEventId: string;
  optionId: string;
  kind: WorkPermissionKind;
  /** The owner's device signature over an allow (never on a reject, D-8). */
  humanSignature?: HumanSignatureRequest;
}

// ---- The owner's device signature on the wire (ADR-0146 개정 D-5 · D-10) ----
//
// Server `HumanSignatureRequest` is `deny_unknown_fields`: a signer's extra
// output (the phone's `schema`, the desktop shell's `devicePublicKey` and
// `payloadSha256`) would turn every signed request into a 400. So the body is
// rebuilt key by key, like the decision body.

export interface HumanSignatureRequest {
  deviceKeyId: string;
  /** 128-bit random; for `input` the `clientMsgId`. */
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
  /** base64 raw r‖s. */
  signature: string;
  /** `input`: `queue` | `interrupt`. */
  mode?: "queue" | "interrupt";
  /** `permission`: `once` | `session`. */
  scope?: "once" | "session";
  /** `spawn` only. */
  agentMemberId?: string;
  folderId?: string;
}

export function humanSignatureRequestBody(
  signature: HumanSignatureRequest
): HumanSignatureRequest {
  const body: HumanSignatureRequest = {
    deviceKeyId: signature.deviceKeyId,
    nonce: signature.nonce,
    issuedAtMs: signature.issuedAtMs,
    expiresAtMs: signature.expiresAtMs,
    signature: signature.signature,
  };
  if (signature.mode !== undefined) body.mode = signature.mode;
  if (signature.scope !== undefined) body.scope = signature.scope;
  if (signature.agentMemberId !== undefined) body.agentMemberId = signature.agentMemberId;
  if (signature.folderId !== undefined) body.folderId = signature.folderId;
  return body;
}

export interface WorkPermissionRequest {
  id: string;
  sessionId: string;
  requestEventId: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  decidedOptionId?: string;
  decidedKind?: WorkPermissionKind;
  expiresAtMs?: number;
}

/**
 * The wire body, built key by key. Nothing else the caller carries (a draft
 * instruction, the session id, a stray field) can ride along: the session goes
 * in the path, and the three keys are the whole body.
 */
export function workPermissionDecisionBody(
  decision: WorkPermissionDecisionBody
): WorkPermissionDecisionBody {
  const body: WorkPermissionDecisionBody = {
    requestEventId: decision.requestEventId,
    optionId: decision.optionId,
    kind: decision.kind,
  };
  if (decision.humanSignature) {
    body.humanSignature = humanSignatureRequestBody(decision.humanSignature);
  }
  return body;
}

export async function decideWorkPermission(
  workspaceId: string,
  sessionId: string,
  decision: WorkPermissionDecisionBody
): Promise<WorkPermissionRequest> {
  const res = await request<{ permissionRequest: WorkPermissionRequest }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/permission-decisions`,
    { method: "POST", body: JSON.stringify(workPermissionDecisionBody(decision)) }
  );
  return res.permissionRequest;
}

// ---- The owner's read of one permission request (#3118 → #3128) -------------
// GET /v1/workspaces/{ws}/work-sessions/{session}/permission-requests/{requestEventId}
//
// ADR-0188 D5 「미리보기는 소유자의 조회로만」, ADR-0146 증보 2026-09-29 (R2 H1).
// The host's closed preview (`momo.work_permission.preview.v1`) as the host
// relayed it, to the session owner only (404 for anyone else — the same answer
// as a missing request). `preview` is null for a request relayed without one.
// The caller never trusts it: `checkPermissionPreview` re-hashes what it renders.

export interface WorkPermissionPreviewResponse {
  permissionRequest: WorkPermissionRequest & {
    /** Lowercase hex SHA-256 of the host's preview; absent without one. */
    previewSha256?: string;
  };
  options: Array<{ optionId: string; kind: string }>;
  /** The closed preview object, unchecked (`checkPermissionPreview` reads it). */
  preview: unknown;
}

export async function fetchWorkPermissionPreview(
  workspaceId: string,
  sessionId: string,
  requestEventId: string
): Promise<WorkPermissionPreviewResponse> {
  const res = await request<Partial<WorkPermissionPreviewResponse>>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-sessions/${encodeURIComponent(
      sessionId
    )}/permission-requests/${encodeURIComponent(requestEventId)}`
  );
  if (typeof res.permissionRequest !== "object" || res.permissionRequest === null) {
    throw new ApiError(0, "permission preview response has no request");
  }
  return {
    permissionRequest: res.permissionRequest,
    options: Array.isArray(res.options) ? res.options : [],
    preview: res.preview ?? null,
  };
}

// ---- Signed instruction (#3027 R2-E7 → #3028) --------------------------------
// POST /v1/workspaces/{ws}/work-sessions/{session}/instructions
//
// Golden: docs/api/work-instruction.golden.json. The owner's signed `input`:
// `clientMsgId` MUST equal the signature's nonce and `mode` the signed mode
// (400 `instruction_signature_mismatch`). Closed while the server does not
// require signed instructions (403 `signed_instructions_disabled`). A retry
// of the same signed instruction answers 200 with `replayed: true`.

export type WorkInstructionMode = "queue" | "interrupt";

export interface WorkInstructionBody {
  text: string;
  mode: WorkInstructionMode;
  clientMsgId: string;
  humanSignature: HumanSignatureRequest;
}

export interface WorkInstructionResult {
  workControl: { id: string; status: string };
  message: { id: string; channelId: string; rootId: string; seq: number; clientMsgId: string };
  replayed: boolean;
}

export function workInstructionBody(body: WorkInstructionBody): WorkInstructionBody {
  return {
    text: body.text,
    mode: body.mode,
    clientMsgId: body.clientMsgId,
    humanSignature: humanSignatureRequestBody(body.humanSignature),
  };
}

export async function sendWorkInstruction(
  workspaceId: string,
  sessionId: string,
  body: WorkInstructionBody
): Promise<WorkInstructionResult> {
  return request<WorkInstructionResult>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/instructions`,
    { method: "POST", body: JSON.stringify(workInstructionBody(body)) }
  );
}

// ---- Signed new-work spawn (#3570 T5 → #3592 P1) -----------------------------
// POST /v1/workspaces/{ws}/work-spawns
//
// The owner's `momo.human.control.v4` over a NEW task on their own Mac: a
// harness (「내 도구」) or a personal agent called by its alias (ADR-0198 D7).
// It is not a chat message — the message is sent first by the ordinary send
// path and this call names it (`originMessageId`). Closed while the server
// does not require signed controls (403 `signed_spawn_disabled`); a retry of
// the same signed spawn answers 200 with `replayed: true`.

export interface WorkSpawnBody {
  /** The harness key the host launches (`claude`, `codex`, …): signed. */
  tool: string;
  /** The card title: one trimmed NFC line, signed. */
  label: string;
  /** The whole first prompt, NFC: signed. */
  prompt: string;
  channelId: string;
  /** The thread the owner called from, when it was said in one: signed. */
  threadRootId?: string;
  /** The owner's own message the call came from: signed. */
  originMessageId?: string;
  /** Narrows which of the owner's Macs; the server derives the host. */
  targetHostId?: string;
  /** `folderId` required; `agentMemberId` only for a personal agent. */
  humanSignature: HumanSignatureRequest;
}

export interface WorkSpawnResult {
  workControl: { id: string; status: string };
  replayed: boolean;
}

/** The request body, key by key: the server's body is closed-world. */
export function workSpawnBody(body: WorkSpawnBody): WorkSpawnBody {
  const out: WorkSpawnBody = {
    tool: body.tool,
    label: body.label,
    prompt: body.prompt,
    channelId: body.channelId,
    humanSignature: humanSignatureRequestBody(body.humanSignature),
  };
  if (body.threadRootId !== undefined) out.threadRootId = body.threadRootId;
  if (body.originMessageId !== undefined) out.originMessageId = body.originMessageId;
  if (body.targetHostId !== undefined) out.targetHostId = body.targetHostId;
  return out;
}

export async function postWorkSpawn(
  workspaceId: string,
  body: WorkSpawnBody
): Promise<WorkSpawnResult> {
  return request<WorkSpawnResult>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-spawns`,
    { method: "POST", body: JSON.stringify(workSpawnBody(body)) }
  );
}

// ---- Terminal attach capability (ADR-0126 D1 / ADR-0125 D10) ----------------
// POST /v1/workspaces/{ws}/work-sessions/{session}/terminal-attach
//
// This is a CONTROL PLANE call and nothing else. The server mints a 60 second
// opaque bearer and hands back the host's own endpoint; it carries no stream,
// no socket and no relay (TerminalAttachRoutes: "There is intentionally no
// stream, websocket, stdin, stdout, resize, or relay route in this server").
// The bytes then flow client <-> host directly, which is the invariant that
// keeps raw terminal output off momo's servers.
//
// The response is snake_case, unlike every camelCase body above; it is the
// wire shape the mac client already consumes, and renaming it here would hide
// which fields came from the server.
//
// `mode` is the D1 grade. The web client only ever asks for `observer`: a
// controller grant carries stdin/resize/kill rights this client has no code to
// use (see features/work/observerStream.ts, which cannot encode those frames).

export interface TerminalAttachGrant {
  /** The HOST's endpoint, https/wss, credential free (server-validated). */
  attach_endpoint: string;
  /** Opaque bearer, 60s TTL, validated by the host against this server. */
  capability_token: string;
  pty_id: string;
}

export async function issueObserverTerminalAttach(
  workspaceId: string,
  sessionId: string
): Promise<TerminalAttachGrant> {
  return request<TerminalAttachGrant>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/terminal-attach`,
    { method: "POST", body: JSON.stringify({ mode: "observer" }) }
  );
}

// ---- Display attach capability (LIVE-1 / ADR-0165) --------------------------
// POST /v1/workspaces/{ws}/work-sessions/{session}/display-attach
//
// The screen twin of the block above, and the same kind of call: a control
// plane request that mints a 60 second bearer and hands back the HOST's own
// address. What it hands back is the sandbox's WebRTC SIGNALLING socket, and
// momo carries neither the signalling nor the media that follows: no SFU, no
// TURN of ours, no recording (ADR-0165 D2/D3/D5). The server module holding the
// other end says it plainly: "nothing here opens a socket".
//
// It is a separate function rather than a `kind` argument on the one above for
// the reason the server split the routes: the two responses carry different
// required fields (`pty_id` vs `display_id`), and one shape with both optional
// would let a caller dial the wrong stream on a typo.
//
// snake_case for `TerminalAttachGrant`'s reason: it is the sibling of a body
// two shipped clients already parse that way, and one attach response in each
// case would be a trap for whoever writes the third.

/**
 * One entry of `RTCConfiguration.iceServers`, in the W3C's own spelling because
 * the array is handed to `RTCPeerConnection` unchanged.
 *
 * The credential is minted per work session and expires on its own; momo hands
 * it out and still carries no media (ADR-0165 D3 — the relay is oort-operated
 * and never a third party's).
 */
export interface IceServerConfig {
  urls: string[];
  username: string;
  credential: string;
}

export interface DisplayAttachGrant {
  /**
   * The HOST's own WebRTC signalling endpoint, https/wss, credential free and
   * query free (server-validated on the way in AND on the way out).
   */
  display_endpoint: string;
  /** Opaque bearer, 60s TTL, validated by the producer against this server. */
  capability_token: string;
  display_id: string;
  /**
   * The grade the server actually minted: `"observer"` or, for the session
   * owner asking for it by name, `"controller"`.
   *
   * It is read rather than assumed. A view-only stream that LOOKS identical to a
   * controllable one is how a person ends up typing into a window that will
   * never deliver a keystroke, so the client checks the word the server sent
   * before it renders a screen, and refuses anything else instead of guessing.
   */
  mode: string;
  /**
   * When the control window opened, in epoch milliseconds. Present only on a
   * controller grant.
   *
   * The caller's own copy of the boundary event `work.session.control` carries,
   * so the surface that just took the keyboard can say when it took it without
   * waiting for the relay to tell it what it already did.
   */
  control_started_at?: number;
  /**
   * The relay this grant may allocate through, with a credential minted for
   * this session.
   *
   * ALWAYS PRESENT and EMPTY on an instance that was given no relay policy. A
   * client must read empty as **use what you were already configured with**,
   * never as an error: the openapi description says so in those words, and a
   * client that draws an error there would break every self-hosted instance
   * that never had a relay to be given.
   */
  ice_servers: IceServerConfig[];
}

/**
 * Ask for a view-only display capability.
 *
 * `observer` is sent explicitly rather than left to the route's default, and it
 * is HARDCODED rather than taken as an argument. That is the whole boundary in
 * one line: a caller of this function cannot ask for `controller`, because
 * there is no parameter to ask with, so no typo and no forwarded variable can
 * turn a watch into a takeover.
 *
 * The grade that CAN stop an agent lives in its own function below, with its
 * own name, so that "who can mint a controller grant" is answerable by grepping
 * for one identifier.
 */
export async function issueDisplayAttach(
  workspaceId: string,
  sessionId: string
): Promise<DisplayAttachGrant> {
  return request<DisplayAttachGrant>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/display-attach`,
    { method: "POST", body: JSON.stringify({ mode: "observer" }) }
  );
}

/**
 * Take this session's keyboard (ADR-0004 증보 3 / LIVE-5).
 *
 * A SEPARATE FUNCTION, not a `mode` argument on the one above, and the reason
 * is what this call does rather than what it returns. It opens a control window
 * in the ledger, and while that window stands the agent's own path into this
 * session is refused and observation is forced to 소유자만 보기. That is not a
 * variation of watching; it is the act of stopping a running agent, and the
 * call that performs it should be impossible to reach by passing a variable to
 * the call that does not.
 *
 * Owner only, and the server is the one that enforces it (403 for anybody
 * else). A surface must still not OFFER it to a non-owner: a control that
 * exists only to answer 403 is an affordance that lies.
 */
export async function issueControllerDisplayAttach(
  workspaceId: string,
  sessionId: string
): Promise<DisplayAttachGrant> {
  return request<DisplayAttachGrant>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/display-attach`,
    { method: "POST", body: JSON.stringify({ mode: "controller" }) }
  );
}

/** What the server says about the window this return just closed, or did not. */
export interface DisplayControlReturn {
  /**
   * Whether THIS call is what closed a standing window. `false` is a success:
   * a retried return, a lease that had already lapsed, or a session that ended
   * underneath it. All three mean the same thing to a reader — nobody holds the
   * keyboard now — and none of them is an error to report.
   */
  closed: boolean;
}

/**
 * Hand the screen back to the agent.
 *
 * IDEMPOTENT by the server's contract, which is what makes it safe to call from
 * an automatic path: the three ways a window closes (this call, a lapsed lease,
 * the session ending) can race, and a client that treated "already closed" as a
 * failure would put an error banner in front of a person whose control had in
 * fact been returned.
 */
export async function returnDisplayControl(
  workspaceId: string,
  sessionId: string
): Promise<DisplayControlReturn> {
  return request<DisplayControlReturn>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/display-control`,
    { method: "DELETE" }
  );
}

/**
 * Registered execution host (ADR-0125 D1). `type` is what decides whether the
 * ACP event relay behind a session is a verified path: `app` is the local
 * client host, everything else is a remote workd/cloud host whose normalised
 * ACP relay is still in flight (X-11 / MOMO-546), so the panel must not draw a
 * remote session's silence as "quiet".
 */
export interface WorkHost {
  id: string;
  workspaceId: string;
  scope: "member" | "workspace";
  ownerMemberId: string;
  type: string;
  displayName: string;
  capabilities: Record<string, boolean>;
  lastSeenAtMs?: number;
  revokedAtMs?: number;
  createdAtMs: number;
  online: boolean;
  /**
   * The folders this host issued (#3590, ADR-0188 D6): an opaque id and the
   * name to show — never a path. Present only on the viewer's OWN live host;
   * absent on anybody else's row (ADR-0188 §8.8) and on a revoked host.
   */
  folders?: WorkHostFolder[];
  /**
   * The folder a request that names none uses: the host's `question` folder
   * (ADR-0198 증보 1 D7). Absent when the host has none — a client then asks the
   * owner to pick; it never falls back to a project folder on its own.
   */
  defaultFolderId?: string;
}

export interface WorkHostFolder {
  id: string;
  displayName: string;
  /** `question` = the host-issued empty 「질문용 폴더」. */
  kind: "project" | "question";
}

export async function fetchWorkHosts(workspaceId: string): Promise<WorkHost[]> {
  const res = await request<{ workHosts: WorkHost[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/work-hosts`
  );
  return arrayField<WorkHost>(res, "workHosts") ?? [];
}

// ---- Workstreams: the goal layer over Runs (ADR-0143, WorkstreamRoutes) -----
// GET /v1/workspaces/{ws}/workstreams?status=&channelId=&sessionId=&limit=
// GET /v1/workspaces/{ws}/workstreams/{workstream}
// GET /v1/workspaces/{ws}/workstreams/{workstream}/runs
//
// A workstream is one GOAL anchored on a thread root message; a work session is
// one RUN of it. `run.memberId` is that Run's actor and is never transferred
// (D2), so the run list is the evidence that a goal outlived the person who
// started it: A's run and B's run stand side by side under one goal.
//
// THE THREE READS ARE DELIBERATELY ASYMMETRIC AND A CLIENT MUST NOT EVEN THEM
// OUT (WorkstreamRoutes "minimum exposure"): a caller outside the anchor channel
// gets ZERO rows from the list and 404 — not 403 — from the detail and the run
// list, so these reads cannot be used to probe for other people's work. Only
// `resumeWorkSession` answers 403, and only because by then the caller is acting
// on a session they were shown. `isNotFound` is exported so a surface can say
// "찾을 수 없습니다" for the first case and talk about permission only for the
// second; a UI that renders 404 as "권한이 없습니다" hands back exactly the
// existence signal the server refused.
//
// There is no write here on purpose: explicit create/split/merge is ADR-0143 P2,
// and continuing a workstream reuses the lineage resume above rather than
// inventing a second verb for the same act.

export const WORKSTREAM_STATUSES = [
  "active",
  "paused",
  "done",
  "cancelled",
] as const;

export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number];

export interface Workstream {
  id: string;
  workspaceId: string;
  channelId: string;
  /** The anchor thread. The workstream extends the thread, never replaces it. */
  rootMessageId: string;
  goal: string;
  status: WorkstreamStatus;
  /** Provenance only. Eligibility to continue is channel membership (D3). */
  createdByMemberId: string;
  createdAtMs: number;
  updatedAtMs: number;
  runCount: number;
  activeRunCount: number;
}

/**
 * One Run of a workstream. `status` stays a plain string rather than the work
 * session union: `workSessionStatus()` already answers "상태 확인 필요" for a
 * value it does not know, and a goal's whole history failing to render because
 * the ledger grew a fifth state is a worse answer than one unnamed row.
 */
export interface WorkstreamRun {
  id: string;
  memberId: string;
  hostId: string;
  tool: string;
  label: string;
  status: string;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  endReason?: string;
  /** Set when this Run continued another one — the lineage, inside one goal. */
  resumedFromSessionId?: string;
}

export interface WorkstreamRunList {
  workstreamId: string;
  runs: WorkstreamRun[];
}

export interface WorkstreamQuery {
  status?: WorkstreamStatus;
  channelId?: string;
  sessionId?: string;
  limit?: number;
}

function isWorkstreamStatus(value: string): value is WorkstreamStatus {
  return (WORKSTREAM_STATUSES as readonly string[]).includes(value);
}

export function workstreamFromWire(value: unknown): Workstream {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const channelId = str(source, "channelId");
  const rootMessageId = str(source, "rootMessageId");
  const goal = str(source, "goal");
  const status = str(source, "status");
  const createdByMemberId = str(source, "createdByMemberId");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  const runCount = num(source, "runCount");
  const activeRunCount = num(source, "activeRunCount");
  if (
    id === undefined ||
    workspaceId === undefined ||
    channelId === undefined ||
    rootMessageId === undefined ||
    goal === undefined ||
    status === undefined ||
    !isWorkstreamStatus(status) ||
    createdByMemberId === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    runCount === undefined ||
    activeRunCount === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    channelId: channelId.toLowerCase(),
    rootMessageId: rootMessageId.toLowerCase(),
    goal,
    status,
    createdByMemberId: createdByMemberId.toLowerCase(),
    createdAtMs,
    updatedAtMs,
    runCount,
    activeRunCount,
  };
}

export function workstreamListFromWire(value: unknown): Workstream[] {
  const source = responseRecord(value);
  const workstreams = arrayField(source, "workstreams");
  if (workstreams === null) throw new WireShapeError();
  return workstreams.map(workstreamFromWire);
}

export function workstreamRunFromWire(value: unknown): WorkstreamRun {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const memberId = str(source, "memberId");
  const hostId = str(source, "hostId");
  const tool = str(source, "tool");
  const label = str(source, "label");
  const status = str(source, "status");
  const startedAtMs = num(source, "startedAtMs");
  if (
    id === undefined ||
    memberId === undefined ||
    hostId === undefined ||
    tool === undefined ||
    label === undefined ||
    status === undefined ||
    startedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  const endedAtMs = optionalFiniteNumber(source, "endedAtMs");
  const exitCode = optionalFiniteNumber(source, "exitCode");
  const endReason = optionalString(source, "endReason");
  const resumedFromSessionId = optionalString(source, "resumedFromSessionId");
  return {
    id: id.toLowerCase(),
    memberId: memberId.toLowerCase(),
    hostId: hostId.toLowerCase(),
    tool,
    label,
    status,
    startedAtMs,
    ...(endedAtMs === undefined ? {} : { endedAtMs }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(endReason === undefined ? {} : { endReason }),
    ...(resumedFromSessionId === undefined
      ? {}
      : { resumedFromSessionId: resumedFromSessionId.toLowerCase() }),
  };
}

export function workstreamRunListFromWire(value: unknown): WorkstreamRunList {
  const source = responseRecord(value);
  const workstreamId = str(source, "workstreamId");
  const runs = arrayField(source, "runs");
  if (workstreamId === undefined || runs === null) throw new WireShapeError();
  return {
    workstreamId: workstreamId.toLowerCase(),
    runs: runs.map(workstreamRunFromWire),
  };
}

export async function fetchWorkstreams(
  workspaceId: string,
  query: WorkstreamQuery = {}
): Promise<Workstream[]> {
  const params = new URLSearchParams();
  if (query.status !== undefined) params.set("status", query.status);
  if (query.channelId !== undefined) {
    params.set("channelId", query.channelId.toLowerCase());
  }
  if (query.sessionId !== undefined) {
    params.set("sessionId", query.sessionId.toLowerCase());
  }
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const search = params.toString();
  return workstreamListFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId.toLowerCase())}/workstreams${
        search === "" ? "" : `?${search}`
      }`
    )
  );
}

export async function fetchWorkstream(
  workspaceId: string,
  workstreamId: string
): Promise<Workstream> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/workstreams/${encodeURIComponent(workstreamId.toLowerCase())}`
    )
  );
  return workstreamFromWire(source.workstream);
}

export async function fetchWorkstreamRuns(
  workspaceId: string,
  workstreamId: string
): Promise<WorkstreamRunList> {
  return workstreamRunListFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/workstreams/${encodeURIComponent(workstreamId.toLowerCase())}/runs`
    )
  );
}

// ---- Approvals: read projection over the decision ledger --------------------
// GET /v1/workspaces/{ws}/approvals?status=&limit= (ApprovalDecisionRoutes).
// Rows are scoped by channel membership server-side and ordered
// `expires_at NULLS LAST, created_at DESC`.
//
// ## 두 표기를 다 읽는다 (goal M-AP1 2R)
//
// 이 클라이언트가 만나는 서버는 둘이고 **키 표기가 다르다**:
//
//   * 정본 스펙 `docs/api/openapi.yaml`의 `ApprovalProjection` = snake_case
//     (Swift 서버가 그렇게 보냈고, 이 파서는 원래 그것만 읽었다).
//   * 이식된 Rust 서버의 `ApprovalDto`(`bins/momo-server/src/dto.rs:2213`) =
//     `#[serde(rename_all = "camelCase")]`.
//
// 한쪽만 읽는 파서는 다른 쪽 서버에서 **모든 행을 조용히 버린다** — `filter`가
// 형상 검사를 통과하지 못한 행을 떨어뜨리므로 오류 하나 없이 빈 목록이 되고,
// 빈 목록은 사람 자리에서 「결정할 것이 없다」로 읽힌다. 그 문장은 승인이 실제로
// 기다리고 있을 때 거짓이다. 그래서 필드마다 두 표기를 모두 본다.
//
// 어느 쪽이 옳은지는 이 파일이 정할 일이 아니다(서버/스펙 소유자의 결정이고 PR
// 이탈로 올렸다). 클라이언트가 할 수 있는 정직한 일은 **둘 다 읽는 것**이다.
//
// ## `payload`는 이제 타입에 있다 — 필요한 한 조각만
//
// 예전 주석은 "tool 인자/경로는 제품 UI에서 불투명하게 둔다"며 payload를 통째로
// 제외했다. 그 결과 화면에는 `action_type`만 남았는데, 이 서버가 보내는
// action_type은 언제나 `tool_call`이라 행 제목이 내부 식별자가 됐다.
// 무엇을 허가하는지는 `payload.tool_call.name`에만 있다
// (`crates/momo-agent/src/approval.rs:566-590` 실측). 그래서 **이름 하나만**
// 꺼낸다 — 인자는 여전히 꺼내지 않는다(경로·프롬프트는 제품 UI의 몫이 아니다).

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface Approval {
  id: string;
  workspaceId: string;
  runId: string;
  channelId: string;
  /** The message carrying the approval card, when the run wrote one. */
  requestMessageId?: string;
  /** The AGENT member that asked. Agents are members (ADR-0004). */
  requestedBy: string;
  /** The human the agent acted for, when the run recorded one. */
  onBehalfOf?: string;
  /** Approval class as the ledger stores it, e.g. `tool_call` / `work.spawn`. */
  actionType: string;
  /**
   * 이 승인이 실행하려는 툴의 이름 (`payload.tool_call.name`), 있을 때만.
   *
   * `actionType`과 다른 층위다: `tool_call`은 "툴 호출 승인"이라는 갈래 이름이고
   * 사람이 알아야 하는 것은 **어떤 툴인가**이다. 없을 수도 있으므로 옵셔널이고,
   * 없으면 화면은 지어내지 않는다.
   */
  toolName?: string;
  status: ApprovalStatus;
  /**
   * 서버가 **명시적으로** 실은 가역성 플래그.
   *
   * 부재는 "모른다"이지 "되돌릴 수 있다"가 아니다 — 서버가 그렇게 못박았다
   * (`dto.rs:2210-2212`). 판정은 `features/inbox/model.ts`가 fail-closed로 한다.
   */
  isReversible?: boolean;
  /**
   * 이 승인이 **어디서 실행할지**까지 묻는 경우의 재료 (ADR-0125 D6-A, #1114).
   *
   * `payload.execution`에만 있고 스폰 승인에만 실린다. 여기서 이름 한 조각이
   * 아니라 객체를 통째로 꺼내는 것이 위 `toolName`의 규율과 어긋나 보이지만
   * 아니다: 그 규율이 막는 것은 **호스트 로컬 사실**(경로·프롬프트·인자)이
   * 화면으로 새는 것이고, 이 객체에는 그런 것이 한 조각도 없다. 서버가 이 칸에
   * 무엇을 넣지 않기로 했는지 명시해 두었다(`SpawnHostCandidate::to_json`:
   * 호스트 로컬 경로·환경·프로세스 상태·자격증명 없음). 남은 것은 등록된 기계의
   * 표시 이름과 그것을 고를 수 있는지 여부뿐이고, 그 둘은 **사람이 결정하기 위해
   * 반드시 봐야 하는 것**이다.
   */
  execution?: SpawnExecutionPlan;
  decidedBy?: string;
  decidedAtMs?: number;
  decisionReason?: string;
  expiresAtMs?: number;
  /**
   * 워크스페이스 행동 승인(`actionType === "workspace_action"`)의 레지스트리 id
   * (`payload.action.id`, ADR-0186 부록 A). 이름 한 조각만 꺼낸다 — `args`에는
   * 사람이 판단할 값이 들어 있지만 행 문장은 카드가 이미 갖고 있고, 인박스 행이
   * 할 말은 「무엇을 허가하는가」 한마디다 (#3729).
   */
  workspaceActionId?: string;
}

/**
 * 한 필드를 두 표기로 찾는다: snake_case(정본 스펙) 먼저, 없으면 camelCase(Rust).
 *
 * 순서에 의미는 없다 — 한 행이 두 표기를 섞어 보낼 일은 없고, 섞여 오더라도 먼저
 * 발견된 값을 쓰는 것이 "둘 다 못 읽어 행을 버리는 것"보다 낫다.
 */
function wireStr(source: unknown, snake: string, camel: string): string | undefined {
  return str(source, snake) ?? str(source, camel);
}

function wireNum(source: unknown, snake: string, camel: string): number | undefined {
  return num(source, snake) ?? num(source, camel);
}

function wireBool(source: unknown, snake: string, camel: string): boolean | undefined {
  return bool(source, snake) ?? bool(source, camel);
}

/**
 * 승인이 실행하려는 툴의 이름.
 *
 * 서버가 쓰는 payload는 `{run_id, action_type, tool_call: {call_id, name,
 * arguments, arguments_json, tool_grant?}, approval_reason, resume_model}`이다
 * (`crates/momo-agent/src/approval.rs:566-590`). 여기서 **이름 한 조각만** 꺼낸다:
 * arguments에는 세션 id·경로·프롬프트가 들어 있고 그것은 인박스 행이 할 말이 아니다.
 */
function toolNameFromPayload(payload: unknown): string | undefined {
  const call = record(payload)?.["tool_call"];
  const name = str(call, "name")?.trim();
  return name !== undefined && name !== "" ? name : undefined;
}

/** `payload.action.id` — 워크스페이스 행동 승인에만 있다. */
function workspaceActionIdFromPayload(payload: unknown): string | undefined {
  const id = str(record(payload)?.["action"], "id")?.trim();
  return id !== undefined && id !== "" ? id : undefined;
}

function toApproval(value: unknown): Approval {
  const approval: Approval = {
    id: wireStr(value, "id", "id") as string,
    workspaceId: wireStr(value, "workspace_id", "workspaceId") as string,
    runId: wireStr(value, "run_id", "runId") as string,
    channelId: wireStr(value, "channel_id", "channelId") as string,
    requestedBy: wireStr(value, "requested_by", "requestedBy") as string,
    actionType: wireStr(value, "action_type", "actionType") as string,
    status: wireStr(value, "status", "status") as ApprovalStatus,
  };
  const requestMessageId = wireStr(value, "request_message_id", "requestMessageId");
  if (requestMessageId !== undefined) approval.requestMessageId = requestMessageId;
  const onBehalfOf = wireStr(value, "on_behalf_of", "onBehalfOf");
  if (onBehalfOf !== undefined) approval.onBehalfOf = onBehalfOf;
  const toolName = toolNameFromPayload(record(value)?.["payload"]);
  if (toolName !== undefined) approval.toolName = toolName;
  const execution = parseExecutionPlan(record(value)?.["payload"]);
  if (execution !== null) approval.execution = execution;
  const workspaceActionId = workspaceActionIdFromPayload(record(value)?.["payload"]);
  if (workspaceActionId !== undefined) approval.workspaceActionId = workspaceActionId;
  const isReversible = wireBool(value, "is_reversible", "isReversible");
  if (isReversible !== undefined) approval.isReversible = isReversible;
  const decidedBy = wireStr(value, "decided_by", "decidedBy");
  if (decidedBy !== undefined) approval.decidedBy = decidedBy;
  const decidedAtMs = wireNum(value, "decided_at_ms", "decidedAtMs");
  if (decidedAtMs !== undefined) approval.decidedAtMs = decidedAtMs;
  const decisionReason = wireStr(value, "decision_reason", "decisionReason");
  if (decisionReason !== undefined) approval.decisionReason = decisionReason;
  const expiresAtMs = wireNum(value, "expires_at_ms", "expiresAtMs");
  if (expiresAtMs !== undefined) approval.expiresAtMs = expiresAtMs;
  return approval;
}

/** 필수 칸이 두 표기 중 하나로라도 다 있는 행만 쓴다. */
export function isWireApproval(value: unknown): boolean {
  return (
    wireStr(value, "id", "id") !== undefined &&
    wireStr(value, "workspace_id", "workspaceId") !== undefined &&
    wireStr(value, "run_id", "runId") !== undefined &&
    wireStr(value, "channel_id", "channelId") !== undefined &&
    wireStr(value, "requested_by", "requestedBy") !== undefined &&
    wireStr(value, "action_type", "actionType") !== undefined &&
    wireStr(value, "status", "status") !== undefined
  );
}

/** One approval status page. The server clamps `limit` to 1...500. */
export async function fetchApprovals(
  workspaceId: string,
  status: ApprovalStatus = "pending",
  limit = 50
): Promise<Approval[]> {
  const res = await request<{ approvals: unknown[] }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/approvals?status=${status}&limit=${limit}`
  );
  return approvalsFromWire(res);
}

/**
 * `{approvals: [...]}` 한 페이지를 행 목록으로. 형상이 아닌 행은 조용히 버린다 —
 * 한 행이 이상하다고 나머지를 못 보여줄 이유는 없다.
 *
 * 내보내는 이유는 이 파일의 다른 디코더들과 같다: 네트워크 없이 **와이어 형상
 * 자체**를 테스트할 수 있어야 하고, 이 프로젝션은 표기가 둘이라 그 테스트가 특히
 * 필요하다.
 */
export function approvalsFromWire(value: unknown): Approval[] {
  const approvals = arrayField(value, "approvals");
  return approvals === null ? [] : approvals.filter(isWireApproval).map(toApproval);
}

// ---- Agent runs: work projection ------------------------------------------
// GET /v1/workspaces/{ws}/channels/{ch}/agent-runs (type=work only, the server
// rejects any other value). camelCase on the wire, unlike read-state/approvals.

export type AgentRunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface AgentRun {
  id: string;
  workspaceId: string;
  agentMemberId: string;
  channelId: string;
  triggerMessageId?: string;
  status: AgentRunStatus;
  stepCount: number;
  maxSteps: number;
  /** Validated work input: `{ type, title, brief, repo?, branch? }`. */
  input?: Record<string, unknown>;
  /**
   * 에이전트가 스스로 알린 보고(`{ stages, artifacts }`, ADR-0162 증보 3 D11·D12).
   * 모양을 믿지 않는다: `agentRunReport`가 읽는다.
   */
  output?: unknown;
  /**
   * 「쓴 앱」(ADR-0113 증보 2 E8, #3946): 실행 장소가 **스스로 알린** 앱 사용. 서버가
   * 검증하지 않은 자기 보고다. 보고가 없으면(옛 서버·벤더 경로) 키 자체가 없다.
   */
  appsUsed?: AppsUsedEntry[];
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** 「쓴 앱」 한 줄. 와이어 키는 이 셋뿐이다(본문·인자·결과·URL·토큰이 실릴 키가 없다). */
export interface AppsUsedEntry {
  pluginId: string;
  tool: string;
  calls: number;
}

const APPS_USED_MAX_ENTRIES = 16;
const APPS_USED_KEYS = new Set(["pluginId", "tool", "calls"]);
// 서버 `is_plugin_id`와 같다: `^[a-z0-9][a-z0-9._-]{2,127}$`.
const APPS_USED_PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const APPS_USED_TOOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APPS_USED_MAX_CALLS = 100000;

/**
 * 서버(`routes::apps_used`)와 **같은 닫힌 규칙**으로 「쓴 앱」을 읽는다: 모양이 하나라도
 * 어긋나면(미지 키·중복 쌍·범위 밖 calls·17개) 보고 전체를 버린다. 빈 배열·없음도 null이라
 * 빈 꼬리를 만들지 않는다. 던지지 않는다.
 */
export function appsUsedFromWire(value: unknown): AppsUsedEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > APPS_USED_MAX_ENTRIES) return null;
  const entries: AppsUsedEntry[] = [];
  const pairs = new Set<string>();
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !APPS_USED_KEYS.has(key))) return null;
    const { pluginId, tool, calls } = item;
    if (typeof pluginId !== "string" || !APPS_USED_PLUGIN_ID.test(pluginId)) return null;
    if (typeof tool !== "string" || !APPS_USED_TOOL.test(tool)) return null;
    if (
      typeof calls !== "number" ||
      !Number.isInteger(calls) ||
      calls < 1 ||
      calls > APPS_USED_MAX_CALLS
    ) {
      return null;
    }
    const pair = `${pluginId}\u0000${tool}`;
    if (pairs.has(pair)) return null;
    pairs.add(pair);
    entries.push({ pluginId, tool, calls });
  }
  return entries;
}

const REQUESTED_APPS_MAX = 3;

/**
 * `message.props.requestedApps`(ADR-0113 증보 3 F5): 요청자가 컴포저에서 고른 공식 앱의 id들. 서버
 * (`routes::requested_apps`)는 중복 없는 3개 이하의 플러그인 id 배열만 쓴다. **모르는 모양이면 통째로 무시한다**
 * (`null`): 배열이 아니거나, 비었거나, 4개 이상이거나, 문자열이 아닌 항목·id 문법에 안 맞는 항목·중복이 하나라도
 * 있으면 서버가 쓴 값이 아니다. 던지지 않는다.
 *
 * 이 키는 **표시용 표식**이다 - 허가도 배달 판정도 아니다. 칩은 사람이 쓴 메시지에만 그린다(그 판단은 호출부).
 */
export function requestedAppsFromWire(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > REQUESTED_APPS_MAX) {
    return null;
  }
  const ids: string[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "string" || !APPS_USED_PLUGIN_ID.test(raw) || ids.includes(raw)) {
      return null;
    }
    ids.push(raw);
  }
  return ids;
}

/** 메시지의 `props.requestedApps`를 읽는다. 없거나 모르는 모양이면 빈 배열. */
export function requestedAppsOfMessage(message: Pick<Message, "props">): string[] {
  return requestedAppsFromWire(message.props?.["requestedApps"]) ?? [];
}

export interface AgentRunSummary {
  id: string;
  channelId: string;
  triggerMessageId?: string;
  triggerSummary?: string;
  status: AgentRunStatus;
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentRunSummaryPage {
  runs: AgentRunSummary[];
  nextCursor?: string;
}

const AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "awaiting_approval",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

function optionalFiniteNumber(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireShapeError();
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new WireShapeError();
  return value;
}

function agentRunSummaryFromWire(value: unknown): AgentRunSummary {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const channelId = str(source, "channelId");
  const status = str(source, "status");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  if (
    id === undefined ||
    channelId === undefined ||
    status === undefined ||
    !AGENT_RUN_STATUSES.has(status as AgentRunStatus) ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    channelId: channelId.toLowerCase(),
    status: status as AgentRunStatus,
    createdAtMs,
    updatedAtMs,
    ...(optionalString(source, "triggerMessageId") === undefined
      ? {}
      : { triggerMessageId: optionalString(source, "triggerMessageId")?.toLowerCase() }),
    ...(optionalString(source, "triggerSummary") === undefined
      ? {}
      : { triggerSummary: optionalString(source, "triggerSummary") }),
    ...(optionalFiniteNumber(source, "startedAtMs") === undefined
      ? {}
      : { startedAtMs: optionalFiniteNumber(source, "startedAtMs") }),
    ...(optionalFiniteNumber(source, "finishedAtMs") === undefined
      ? {}
      : { finishedAtMs: optionalFiniteNumber(source, "finishedAtMs") }),
  };
}

/** Parse the bounded MOMO-653 history page without accepting partial rows. */
export function agentRunSummaryPageFromWire(value: unknown): AgentRunSummaryPage {
  const source = responseRecord(value);
  const runs = arrayField(source, "runs");
  if (runs === null) throw new WireShapeError();
  const nextCursor = optionalString(source, "nextCursor");
  return {
    runs: runs.map(agentRunSummaryFromWire),
    ...(nextCursor === undefined ? {} : { nextCursor: nextCursor.toLowerCase() }),
  };
}

// ---- Agent runs: server-derived progress (ADR-0200 D1~D3) ------------------
// GET /v1/workspaces/{ws}/channels/{ch}/agent-runs/progress
// GET /v1/workspaces/{ws}/agent-runs/{run}/events
//
// 이 두 읽기는 클라이언트가 추정하던 것(「작업 중」·「신호 소실」)을 서버가 직접
// 답하게 한다. `AgentRunPhase`는 realtime 프레임의 `AgentPhaseWire`
// (thinking/streaming/done/error)와 **다른 어휘**다: 앞의 것은 서버가 DB 사실로
// 파생한 run 상태이고, 뒤의 것은 워커가 스트림 도중 내보내는 단계다. 두 낱말이
// 한 변수에 섞이면 「대기」를 「작업 중」으로 그리던 옛 버그가 돌아온다.

/** 서버가 파생한 run 상태. 클라이언트는 이 값을 고르지 않고 그린다. */
export type AgentRunPhase =
  | "queued"
  | "claimed"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

/**
 * 전달 job의 lease. `stale`은 만료됐고 아무도 다시 가져가지 않았다는 뜻이다:
 * 에이전트가 돌아올 수 있으므로 「끊김」이 아니다.
 */
export type AgentLeaseState = "live" | "stale" | "none";

export interface AgentRunProgress {
  id: string;
  channelId: string;
  agentMemberId: string;
  triggerMessageId?: string;
  triggerSummary?: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  leaseState: AgentLeaseState;
  stepCount: number;
  claimedAtMs?: number;
  latestStage?: string;
  lastEventAtMs?: number;
  approvalId?: string;
  approvalExpiresAtMs?: number;
  /** 서버가 쓴 닫힌 코드(`approval_expired` …). 모르는 코드도 그대로 온다. */
  endReason?: string;
  /** 1 = 다음에 가져갈 순서. 아직 아무도 가져가지 않은 run에만 있다. */
  queuePosition?: number;
  /** 에이전트 큐에서 내 앞에 있는 가져가지 않은 run 수(모든 채널). */
  aheadTotal?: number;
  /** 그중 내가 멤버인 채널의 것. 다른 채널의 것은 숫자로만 센다. */
  ahead: { runId: string; channelId: string }[];
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  /**
   * 부른 사람이 없는 시스템 작업(환영 run, ADR-0181)인가. **서버가 보낸 값이 아니다.**
   * 진행 읽기에는 환영 표지(`welcome_kind`)가 없고 ADR-0200 증보 3 E6은 새 필드를 만들지
   * 않았다. 그래서 와이어 경계(`agentRunProgressFromWire`)가 「트리거 메시지도 사람이 쓴
   * 작업 제목도 없다」로 가른다. 서버의 트리거는 넷이고(멘션·스레드 답글은 메시지 id,
   * 작업은 필수 제목, 환영만 둘 다 없다) 그 밖의 모양은 만들지 않는다 — 사람이 부른 run이
   * 둘 다 없이 오는 길은 없다(`RunTrigger::trigger_message_id`, `validated_work_input`의
   * `required_string`, `trigger_summary`; 시험 「서버가 만드는 네 트리거의 와이어 모양」).
   * 서버가 새 트리거를 더하면 이 판별을 서버의 명시 표지로 바꾼다(#4442).
   */
  system?: true;
}

const AGENT_RUN_PHASES = new Set<AgentRunPhase>([
  "queued",
  "claimed",
  "running",
  "awaiting_approval",
  "paused",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const AGENT_LEASE_STATES = new Set<AgentLeaseState>(["live", "stale", "none"]);

function optionalPositiveInt(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const value = optionalFiniteNumber(source, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new WireShapeError();
  return value;
}

export function agentRunProgressFromWire(value: unknown): AgentRunProgress {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const channelId = str(source, "channelId");
  const agentMemberId = str(source, "agentMemberId");
  const status = str(source, "status");
  const phase = str(source, "phase");
  const leaseState = str(source, "leaseState");
  const stepCount = num(source, "stepCount");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  if (
    id === undefined ||
    channelId === undefined ||
    agentMemberId === undefined ||
    status === undefined ||
    !AGENT_RUN_STATUSES.has(status as AgentRunStatus) ||
    phase === undefined ||
    !AGENT_RUN_PHASES.has(phase as AgentRunPhase) ||
    leaseState === undefined ||
    !AGENT_LEASE_STATES.has(leaseState as AgentLeaseState) ||
    stepCount === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  const aheadRaw = source.ahead;
  if (aheadRaw !== undefined && aheadRaw !== null && !Array.isArray(aheadRaw)) {
    throw new WireShapeError();
  }
  const ahead = (aheadRaw ?? []).map((entry: unknown) => {
    const row = record(entry);
    const runId = row === null ? undefined : str(row, "runId");
    const aheadChannel = row === null ? undefined : str(row, "channelId");
    if (runId === undefined || aheadChannel === undefined) {
      throw new WireShapeError();
    }
    return { runId: runId.toLowerCase(), channelId: aheadChannel.toLowerCase() };
  });
  const triggerMessageId = optionalString(source, "triggerMessageId");
  const triggerSummary = optionalString(source, "triggerSummary");
  const claimedAtMs = optionalFiniteNumber(source, "claimedAtMs");
  const latestStage = optionalString(source, "latestStage");
  const lastEventAtMs = optionalFiniteNumber(source, "lastEventAtMs");
  const approvalId = optionalString(source, "approvalId");
  const approvalExpiresAtMs = optionalFiniteNumber(source, "approvalExpiresAtMs");
  const endReason = optionalString(source, "endReason");
  const queuePosition = optionalPositiveInt(source, "queuePosition");
  const aheadTotal = optionalPositiveInt(source, "aheadTotal");
  const startedAtMs = optionalFiniteNumber(source, "startedAtMs");
  const finishedAtMs = optionalFiniteNumber(source, "finishedAtMs");
  // 「부른 사람이 없다」: 메시지도, 사람이 쓴 작업 제목·멘션 발췌도 없다(`AgentRunProgress.system`).
  // 비었는지는 **글자 그대로** 본다(`=== ""`). 서버가 이미 다듬어(Rust `trim()`) 보내고 빈 것은
  // 싣지 않는다(`trigger_summary`) — 여기서 JS `trim()`으로 한 번 더 다듬으면 서버는 제목으로 센
  // 글자(U+FEFF만 있는 제목)를 우리는 「제목 없음」으로 읽어, 사람이 부른 작업이 홈 카드에서
  // 사라진다. 의심스러우면 숨기지 않는 쪽으로 틀린다(#4285 planner 결정 1).
  const system =
    (triggerMessageId === undefined || triggerMessageId === "") &&
    (triggerSummary === undefined || triggerSummary === "");
  return {
    id: id.toLowerCase(),
    channelId: channelId.toLowerCase(),
    agentMemberId: agentMemberId.toLowerCase(),
    status: status as AgentRunStatus,
    phase: phase as AgentRunPhase,
    leaseState: leaseState as AgentLeaseState,
    stepCount,
    ahead,
    createdAtMs,
    updatedAtMs,
    ...(system ? { system: true as const } : {}),
    ...(triggerMessageId === undefined
      ? {}
      : { triggerMessageId: triggerMessageId.toLowerCase() }),
    ...(triggerSummary === undefined ? {} : { triggerSummary }),
    ...(claimedAtMs === undefined ? {} : { claimedAtMs }),
    ...(latestStage === undefined ? {} : { latestStage }),
    ...(lastEventAtMs === undefined ? {} : { lastEventAtMs }),
    ...(approvalId === undefined ? {} : { approvalId: approvalId.toLowerCase() }),
    ...(approvalExpiresAtMs === undefined ? {} : { approvalExpiresAtMs }),
    ...(endReason === undefined ? {} : { endReason }),
    ...(queuePosition === undefined ? {} : { queuePosition }),
    ...(aheadTotal === undefined ? {} : { aheadTotal }),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
  };
}

export function agentRunProgressPageFromWire(value: unknown): AgentRunProgress[] {
  const source = responseRecord(value);
  const runs = arrayField(source, "runs");
  if (runs === null) throw new WireShapeError();
  return runs.map(agentRunProgressFromWire);
}

/**
 * 원장 행의 닫힌 어휘(openapi `AgentRunEvent.kind`). `doorbell_rung`은
 * `?include=doorbell`로 읽을 때만 온다(ADR-0200 증보 2026-10-14, #3824).
 */
export type AgentRunLedgerKnownKind =
  | "queued"
  | "claimed"
  | "started"
  | "stage"
  | "paused"
  | "resumed"
  | "approval_requested"
  | "approval_decided"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "doorbell_rung";

/**
 * 이 클라이언트가 아는 종류, 그리고 모르는 종류 하나(`unknown`). 서버는 클라이언트보다
 * 먼저 새 종류를 싣는다(#3830 `doorbell_rung`, ADR-0200 증보 2026-10-15 `tool_call`).
 * 모르는 행 하나 때문에 원장 전체를 버리면 사람은 기록이 통째로 사라진 화면을 본다.
 */
export type AgentRunLedgerKind = AgentRunLedgerKnownKind | "unknown";

const AGENT_RUN_LEDGER_KINDS = new Set<AgentRunLedgerKnownKind>([
  "queued",
  "claimed",
  "started",
  "stage",
  "paused",
  "resumed",
  "approval_requested",
  "approval_decided",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "doorbell_rung",
]);

export interface AgentRunLedgerEvent {
  /** 읽는 순간의 1-기반 순번. 키로 쓰지 않는다(200행 상한이 오래된 stage를 지운다). */
  ordinal: number;
  kind: AgentRunLedgerKind;
  /** `kind === "unknown"`일 때 서버가 보낸 낱말 그대로. 화면에 내지 않는다(진단용). */
  rawKind?: string;
  /** 에이전트가 보고한 단계 표식(≤80자). 신뢰하지 않는 일반 텍스트. `stage`에만 있다. */
  stage?: string;
  /** 서버가 쓴 닫힌 코드(`approved`, `approval_expired` …). */
  code?: string;
  approvalId?: string;
  actorMemberId?: string;
  createdAtMs: number;
}

export interface AgentRunLedger {
  runId: string;
  events: AgentRunLedgerEvent[];
}

export function agentRunLedgerFromWire(value: unknown): AgentRunLedger {
  const source = responseRecord(value);
  const runId = str(source, "runId");
  const events = arrayField(source, "events");
  if (runId === undefined || events === null) throw new WireShapeError();
  return {
    runId: runId.toLowerCase(),
    events: events.map((entry) => {
      const row = record(entry);
      if (row === null) throw new WireShapeError();
      const ordinal = num(row, "ordinal");
      const kind = str(row, "kind");
      const createdAtMs = num(row, "createdAtMs");
      if (ordinal === undefined || kind === undefined || createdAtMs === undefined) {
        throw new WireShapeError();
      }
      // 모르는 종류는 원장을 거부하지 않고 `unknown` 한 줄로 남긴다(#3824). 행의
      // 모양(순번·시각) 자체가 틀린 것은 여전히 거부한다.
      const known = AGENT_RUN_LEDGER_KINDS.has(kind as AgentRunLedgerKnownKind);
      const stage = optionalString(row, "stage");
      const code = optionalString(row, "code");
      const approvalId = optionalString(row, "approvalId");
      const actorMemberId = optionalString(row, "actorMemberId");
      return {
        ordinal,
        kind: known ? (kind as AgentRunLedgerKnownKind) : "unknown",
        ...(known ? {} : { rawKind: kind }),
        createdAtMs,
        ...(stage === undefined ? {} : { stage }),
        ...(code === undefined ? {} : { code }),
        ...(approvalId === undefined ? {} : { approvalId: approvalId.toLowerCase() }),
        ...(actorMemberId === undefined
          ? {}
          : { actorMemberId: actorMemberId.toLowerCase() }),
      };
    }),
  };
}

/**
 * 이 채널의 hosted 에이전트 run들의 서버 판정(ADR-0200 D1·D3). 구 서버에는 이
 * 경로가 없고 404/405/501로 답한다 — 호출자는 `serverSaysAbsent`로 접는다.
 */
export async function fetchAgentRunProgress(
  workspaceId: string,
  channelId: string,
  options: { state?: "active" | "all"; limit?: number } = {}
): Promise<AgentRunProgress[]> {
  const query = new URLSearchParams({
    state: options.state ?? "all",
    limit: String(options.limit ?? 50),
  });
  return agentRunProgressPageFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/channels/${encodeURIComponent(
        channelId.toLowerCase()
      )}/agent-runs/progress?${query.toString()}`
    )
  );
}

/**
 * run 하나의 원장 전체(≤200행). 커서가 없으니 매번 통째로 다시 읽는다.
 *
 * `?include=doorbell`(#3824): 깨우는 신호 행(`doorbell_rung`)을 함께 달라는 요청이다.
 * 그 행을 아는 서버(#3830)만 싣고, 모르는 서버(v0.1.24 이전)는 쿼리를 읽지 않으므로
 * 그냥 예전 원장을 준다 — 그것이 옛 서버의 폴백이다. 다만 쿼리를 읽고 모르는 값이면
 * 400을 내는 서버가 생길 수 있어, 400이면 쿼리 없이 한 번 더 읽는다(`absentInclude`).
 * 이 클라이언트는 `doorbell` 외의 값을 보내지 않는다.
 */
export async function fetchAgentRunEvents(
  workspaceId: string,
  runId: string,
  options: { includeDoorbell?: boolean } = {}
): Promise<AgentRunLedger> {
  const base = `/v1/workspaces/${encodeURIComponent(
    workspaceId.toLowerCase()
  )}/agent-runs/${encodeURIComponent(runId.toLowerCase())}/events`;
  if (options.includeDoorbell !== true || ledgerIncludeRejected) {
    return agentRunLedgerFromWire(await request<unknown>(base));
  }
  try {
    return agentRunLedgerFromWire(await request<unknown>(`${base}?include=doorbell`));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    // 같은 경로가 틀린 run id에도 400을 낸다. 쿼리 없이 읽기가 **성공했을 때만** 이 서버가
    // 쿼리를 거절한다고 기억한다 — 그렇지 않으면 400 한 번이 세션 내내 깨움 줄을 끈다.
    const ledger = agentRunLedgerFromWire(await request<unknown>(base));
    ledgerIncludeRejected = true;
    return ledger;
  }
}

/** 이 서버가 `?include=doorbell`을 400으로 거절했는가. 거절했으면 다시 묻지 않는다. */
let ledgerIncludeRejected = false;

/** 세션·워크스페이스가 바뀌면 다시 물어본다(다른 서버일 수 있다). 시험 seam이기도 하다. */
export function resetRunLedgerIncludeProbe(): void {
  ledgerIncludeRejected = false;
}

// ---- Hosted agent liveness (ADR-0200 D4, #3742) -----------------------------
// GET /v1/workspaces/{ws}/agents/{agent}/liveness
//
// 「토큰이 연결돼 있다고 연결이 아니라, 지금 살아있는지가 궁금한거야」(성재). 연결
// 상태(`status: active`)는 자격증명이 한 번 증명됐다는 뜻이고 시간이 지나도 변하지
// 않는다. 이 라벨은 서버가 자기 사실(수령·읽기·run 이벤트·ping)로 **지금** 파생한다.

export type AgentLivenessState =
  | "inactive"
  | "error"
  | "woken_not_collected"
  | "work_waiting"
  | "responsive"
  | "alive_idle"
  | "quiet"
  | "unresponsive";

const AGENT_LIVENESS_STATES = new Set<AgentLivenessState>([
  "inactive",
  "error",
  "woken_not_collected",
  "work_waiting",
  "responsive",
  "alive_idle",
  "quiet",
  "unresponsive",
]);

/** 채널을 공유하는 멤버가 보는 것: 라벨과 마지막으로 말한 때뿐이다. */
export interface AgentLiveness {
  agentMemberId: string;
  state: AgentLivenessState;
  lastSignalAtMs?: number;
}

export function agentLivenessFromWire(value: unknown): AgentLiveness {
  const source = responseRecord(value);
  const agentMemberId = str(source, "agentMemberId");
  const state = str(source, "state");
  if (
    agentMemberId === undefined ||
    state === undefined ||
    !AGENT_LIVENESS_STATES.has(state as AgentLivenessState)
  ) {
    throw new WireShapeError();
  }
  const lastSignalAtMs = optionalFiniteNumber(source, "lastSignalAtMs");
  return {
    agentMemberId: agentMemberId.toLowerCase(),
    state: state as AgentLivenessState,
    ...(lastSignalAtMs === undefined ? {} : { lastSignalAtMs }),
  };
}

/**
 * 이 hosted 에이전트가 지금 살아 있는가. hosted가 아닌 에이전트와 채널을 공유하지
 * 않는 에이전트는 같은 404다(이 경로는 「hosted인가」를 알아내는 탐침이 아니다):
 * 호출자는 404를 「라벨 없음」으로 접는다.
 */
export async function fetchAgentLiveness(
  workspaceId: string,
  agentMemberId: string
): Promise<AgentLiveness> {
  return agentLivenessFromWire(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId.toLowerCase()
      )}/agents/${encodeURIComponent(agentMemberId.toLowerCase())}/liveness`
    )
  );
}

/**
 * What `POST …/agent-runs/{run}/cancel` answers (openapi
 * `AgentRunCancelResponse`, server-rust `dto.rs`).
 *
 * Four fields and every one load-bearing, which is why none is optional.
 * `status` is always the literal `"cancelled"` — a refusal never reaches this
 * shape, it is an `ErrorResponse` — and the pair `linkedWorkSessionIds` +
 * `workSessionsTerminated: false` is the response telling the truth about what
 * it did NOT do. Cancelling stops the run and retires its queued jobs; it does
 * not kill the work sessions that run touched. A client that reports "중단했습니다"
 * without reading these two is telling someone their terminal stopped when it
 * did not.
 */
export interface AgentRunCancelResult {
  runId: string;
  status: "cancelled";
  linkedWorkSessionIds: string[];
  workSessionsTerminated: boolean;
}

/**
 * Stop one agent run, as a human channel member (ADR-0132 D1).
 *
 * Authorization is CHANNEL MEMBERSHIP, not workspace ownership — this is the
 * human stop right, and gating it on ownership would mean the person watching an
 * agent do the wrong thing has to go find someone else. Agent and work-host
 * bearers are rejected server side.
 *
 * Idempotent: cancelling an already-cancelled run answers 200 with the same body
 * and writes nothing. Every other refusal throws `ApiError` and is read by
 * `features/agents/runCancel`, which is where the sentences live.
 */
export async function cancelAgentRun(
  workspaceId: string,
  runId: string
): Promise<AgentRunCancelResult> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" }
  );
  return {
    runId: str(res, "runId") ?? runId,
    status: "cancelled",
    linkedWorkSessionIds: (arrayField(res, "linkedWorkSessionIds") ?? []).filter(
      (id): id is string => typeof id === "string"
    ),
    // Read, never assumed. The schema pins it to `false` today; a server that
    // one day terminates sessions must be able to say so without this client
    // continuing to promise the opposite.
    workSessionsTerminated:
      (res as Record<string, unknown> | null)?.workSessionsTerminated === true,
  };
}

export async function fetchAgentRuns(
  workspaceId: string,
  channelId: string,
  limit = 20
): Promise<AgentRun[]> {
  const res = await request<{ runs: AgentRun[] }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/agent-runs?limit=${limit}`
  );
  return res.runs;
}

export async function fetchAgentRunSummaries(
  workspaceId: string,
  agentMemberId: string,
  cursor?: string,
  limit = 20
): Promise<AgentRunSummaryPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor.toLowerCase());
  return agentRunSummaryPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agents/${encodeURIComponent(
      agentMemberId.toLowerCase()
    )}/runs?${query.toString()}`
  ));
}

function agentRunDetailFromWire(value: unknown): AgentRun {
  const source = responseRecord(value);
  const summary = agentRunSummaryFromWire(source);
  const workspaceId = str(source, "workspaceId");
  const agentMemberId = str(source, "agentMemberId");
  const stepCount = num(source, "stepCount");
  const maxSteps = num(source, "maxSteps");
  if (
    workspaceId === undefined ||
    agentMemberId === undefined ||
    stepCount === undefined ||
    maxSteps === undefined
  ) {
    throw new WireShapeError();
  }
  const input = record(source.input);
  const output = source.output;
  // 최상위 `appsUsed`가 정본이고, 없을 때만 저장 원문(`output.appsUsed`)을 본다.
  const appsUsed = appsUsedFromWire(
    source.appsUsed ?? record(output)?.["appsUsed"]
  );
  return {
    ...summary,
    workspaceId: workspaceId.toLowerCase(),
    agentMemberId: agentMemberId.toLowerCase(),
    stepCount,
    maxSteps,
    ...(input === null ? {} : { input }),
    ...(output === undefined || output === null ? {} : { output }),
    ...(appsUsed === null ? {} : { appsUsed }),
  };
}

export async function fetchAgentRunDetail(
  workspaceId: string,
  runId: string
): Promise<AgentRun> {
  return agentRunDetailFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agent-runs/${encodeURIComponent(runId.toLowerCase())}`
  ));
}

/**
 * 에이전트에게 작업을 맡기는 요청의 결과.
 * `replayed`는 같은 `clientRunId`의 요청이 이미 접수돼 있어서 서버가 새로 만들지
 * 않고 그 run을 돌려줬다는 뜻이다(HTTP 200, 새로 만들면 201). 두 경우 모두 성공이다.
 */
export interface CreatedAgentWorkRun {
  run: AgentRun;
  replayed: boolean;
}

/**
 * `POST /v1/workspaces/{ws}/channels/{ch}/agent-runs` 의 `type=work` (ADR-0198 D4
 * 「에이전트」 경로, ADR-0162 증보 3). 서버 변경 없음 — 이미 있는 경로의 호출이다.
 *
 * 멱등: 서버는 `(channel, actor, agent, clientRunId)`로 run을 한 건만 만든다.
 * 요청이 갔는지 모를 때(네트워크 끊김·5xx) **같은 `clientRunId`와 같은 내용**으로
 * 다시 보내면 중복 없이 같은 run이 온다. 같은 id에 다른 내용을 실으면 409다.
 *
 * 입력은 보내기 전에 서버와 같은 방식(공백 다듬기·빈 선택값 생략·UTF-8 바이트 한도)
 * 으로 정규화하고, 어긋나면 `WorkRunDraftError`를 던진다(서버는 호출되지 않는다).
 * 거절은 `ApiError`로 던져지고 문장은 `features/agents/workRunRequest`의
 * `workRunFailure`가 만든다. 응답은 느슨하게 읽는다: 모르는 필드는 무시하고,
 * run을 가리킬 `id`·`channelId`·`status` 등 필수 값이 없을 때만 `WireShapeError`다.
 */
export async function createAgentWorkRun(
  workspaceId: string,
  channelId: string,
  draft: WorkRunDraft
): Promise<CreatedAgentWorkRun> {
  const input = normalizeWorkRunInput(draft);
  const res = await authedRequest(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/channels/${encodeURIComponent(channelId.toLowerCase())}/agent-runs`,
    {
      method: "POST",
      body: JSON.stringify({
        agentMemberId: draft.agentMemberId.toLowerCase(),
        clientRunId: draft.clientRunId.toLowerCase(),
        input,
      }),
    }
  );
  return {
    run: agentRunDetailFromWire(responseRecord(res.json<unknown>())),
    replayed: res.status === 200,
  };
}

// ---- 모델·추론 강도 라우팅 (ADR-0134) ---------------------------------------
// GET     /v1/provider/effort-table                    (D2, MOMO-621)
// GET/PUT /v1/workspaces/{ws}/agents/{agent}/profile    (D3 상속 체인의 2층)
//
// The effort table is the ONE endpoint of this surface that is safe to probe:
// no side effect, no tenant row, no credential-shaped field (ADR-0004), and any
// authenticated principal may read it. features/routing/capability.ts uses that
// property to decide what this server can honestly be asked for.
//
// The body is returned untyped and shaped by `parseEffortTable`
// (features/routing/routingModel.ts), which is where the contract is pinned and
// fixture-tested, the same split the usage summary uses.

export function fetchEffortTable(signal?: AbortSignal): Promise<unknown> {
  return request<unknown>("/v1/provider/effort-table", { signal });
}

/**
 * The agent profile projection (openapi `AgentProfile`).
 *
 * `effortPref` is ADR-0134 D3's new tier and is absent from a server that
 * predates it. Absent is not "none": the two are told apart by the routing
 * capability probe, never by guessing from a missing key.
 */
export interface AgentProfile {
  agentMemberId: string;
  workspaceId: string;
  instructions: string;
  modelPref?: string;
  effortPref?: string;
  enabledTools: string[];
  /**
   * `mention` is pinned to true by the contract on both ends (openapi
   * `AgentProfileTriggers.mention` is `enum: [true]`, and the server rejects
   * anything else), so the only part that varies is `schedule`. Typed as the
   * literal because a caller echoing this object back into a PUT is doing the
   * right thing, and the type should not make it look like a re-decision.
   */
  triggers: AgentProfileTriggers;
  paused: boolean;
  version: number;
  updatedBy: string;
  updatedAtMs: number;
}

/**
 * `schedule` is defined but not executed in v0 (openapi says so in as many
 * words). It is still round-tripped verbatim: a client that edits routing and
 * drops the key would delete a stored schedule, because the server upsert is
 * `triggers = EXCLUDED.triggers` (AgentProfileRoutes.swift), not a merge.
 */
export interface AgentProfileTriggers {
  mention: true;
  schedule?: unknown;
}

/**
 * Closed-world PUT body (`AgentProfileInput`): a key the server does not know is
 * a 400, and it is a REPLACE, not a patch. `instructions` and `enabledTools`
 * are therefore always sent back as read, so editing one routing field cannot
 * erase the profile's instructions.
 */
export interface AgentProfileInput {
  instructions: string;
  enabledTools: string[];
  modelPref?: string;
  effortPref?: string;
  triggers?: AgentProfileTriggers;
}

export async function fetchAgentProfile(
  workspaceId: string,
  agentMemberId: string
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/profile`
  );
  return res.profile;
}

/**
 * The list is agent-specific (`agent.model ∪ allowed_agent_models`). `null`
 * means this server did not send a usable list, so routing keeps its compatible
 * broad-picker fallback rather than trapping a user behind an empty select.
 */
export async function fetchAgentAllowedModels(
  workspaceId: string,
  agentMemberId: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const response = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/allowed-models`,
    { signal }
  );
  const models = stringArrayField(response, "allowedAgentModels");
  if (
    models === null ||
    models.length === 0 ||
    models.some((model) => model.trim() === "") ||
    new Set(models).size !== models.length
  ) {
    return null;
  }
  return models;
}

export async function putAgentProfile(
  workspaceId: string,
  agentMemberId: string,
  input: AgentProfileInput
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/agents/${encodeURIComponent(agentMemberId)}/profile`,
    { method: "PUT", body: JSON.stringify(input) }
  );
  return res.profile;
}

export type AgentToolCatalogRead =
  | { kind: "ready"; tools: AgentToolCatalogEntry[] }
  | { kind: "absent" }
  | { kind: "forbidden"; message: string }
  | { kind: "unknown"; message: string };

export const AGENT_TOOL_CATALOG_FORBIDDEN =
  "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없습니다.";

export const AGENT_TOOL_CATALOG_UNKNOWN =
  "도구 목록을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.";

/**
 * Workspace tool catalog for Agent Hub enabledTools editing (UX-R4a).
 *
 * GET `/v1/workspaces/{ws}/agent-tool-catalog` is not in OpenAPI yet. 404/405/501
 * and an unreadable 200 are `absent` (display-only chips). The client never
 * copies `tools.rs` CATALOG.
 */
export async function fetchAgentToolCatalog(
  workspaceId: string,
  signal?: AbortSignal
): Promise<AgentToolCatalogRead> {
  try {
    const body = await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-tool-catalog`,
      { signal }
    );
    const tools = parseAgentToolCatalog(body);
    if (tools === null) return { kind: "absent" };
    return { kind: "ready", tools };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404 || error.status === 405 || error.status === 501) {
        return { kind: "absent" };
      }
      if (error.status === 403) {
        return { kind: "forbidden", message: AGENT_TOOL_CATALOG_FORBIDDEN };
      }
    }
    if (error instanceof NetworkError) {
      return { kind: "unknown", message: error.message };
    }
    return { kind: "unknown", message: AGENT_TOOL_CATALOG_UNKNOWN };
  }
}

export async function putAgentPause(
  workspaceId: string,
  agentMemberId: string,
  paused: boolean
): Promise<AgentProfile> {
  const res = await request<{ profile: AgentProfile }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/agents/${encodeURIComponent(
      agentMemberId.toLowerCase()
    )}/pause`,
    { method: "PUT", body: JSON.stringify({ paused }) }
  );
  return res.profile;
}

// ---- 전송 표면이 `routing`을 받는가 (ADR-0134 D1 멘션 tier, MOMO-625) --------
//
// GET 하나로 답할 수 없는 질문이다. `routing`은 `POST .../messages`의 본문 키이고
// (MOMO-625가 `SendMessageRequest.allowedKeys`에 더한 단 하나의 키), 그 키를 모르는
// 세대의 서버는 400을 주지 않고 **조용히 무시한다**. 즉 "거절이 없었다"는 사실은
// 성공의 근거가 되지 못한다. 그래서 그 표면에 직접, 그러나 아무것도 남기지 않는
// 방식으로 물어본다.
//
// 물음의 형태: **두 세대 모두가 반드시 거절하는 요청** 하나.
//   rootId  이번에 만든 난수 UUID. 그런 메시지는 존재하지 않으므로 스레드 루트
//           조회가 404로 끝난다. 트랜잭션은 열리지만 INSERT까지 가지 않는다.
//   routing 유효 레벨 집합에 없는 effort 토큰.
//
// 그래서 답이 갈린다.
//   MOMO-625 이후  decode 직후 `RunRoutingInput.validate`가 400을 던진다
//                  (MessageRoutes.swift: 트랜잭션이 열리기 전).
//   MOMO-625 이전  `routing`은 모르는 키라 무시되고 404 "thread root not found".
//
// 두 경로 모두 메시지를 만들지 않는다. momowebqa(=main 형상)에서 실측했다:
// 404, 채널 seq 불변, 감사행 없음. 이 함수는 그래서 항상 throw한다.
// 판정은 `features/routing/capability.ts`의 `verdictFromSendProbe`가 한다.
//
// ---- 엔진 랜딩 시 재확인 (MOMO-625가 main에 들어오는 순간) -------------------
// 이 프로브의 무해함 가운데 **앞 세대(404)만** 이 브랜치에서 실측됐다. 뒤 세대의
// 근거는 아직 track/engine에 있으므로(R2 M6), MOMO-625 랜딩 직후 살아 있는 서버
// 한 대에 대고 아래 셋을 다시 재고 그 결과를 ENGINE_HANDOFF에 적는다.
//   ① 400이 트랜잭션 이전에 나는가: 프로브 전후로 채널 newest seq가 불변이고
//      message·agent_run·audit_log에 행이 생기지 않는다.
//   ② 400 문구가 `routing`을 이름으로 부르는가: `verdictFromSendProbe`의 ready
//      분기는 `/routing/i` 매칭이다. 서버가 그 리터럴 없이 거절하면 판정은
//      unknown으로 떨어진다(잠기지만 영구는 아니다: [다시 확인]이 있다).
//   ③ 검사 순서가 rootId 조회보다 앞인가: 뒤라면 랜딩한 서버도 404를 주고,
//      화면은 되는 기능을 없다고 말하게 된다.
// 셋 중 하나라도 어긋나면 프로브의 형태를 고치는 것이 맞고, 화면 문구가 아니다.

/** 어떤 모델에서도 유효할 수 없는 토큰. 32바이트 상한(마이그레이션 041) 안. */
const SEND_ROUTING_PROBE_EFFORT = "__momo-capability-probe__";

export async function probeSendRouting(
  workspaceId: string,
  channelId: string
): Promise<void> {
  await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        clientMsgId: crypto.randomUUID(),
        rootId: crypto.randomUUID(),
        type: "text",
        body: "",
        routing: { effort: SEND_ROUTING_PROBE_EFFORT },
      }),
    }
  );
}

// ---- Inbox projection (ADR-0199 D6, E3 #3684) -------------------------------
// GET  /v1/workspaces/{ws}/inbox?filter=&cursor=&limit=&muted=
// PUT  /v1/workspaces/{ws}/inbox/{id}/read
// POST /v1/workspaces/{ws}/inbox/read-all?filter=&muted=
//
// A server older than E2 answers 404 to the GET. Callers tell that apart from an
// outage with `isInboxAbsent` and fall back to the composed mailbox.

export async function fetchInbox(
  workspaceId: string,
  query: InboxQuery = {}
): Promise<ServerInboxPage> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/inbox${inboxQueryString(query)}`
  );
  const page = parseInboxPage(res);
  if (page === null) throw new WireShapeError();
  return page;
}

export async function markInboxItemRead(
  workspaceId: string,
  itemId: string
): Promise<InboxItemReadResult> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(itemId)}/read`,
    { method: "PUT" }
  );
  const done = parseInboxItemRead(res);
  if (done === null) throw new WireShapeError();
  return done;
}

export async function markInboxReadAll(
  workspaceId: string,
  query: Pick<InboxQuery, "filter" | "muted"> = {}
): Promise<InboxReadAllResult> {
  const res = await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/inbox/read-all${inboxQueryString(query)}`,
    { method: "POST" }
  );
  const done = parseInboxReadAll(res);
  if (done === null) throw new WireShapeError();
  return done;
}

/** True when the server has no inbox projection (404), false for any other failure. */
export function isInboxAbsent(error: unknown): boolean {
  return error instanceof ApiError && isInboxAbsentStatus(error.status);
}
