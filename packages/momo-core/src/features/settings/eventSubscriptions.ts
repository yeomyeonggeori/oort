// =============================================================================
// 이벤트 구독 — outbound event subscriptions (#1202 워커 V).
//
// Wire contract: docs/api/openapi.yaml `event-subscriptions` (4 operations,
// nothing new added here), server/Sources/MomoServer/Routes/EventSubscriptionRoutes.swift,
// server/Migrations/033_event_subscription.sql. Ported from the macOS client
// (MomoEventSubscriptionModels.swift + MomoEventSubscriptionSettingsView.swift),
// which stays the reference for the state machine and the failure copy.
//
// Its own file rather than an addition to ./api.ts and ./model.ts, for the same
// reason ./api.ts states about ./lib/api.ts: two #1202 workers edit the settings
// surface in one batch, and the shared modules are the files most likely to
// collide. It reuses `settingsRequest`, so there is still one transport and one
// auth path.
//
// Three boundaries this module exists to keep honest, all three read out of the
// migration rather than assumed:
//
//   1. SCOPE IS THE WORKSPACE. `enqueue_event_subscription_delivery` selects
//      `WHERE s.workspace_id = event_workspace_id` with no channel predicate, so
//      a subscription cannot be narrowed to one channel. A picker would be a
//      lie; the panel states the scope instead.
//   2. THE PAYLOAD LEAVES THE WORKSPACE. The mention and approval projections
//      carry `body` — the message text itself — to a third-party address. The
//      per-event copy below says so, because "멘션" alone does not.
//   3. THE SIGNING SECRET IS ANSWERED ONCE. `secret_ref` is derivation material
//      and the secret is never persisted, so the create response is the only
//      time it exists on this client. Nothing here logs it, stores it, or reads
//      it back, and no other response carries it.
// =============================================================================

import { ApiError, uuidEq } from "../../lib/api";
import {
  bool,
  num,
  record,
  str,
  stringArrayField,
  WireShapeError,
} from "../../lib/wire";
import { settingsRequest } from "./api";

// --- 이벤트 종류 -------------------------------------------------------------

/**
 * The three kinds the server accepts, in the order they are offered.
 *
 * Closed set on the wire (`event_subscription_event_kinds_ck`), so the create
 * form offers exactly these. A subscription that came BACK carrying something
 * else is still rendered — see `eventKindLabel`.
 */
export const EVENT_SUBSCRIPTION_KINDS = [
  "mention",
  "approval_request",
  "work.status_changed",
] as const;

export type EventSubscriptionKind = (typeof EVENT_SUBSCRIPTION_KINDS)[number];

export function isEventSubscriptionKind(
  value: string
): value is EventSubscriptionKind {
  return (EVENT_SUBSCRIPTION_KINDS as readonly string[]).includes(value);
}

/**
 * Korean name for one event kind, falling back to the raw token.
 *
 * The fallback is the point. A server one version ahead can send a fourth kind,
 * and this surface exists to say what is being sent OUT of the workspace: a
 * label that quietly dropped the unknown one would understate that, and a
 * decoder that threw would take the whole panel down over an addition it was
 * always going to survive.
 */
export function eventKindLabel(kind: string): string {
  switch (kind) {
    case "mention":
      return "멘션";
    case "approval_request":
      return "승인 요청";
    case "work.status_changed":
      return "작업 상태 변경";
    default:
      return kind;
  }
}

export function eventKindsLabel(kinds: readonly string[]): string {
  return kinds.map(eventKindLabel).join(" · ");
}

/**
 * What the destination actually receives, transcribed from the trigger bodies
 * in 033_event_subscription.sql. Two of the three carry the message text.
 */
export function eventKindDetail(kind: EventSubscriptionKind): string {
  switch (kind) {
    case "mention":
      return "멘션이 달린 메시지의 본문, 채널 ID, 작성자 ID가 함께 나갑니다.";
    case "approval_request":
      return "승인 요청 메시지의 본문과 속성이 함께 나갑니다.";
    case "work.status_changed":
      return "작업 세션의 이전 상태, 새 상태, 도구 이름, 종료 코드가 나갑니다. 메시지 본문은 들어 있지 않습니다.";
  }
}

// --- 구독 행 ----------------------------------------------------------------

