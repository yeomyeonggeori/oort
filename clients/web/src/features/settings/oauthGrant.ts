import { record, str } from "@momo/core/lib/wire";

// =============================================================================
// auth.json 붙여넣기 → PUT /v1/provider/link 의 `oauth` 객체 (ADR-0147 결정 3).
//
// momo relays no browser OAuth flow — 결정 3 puts the login in the operator's
// OWN local Codex CLI. So this module's whole job is reading exactly one
// document shape and refusing everything else BY NAME, because the person
// holding a broken paste needs to know which line of their file is the problem,
// not that "저장에 실패했습니다".
//
// ## Field origins (measured, not invented)
//
// `server-rust/crates/momo-settings/src/oauth.rs` records the key structure of
// `~/.codex/auth.json`, read key-structure-only (values never opened):
//
//   top level : OPENAI_API_KEY, auth_mode, last_refresh, tokens
//   tokens    : access_token, account_id, id_token, refresh_token
//
// and `PutProviderOAuthRequest` (server-rust `bins/momo-server/src/dto.rs`) is
// the closed world this builds: `refreshToken` (required) plus `accessToken`,
// `expiresAtMs`, `accountId`, `accountLabel`, `clientId`, `tokenEndpoint`.
// `deny_unknown_fields` means an extra key is a 400, not a shrug.
//
// ## Three deliberate omissions, each a decision rather than an oversight
//
//   * **`id_token` is dropped.** The server refuses it by name: it is a
//     login-flow identity assertion, not a call credential, and storing it
//     widens the secret surface for nothing (ADR-0147 "토큰 탈취 면적"). Passing
//     it through would be a guaranteed 400 AND a secret this client had no
//     reason to hold.
//   * **`expiresAtMs` is NOT derived from `last_refresh`.** auth.json records
//     when a token was MINTED; the worker needs to know when it DIES. Turning
//     one into the other requires a lifetime nobody here measured, and a
//     guessed deadline is worse than an absent one — absent means "refresh
//     reactively on a 401", which is correct, while a wrong deadline means
//     "keep using a dead token until the clock says so".
//   * **`OPENAI_API_KEY` is ignored.** It is a bearer, and a link carries
//     exactly one credential; the server 400s on bearer+oauth together. An
//     operator who wants the key path uses the 키 method, which is right there.
//
// ## Secrets
//
// Nothing here logs, stores, or echoes the pasted document. The parsed grant is
// handed straight to the transport and the caller drops it; `grantPreviewRows`
// below exists so the operator can confirm they pasted the right FILE without
// this surface ever putting a token back on screen (ADR-0004 Rules #2/#5).
// =============================================================================

/** The `oauth` half of a PUT body. Mirrors `PutProviderOAuthRequest` exactly. */
export interface ProviderOAuthGrant {
  refreshToken: string;
  accessToken?: string;
  accountId?: string;
  accountLabel?: string;
  clientId?: string;
  tokenEndpoint?: string;
}

/**
 * The whole PUT body for the OAuth method. `bearer` is absent as a KEY, not
 * empty: the server reads `(bearer, oauth)` as a pair and an empty string would
 * be trimmed to the same thing, but a body that names a credential field it is
 * not using is a body that says two things at once.
 */
export interface ProviderOAuthLinkBody {
  baseUrl: string;
  mode: string;
  oauth: ProviderOAuthGrant;
}

/**
 * Which control the message belongs under. Errors live AT the field, never in a
 * pile at the bottom of the form: `Field` binds the message to its control with
 * `aria-describedby`/`aria-invalid`, so a person who tabs back into the box ten
 * seconds later still hears what is wrong with it. Both registration methods
 * draw from this one set, because the same sentence about the same address must
 * not move to a different place on screen when a radio changes (H5).
 */
export type LinkFormField = "paste" | "accountLabel" | "baseUrl" | "bearer";

export interface LinkFormError {
  field: LinkFormField;
  message: string;
}

export type OAuthParseResult =
  | { ok: true; grant: ProviderOAuthGrant }
  | { ok: false; error: LinkFormError };

/**
 * The base URL an ADR-0147 OAuth link stores, measured rather than chosen:
 * `momo-settings/src/link.rs:349` writes it, `momo-agent-worker/src/provider.rs`
 * throws `/responses` at it, and `GET .../models` answered 401 (path exists,
 * auth gates it) on 2026-08-04. Offered as the starting value BECAUSE it is the
 * one address this grant can actually reach — unlike the bearer form, where the
 * environment fallback is a mock and prefilling it would be a suggestion.
 */
export const CHATGPT_OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * An OAuth link is `external-hermes` and nothing else. `provider_link.mode` has
 * a three-value CHECK constraint (migration 039) and the grant IS the external
 * provider boundary, so there is no choice to offer here — offering one would
 * be inventing a decision the schema already made.
 */
