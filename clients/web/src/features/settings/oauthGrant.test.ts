import { describe, expect, it } from "vitest";
import {
  accessTokenStatus,
  buildOAuthLinkBody,
  CHATGPT_OAUTH_BASE_URL,
  credentialKind,
  credentialKindLabel,
  credentialMeta,
  grantPreviewRows,
  OAUTH_LINK_MODE,
  parseAuthJson,
  type ProviderOAuthGrant,
} from "./oauthGrant";

// =============================================================================
// U3 Goal 1/2 — auth.json 붙여넣기 → PUT body, and the GET projection behind the
// connection-health card.
//
// Two of these are the RED PROOFS the packet requires, and both fail against
// the pre-U3 surface for a reason that is not "the function does not exist yet":
//
//   ① `sends_an_oauth_object_...` pins the PUT payload SHAPE against the
//      server's `deny_unknown_fields` closed world. Before U3 this panel could
//      only ever send `{baseUrl, bearer, mode}`, so an OAuth grant had no way
//      onto the wire at all — which is exactly why 2026-08-04 registration went
//      through a browser console snippet.
//   ② `never_puts_a_credential_back_on_screen` pins ADR-0004 Rules #2/#5 on the
//      NEW code path. A paste box is the first control on this surface that
//      holds a whole credential document in component state, so "the bearer is
//      write-only" stops being true by construction and starts needing a test.
//
// The server contract these assert against is measured, not assumed:
// `server-rust/bins/momo-server/src/dto.rs` `PutProviderLinkRequest` /
// `PutProviderOAuthRequest`, both `#[serde(rename_all = "camelCase",
// deny_unknown_fields)]`.
// =============================================================================

/** Every key `PutProviderLinkRequest` accepts. Anything else is a 400. */
const PUT_LINK_KEYS = ["baseUrl", "bearer", "mode", "oauth"];
/** Every key `PutProviderOAuthRequest` accepts. Anything else is a 400. */
const PUT_OAUTH_KEYS = [
  "refreshToken",
  "accessToken",
  "expiresAtMs",
  "accountId",
  "accountLabel",
  "clientId",
  "tokenEndpoint",
];

/**
 * A realistic Codex CLI `auth.json`. The key structure is the measured one
 * recorded in `momo-settings/src/oauth.rs`; every value here is invented for
 * this test and is not a credential.
 */
const AUTH_JSON = JSON.stringify({
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  tokens: {
    id_token: "test-id-token-not-a-credential",
    access_token: "test-access-token-not-a-credential",
    refresh_token: "test-refresh-token-not-a-credential",
    account_id: "acct-01996f2a-7c3d-4f11-9a20-3d6f0c9b41ee",
  },
  last_refresh: "2026-08-04T11:20:03.914Z",
});

function parsed(json: string): ProviderOAuthGrant {
  const result = parseAuthJson(json);
  if (!result.ok) throw new Error(`parse failed: ${result.error.message}`);
  return result.grant;
}

