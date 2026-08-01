//! The `oauth-openai` provider_link kind (ADR-0147 결정 1).
//!
//! ## Why this is a payload extension and not a migration
//!
//! ADR-0147 결정 1 is explicit that the *existing* vault holds the OAuth
//! material: "기존 봉인 계약 그대로 … 들어가는 내용물이 'API 키'에서 'OAuth
//! refresh token(+메타)'로 확장될 뿐". Measured against the schema, that lands in
//! exactly one place:
//!
//! * `provider_link.mode` is `CHECK (mode IN ('local-mock', 'internal-host-mock',
//!   'external-hermes'))` (migration 039:40-41). A fourth label there **would**
//!   need a migration, and the packet forbids one.
//! * `provider_link.bearer_ciphertext` is `bytea NOT NULL` with only
//!   `octet_length(...) > 0` (039:39). Its *contents* are opaque to SQL.
//!
//! So the kind lives in the sealed plaintext, the row stays `external-hermes`
//! (which is what an OAuth link is — the external provider boundary), and no DDL
//! changes. The sealed box format itself ([`crate::crypto`]) is untouched: this
//! module only decides what string goes inside it.
//!
//! ## The compatibility rule that keeps every existing row working
//!
//! A stored plaintext is an envelope **only** when it starts with `{` *and*
//! decodes as an object whose `kind` is [`OAUTH_OPENAI_KIND`]. Anything else —
//! including a `{`-leading string that is not this envelope — is a legacy bearer,
//! byte for byte. A provider bearer is an opaque token, so the two vocabularies
//! cannot collide by accident; and the fallback direction is the safe one (a
//! misparsed envelope degrades to "unusable link → env fallback", never to
//! "present the whole document as a bearer").
//!
//! ## Field origins (measured, not invented)
//!
//! The persisted field names mirror the Codex CLI's `~/.codex/auth.json`, read
//! **key-structure only** (values never opened):
//!
//! ```text
//! top level : OPENAI_API_KEY, auth_mode, last_refresh, tokens
//! tokens    : access_token, account_id, id_token, refresh_token
//! ```
//!
//! Two deliberate differences:
//!
//! * **`id_token` is not stored.** It is an identity assertion for the login
//!   flow, not a call credential; keeping it would widen the secret surface for
//!   nothing (ADR-0147 "토큰 탈취 면적" 최소화).
//! * **`expires_at_ms` replaces `last_refresh`.** auth.json records when the
//!   token was *minted*; a worker needs to know when it *dies*, and the token
//!   endpoint answers in `expires_in`. Storing the absolute deadline means the
//!   refresh decision is one comparison and needs no second constant.
//!
//! `client_id` and `token_endpoint` are carried per-link rather than compiled in:
//! ADR-0147 결정 3 puts the OAuth flow in the operator's own local CLI, so the
//! client that minted a refresh token is the operator's fact, not momo's. momo
//! embedding a third party's client identifier would be asserting an
//! authorization relationship it does not have.

use serde::{Deserialize, Serialize};

/// The envelope discriminator. Also the label the settings surface projects as
/// the link's credential kind.
pub const OAUTH_OPENAI_KIND: &str = "oauth-openai";

/// OpenAI's OAuth token endpoint — measured from the shipped Codex CLI binary
/// (`@openai/codex` 0.144.1, `codex-darwin-arm64` vendor binary):
/// `https://auth.openai.com/oauth/token`, alongside the request/response field
/// vocabulary `CreateOAuth2TokenRequestBody{client_id, grant_type, code,
/// redirect_uri, code_verifier, refresh_token}` /
/// `CreateOAuth2TokenResponseBody{token_type, expires_in, refresh_token, …}`.
///
/// It is only the **default** for a link that carries no `token_endpoint`: the
/// stored value wins, so a conformance test (or an operator on a different
/// tenant of the same provider) redirects it without a code change.
pub const DEFAULT_OPENAI_TOKEN_ENDPOINT: &str = "https://auth.openai.com/oauth/token";

/// ADR-0147 제약: a subscription OAuth link is one human's personal account.
pub const ATTRIBUTION_PERSONAL: &str = "personal-subscription";

/// ADR-0147 제약: "내부 도그푸딩 한정 경로". The product default stays API keys.
pub const USAGE_SCOPE_INTERNAL_ONLY: &str = "internal-only";

