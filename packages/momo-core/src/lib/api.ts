// =============================================================================
// REST client for the canonical web UI (ADR-0133 §1; originated in the MOMO-595
// P0 spike against momowebqa).
//
// Contract source of truth: server Routes + docs/api/openapi.yaml, mirrored by
// the ADR-0119 client at clients/web-legacy/src/api. Quirks preserved on purpose:
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
// ported from clients/web-legacy/src/api/client.ts.
//
// Base address (P2, MOMO-604): every path below is relative to `apiBase()`,
// read at call time rather than captured at import. Same-origin stays the
// default (empty base = the existing web deployment and dev proxy); the connect
// screen can point this device at another server, and the Tauri shell must.
// =============================================================================

import { fetchWithDeadline, type HttpResponse } from "./http";
import { apiBase, coreSession } from "../runtime/host";
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
  arrayField,
  bool,
  num,
  record,
  responseRecord,
  str,
  stringArrayField,
  WireShapeError,
} from "./wire";

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
   * Custom status (ADR-0176), human only. Orthogonal to `presenceStatus`.
   * ABSENT means there is nothing to show (unset, expired on the server, or
   * an older projection). Consumers go through `visibleCustomStatus`.
   */
  statusEmoji?: string;
  statusText?: string;
  statusExpiresAtMs?: number;
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
   * **모든 투영에 실린다**: 전송 응답, 히스토리, 답글, 실시간 프레임까지
   * (`message_dto` 주석: 실시간 프레임에서만 첨부를 배우는 클라는 새로고침 한
   * 번에 파일 없는 메시지를 그린다). 그래서 `replyTo`와 달리 이 배열은 어느
   * 경로로 들어온 행에도 있고, 비어 있다는 것은 첨부가 없다는 뜻이다.
   *
   * 업로드 capability URL도 Drive file id도 여기 없다. 바이트로 가는 유일한 길은
   * 인가 프록시(`GET …/attachments/{id}/content`)다.
   */
  attachments?: MessageAttachment[];
  /** 2-hop closure: the reply rollup rides the page, no extra round trip. */
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
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
  const body = res.jsonOrNull<{ error?: { message?: string } }>();
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  return new ApiError(res.status, message);
}

// ---- refresh rotation (single flight) ---------------------------------------
// The refresh token is single-use (MOMO-300): the server revokes the presented
// token as it issues the new pair. Concurrent 401s must therefore funnel into
// ONE rotation, because a second concurrent call would present an
// already-revoked token and end the session. Cross-TAB races stay possible
// while the token lives in localStorage; see ./session.ts.

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
 */
export type RefreshOutcome = "rotated" | "rejected" | "unreachable";

let refreshInFlight: Promise<RefreshOutcome> | null = null;