describe("parseAuthJson", () => {
  it("reads the measured auth.json key structure", () => {
    expect(parsed(AUTH_JSON)).toEqual({
      refreshToken: "test-refresh-token-not-a-credential",
      accessToken: "test-access-token-not-a-credential",
      accountId: "acct-01996f2a-7c3d-4f11-9a20-3d6f0c9b41ee",
    });
  });

  it("drops id_token, which the server refuses by name", () => {
    // Not a preference: `deny_unknown_fields` means forwarding it turns a
    // correct paste into a 400, and holding it widens the secret surface for a
    // value no call ever uses.
    expect(Object.keys(parsed(AUTH_JSON))).not.toContain("idToken");
    expect(JSON.stringify(parsed(AUTH_JSON))).not.toContain("test-id-token");
  });

  it("does not invent expiresAtMs from last_refresh", () => {
    // auth.json records when the token was minted. The worker needs to know
    // when it dies. A guessed deadline is worse than an absent one: absent
    // means "refresh reactively on 401", wrong means "keep using a dead token".
    expect(Object.keys(parsed(AUTH_JSON))).not.toContain("expiresAtMs");
    expect(JSON.stringify(parsed(AUTH_JSON))).not.toContain("2026-08-04");
  });

  it("ignores OPENAI_API_KEY: a link carries exactly one credential", () => {
    const withKey = JSON.stringify({
      OPENAI_API_KEY: "sk-test-not-a-credential",
      tokens: { refresh_token: "rt-test" },
    });
    const grant = parsed(withKey);
    expect(JSON.stringify(grant)).not.toContain("sk-test-not-a-credential");
  });

  it("accepts the inner tokens object on its own", () => {
    const inner = JSON.stringify({
      refresh_token: "rt-test",
      access_token: "at-test",
    });
    expect(parsed(inner)).toEqual({ refreshToken: "rt-test", accessToken: "at-test" });
  });

  it("accepts the camelCase wire spelling as well as the file spelling", () => {
    const camel = JSON.stringify({ tokens: { refreshToken: "rt-test" } });
    expect(parsed(camel)).toEqual({ refreshToken: "rt-test" });
  });

  it("carries client_id and token_endpoint only when the document names them", () => {
    const bare = parsed(AUTH_JSON);
    expect(bare.clientId).toBeUndefined();
    expect(bare.tokenEndpoint).toBeUndefined();

    const named = parsed(
      JSON.stringify({
        client_id: "app_TestClientNotACredential",
        tokens: { refresh_token: "rt-test", token_endpoint: "https://auth.example.test/oauth/token" },
      })
    );
    expect(named.clientId).toBe("app_TestClientNotACredential");
    expect(named.tokenEndpoint).toBe("https://auth.example.test/oauth/token");
  });

  describe("field-level Korean errors", () => {
    const cases: [string, string, string][] = [
      ["빈 붙여넣기", "   ", "auth.json 내용을 붙여넣으세요."],
      [
        "JSON 아님",
        "not json at all",
        "JSON으로 읽지 못했습니다. auth.json 파일 내용을 잘라내지 말고 그대로 붙여넣으세요.",
      ],
      [
        "객체 아님",
        '["tokens"]',
        "auth.json 은 중괄호로 시작하는 객체여야 합니다. 파일 전체를 붙여넣었는지 확인하세요.",
      ],
      [
        "tokens 없음",
        '{"OPENAI_API_KEY":null}',
        "tokens 객체가 없습니다. ~/.codex/auth.json 파일 전체를 붙여넣었는지 확인하세요.",
      ],
      [
        "tokens 가 객체가 아님",
        '{"tokens":"oops"}',
        "tokens 값이 객체가 아닙니다. ~/.codex/auth.json 파일을 편집하지 말고 그대로 붙여넣으세요.",
      ],
      [
        "refresh_token 없음",
        '{"tokens":{"access_token":"at-test"}}',
        "tokens.refresh_token 이 없습니다. Codex CLI 로그인을 마친 계정의 auth.json 인지 확인하세요.",
      ],
      [
        "refresh_token 이 공백",
        '{"tokens":{"refresh_token":"   "}}',
        "tokens.refresh_token 이 없습니다. Codex CLI 로그인을 마친 계정의 auth.json 인지 확인하세요.",
      ],
    ];

    it.each(cases)("%s", (_name, input, message) => {
      const result = parseAuthJson(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.field).toBe("paste");
      expect(result.error.message).toBe(message);
    });
  });
});

