// =============================================================================
// Incoming webhook installations: shapes, copy and the two rules that keep a
// one-time credential from becoming a permanent one (#1202).
//
// Ported from the macOS client (clients/macOS/Sources/MomoMac/MomoWebhook*.swift)
// as behaviour, not as code: the screen structure, the wording and above all
// the secret-handling discipline are carried over, while the rendering is left
// to the web idiom the settings shell already speaks.
//
// ## What this file exists to prevent
//
// The server reveals a webhook credential exactly once, keeps only a hash, and
// answers `no-store` (openapi `createWebhookInstallation` / `rotateWebhookSecret`).
// Every promise in that sentence is broken by a client that is merely careless:
//
//   1. A list row rebuilt by spreading the wire object would carry a `secret`
//      the server should not have sent, straight into whatever renders it.
//      `parseInstallations` copies eight named fields and nothing else.
//   2. An error rendered as `error.message` would paint whatever the server put
//      in it. `webhookFailureMessage` maps STATUS to Korean copy and never
//      echoes the wire string.
//   3. A receive URL resolved against the wrong base would send someone's
//      secret-bearing path to another origin. `resolveReceiveUrl` refuses
//      anything that is not a same-origin, credential-free, bare path.
//
// The mac client holds the same three rules (MomoWebhookURLResolver, the
// classified `MomoWebhookUserFailure`, the DTO with no secret on the list row).
// This is that discipline in TypeScript, with the tests it never had.
// =============================================================================

import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { arrayField, num, record, str, WireShapeError } from "../../lib/wire";
import { formatDay } from "../settings/model";

export type WebhookMode = "native" | "slack_compatible";
export type WebhookStatus = "active" | "revoked";

/**
 * One installation as the LIST returns it. There is deliberately no `secret`
 * and no `url` field: the list response carries neither by contract, and a type
 * that cannot hold a secret is one fewer place a secret can be rendered from.
 */