/// The operator-facing sentence for the two labels above, so the constraint is
/// carried by the data rather than re-typed by every surface that renders it
/// (ADR-0147 "UI/문서에 '개인 계정 귀속·내부용' 라벨").
pub const ATTRIBUTION_NOTICE_KO: &str =
    "개인 계정 귀속 · 내부용 — 이 연결은 특정 구성원의 개인 ChatGPT 구독으로 동작하며, \
     사용량은 그 사람의 구독 한도를 씁니다. 제품 기본 경로는 API 키입니다.";

/// The sealed OAuth credential for one provider link.
///
/// `Debug` is hand-written: a `#[derive(Debug)]` here would put a live refresh
/// token into the first `tracing::error!(?credential, …)` anyone adds, which is
/// exactly the failure ADR-0004 Rules #2/#5 forbid.
#[derive(Clone, PartialEq, Eq)]
pub struct OpenAiOAuthCredential {
    /// The long-lived grant. The only field that makes a link usable.
    pub refresh_token: String,
    /// The short-lived Bearer. Absent on a freshly registered link — the worker
    /// mints one on the first turn.
    pub access_token: Option<String>,
    /// Absolute deadline for `access_token`, epoch milliseconds. Absent means
    /// "unknown": the worker then refreshes reactively on a 401 rather than
    /// guessing a lifetime.
    pub expires_at_ms: Option<i64>,
    /// `tokens.account_id` from auth.json — presented as `chatgpt-account-id`,
    /// the header the ChatGPT backend uses to pick the paying account.
    pub account_id: Option<String>,
    /// Whose subscription this is, in the operator's own words. Non-secret: it
    /// is projected to the settings surface so nobody has to guess whose quota a
    /// run is spending.
    pub account_label: Option<String>,
    /// The OAuth client that minted `refresh_token` (the operator's local CLI).
    pub client_id: Option<String>,
    /// Token endpoint override; [`DEFAULT_OPENAI_TOKEN_ENDPOINT`] when absent.
    pub token_endpoint: Option<String>,
    /// [`ATTRIBUTION_PERSONAL`] — the ADR-0147 identity label.
    pub attribution: String,
    /// [`USAGE_SCOPE_INTERNAL_ONLY`] — the ADR-0147 scope label.
    pub usage_scope: String,
}

impl std::fmt::Debug for OpenAiOAuthCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiOAuthCredential")
            .field("refresh_token", &"<redacted>")
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            // account_id/label are non-secret operator metadata, and the whole
            // point of them is to be readable in an operational log line.
            .field("account_id", &self.account_id)
            .field("account_label", &self.account_label)
            .field("token_endpoint", &self.token_endpoint)
            .field("attribution", &self.attribution)
            .field("usage_scope", &self.usage_scope)
            .finish()
    }
}

impl OpenAiOAuthCredential {
    /// A newly registered link: refresh grant only, everything else derived on
    /// the first turn.
    pub fn from_refresh_token(refresh_token: impl Into<String>) -> OpenAiOAuthCredential {
        OpenAiOAuthCredential {
            refresh_token: refresh_token.into(),
            access_token: None,
            expires_at_ms: None,
            account_id: None,
            account_label: None,
            client_id: None,
            token_endpoint: None,
            attribution: ATTRIBUTION_PERSONAL.to_string(),
            usage_scope: USAGE_SCOPE_INTERNAL_ONLY.to_string(),
        }
    }

    /// The endpoint a refresh call goes to.
    pub fn token_endpoint_or_default(&self) -> &str {
        self.token_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_OPENAI_TOKEN_ENDPOINT)
    }

    /// The Bearer to present right now, if there is one.
    pub fn presentable_access_token(&self) -> Option<&str> {
        self.access_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// Is the stored access token missing, or close enough to its deadline that
    /// starting a turn with it is a coin flip?
    ///
    /// `skew_ms` is the caller's safety margin: a request issued 3 seconds
    /// before expiry can still arrive after it, and the resulting 401 costs a
    /// whole round trip. An **unknown** deadline is deliberately *not* treated as
    /// expired — a token with no recorded lifetime is still worth trying, and the
    /// 401 path refreshes it. Guessing "expired" instead would burn a refresh on
    /// every turn of a link that never records `expires_in`.
    pub fn needs_refresh(&self, now_ms: i64, skew_ms: i64) -> bool {
        match self.presentable_access_token() {
            None => true,
            Some(_) => match self.expires_at_ms {
                None => false,
                Some(deadline) => deadline <= now_ms.saturating_add(skew_ms),
            },
        }
    }

    /// Apply a token-endpoint answer.
    ///
    /// `refresh_token` is replaced **only when the provider returned one**: a
    /// provider that does not rotate omits the field, and overwriting the stored
    /// grant with `None` would delete the only thing that makes the link usable.
    pub fn apply_refresh(
        &mut self,
        access_token: impl Into<String>,
        rotated_refresh_token: Option<String>,
        expires_at_ms: Option<i64>,
    ) {
        self.access_token = Some(access_token.into());
        if let Some(rotated) = rotated_refresh_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
        {
            self.refresh_token = rotated;
        }
        self.expires_at_ms = expires_at_ms;
    }
}