export interface EventSubscription {
  id: string;
  workspaceId: string;
  url: string;
  /**
   * Raw wire strings, not a narrowed union: an unknown kind has to survive the
   * trip to the screen (see `eventKindLabel`).
   */
  eventKinds: string[];
  enabled: boolean;
  deliveryFailureCount: number;
  disabledAtMs?: number;
  /** `disabled_by_admin` | `server_5xx_threshold` on today's server. */
  disabledReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The one response that ever carries signing material. Never re-fetchable. */
export interface CreatedEventSubscription {
  eventSubscription: EventSubscription;
  secret: string;
  signatureVersion: string;
  algorithm: string;
}

export interface EventSubscriptionInput {
  url: string;
  eventKinds: EventSubscriptionKind[];
}

function subscriptionFromWire(value: unknown): EventSubscription {
  const row = record(value);
  const id = str(row, "id");
  const workspaceId = str(row, "workspaceId");
  const url = str(row, "url");
  const eventKinds = stringArrayField(row, "eventKinds");
  const enabled = bool(row, "enabled");
  const deliveryFailureCount = num(row, "deliveryFailureCount");
  const createdAtMs = num(row, "createdAtMs");
  const updatedAtMs = num(row, "updatedAtMs");
  if (
    !id ||
    !workspaceId ||
    !url ||
    eventKinds === null ||
    eventKinds.length === 0 ||
    enabled === undefined ||
    deliveryFailureCount === undefined ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    throw new WireShapeError();
  }
  return {
    id,
    workspaceId,
    url,
    eventKinds,
    enabled,
    deliveryFailureCount,
    disabledAtMs: num(row, "disabledAtMs"),
    disabledReason: str(row, "disabledReason"),
    createdAtMs,
    updatedAtMs,
  };
}

/** Newest first, id as the tie-break so two rows born in one ms hold still. */
export function sortEventSubscriptions(
  rows: readonly EventSubscription[]
): EventSubscription[] {
  return [...rows].sort((a, b) =>
    a.createdAtMs === b.createdAtMs
      ? a.id.localeCompare(b.id)
      : b.createdAtMs - a.createdAtMs
  );
}

// --- 상태 --------------------------------------------------------------------

export type EventSubscriptionState =
  | "enabled"
  | "disabled_by_admin"
  | "auto_disabled"
  | "needs_review";

/**
 * Derived from the row, never guessed.
 *
 * `needs_review` is the case a naive mapping loses: a row that is off with no
 * reason recorded. Calling that 관리자 중지 tells an operator a person did it,
 * which is a claim this client cannot support and the wrong next move (they
 * would go looking for who, instead of re-enabling or deleting).
 */
export function eventSubscriptionState(subscription: {
  enabled: boolean;
  disabledReason?: string;
}): EventSubscriptionState {
  if (subscription.enabled) return "enabled";
  switch (subscription.disabledReason) {
    case "disabled_by_admin":
      return "disabled_by_admin";
    case "server_5xx_threshold":
      return "auto_disabled";
    default:
      return "needs_review";
  }
}

/** Text-first chip: tone never carries the meaning on its own. */
export function eventSubscriptionStatus(subscription: {
  enabled: boolean;
  disabledReason?: string;
}): { tone: "ok" | "warn" | "danger" | "muted"; label: string } {
  switch (eventSubscriptionState(subscription)) {
    case "enabled":
      return { tone: "ok", label: "사용 중" };
    case "disabled_by_admin":
      return { tone: "muted", label: "관리자 중지" };
    case "auto_disabled":
      return { tone: "warn", label: "자동 중지" };
    case "needs_review":
      return { tone: "danger", label: "상태 확인 필요" };
  }
}

/** Why delivery stopped, and the next move. Null while it is running. */
export function disabledReasonLine(subscription: {
  enabled: boolean;
  disabledReason?: string;
}): string | null {
  switch (eventSubscriptionState(subscription)) {
    case "enabled":
      return null;
    case "disabled_by_admin":
      return "관리자가 전송을 멈췄습니다.";
    case "auto_disabled":
      return "받는 서버가 오류를 반복해서 자동으로 멈췄습니다. 주소를 고친 뒤 다시 사용하면 실패 횟수가 0으로 돌아갑니다.";
    case "needs_review":
      return "멈춘 이유가 기록되지 않았습니다. 다시 사용하거나 지우세요.";
  }
}

export function deliveryFailureLine(count: number): string | null {
  return count > 0 ? `연속 전송 실패 ${count}회` : null;
}

// --- 주소 --------------------------------------------------------------------

export const DESTINATION_MAX_LENGTH = 2048;

export type DestinationProblem =
  | "empty"
  | "unparsable"
  | "scheme"
  | "credentials"
  | "fragment"
  | "too_long";

/**
 * Format check only. Whether a destination is REACHABLE and SAFE is the
 * server's call (it resolves DNS and refuses private, loopback, link-local,
 * multicast and reserved ranges), and this client does not second-guess it: an
 * invented gate here would refuse addresses the server accepts.
 *
 * The credential and fragment rules are not gates, they are hygiene, and both
 * are inherited from the macOS client:
 *   - `https://user:password@hooks.example.com` would store a third-party
 *     credential in a plaintext column and then print it in this list, on a
 *     panel whose whole discipline is that secrets are shown once and never
 *     again. Authentication to the destination is what the signing secret is.
 *   - a `#fragment` is never sent by any HTTP client, so accepting one saves an
 *     address that does not mean what it looks like.
 */
export function destinationProblem(raw: string): DestinationProblem | null {
  const value = raw.trim();
  if (!value) return "empty";
  if (new TextEncoder().encode(value).length > DESTINATION_MAX_LENGTH) {
    return "too_long";
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "unparsable";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "scheme";
  }
  if (!parsed.hostname) return "unparsable";
  if (parsed.username || parsed.password) return "credentials";
  if (parsed.hash) return "fragment";
  return null;
}

/** The trimmed address to send, or null when it is not one. */
export function normalizeDestination(raw: string): string | null {
  return destinationProblem(raw) === null ? raw.trim() : null;
}

/** What is wrong and what to type instead. Null while the draft is usable. */
export function destinationError(raw: string): string | null {
  switch (destinationProblem(raw)) {
    case null:
      return null;
    case "empty":
      return "이벤트를 받을 주소를 입력하세요.";
    case "too_long":
      return `주소는 ${DESTINATION_MAX_LENGTH}자를 넘을 수 없습니다.`;
    case "unparsable":
      return "주소를 읽지 못했습니다. https://hooks.example.com/oort 형태로 입력하세요.";
    case "scheme":
      return "https:// 또는 http:// 로 시작하는 주소만 등록됩니다. 운영 서버는 공개 https 주소만 받습니다.";
    case "credentials":
      return "주소에 아이디와 비밀번호를 넣을 수 없습니다. 받는 쪽 인증은 서명 비밀로 합니다.";
    case "fragment":
      return "# 뒤쪽은 서버로 전송되지 않습니다. # 없이 입력하세요.";
  }
}

// --- 오류 문구 ---------------------------------------------------------------

export type EventSubscriptionAction =
  | "load"
  | "create"
  | "enable"
  | "disable"
  | "delete";

function actionFailed(action: EventSubscriptionAction): string {
  switch (action) {
    case "load":
      return "구독 목록을 불러오지 못했습니다.";
    case "create":
      return "구독을 만들지 못했습니다.";
    case "enable":
      return "구독을 다시 사용하지 못했습니다.";
    case "disable":
      return "구독을 멈추지 못했습니다.";
    case "delete":
      return "구독을 지우지 못했습니다.";
  }
}

/**
 * A create that answered 2xx with a body this client could not verify.
 *
 * Its own sentence because its next move is unlike every other failure: the row
 * may well EXIST on the server, and the signing secret that came with it is
 * already gone (the server derives it and never stores it). Telling someone to
 * "다시 시도" without saying that leaves a live, unusable destination behind.
 */
export const UNVERIFIED_CREATE_MESSAGE =
  "구독이 만들어졌는지 확인하지 못했습니다. 서명 비밀은 다시 받을 수 없으니, 목록을 새로 불러와 같은 주소가 있으면 지운 뒤 다시 만드세요.";

function failureDetail(
  action: EventSubscriptionAction,
  error: unknown
): string {
  if (error instanceof WireShapeError) {
    return action === "create"
      ? UNVERIFIED_CREATE_MESSAGE
      : "서버 응답을 읽지 못했습니다. 목록을 다시 불러오세요.";
  }
  if (!(error instanceof ApiError)) {
    // NetworkError already carries Korean copy that names the next move; an
    // unknown throw falls back rather than leaking a wire string.
    return error instanceof Error && error.message
      ? error.message
      : "잠시 뒤에 다시 시도하세요.";
  }
  switch (error.status) {
    case 400:
      return "서버가 주소나 이벤트 선택을 거절했습니다. 공개 https 주소인지 확인한 뒤 다시 시도하세요.";
    case 401:
      return "로그인이 만료되었습니다. 다시 로그인한 뒤 시도하세요.";
    case 403:
      return "이벤트 구독은 워크스페이스 오너나 관리자만 관리할 수 있습니다.";
    case 404:
      return "이 구독은 이미 바뀌었거나 지워졌습니다. 목록을 다시 불러오세요.";
    case 429:
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    default:
      return "잠시 뒤에 다시 시도하세요.";
  }
}

/** "{무엇이 안 됐는지}. {왜, 그리고 다음에 뭘 할지}" — macOS와 같은 조립. */
export function eventSubscriptionErrorMessage(
  action: EventSubscriptionAction,
  error: unknown
): string {
  const detail = failureDetail(action, error);
  return detail === UNVERIFIED_CREATE_MESSAGE
    ? detail
    : `${actionFailed(action)} ${detail}`;
}

// --- REST --------------------------------------------------------------------

function basePath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/event-subscriptions`;
}

function rowPath(workspaceId: string, subscriptionId: string): string {
  return `${basePath(workspaceId)}/${encodeURIComponent(subscriptionId)}`;
}

/**
 * RLS already scopes the read to one workspace. This asserts it anyway, because
 * the failure it guards against is not "a wrong row renders" but "a row from
 * another tenant is offered a delete button on this panel".
 */
function requireWorkspace(
  subscription: EventSubscription,
  workspaceId: string
): EventSubscription {
  if (!uuidEq(subscription.workspaceId, workspaceId)) throw new WireShapeError();
  return subscription;
}

export async function listEventSubscriptions(
  workspaceId: string
): Promise<EventSubscription[]> {
  const res = await settingsRequest<unknown>(basePath(workspaceId));
  const rows = record(res)?.eventSubscriptions;
  if (!Array.isArray(rows)) throw new WireShapeError();
  return sortEventSubscriptions(
    rows.map((row) => requireWorkspace(subscriptionFromWire(row), workspaceId))
  );
}

/**
 * The created row is checked against what was ASKED for, not merely parsed.
 *
 * A one-time secret is only worth saving if it belongs to the destination and
 * the events the operator chose. If the server answered something else, the
 * honest outcome is the unverified-create sentence above, not a copyable secret
 * beside a subscription nobody asked for.
 */
export async function createEventSubscription(
  workspaceId: string,
  input: EventSubscriptionInput
): Promise<CreatedEventSubscription> {
  const url = normalizeDestination(input.url);
  if (!url || input.eventKinds.length === 0) throw new WireShapeError();
  const kinds = [...new Set(input.eventKinds)].sort();
  const res = await settingsRequest<unknown>(basePath(workspaceId), {
    method: "POST",
    body: JSON.stringify({ url, eventKinds: kinds, enabled: true }),
  });
  const created = record(res);
  const eventSubscription = requireWorkspace(
    subscriptionFromWire(created?.eventSubscription),
    workspaceId
  );
  const secret = str(created, "secret");
  const signatureVersion = str(created, "signatureVersion");
  const algorithm = str(created, "algorithm");
  const sameKinds =
    eventSubscription.eventKinds.length === kinds.length &&
    [...eventSubscription.eventKinds].sort().every((k, i) => k === kinds[i]);
  if (
    !secret ||
    !signatureVersion ||
    !algorithm ||
    !eventSubscription.enabled ||
    eventSubscription.url !== url ||
    !sameKinds
  ) {
    throw new WireShapeError();
  }
  return { eventSubscription, secret, signatureVersion, algorithm };
}

function singleFromWire(value: unknown, workspaceId: string): EventSubscription {
  return requireWorkspace(
    subscriptionFromWire(record(value)?.eventSubscription),
    workspaceId
  );
}

/**
 * Only `enabled` is sent. Editing the destination or the event set of a LIVE
 * subscription is deliberately not offered: the secret already lives in the old
 * destination's config, and silently re-pointing it at another host is a change
 * the receiving side cannot notice. Delete and create instead, which forces a
 * new secret.
 */
export async function setEventSubscriptionEnabled(
  workspaceId: string,
  subscriptionId: string,
  enabled: boolean
): Promise<EventSubscription> {
  const res = await settingsRequest<unknown>(
    rowPath(workspaceId, subscriptionId),
    { method: "PUT", body: JSON.stringify({ enabled }) }
  );
  const updated = singleFromWire(res, workspaceId);
  if (!uuidEq(updated.id, subscriptionId) || updated.enabled !== enabled) {
    throw new WireShapeError();
  }
  return updated;
}

export async function deleteEventSubscription(
  workspaceId: string,
  subscriptionId: string
): Promise<EventSubscription> {
  const res = await settingsRequest<unknown>(
    rowPath(workspaceId, subscriptionId),
    { method: "DELETE" }
  );
  const deleted = singleFromWire(res, workspaceId);
  if (!uuidEq(deleted.id, subscriptionId)) throw new WireShapeError();
  return deleted;
}