export interface WebhookInstallation {
  id: string;
  channelId: string;
  authorMemberId: string;
  mode: WebhookMode;
  label: string;
  status: WebhookStatus;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * The one-time reveal. Held in component state for as long as the panel shows
 * it and dropped on dismiss; never written to a query cache, never persisted,
 * never logged. `secret` is the native HMAC key; in Slack-compatible mode the
 * secret is inside `url` instead, which is why the two are treated identically
 * everywhere below.
 */
export interface RevealedWebhookCredential {
  installation: WebhookInstallation;
  keyId: string;
  /** Native mode only. Absent in Slack-compatible mode, where the URL is it. */
  secret?: string;
  /** Relative ingress path: `/v1/webhooks/{ws}/{id}` or `/hooks/{token}`. */
  url: string;
  signatureVersion?: string;
  algorithm?: string;
  overlapSeconds?: number;
}

export const WEBHOOK_LABEL_MAX = 80;

/**
 * How long the PREVIOUS credential keeps working after a rotation. One day is
 * what the mac client offers and what the spec defaults to, and it is the whole
 * point of rotation: a sender can be updated without a window where deliveries
 * are rejected. The spec allows 0..604800.
 */
export const WEBHOOK_ROTATE_OVERLAP_SECONDS = 86_400;

// --- wire -------------------------------------------------------------------

function toMode(value: string | undefined): WebhookMode | null {
  return value === "native" || value === "slack_compatible" ? value : null;
}

function toStatus(value: string | undefined): WebhookStatus | null {
  return value === "active" || value === "revoked" ? value : null;
}

/**
 * One row, rebuilt field by field.
 *
 * Not a spread and not a cast: both would carry every key the server sent,
 * including one it promised never to send. A row that fails the required-field
 * check is dropped rather than half-rendered, which is the same choice the wire
 * helpers make everywhere else in the core.
 */
function toInstallation(value: unknown): WebhookInstallation | null {
  const row = record(value);
  if (!row) return null;
  const id = str(row, "id");
  const channelId = str(row, "channelId");
  const authorMemberId = str(row, "authorMemberId");
  const mode = toMode(str(row, "mode"));
  const status = toStatus(str(row, "status"));
  const createdAtMs = num(row, "createdAtMs");
  const updatedAtMs = num(row, "updatedAtMs");
  if (
    !id ||
    !channelId ||
    !authorMemberId ||
    !mode ||
    !status ||
    createdAtMs === undefined ||
    updatedAtMs === undefined
  ) {
    return null;
  }
  return {
    id,
    channelId,
    authorMemberId,
    mode,
    label: str(row, "label") ?? "",
    status,
    createdAtMs,
    updatedAtMs,
  };
}

/** Newest first, matching the server's own ordering promise and the mac list. */
export function parseInstallations(wire: unknown): WebhookInstallation[] {
  const rows = arrayField(wire, "installations") ?? [];
  return rows
    .map(toInstallation)
    .filter((row): row is WebhookInstallation => row !== null)
    .sort((a, b) =>
      a.createdAtMs === b.createdAtMs
        ? a.id.localeCompare(b.id)
        : b.createdAtMs - a.createdAtMs
    );
}

/**
 * The create/rotate response.
 *
 * `expected` is the mac client's guard (MomoWebhookSettingsModel.create): a
 * response describing a DIFFERENT installation than the one just asked for is
 * not a credential anyone should be told to save, so it is refused rather than
 * shown. An unusable shape throws, so the caller renders its error state
 * instead of a reveal panel with blanks in it.
 */
export function parseRevealedCredential(
  wire: unknown,
  expected?: { channelId?: string; mode?: WebhookMode; installationId?: string }
): RevealedWebhookCredential {
  const row = record(wire);
  const installation = toInstallation(row?.["installation"]);
  const keyId = str(row, "keyId");
  const url = str(row, "url");
  if (!installation || !keyId || !url) throw new WireShapeError();
  if (installation.status !== "active") throw new WireShapeError();
  if (expected?.channelId && installation.channelId !== expected.channelId) {
    throw new WireShapeError();
  }
  if (expected?.mode && installation.mode !== expected.mode) {
    throw new WireShapeError();
  }
  if (
    expected?.installationId &&
    installation.id !== expected.installationId
  ) {
    throw new WireShapeError();
  }
  return {
    installation,
    keyId,
    secret: str(row, "secret"),
    url,
    signatureVersion: str(row, "signatureVersion"),
    algorithm: str(row, "algorithm"),
    overlapSeconds: num(row, "overlapSeconds"),
  };
}

/**
 * The revoke response. `revoked: false` with a 200 is a server saying it did
 * not do the irreversible thing, and treating that as success would leave a
 * live ingress behind a row that reads 폐기됨.
 */
export function parseRevokedInstallation(
  wire: unknown,
  expectedId: string
): WebhookInstallation {
  const row = record(wire);
  const installation = toInstallation(row?.["installation"]);
  if (!installation) throw new WireShapeError();
  if (row?.["revoked"] !== true) throw new WireShapeError();
  if (installation.id !== expectedId) throw new WireShapeError();
  if (installation.status !== "revoked") throw new WireShapeError();
  return installation;
}

// --- label ------------------------------------------------------------------

export type WebhookLabelIssue = "empty" | "tooLong" | "controlCharacter";

export function normalizeWebhookLabel(raw: string): string {
  return raw.trim();
}

/**
 * Same bounds the server documents (1..80) plus the control-character rule the
 * mac client applies, checked here so the panel can say what is wrong before a
 * round trip that would answer 400 with an English sentence.
 */
export function webhookLabelIssue(raw: string): WebhookLabelIssue | null {
  const label = normalizeWebhookLabel(raw);
  if (label.length === 0) return "empty";
  if (label.length > WEBHOOK_LABEL_MAX) return "tooLong";
  // Code points rather than a character class: a class written with literal
  // control characters is invisible in a diff (and turns this file binary to
  // grep), and the escaped form needs an eslint suppression to survive
  // `no-control-regex`. This says the same thing and can be read.
  for (const character of label) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "controlCharacter";
  }
  return null;
}

export function webhookLabelIssueMessage(issue: WebhookLabelIssue): string {
  switch (issue) {
    case "empty":
      return "이름을 입력하세요. 목록에서 이 웹훅을 구별하는 유일한 값입니다.";
    case "tooLong":
      return `이름은 ${WEBHOOK_LABEL_MAX}자까지 쓸 수 있습니다.`;
    case "controlCharacter":
      return "이름에 제어 문자를 쓸 수 없습니다. 붙여넣은 값이라면 줄바꿈이 섞였는지 확인하세요.";
  }
}

// --- mode -------------------------------------------------------------------

export interface WebhookModeChoice {
  id: WebhookMode;
  label: string;
  detail: string;
}

/**
 * The two receive modes, with the difference that actually matters stated in
 * the detail line: where the secret lives. In native mode the URL is safe to
 * keep and the signing key is the secret; in Slack-compatible mode the URL IS
 * the secret, so it is never recoverable from the list.
 */
export const WEBHOOK_MODES: readonly WebhookModeChoice[] = [
  {
    id: "native",
    label: "oort 서명",
    detail:
      "HMAC-SHA256 서명 비밀을 한 번만 보여줍니다. 수신 URL은 목록에서 다시 복사할 수 있습니다.",
  },
  {
    id: "slack_compatible",
    label: "Slack 호환",
    detail:
      "URL 자체가 비밀값입니다. 지금 한 번만 보이고 목록에서 다시 볼 수 없습니다.",
  },
];