export const OAUTH_LINK_MODE = "external-hermes";

/** Read the first present, non-blank string among several spellings. */
function firstString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = str(source, key);
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * Parse a pasted `auth.json` into the grant the server accepts.
 *
 * Both spellings are read at every field. The FILE is snake_case and the WIRE
 * is camelCase, and an operator moving a credential between the two has no way
 * to know which vocabulary this box wants — so it wants either, and says so in
 * its hint rather than rejecting a correct paste on a naming convention.
 */
export function parseAuthJson(pasted: string): OAuthParseResult {
  const text = pasted.trim();
  if (!text) {
    return fail("paste", "auth.json 내용을 붙여넣으세요.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return fail(
      "paste",
      "JSON으로 읽지 못했습니다. auth.json 파일 내용을 잘라내지 말고 그대로 붙여넣으세요."
    );
  }

  const root = record(decoded);
  if (!root) {
    return fail(
      "paste",
      "auth.json은 중괄호로 시작하는 객체여야 합니다. 파일 전체를 붙여넣었는지 확인하세요."
    );
  }

  // The tokens live one level down in the real file, but an operator who opened
  // it and copied the interesting half pasted the inner object. Both are the
  // same intent, so both are read.
  const nested = record(root.tokens);
  if (root.tokens !== undefined && nested === null) {
    return fail(
      "paste",
      "tokens 값이 객체가 아닙니다. ~/.codex/auth.json 파일을 편집하지 말고 그대로 붙여넣으세요."
    );
  }
  const tokens = nested ?? root;
  if (
    nested === null &&
    !firstString(root, "refresh_token", "refreshToken")
  ) {
    return fail(
      "paste",
      "tokens 객체가 없습니다. ~/.codex/auth.json 파일 전체를 붙여넣었는지 확인하세요."
    );
  }

  const refreshToken = firstString(tokens, "refresh_token", "refreshToken");
  if (!refreshToken) {
    return fail(
      "paste",
      "tokens.refresh_token이 없습니다. Codex CLI 로그인을 마친 계정의 auth.json인지 확인하세요."
    );
  }

  const grant: ProviderOAuthGrant = { refreshToken };

  // access_token is optional on purpose: a link registered from a stale file has
  // no live token and the worker mints one on the next turn. Absent is a normal
  // state here, not a defect (see `accessTokenPresent` on the GET projection).
  const accessToken = firstString(tokens, "access_token", "accessToken");
  if (accessToken) grant.accessToken = accessToken;

  const accountId = firstString(tokens, "account_id", "accountId");
  if (accountId) grant.accountId = accountId;

  // Not part of auth.json's measured key structure, and deliberately not
  // compiled in either (ADR-0147 결정 3: the client that minted the grant is the
  // operator's fact, not momo's). Carried only when the pasted document
  // actually names it, at either level.
  const clientId =
    firstString(tokens, "client_id", "clientId") ??
    firstString(root, "client_id", "clientId");
  if (clientId) grant.clientId = clientId;

  const tokenEndpoint =
    firstString(tokens, "token_endpoint", "tokenEndpoint") ??
    firstString(root, "token_endpoint", "tokenEndpoint");
  if (tokenEndpoint) grant.tokenEndpoint = tokenEndpoint;

  return { ok: true, grant };
}

function fail(field: LinkFormField, message: string): OAuthParseResult {
  return { ok: false, error: { field, message } };
}

/**
 * The PUT body, assembled from a parsed grant plus the two things only the
 * operator can answer: where the link points and whose subscription it spends.
 *
 * `accountLabel` is required by THIS form although the wire allows its absence.
 * ADR-0147 제약 is that a subscription link is one named human's personal
 * account and every surface says so; an unlabelled one produces exactly the
 * screen the constraint exists to prevent — "개인 계정 귀속" next to a blank.
 */
/**
 * The address rule, owned in ONE place so the two registration methods cannot
 * drift into two rules (or, as they had, two screen positions for the identical
 * sentence). Returns null when the address is usable.
 */
export function validateBaseUrl(raw: string): LinkFormError | null {
  const baseUrl = raw.trim();
  if (!baseUrl) {
    return { field: "baseUrl", message: "provider 주소를 입력하세요." };
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return {
      field: "baseUrl",
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
    };
  }
  return null;
}

export function buildOAuthLinkBody(input: {
  baseUrl: string;
  accountLabel: string;
  grant: ProviderOAuthGrant;
}): { ok: true; body: ProviderOAuthLinkBody } | { ok: false; error: LinkFormError } {
  const addressError = validateBaseUrl(input.baseUrl);
  if (addressError) return { ok: false, error: addressError };
  const baseUrl = input.baseUrl.trim();

  const accountLabel = input.accountLabel.trim();
  if (!accountLabel) {
    return {
      ok: false,
      error: {
        field: "accountLabel",
        message:
          "누구의 구독인지 적으세요. 이 연결이 쓰는 사용량은 그 사람의 한도에서 나갑니다.",
      },
    };
  }

  return {
    ok: true,
    body: {
      baseUrl,
      mode: OAUTH_LINK_MODE,
      oauth: { ...input.grant, accountLabel },
    },
  };
}