describe("buildOAuthLinkBody", () => {
  // ---------------------------------------------------------------- RED ① ---
  it("sends an oauth object and no bearer key, within the server's closed world", () => {
    const built = buildOAuthLinkBody({
      baseUrl: CHATGPT_OAUTH_BASE_URL,
      accountLabel: "성재 개인 ChatGPT 구독",
      grant: parsed(AUTH_JSON),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const body = built.body;
    expect(body).toEqual({
      baseUrl: CHATGPT_OAUTH_BASE_URL,
      mode: OAUTH_LINK_MODE,
      oauth: {
        refreshToken: "test-refresh-token-not-a-credential",
        accessToken: "test-access-token-not-a-credential",
        accountId: "acct-01996f2a-7c3d-4f11-9a20-3d6f0c9b41ee",
        accountLabel: "성재 개인 ChatGPT 구독",
      },
    });

    // `bearer` is absent as a KEY, not empty. The server reads (bearer, oauth)
    // as a pair and 400s on both-present; a body that names a credential field
    // it is not using is a body that says two things at once.
    expect(Object.keys(body)).not.toContain("bearer");

    // deny_unknown_fields coexistence, measured against dto.rs rather than
    // assumed: every key we send has to be one the server declares.
    for (const key of Object.keys(body)) {
      expect(PUT_LINK_KEYS).toContain(key);
    }
    for (const key of Object.keys(body.oauth)) {
      expect(PUT_OAUTH_KEYS).toContain(key);
    }

    // The whole body must survive JSON.stringify with the same key set: an
    // undefined-valued optional would vanish on the wire and make this
    // assertion a statement about the object, not about the request.
    expect(Object.keys(JSON.parse(JSON.stringify(body)))).toEqual(Object.keys(body));
  });

  it("mode is external-hermes and is not offered as a choice", () => {
    // provider_link.mode has a three-value CHECK (migration 039) and an OAuth
    // grant IS the external provider boundary. There is no decision to make.
    expect(OAUTH_LINK_MODE).toBe("external-hermes");
  });

  it("requires an account label, because ADR-0147 attribution is the point", () => {
    const built = buildOAuthLinkBody({
      baseUrl: CHATGPT_OAUTH_BASE_URL,
      accountLabel: "  ",
      grant: parsed(AUTH_JSON),
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe("accountLabel");
    expect(built.error.message).toContain("누구의 구독인지");
  });

  it.each([
    ["빈 주소", "", "provider 주소를 입력하세요."],
    ["스킴 없음", "chatgpt.com/backend-api/codex", "주소는 http:// 또는 https:// 로 시작해야 합니다."],
  ])("주소 오류: %s", (_name, baseUrl, message) => {
    const built = buildOAuthLinkBody({
      baseUrl,
      accountLabel: "성재 개인 ChatGPT 구독",
      grant: parsed(AUTH_JSON),
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.field).toBe("baseUrl");
    expect(built.error.message).toBe(message);
  });
});

// ------------------------------------------------------------------ RED ② ---
describe("비밀 재노출 금지", () => {
  const SECRETS = [
    "test-refresh-token-not-a-credential",
    "test-access-token-not-a-credential",
    "test-id-token-not-a-credential",
  ];

  it("never puts a credential back on screen after a paste", () => {
    const grant = parsed(AUTH_JSON);
    const rendered = JSON.stringify(grantPreviewRows(grant));
    for (const secret of SECRETS) {
      expect(rendered).not.toContain(secret);
    }
    // Presence, not value: the operator learns their paste was the right file.
    expect(rendered).toContain("함께 등록됩니다");
  });

  it("does not echo the account id, which the server itself withholds", () => {
    // ProviderLinkCredentialMeta projects accountLabel and never accountId. A
    // client that showed what the server chose not to send would be widening
    // the disclosure boundary from the outside.
    const rendered = JSON.stringify(grantPreviewRows(parsed(AUTH_JSON)));
    expect(rendered).not.toContain("acct-01996f2a");
    expect(rendered).toContain("확인됨");
  });

  it("the status card reads only non-secret projection fields", () => {
    const link = {
      configured: true,
      credentialKind: "oauth-openai",
      credentialMeta: {
        attribution: "personal-subscription",
        usageScope: "internal-only",
        accountLabel: "성재 개인 ChatGPT 구독",
        notice: "개인 계정 귀속 · 내부용",
        accessTokenPresent: true,
        accessTokenExpiresAtMs: 1_785_000_000_000,
      },
      // A server that (wrongly) leaked a token must not become a screen that
      // shows one. Nothing in this module reads these keys.
      bearer: "leaked-bearer-not-a-credential",
      refreshToken: "leaked-refresh-not-a-credential",
    };
    const meta = credentialMeta(link);
    expect(meta).not.toBeNull();
    expect(JSON.stringify(meta)).not.toContain("leaked");
    expect(JSON.stringify(meta)).not.toContain("bearer");
  });
});

describe("연결 상태 표면 (Goal 2)", () => {
  it("reads credentialKind, and says nothing when the server predates ADR-0147", () => {
    expect(credentialKind({ credentialKind: "oauth-openai" })).toBe("oauth-openai");
    expect(credentialKind({ configured: true })).toBeUndefined();
    expect(credentialMeta({ configured: true })).toBeNull();
  });

  it("labels the registration method in human words, keeping unknown values verbatim", () => {
    expect(credentialKindLabel("oauth-openai")).toBe("ChatGPT 계정 (OAuth)");
    expect(credentialKindLabel("bearer")).toBe("키");
    expect(credentialKindLabel(undefined)).toBe("서버 환경값");
    expect(credentialKindLabel("something-new")).toBe("something-new");
  });

  it("keeps a partial credentialMeta usable instead of throwing on it", () => {
    const meta = credentialMeta({ credentialMeta: { accountLabel: 7, notice: "안내" } });
    expect(meta).toEqual({
      attribution: undefined,
      usageScope: undefined,
      accountLabel: undefined,
      notice: "안내",
      accessTokenPresent: undefined,
      accessTokenExpiresAtMs: undefined,
    });
  });

  describe("accessTokenStatus", () => {
    const now = 1_785_000_000_000;

    it("a freshly registered grant with no token is normal, not a failure", () => {
      expect(accessTokenStatus({ accessTokenPresent: false }, now)).toEqual({
        text: "없음. 다음 턴에 서버가 발급합니다",
        tone: "muted",
      });
    });

    it("an expired token says what happens next rather than raising an alarm", () => {
      const status = accessTokenStatus(
        { accessTokenPresent: true, accessTokenExpiresAtMs: now - 60_000 },
        now
      );
      expect(status.tone).toBe("warn");
      expect(status.text).toContain("다음 턴에 서버가 갱신합니다");
    });

    it("a live token reports its deadline", () => {
      const status = accessTokenStatus(
        { accessTokenPresent: true, accessTokenExpiresAtMs: now + 3_600_000 },
        now
      );
      expect(status.tone).toBe("ok");
      expect(status.text).toContain("까지 유효");
    });

    it("a token with no reported deadline says so instead of guessing one", () => {
      expect(accessTokenStatus({ accessTokenPresent: true }, now)).toEqual({
        text: "보유 중 (만료 시각 미보고)",
        tone: "ok",
      });
    });
  });
});