export function webhookModeName(mode: WebhookMode): string {
  return WEBHOOK_MODES.find((choice) => choice.id === mode)?.label ?? mode;
}

export function webhookStatusChip(status: WebhookStatus): {
  tone: "ok" | "muted";
  label: string;
} {
  return status === "active"
    ? { tone: "ok", label: "활성" }
    : { tone: "muted", label: "폐기됨" };
}

export function webhookCreatedLabel(createdAtMs: number): string {
  return `${formatDay(createdAtMs)} 생성`;
}

// --- receive URL ------------------------------------------------------------

/** The documented native ingress path. Slack-compatible paths come from the server. */
export function nativeReceivePath(
  workspaceId: string,
  installationId: string
): string {
  return `/v1/webhooks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(
    installationId
  )}`;
}

/**
 * Resolve a server-supplied ingress PATH against this deployment's own base.
 *
 * Every rejection here is one the mac client also makes (MomoWebhookURLResolver),
 * and each closes a way for a credential to be handed to the wrong host:
 *
 *   - not a bare path, or protocol-relative (`//evil.example`): the "path" is
 *     really another origin, and copying it would hand a Slack-mode secret URL
 *     to that origin's owner.
 *   - a different scheme/host/port after resolution: same failure, arrived at
 *     through a base that is not what the caller thought it was.
 *   - userinfo, query or fragment: a receive URL has none of the three, and a
 *     value that grew one is not the value the server issued.
 *
 * Returns null rather than throwing: the caller renders "서버가 유효한 수신
 * 주소를 주지 않았습니다" in place of a copy button, which is the honest state.
 */
export function resolveReceiveUrl(path: string, baseUrl: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(baseUrl);
    resolved = new URL(path, base);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) return null;
  if (resolved.username !== "" || resolved.password !== "") return null;
  if (resolved.search !== "" || resolved.hash !== "") return null;
  return resolved.toString();
}

/**
 * The copyable receive URL for a LIST row, which exists only in native mode.
 * A Slack-compatible installation has no recoverable URL by design, and the
 * list is exactly where the mac client refuses to invent one.
 */
export function installationReceiveUrl(
  installation: WebhookInstallation,
  workspaceId: string,
  baseUrl: string
): string | null {
  if (installation.mode !== "native") return null;
  if (installation.status !== "active") return null;
  return resolveReceiveUrl(
    nativeReceivePath(workspaceId, installation.id),
    baseUrl
  );
}

// --- failures ---------------------------------------------------------------

export type WebhookAction = "list" | "create" | "rotate" | "revoke";

function actionPrefix(action: WebhookAction): string {
  switch (action) {
    case "list":
      return "웹훅 목록을 불러오지 못했습니다.";
    case "create":
      return "웹훅을 만들지 못했습니다.";
    case "rotate":
      return "비밀값을 회전하지 못했습니다.";
    case "revoke":
      return "웹훅을 폐기하지 못했습니다.";
  }
}

function statusAdvice(action: WebhookAction, status: number): string {
  switch (status) {
    case 400:
      return action === "rotate"
        ? "겹침 시간이 서버가 허용하는 범위를 벗어났습니다."
        : "채널, 수신 방식, 이름 중 하나를 서버가 거절했습니다. 값을 확인하고 다시 시도하세요.";
    case 401:
      return "로그인 세션이 만료되었습니다. 다시 로그인한 뒤 시도하세요.";
    case 403:
      return "이 워크스페이스의 웹훅은 오너나 관리자만 관리할 수 있습니다. 관리자에게 요청하세요.";
    case 404:
      return action === "create"
        ? "고른 채널을 서버에서 찾지 못했습니다. 목록을 다시 불러온 뒤 다른 채널을 고르세요."
        : "이 웹훅이 서버에 없습니다. 목록을 다시 불러오세요.";
    case 409:
      return "이미 폐기된 웹훅입니다. 목록을 다시 불러오세요.";
    case 429:
      return "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.";
    default:
      return "잠시 뒤에 다시 시도하세요.";
  }
}

/**
 * What happened plus the next step, keyed by STATUS.
 *
 * The wire message is deliberately not part of the output. Two reasons, and the
 * second is why this function is tested: the server speaks operator English
 * here, which is the right thing to log and the wrong thing to put on a Korean
 * settings panel; and this is the one surface where a server that echoed a
 * submitted secret back inside an error body would get it painted on screen.
 *
 * `NetworkError.message` IS used, because that string is written in this
 * package for exactly this purpose and never contains anything from the wire.
 */
export function webhookFailureMessage(
  action: WebhookAction,
  error: unknown
): string {
  const prefix = actionPrefix(action);
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof ApiError) {
    return `${prefix} ${statusAdvice(action, error.status)}`;
  }
  if (error instanceof WireShapeError) {
    return `${prefix} 서버 응답을 확인하지 못했습니다. 목록을 다시 불러오세요.`;
  }
  return `${prefix} 잠시 뒤에 다시 시도하세요.`;
}