/// What a provider link's sealed box actually contains.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkCredential {
    /// The legacy shape: an opaque gateway bearer, stored as its own plaintext.
    Bearer(String),
    /// ADR-0147: an OpenAI subscription OAuth grant.
    OpenAiOAuth(Box<OpenAiOAuthCredential>),
}

impl LinkCredential {
    /// Decide what a decrypted plaintext is. See the module docs for why the
    /// legacy direction is the fallback and not the other way round.
    pub fn parse(plaintext: &str) -> LinkCredential {
        let trimmed = plaintext.trim();
        if !trimmed.starts_with('{') {
            return LinkCredential::Bearer(trimmed.to_string());
        }
        match serde_json::from_str::<OAuthEnvelope>(trimmed) {
            Ok(envelope) if envelope.kind == OAUTH_OPENAI_KIND => {
                LinkCredential::OpenAiOAuth(Box::new(envelope.into_credential()))
            }
            _ => LinkCredential::Bearer(trimmed.to_string()),
        }
    }

    /// The plaintext to seal. Legacy bearers round-trip unchanged, so re-sealing
    /// an untouched link never rewrites its meaning.
    pub fn to_sealed_plaintext(&self) -> String {
        match self {
            LinkCredential::Bearer(bearer) => bearer.clone(),
            LinkCredential::OpenAiOAuth(credential) => {
                serde_json::to_string(&OAuthEnvelope::from_credential(credential))
                    // The envelope is a closed struct of owned Strings and
                    // integers; serialization has no failure mode. Falling back
                    // to an empty document rather than panicking keeps a worker
                    // alive, and an empty plaintext is refused by `seal_bearer`.
                    .unwrap_or_default()
            }
        }
    }

    /// The `Authorization: Bearer` value for this turn, or `""` when the link
    /// holds a grant that has not been exchanged for one yet.
    pub fn presentable_bearer(&self) -> &str {
        match self {
            LinkCredential::Bearer(bearer) => bearer,
            LinkCredential::OpenAiOAuth(credential) => {
                credential.presentable_access_token().unwrap_or("")
            }
        }
    }

    /// Does this link carry enough to reach a provider — now or after one
    /// refresh? This is what makes an OAuth link with no access token yet
    /// *usable* rather than half-written.
    pub fn is_present(&self) -> bool {
        match self {
            LinkCredential::Bearer(bearer) => !bearer.trim().is_empty(),
            LinkCredential::OpenAiOAuth(credential) => !credential.refresh_token.trim().is_empty(),
        }
    }

    /// `bearer` | `oauth-openai` — a non-secret label for responses and logs.
    pub fn kind_label(&self) -> &'static str {
        match self {
            LinkCredential::Bearer(_) => "bearer",
            LinkCredential::OpenAiOAuth(_) => OAUTH_OPENAI_KIND,
        }
    }

    pub fn as_openai_oauth(&self) -> Option<&OpenAiOAuthCredential> {
        match self {
            LinkCredential::OpenAiOAuth(credential) => Some(credential),
            LinkCredential::Bearer(_) => None,
        }
    }

    pub fn as_openai_oauth_mut(&mut self) -> Option<&mut OpenAiOAuthCredential> {
        match self {
            LinkCredential::OpenAiOAuth(credential) => Some(credential),
            LinkCredential::Bearer(_) => None,
        }
    }

    /// `tokens.account_id`, for the `chatgpt-account-id` header.
    pub fn account_id(&self) -> Option<&str> {
        self.as_openai_oauth()
            .and_then(|credential| credential.account_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }
}