/** The detailed rotation. Use this wherever the *reason* changes what you do. */
export function refreshSessionOutcome(): Promise<RefreshOutcome> {
  refreshInFlight ??= (async () => {
    try {
      const refreshToken = coreSession().getRefreshToken();
      // Having no token to present is not a network problem: there is nothing
      // to rotate and nothing to keep waiting for.
      if (!refreshToken) return "rejected";
      const res = await rawRequest(
        "/v1/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken }) },
        null
      );
      if (!res.ok) {
        coreSession().markAuthExpired();
        return "rejected";
      }
      const pair = refreshResponseFromWire(res.json<unknown>());
      coreSession().applyRotation(pair.accessToken, pair.refreshToken);
      return "rotated";
    } catch {
      // Offline, unreachable server, or a blown deadline: the caller keeps
      // rendering cached content (P15) and the session is not declared dead,
      // because nothing answered to say it is.
      return "unreachable";
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Boolean view, for callers that only need "did I end up with a usable token". */
export function refreshSession(): Promise<boolean> {
  return refreshSessionOutcome().then((outcome) => outcome === "rotated");
}

/**
 * Authenticated request. On 401 it attempts exactly one rotation and retries
 * once; a 401 that survives the rotation ends the session. `init.body` is
 * always a string here, so replaying it on the retry is safe.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, init, coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await refreshSession()) {
      res = await rawRequest(path, init, coreSession().getAccessToken());
    }
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw parseError(res);
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
  coreSession().applyLogin(loginResponse);
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
 * supplies only an email and a password: display name and handle are derived
 * from the email exactly as the mac chooser derives them, so the same person
 * joining from either client gets the same identity.
 */
export async function joinWithInvite(
  code: string,
  email: string,
  password: string
): Promise<LoginResponse> {
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
        displayName: displayNameFromEmail(normalizedEmail),
        handle: handleFromEmail(normalizedEmail),
        password,
        timeZone: browserTimeZone(),
      }),
    },
    null
  );
  if (!res.ok) throw parseError(res);
  const joinResponse = loginResponseFromWire(res.json<unknown>());
  coreSession().applyLogin(joinResponse);
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
  coreSession().applyLogin(claimResponse);
  return claimResponse;
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

/**
 * Log out completely. The local wipe happens FIRST and unconditionally, so a
 * slow or failing network can never leave a usable token on the device; the
 * server revocation then runs with the captured pair as a best effort.
 */
export async function logout(): Promise<void> {
  const access = coreSession().getAccessToken();
  const refresh = coreSession().getRefreshToken();
  coreSession().clearSession();
  if (!access) return; // nothing the server will accept a revocation for
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
      // is already wiped, so this rotation is carried by locals only.
      const rotated = await rawRequest(
        "/v1/auth/refresh",
        { method: "POST", body: JSON.stringify({ refreshToken: refresh }) },
        null
      );
      if (rotated.ok) {
        const pair = refreshResponseFromWire(rotated.json<unknown>());
        await revoke(pair.accessToken, pair.refreshToken);
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
// This is the durable ③ half. Availability ② rides the ephemeral rail and never
// comes back through this API; the connection ① fact is the client's own
// `connStatus`. The effective dot is composed on the client via
// `effectivePresence`.

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
  publisherName?: string;
  publisherVerified?: boolean;
  license?: string;
  provenanceURL?: string;
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
    publisherName: str(publisher, "name"),
    publisherVerified: bool(publisher, "verified"),
    license: str(license, "spdx"),
    provenanceURL: httpsURL(str(provenance, "sourceURL")),
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

interface WireReadState {
  channel_id: string;
  last_read_seq: number;
  latest_seq: number;
  unread_count: number;
  mention_count: number;
}

function toReadState(wire: WireReadState): ReadState {
  return {
    channelId: wire.channel_id,
    lastReadSeq: wire.last_read_seq,
    latestSeq: wire.latest_seq,
    unreadCount: wire.unread_count,
    mentionCount: wire.mention_count,
  };
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
 * Advance the caller's read cursor. The server clamps to
 * `max(current, min(requested, latestSeq))`, so it can never regress.
 */
export async function updateReadState(
  workspaceId: string,
  channelId: string,
  lastReadSeq: number
): Promise<ReadState> {
  const res = await request<WireReadState>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/channels/${encodeURIComponent(channelId)}/read-state`,
    { method: "PUT", body: JSON.stringify({ last_read_seq: lastReadSeq }) }
  );
  return toReadState(res);
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
    if (await refreshSession()) res = await send(coreSession().getAccessToken());
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
  signal?: AbortSignal
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
    if (await refreshSession()) res = await send(coreSession().getAccessToken());
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.blob();
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
  if (!/^\/v1\/workspaces\/[^/]+\/avatar\/content(\?|$)/.test(avatarUrl)) {
    throw new ApiError(400, "not a workspace avatar content path");
  }
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${apiBase()}${avatarUrl}`, { headers });
  };
  let res = await send(coreSession().getAccessToken());
  if (res.status === 401 && coreSession().getRefreshToken()) {
    if (await refreshSession()) res = await send(coreSession().getAccessToken());
  }
  if (res.status === 401) coreSession().markAuthExpired();
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

// ---- 자기 표시 이름 (#1873 / BZ-4e) ----------------------------------------
// PATCH /v1/workspaces/{ws}/members/me `{displayName}`
// 사람 본인만. 정규화는 join과 같고, 위반은 400 `displayName is required`.
// 응답 `{ member }` (login Member 형상). 핸들·역할·아바타는 이 표면의 것이 아니다.

/** Change the signed-in human member's display name. */
export async function changeMyDisplayName(
  workspaceId: string,
  displayName: string
): Promise<Member> {
  const source = responseRecord(
    await request<unknown>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/members/me`,
      { method: "PATCH", body: JSON.stringify({ displayName }) }
    )
  );
  return memberFromWire(source.member);
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
 * Answers with the updated message so the caller replaces the row with what was
 * actually stored, rather than with what it hoped the edit did.
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

/** Continue an orphaned git lineage on an explicitly chosen eligible host. */
export async function resumeWorkSession(
  workspaceId: string,
  sessionId: string,
  targetHostId: string
): Promise<WorkSession> {
  const res = await request<{ workSession: WorkSession }>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId
    )}/work-sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ targetHostId }),
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
  startedAtMs?: number;
  finishedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
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
  return {
    ...summary,
    workspaceId: workspaceId.toLowerCase(),
    agentMemberId: agentMemberId.toLowerCase(),
    stepCount,
    maxSteps,
    ...(input === null ? {} : { input }),
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

// ---- Agent-scoped memory browser (MOMO-652 / ADR-0129) --------------------

export type MemoryScope = "member" | "agent" | "workspace" | "conversation";

export interface MemorySourceRef {
  messageId: string;
  channelId: string;
}

export interface MemoryItem {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  subjectMemberId?: string;
  agentMemberId?: string;
  channelId?: string;
  kind: string;
  body: string;
  confidence: number;
  validAtMs: number;
  invalidAtMs?: number;
  invalidatedByMemoryId?: string;
  createdByKind: "human" | "agent" | "worker";
  createdByMemberId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  sourceRefs: MemorySourceRef[];
}

export interface MemorySearchHit {
  memory: MemoryItem;
  score: number;
}

export interface MemoryVisibilityGrant {
  id: string;
  workspaceId: string;
  memoryId: string;
  granteeKind: "member" | "agent";
  granteeId: string;
  grantedBy: string;
  createdAtMs: number;
  revokedAtMs?: number;
}

const MEMORY_SCOPES = new Set<MemoryScope>([
  "member",
  "agent",
  "workspace",
  "conversation",
]);
const MEMORY_CREATORS = new Set<MemoryItem["createdByKind"]>([
  "human",
  "agent",
  "worker",
]);

function memorySourceRefFromWire(value: unknown): MemorySourceRef {
  const messageId = str(value, "messageId");
  const channelId = str(value, "channelId");
  if (messageId === undefined || channelId === undefined) {
    throw new WireShapeError();
  }
  return {
    messageId: messageId.toLowerCase(),
    channelId: channelId.toLowerCase(),
  };
}

function optionalLowerId(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  return optionalString(source, key)?.toLowerCase();
}

export function memoryItemFromWire(value: unknown): MemoryItem {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const scope = str(source, "scope");
  const kind = str(source, "kind");
  const body = str(source, "body");
  const confidence = num(source, "confidence");
  const validAtMs = num(source, "validAtMs");
  const createdByKind = str(source, "createdByKind");
  const createdAtMs = num(source, "createdAtMs");
  const updatedAtMs = num(source, "updatedAtMs");
  const refs = arrayField(source, "sourceRefs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    scope === undefined ||
    !MEMORY_SCOPES.has(scope as MemoryScope) ||
    kind === undefined ||
    body === undefined ||
    confidence === undefined ||
    validAtMs === undefined ||
    createdByKind === undefined ||
    !MEMORY_CREATORS.has(createdByKind as MemoryItem["createdByKind"]) ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    refs === null
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    scope: scope as MemoryScope,
    kind,
    body,
    confidence,
    validAtMs,
    createdByKind: createdByKind as MemoryItem["createdByKind"],
    createdAtMs,
    updatedAtMs,
    sourceRefs: refs.map(memorySourceRefFromWire),
    ...(optionalLowerId(source, "subjectMemberId") === undefined
      ? {}
      : { subjectMemberId: optionalLowerId(source, "subjectMemberId") }),
    ...(optionalLowerId(source, "agentMemberId") === undefined
      ? {}
      : { agentMemberId: optionalLowerId(source, "agentMemberId") }),
    ...(optionalLowerId(source, "channelId") === undefined
      ? {}
      : { channelId: optionalLowerId(source, "channelId") }),
    ...(optionalFiniteNumber(source, "invalidAtMs") === undefined
      ? {}
      : { invalidAtMs: optionalFiniteNumber(source, "invalidAtMs") }),
    ...(optionalLowerId(source, "invalidatedByMemoryId") === undefined
      ? {}
      : {
          invalidatedByMemoryId: optionalLowerId(
            source,
            "invalidatedByMemoryId"
          ),
        }),
    ...(optionalLowerId(source, "createdByMemberId") === undefined
      ? {}
      : { createdByMemberId: optionalLowerId(source, "createdByMemberId") }),
  };
}

export function memoryPageFromWire(value: unknown): MemoryItem[] {
  const memories = arrayField(responseRecord(value), "memories");
  if (memories === null) throw new WireShapeError();
  return memories.map(memoryItemFromWire);
}

export function memorySearchFromWire(value: unknown): MemorySearchHit[] {
  const hits = arrayField(responseRecord(value), "hits");
  if (hits === null) throw new WireShapeError();
  return hits.map((value) => {
    const source = record(value);
    const score = num(source, "score");
    if (source === null || score === undefined) throw new WireShapeError();
    return { memory: memoryItemFromWire(source.memory), score };
  });
}

function memoryGrantFromWire(value: unknown): MemoryVisibilityGrant {
  const source = record(value);
  if (source === null) throw new WireShapeError();
  const id = str(source, "id");
  const workspaceId = str(source, "workspaceId");
  const memoryId = str(source, "memoryId");
  const granteeKind = str(source, "granteeKind");
  const granteeId = str(source, "granteeId");
  const grantedBy = str(source, "grantedBy");
  const createdAtMs = num(source, "createdAtMs");
  if (
    id === undefined ||
    workspaceId === undefined ||
    memoryId === undefined ||
    (granteeKind !== "member" && granteeKind !== "agent") ||
    granteeId === undefined ||
    grantedBy === undefined ||
    createdAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id: id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    memoryId: memoryId.toLowerCase(),
    granteeKind,
    granteeId: granteeId.toLowerCase(),
    grantedBy: grantedBy.toLowerCase(),
    createdAtMs,
    ...(optionalFiniteNumber(source, "revokedAtMs") === undefined
      ? {}
      : { revokedAtMs: optionalFiniteNumber(source, "revokedAtMs") }),
  };
}

export function memoryGrantPageFromWire(value: unknown): MemoryVisibilityGrant[] {
  const grants = arrayField(responseRecord(value), "grants");
  if (grants === null) throw new WireShapeError();
  return grants.map(memoryGrantFromWire);
}

export async function listAgentMemories(
  workspaceId: string,
  agentMemberId: string,
  limit = 50
): Promise<MemoryItem[]> {
  const query = new URLSearchParams({
    agent: agentMemberId.toLowerCase(),
    limit: String(limit),
  });
  return memoryPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories?${query.toString()}`
  ));
}

export async function searchAgentMemories(
  workspaceId: string,
  agentMemberId: string,
  queryText: string,
  limit = 20
): Promise<MemorySearchHit[]> {
  const query = new URLSearchParams({
    q: queryText,
    agent: agentMemberId.toLowerCase(),
    limit: String(limit),
  });
  return memorySearchFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/search?${query.toString()}`
  ));
}

export async function invalidateMemory(
  workspaceId: string,
  memoryId: string
): Promise<MemoryItem> {
  const source = responseRecord(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/${encodeURIComponent(
      memoryId.toLowerCase()
    )}/invalidate`,
    { method: "POST", body: "{}" }
  ));
  return memoryItemFromWire(source.memory);
}

export async function listMemoryVisibilityGrants(
  workspaceId: string,
  memoryId: string
): Promise<MemoryVisibilityGrant[]> {
  return memoryGrantPageFromWire(await request<unknown>(
    `/v1/workspaces/${encodeURIComponent(
      workspaceId.toLowerCase()
    )}/memories/${encodeURIComponent(
      memoryId.toLowerCase()
    )}/grants`
  ));
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