/** A 403 on the list is the server saying who may manage webhooks, not an error. */
export function isWebhookOperatorDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

// --- reveal panel copy ------------------------------------------------------

export function revealHeadline(mode: WebhookMode): string {
  return mode === "native"
    ? "지금 서명 비밀을 저장하세요."
    : "지금 수신 URL을 저장하세요.";
}

export function revealWarning(mode: WebhookMode): string {
  return mode === "native"
    ? "이 화면을 벗어나면 서명 비밀을 다시 볼 수 없습니다. 서버는 원문을 보관하지 않습니다."
    : "이 화면을 벗어나면 이 수신 URL을 다시 볼 수 없습니다. URL 자체가 비밀값입니다.";
}

export interface WebhookDetailRow {
  key: string;
  value: string;
}

/**
 * The signature metadata shown beside a freshly issued credential.
 *
 * It carries neither `secret` nor `url`, and that absence is asserted by a
 * test. Both values need their own labelled block with their own warning, and a
 * generic row list is exactly the shape that gets copied into a log line, a
 * bug report, or a future "raw response" disclosure without anyone noticing
 * what came along.
 */
export function revealDetailRows(
  credential: RevealedWebhookCredential
): WebhookDetailRow[] {
  const rows: WebhookDetailRow[] = [{ key: "키 ID", value: credential.keyId }];
  if (credential.algorithm) {
    rows.push({ key: "알고리즘", value: credential.algorithm });
  }
  if (credential.signatureVersion) {
    rows.push({ key: "서명 버전", value: credential.signatureVersion });
  }
  if (credential.overlapSeconds !== undefined) {
    rows.push({
      key: "이전 비밀값",
      value: overlapExpiryLabel(credential.overlapSeconds),
    });
  }
  return rows;
}

export function overlapExpiryLabel(seconds: number): string {
  if (seconds <= 0) return "즉시 만료";
  const hours = Math.round(seconds / 3600);
  if (hours >= 1) return `${hours}시간 뒤 만료`;
  return `${Math.max(1, Math.round(seconds / 60))}분 뒤 만료`;
}

export function rotateConfirmQuestion(): string {
  return `비밀값을 회전하면 새 값이 한 번만 표시되고, 이전 값은 ${overlapExpiryLabel(
    WEBHOOK_ROTATE_OVERLAP_SECONDS
  )}됩니다. 회전할까요?`;
}

export function revokeConfirmQuestion(label: string): string {
  return `${label}의 모든 비밀값이 즉시 무효화되고 되돌릴 수 없습니다. 폐기할까요?`;
}

/** Shown on a Slack-compatible row, where the list can never show the URL again. */
export const SLACK_URL_RECOVERY_HINT =
  "Slack 호환 수신 URL은 서버에 저장되지 않습니다. 새 URL이 필요하면 비밀값을 회전하세요.";

// --- delivery failures ------------------------------------------------------

/**
 * Why a delivery from the outside can fail, per mode.
 *
 * This is the honest answer to "전송 실패 가시성" for INCOMING webhooks: the
 * server keeps no per-installation delivery log and openapi exposes no attempt
 * or failure resource for this tag (the `deliveryFailureCount` field belongs to
 * outbound event subscriptions, a different surface). Inventing a wire to hold
 * one is out of scope for a port whose target is zero new endpoints.
 *
 * What an operator can be given without inventing anything is the ingress
 * contract itself, stated where they are looking when a webhook has gone quiet:
 * every rejection code the sender will have received, and what each one means.
 * Transcribed from the two ingress operations in docs/api/openapi.yaml.
 */
export function webhookIngressNotes(mode: WebhookMode): readonly string[] {
  if (mode === "native") {
    return [
      "서명, 타임스탬프, 키 ID 중 하나라도 맞지 않으면 401로 거절됩니다. 보내는 쪽의 시계와 키 ID를 먼저 확인하세요.",
      "지원하지 않는 본문은 400, 256KB를 넘는 본문은 413으로 거절됩니다.",
      "같은 전송 ID가 다시 오면 메시지를 새로 만들지 않고 원래 접수를 200으로 돌려줍니다.",
      "짧은 시간에 너무 많이 보내면 429로 거절됩니다.",
    ];
  }
  return [
    "URL이 틀렸거나 회전, 폐기된 뒤라면 401로 거절됩니다.",
    "blocks 필드가 있으면 400으로 거절됩니다. text와 attachments만 읽습니다.",
    "같은 본문이 짧은 시간 안에 다시 오면 원래 접수를 200으로 돌려줍니다.",
    "256KB를 넘는 본문은 413, 너무 잦은 요청은 429로 거절됩니다.",
  ];
}