/// The on-disk (in-vault) JSON shape. Separate from [`OpenAiOAuthCredential`] so
/// the storage contract is one struct a reviewer can read, and so the in-memory
/// type is free to carry no `kind` field it would have to keep consistent.
#[derive(Debug, Serialize, Deserialize)]
struct OAuthEnvelope {
    kind: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_endpoint: Option<String>,
    #[serde(default = "default_attribution")]
    attribution: String,
    #[serde(default = "default_usage_scope")]
    usage_scope: String,
}

fn default_attribution() -> String {
    ATTRIBUTION_PERSONAL.to_string()
}

fn default_usage_scope() -> String {
    USAGE_SCOPE_INTERNAL_ONLY.to_string()
}

impl OAuthEnvelope {
    fn into_credential(self) -> OpenAiOAuthCredential {
        OpenAiOAuthCredential {
            refresh_token: self.refresh_token,
            access_token: self.access_token,
            expires_at_ms: self.expires_at_ms,
            account_id: self.account_id,
            account_label: self.account_label,
            client_id: self.client_id,
            token_endpoint: self.token_endpoint,
            attribution: self.attribution,
            usage_scope: self.usage_scope,
        }
    }

    fn from_credential(credential: &OpenAiOAuthCredential) -> OAuthEnvelope {
        OAuthEnvelope {
            kind: OAUTH_OPENAI_KIND.to_string(),
            refresh_token: credential.refresh_token.clone(),
            access_token: credential.access_token.clone(),
            expires_at_ms: credential.expires_at_ms,
            account_id: credential.account_id.clone(),
            account_label: credential.account_label.clone(),
            client_id: credential.client_id.clone(),
            token_endpoint: credential.token_endpoint.clone(),
            attribution: credential.attribution.clone(),
            usage_scope: credential.usage_scope.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oauth(refresh: &str) -> OpenAiOAuthCredential {
        OpenAiOAuthCredential::from_refresh_token(refresh)
    }

    /// Every provider_link row that exists today holds a raw bearer. If this
    /// direction ever flipped, every deployed instance would start presenting a
    /// mangled Authorization header on its next turn.
    #[test]
    fn a_legacy_bearer_round_trips_untouched() {
        let credential = LinkCredential::parse("sk-live-abcdefgh");
        assert_eq!(
            credential,
            LinkCredential::Bearer("sk-live-abcdefgh".to_string())
        );
        assert_eq!(credential.to_sealed_plaintext(), "sk-live-abcdefgh");
        assert_eq!(credential.presentable_bearer(), "sk-live-abcdefgh");
        assert_eq!(credential.kind_label(), "bearer");
        assert!(credential.is_present());
    }

    /// A `{`-leading plaintext that is not this envelope must stay a bearer.
    /// Guessing "OAuth" for any JSON-looking secret would silently take a working
    /// link away from a provider whose tokens happen to be JSON-shaped.
    #[test]
    fn only_the_declared_kind_is_an_envelope() {
        for not_ours in [
            r#"{"kind":"oauth-anthropic","refresh_token":"r"}"#,
            r#"{"refresh_token":"r"}"#,
            r#"{not json at all"#,
        ] {
            assert!(
                matches!(LinkCredential::parse(not_ours), LinkCredential::Bearer(_)),
                "{not_ours}"
            );
        }
    }

    #[test]
    fn an_oauth_envelope_round_trips_through_the_vault_plaintext() {
        let mut credential = oauth("rt-primary");
        credential.access_token = Some("at-current".to_string());
        credential.expires_at_ms = Some(1_800_000_000_000);
        credential.account_id = Some("acct-1".to_string());
        credential.account_label = Some("성재 개인 구독".to_string());
        credential.client_id = Some("client-local".to_string());
        credential.token_endpoint = Some("https://auth.example/oauth/token".to_string());

        let sealed = LinkCredential::OpenAiOAuth(Box::new(credential.clone()));
        let plaintext = sealed.to_sealed_plaintext();
        assert_eq!(LinkCredential::parse(&plaintext), sealed);
        assert_eq!(sealed.presentable_bearer(), "at-current");
        assert_eq!(sealed.kind_label(), OAUTH_OPENAI_KIND);
        assert_eq!(sealed.account_id(), Some("acct-1"));
    }

    /// ADR-0147's two labels are the constraint 성재 accepted. A link that
    /// somehow reached the vault without them must still read as personal and
    /// internal-only, never as an unlabelled production credential.
    #[test]
    fn the_attribution_labels_default_rather_than_going_missing() {
        let credential =
            LinkCredential::parse(r#"{"kind":"oauth-openai","refresh_token":"rt-only"}"#);
        let oauth = credential.as_openai_oauth().expect("oauth kind");
        assert_eq!(oauth.attribution, ATTRIBUTION_PERSONAL);
        assert_eq!(oauth.usage_scope, USAGE_SCOPE_INTERNAL_ONLY);
        assert_eq!(
            oauth.token_endpoint_or_default(),
            DEFAULT_OPENAI_TOKEN_ENDPOINT
        );
    }

    /// A grant with no access token yet is a *usable* link — the worker's first
    /// turn mints one. Reading it as half-written would send the instance back to
    /// the env bearer the operator just replaced.
    #[test]
    fn a_grant_without_an_access_token_is_still_present_but_needs_a_refresh() {
        let credential = LinkCredential::OpenAiOAuth(Box::new(oauth("rt-primary")));
        assert!(credential.is_present());
        assert_eq!(credential.presentable_bearer(), "");
        assert!(credential
            .as_openai_oauth()
            .expect("oauth")
            .needs_refresh(0, 60_000));

        let empty = LinkCredential::OpenAiOAuth(Box::new(oauth("   ")));
        assert!(
            !empty.is_present(),
            "no grant means nothing to refresh with"
        );
    }

    /// The refresh decision. The skew is what stops a token that expires
    /// mid-flight from costing a wasted request, and an unknown deadline must not
    /// force a refresh on every single turn.
    #[test]
    fn expiry_uses_a_skew_and_an_unknown_deadline_is_not_an_expired_one() {
        let mut credential = oauth("rt");
        credential.access_token = Some("at".to_string());

        credential.expires_at_ms = Some(1_000_000);
        assert!(!credential.needs_refresh(900_000, 60_000), "still fresh");
        assert!(
            credential.needs_refresh(940_001, 60_000),
            "inside the skew window it is treated as expired"
        );
        assert!(credential.needs_refresh(1_000_001, 0), "past the deadline");

        credential.expires_at_ms = None;
        assert!(
            !credential.needs_refresh(i64::MAX, 60_000),
            "an unrecorded lifetime must not burn a refresh every turn"
        );
    }

    /// Provider behaviour ADR-0147 names explicitly ("refresh token 회전 시 이전
    /// 토큰 무효화는 provider 동작을 따름"): when the endpoint rotates the grant,
    /// the new one must replace the old, and when it does not, the old one must
    /// survive.
    #[test]
    fn a_rotated_grant_replaces_the_old_one_and_a_missing_one_never_erases_it() {
        let mut credential = oauth("rt-1");
        credential.apply_refresh("at-1", Some("rt-2".to_string()), Some(10));
        assert_eq!(credential.refresh_token, "rt-2");
        assert_eq!(credential.access_token.as_deref(), Some("at-1"));
        assert_eq!(credential.expires_at_ms, Some(10));

        credential.apply_refresh("at-2", None, Some(20));
        assert_eq!(
            credential.refresh_token, "rt-2",
            "a provider that does not rotate must not lose the grant"
        );
        credential.apply_refresh("at-3", Some("  ".to_string()), None);
        assert_eq!(credential.refresh_token, "rt-2", "blank is not a rotation");
    }

    /// The debug path is the one a future `tracing::error!(?credential)` takes.
    #[test]
    fn debugging_a_credential_never_prints_a_token() {
        let mut credential = oauth("rt-supersecret");
        credential.access_token = Some("at-supersecret".to_string());
        credential.account_label = Some("성재 개인 구독".to_string());
        let rendered = format!("{credential:?}");
        assert!(!rendered.contains("rt-supersecret"), "{rendered}");
        assert!(!rendered.contains("at-supersecret"), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(
            rendered.contains("성재 개인 구독"),
            "the non-secret owner label is the point of the field"
        );

        let wrapped = LinkCredential::OpenAiOAuth(Box::new(credential));
        assert!(!format!("{wrapped:?}").contains("supersecret"));
    }
}