/**
 * What the form shows back after a successful parse, so the operator can tell a
 * good paste from the wrong file WITHOUT this surface putting a credential on
 * screen.
 *
 * Every row is a fact about presence, never a value. `accountId` is reported as
 * a yes/no even though it is not itself a token: the server's own projection
 * (`ProviderLinkCredentialMeta`) declines to send it back, and a client that
 * displayed what the server chose to withhold would be widening the disclosure
 * boundary from the outside.
 */
export function grantPreviewRows(
  grant: ProviderOAuthGrant
): { key: string; value: string; prose?: boolean }[] {
  return [
    { key: "갱신 토큰", value: "읽었습니다" },
    {
      key: "액세스 토큰",
      prose: true,
      value: grant.accessToken
        ? "함께 등록됩니다"
        : "없음. 다음 턴에 서버가 발급합니다",
    },
    { key: "계정 ID", value: grant.accountId ? "확인됨" : "없음" },
    ...(grant.clientId ? [{ key: "OAuth 클라이언트", value: "확인됨" }] : []),
    ...(grant.tokenEndpoint
      ? [{ key: "토큰 엔드포인트", value: grant.tokenEndpoint }]
      : []),
  ];
}

// --- GET 투영: 연결 상태 표면 (Goal 2) ---------------------------------------
//
// `credentialKind` and `credentialMeta` are ADR-0147 additions to
// `ProviderLinkResponse`. They are read defensively rather than typed, for the
// same reason `entries` is on the probe: a server built before ADR-0147 landed
// omits them entirely, and that has to read as "this server has no OAuth link"
// rather than as an empty one.

export interface ProviderCredentialMeta {
  /** `personal-subscription`. */
  attribution?: string;
  /** `internal-only`. */
  usageScope?: string;
  accountLabel?: string;
  /** The server's own sentence. Rendered verbatim so every surface agrees. */
  notice?: string;
  accessTokenPresent?: boolean;
  accessTokenExpiresAtMs?: number;
}

export const OAUTH_CREDENTIAL_KIND = "oauth-openai";

/** `bearer` | `oauth-openai` | undefined (env fallback has no vault). */
export function credentialKind(link: unknown): string | undefined {
  return str(link, "credentialKind");
}

/** 등록 방식을 사람 어휘로. 미지 값은 원문 유지 — 지어내지 않는다. */
export function credentialKindLabel(kind: string | undefined): string {
  if (kind === OAUTH_CREDENTIAL_KIND) return "ChatGPT 계정 (OAuth)";
  if (kind === "bearer") return "키";
  return kind ?? "서버 환경값";
}

export function credentialMeta(link: unknown): ProviderCredentialMeta | null {
  const meta = record(record(link)?.credentialMeta);
  if (!meta) return null;
  const accessTokenPresent = meta.accessTokenPresent;
  const expires = meta.accessTokenExpiresAtMs;
  return {
    attribution: str(meta, "attribution"),
    usageScope: str(meta, "usageScope"),
    accountLabel: str(meta, "accountLabel"),
    notice: str(meta, "notice"),
    accessTokenPresent:
      typeof accessTokenPresent === "boolean" ? accessTokenPresent : undefined,
    accessTokenExpiresAtMs:
      typeof expires === "number" && Number.isFinite(expires) ? expires : undefined,
  };
}

/**
 * The access-token line.
 *
 * A freshly registered grant holding no token is NORMAL, and saying "토큰 없음"
 * there would report a working save as a failure. An expired one is also not a
 * failure — the worker refreshes — so it says what will happen next instead of
 * raising an alarm the operator cannot act on.
 */
export function accessTokenStatus(
  meta: ProviderCredentialMeta,
  nowMs: number
): { text: string; tone: "ok" | "warn" | "muted" } {
  if (meta.accessTokenPresent !== true) {
    return { text: "없음. 다음 턴에 서버가 발급합니다", tone: "muted" };
  }
  const expires = meta.accessTokenExpiresAtMs;
  if (expires === undefined) {
    return { text: "보유 중 (만료 시각 미보고)", tone: "ok" };
  }
  if (expires <= nowMs) {
    return {
      text: `${formatMoment(expires)}에 만료됨. 다음 턴에 서버가 갱신합니다`,
      tone: "warn",
    };
  }
  return { text: `${formatMoment(expires)}까지 유효`, tone: "ok" };
}

/** 사용자 화면의 시각 표기는 한 곳에서만 만든다. */
export function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString("ko-KR");
}
