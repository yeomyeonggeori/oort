//! ADR-0162 증보 1 / HAP-E7 — the SQL-free half of MCP OAuth 2.1.
//!
//! Everything here is a pure function of its arguments: metadata documents,
//! PKCE `S256` verification, exact redirect-URI comparison and the closed
//! parameter grammar of the authorization/token/revocation requests. No
//! database, no HTTP client, no environment. The server adapter owns issuer
//! configuration, the registered-client allowlist, persistence and audit, and
//! injects the already-resolved values into the constructors below.
//!
//! ## What this module deliberately does NOT do
//!
//! * It never derives the issuer or the resource from a request. Both arrive as
//!   operator configuration, because `Host`/`Forwarded`/`X-Forwarded-*` are
//!   attacker-controlled and an authorization server whose identity moves with
//!   a header has no identity at all (RFC 9207 §2.3, RFC 8414 §2).
//! * It advertises only what is implemented. There is no `registration_endpoint`
//!   and no Client ID Metadata Document support, so a first-wave deployment
//!   cannot be talked into fetching a URL a client named (SSRF) or into
//!   registering a client nobody approved.
//! * It knows nothing about `client_secret`. Every registered client is public
//!   and proves possession with PKCE alone.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The one code challenge method this server accepts. `plain` is not
/// implemented, not advertised, and refused by [`validate_code_challenge`].
pub const CODE_CHALLENGE_METHOD_S256: &str = "S256";
/// The one `response_type`.
pub const RESPONSE_TYPE_CODE: &str = "code";
pub const GRANT_TYPE_AUTHORIZATION_CODE: &str = "authorization_code";
pub const GRANT_TYPE_REFRESH_TOKEN: &str = "refresh_token";
/// RFC 6750 token type, rendered with this exact spelling in token responses.
pub const TOKEN_TYPE_BEARER: &str = "Bearer";

/// The `.well-known` prefix RFC 9728 §3.1 reserves for a protected resource
/// whose identifier carries a path. The resource path is appended verbatim.
pub const PROTECTED_RESOURCE_WELL_KNOWN_PREFIX: &str = "/.well-known/oauth-protected-resource";
/// RFC 8414 §3 authorization-server metadata path (issuer has no path component
/// in this deployment, so the bare well-known is the whole location).
pub const AUTHORIZATION_SERVER_WELL_KNOWN: &str = "/.well-known/oauth-authorization-server";

/// Bounds. Every one of these is a refusal, not a truncation.
pub const MAX_CLIENT_ID_BYTES: usize = 200;
pub const MAX_REDIRECT_URI_BYTES: usize = 2000;
pub const MAX_STATE_BYTES: usize = 512;
pub const MAX_RESOURCE_BYTES: usize = 2000;
pub const MIN_CODE_CHALLENGE_CHARS: usize = 43;
pub const MAX_CODE_CHALLENGE_CHARS: usize = 128;
pub const MIN_CODE_VERIFIER_CHARS: usize = 43;
pub const MAX_CODE_VERIFIER_CHARS: usize = 128;

/// RFC 6749 §4.1.2.1 / §5.2 error codes this server emits. A closed enum rather
/// than free strings so a new refusal cannot invent a code a client will not
/// recognise — and so no refusal can accidentally carry a detail string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OauthError {
    InvalidRequest,
    InvalidClient,
    InvalidGrant,
    UnauthorizedClient,
    UnsupportedGrantType,
    UnsupportedResponseType,
    InvalidScope,
    AccessDenied,
    ServerError,
    /// RFC 8707 §2 — the request named a resource this server does not protect.
    InvalidTarget,
}

impl OauthError {
    pub fn code(self) -> &'static str {
        match self {
            OauthError::InvalidRequest => "invalid_request",
            OauthError::InvalidClient => "invalid_client",
            OauthError::InvalidGrant => "invalid_grant",
            OauthError::UnauthorizedClient => "unauthorized_client",
            OauthError::UnsupportedGrantType => "unsupported_grant_type",
            OauthError::UnsupportedResponseType => "unsupported_response_type",
            OauthError::InvalidScope => "invalid_scope",
            OauthError::AccessDenied => "access_denied",
            OauthError::ServerError => "server_error",
            OauthError::InvalidTarget => "invalid_target",
        }
    }

    /// The HTTP status a token/revocation endpoint answers with.
    pub fn status(self) -> u16 {
        match self {
            OauthError::InvalidClient => 401,
            OauthError::ServerError => 500,
            _ => 400,
        }
    }

    /// The body. Deliberately code-only: an OAuth error must never carry a
    /// description assembled from request material, because the request carries
    /// the code, the verifier and the client's own state.
    pub fn body(self) -> Value {
        json!({ "error": self.code() })
    }
}

/// RFC 9728 protected-resource metadata for the canonical Agent Port.
///
/// `authorization_servers` names exactly one issuer — the operator's — so a
/// client that follows this document cannot be steered to a third-party
/// authorization server by anything a request contains.
pub fn protected_resource_metadata(resource: &str, issuer: &str, scopes: &[&str]) -> Value {
    json!({
        "resource": resource,
        "authorization_servers": [issuer],
        "scopes_supported": scopes,
        "bearer_methods_supported": ["header"],
        "resource_name": "oort Agent Port",
    })
}

/// RFC 8414 authorization-server metadata.
///
/// Every advertised capability below is implemented by this server. In
/// particular there is **no** `registration_endpoint` (Dynamic Client
/// Registration is not implemented and not fetched), no
/// `token_endpoint_auth_signing_alg_values_supported` (no client
/// authentication exists), and `token_endpoint_auth_methods_supported` is
/// `["none"]` because every registered client is public.
pub fn authorization_server_metadata(
    issuer: &str,
    authorization_endpoint: &str,
    token_endpoint: &str,
    revocation_endpoint: &str,
    scopes: &[&str],
) -> Value {
    json!({
        "issuer": issuer,
        "authorization_endpoint": authorization_endpoint,
        "token_endpoint": token_endpoint,
        "revocation_endpoint": revocation_endpoint,
        "revocation_endpoint_auth_methods_supported": ["none"],
        "response_types_supported": [RESPONSE_TYPE_CODE],
        "response_modes_supported": ["query"],
        "grant_types_supported": [GRANT_TYPE_AUTHORIZATION_CODE, GRANT_TYPE_REFRESH_TOKEN],
        "code_challenge_methods_supported": [CODE_CHALLENGE_METHOD_S256],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": scopes,
        "authorization_response_iss_parameter_supported": true,
        "resource_indicators_supported": true,
    })
}

/// Exact string comparison of a presented redirect URI against the registered
/// set (RFC 6749 §3.1.2.3 / OAuth 2.1 §4.1.3).
///
/// No normalization, no prefix rule, no wildcard, no case folding. A registered
/// `https://c.example/cb` does not match `https://c.example/cb/`,
/// `https://c.example/cb?x=1`, `https://C.example/cb` or
/// `https://c.example/cb/../cb`. Every one of those is an open redirect in some
/// deployment, and none of them is worth a convenience.
pub fn redirect_uri_is_registered(presented: &str, registered: &[String]) -> bool {
    presented.len() <= MAX_REDIRECT_URI_BYTES
        && registered.iter().any(|allowed| allowed == presented)
}

/// Validate a `code_challenge` + `code_challenge_method` pair.
///
/// `plain` fails closed here rather than downgrading, and an absent method is
/// **not** defaulted to `plain` the way RFC 7636 §4.3 permits: OAuth 2.1
/// requires S256 for public clients and a default that weakens the exchange is
/// a downgrade with extra steps.
pub fn validate_code_challenge(challenge: &str, method: Option<&str>) -> Result<(), OauthError> {
    if method != Some(CODE_CHALLENGE_METHOD_S256) {
        return Err(OauthError::InvalidRequest);
    }
    if !is_base64url_of_length(
        challenge,
        MIN_CODE_CHALLENGE_CHARS,
        MAX_CODE_CHALLENGE_CHARS,
    ) {
        return Err(OauthError::InvalidRequest);
    }
    Ok(())
}

/// RFC 7636 §4.6 — `BASE64URL(SHA256(ASCII(verifier))) == challenge`.
///
/// The comparison is over the recomputed challenge, so it is a comparison of
/// two server-derived values of equal length and shape; the verifier itself
/// never leaves this function and is never rendered anywhere.
pub fn verify_pkce_s256(verifier: &str, challenge: &str) -> bool {
    if !is_unreserved_of_length(verifier, MIN_CODE_VERIFIER_CHARS, MAX_CODE_VERIFIER_CHARS) {
        return false;
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let recomputed = URL_SAFE_NO_PAD.encode(digest);
    constant_time_eq(recomputed.as_bytes(), challenge.as_bytes())
}

/// Compare two byte strings without an early exit on the first difference.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn is_base64url_of_length(value: &str, min: usize, max: usize) -> bool {
    let length = value.chars().count();
    length >= min
        && length <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// RFC 7636 §4.1 `code_verifier` alphabet: `[A-Za-z0-9-._~]`.
fn is_unreserved_of_length(value: &str, min: usize, max: usize) -> bool {
    let length = value.chars().count();
    length >= min
        && length <= max
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || byte == b'-'
                || byte == b'.'
                || byte == b'_'
                || byte == b'~'
        })
}

/// A `state` value bounded and echoed verbatim, or `None` when absent.
///
/// State is client material travelling through a browser. It is bounded so it
/// cannot be used as a storage channel, and it is the ONLY client-controlled
/// value this server ever writes back into a redirect.
pub fn validate_state(state: Option<&str>) -> Result<Option<String>, OauthError> {
    match state {
        None => Ok(None),
        Some(value) if value.len() <= MAX_STATE_BYTES && !value.is_empty() => {
            Ok(Some(value.to_string()))
        }
        Some(_) => Err(OauthError::InvalidRequest),
    }
}

/// RFC 8707 `resource`: required, single-valued, and exactly the canonical
/// resource this server protects.
pub fn validate_resource(presented: Option<&str>, canonical: &str) -> Result<(), OauthError> {
    match presented {
        Some(value) if value.len() <= MAX_RESOURCE_BYTES && value == canonical => Ok(()),
        _ => Err(OauthError::InvalidTarget),
    }
}

/// Space-delimited scope request → the closed vocabulary, preserving neither
/// duplicates nor unknown values.
///
/// Refusing an unknown scope (rather than silently dropping it) is what makes
/// the consent screen's list the same list the credential ends up with.
pub fn parse_requested_scopes(
    scope: Option<&str>,
    grantable: &[&str],
) -> Result<Vec<String>, OauthError> {
    let Some(scope) = scope else {
        return Err(OauthError::InvalidScope);
    };
    let mut parsed: Vec<String> = Vec::new();
    for item in scope.split(' ').filter(|item| !item.is_empty()) {
        if !grantable.contains(&item) || parsed.iter().any(|existing| existing == item) {
            return Err(OauthError::InvalidScope);
        }
        parsed.push(item.to_string());
    }
    if parsed.is_empty() {
        return Err(OauthError::InvalidScope);
    }
    Ok(parsed)
}

/// Percent-encode one query-parameter value.
///
/// Written here rather than pulled in as a dependency because the only values
/// this server ever puts in a redirect are `code`, `state` and `iss`, and the
/// encoding of those three is part of the security contract: an unencoded
/// `state` containing `&` would let a client forge additional parameters.
pub fn percent_encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Build the exact redirect a successful or refused authorization returns.
///
/// `iss` is RFC 9207 and is always present, so a client that received a code
/// can tell which authorization server minted it and cannot be mixed up by a
/// second one. Nothing else is ever appended: no token, no verifier, no
/// connection id, no workspace id.
pub fn authorization_redirect(
    redirect_uri: &str,
    issuer: &str,
    state: Option<&str>,
    outcome: Result<&str, OauthError>,
) -> String {
    let mut query = String::new();
    match outcome {
        Ok(code) => {
            query.push_str("code=");
            query.push_str(&percent_encode_query_value(code));
        }
        Err(error) => {
            query.push_str("error=");
            query.push_str(&percent_encode_query_value(error.code()));
        }
    }
    if let Some(state) = state {
        query.push_str("&state=");
        query.push_str(&percent_encode_query_value(state));
    }
    query.push_str("&iss=");
    query.push_str(&percent_encode_query_value(issuer));
    let separator = if redirect_uri.contains('?') { '&' } else { '?' };
    format!("{redirect_uri}{separator}{query}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRANTABLE: [&str; 6] = [
        "agent:port:connect",
        "agent:inbox:read",
        "messages:read",
        "messages:write",
        "agent:jobs:read",
        "agent:runs:callback",
    ];

    #[test]
    fn pkce_s256_matches_the_rfc_7636_appendix_b_vector() {
        // RFC 7636 Appendix B, byte for byte.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(verify_pkce_s256(verifier, challenge));
        assert!(!verify_pkce_s256(
            verifier,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN"
        ));
    }

    #[test]
    fn plain_and_absent_challenge_methods_fail_closed() {
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(validate_code_challenge(challenge, Some("S256")).is_ok());
        assert_eq!(
            validate_code_challenge(challenge, Some("plain")),
            Err(OauthError::InvalidRequest)
        );
        assert_eq!(
            validate_code_challenge(challenge, None),
            Err(OauthError::InvalidRequest)
        );
        assert_eq!(
            validate_code_challenge("short", Some("S256")),
            Err(OauthError::InvalidRequest)
        );
    }

    #[test]
    fn redirect_uri_comparison_is_byte_exact() {
        let registered = vec!["https://client.example/cb".to_string()];
        assert!(redirect_uri_is_registered(
            "https://client.example/cb",
            &registered
        ));
        for near_miss in [
            "https://client.example/cb/",
            "https://client.example/cb?x=1",
            "https://Client.example/cb",
            "https://client.example/cb/../cb",
            "https://client.example/cb#f",
            "http://client.example/cb",
        ] {
            assert!(
                !redirect_uri_is_registered(near_miss, &registered),
                "{near_miss} must not match"
            );
        }
    }

    #[test]
    fn advertised_metadata_names_no_unimplemented_capability() {
        let document = authorization_server_metadata(
            "https://oort.example",
            "https://oort.example/v1/oauth/authorize",
            "https://oort.example/v1/oauth/token",
            "https://oort.example/v1/oauth/revoke",
            &GRANTABLE,
        );
        let rendered = document.to_string();
        for absent in [
            "registration_endpoint",
            "client_id_metadata_document",
            "client_secret",
            "introspection_endpoint",
            "device_authorization_endpoint",
            "plain",
        ] {
            assert!(
                !rendered.contains(absent),
                "{absent} must not be advertised"
            );
        }
        assert_eq!(
            document["code_challenge_methods_supported"],
            json!(["S256"])
        );
        assert_eq!(
            document["token_endpoint_auth_methods_supported"],
            json!(["none"])
        );
        assert_eq!(
            document["authorization_response_iss_parameter_supported"],
            json!(true)
        );
    }

    #[test]
    fn protected_resource_metadata_names_exactly_one_issuer() {
        let document = protected_resource_metadata(
            "https://oort.example/v1/mcp/agent-port",
            "https://oort.example",
            &GRANTABLE,
        );
        assert_eq!(
            document["authorization_servers"],
            json!(["https://oort.example"])
        );
        assert_eq!(document["bearer_methods_supported"], json!(["header"]));
    }

    #[test]
    fn scope_parsing_refuses_anything_outside_the_hosted_ceiling() {
        assert_eq!(
            parse_requested_scopes(Some("agent:port:connect messages:read"), &GRANTABLE),
            Ok(vec![
                "agent:port:connect".to_string(),
                "messages:read".to_string()
            ])
        );
        for refused in ["work:control", "realtime:subscribe", "provider:quota:write"] {
            assert_eq!(
                parse_requested_scopes(Some(&format!("agent:port:connect {refused}")), &GRANTABLE),
                Err(OauthError::InvalidScope)
            );
        }
        assert_eq!(
            parse_requested_scopes(None, &GRANTABLE),
            Err(OauthError::InvalidScope)
        );
        assert_eq!(
            parse_requested_scopes(Some(""), &GRANTABLE),
            Err(OauthError::InvalidScope)
        );
        assert_eq!(
            parse_requested_scopes(Some("messages:read messages:read"), &GRANTABLE),
            Err(OauthError::InvalidScope)
        );
    }

    #[test]
    fn resource_must_be_the_exact_canonical_one() {
        let canonical = "https://oort.example/v1/mcp/agent-port";
        assert!(validate_resource(Some(canonical), canonical).is_ok());
        for wrong in [
            "https://oort.example/v1/mcp/agent-port/",
            "https://oort.example/v1/mcp/agent-port?x",
            "https://evil.example/v1/mcp/agent-port",
            "https://oort.example",
        ] {
            assert_eq!(
                validate_resource(Some(wrong), canonical),
                Err(OauthError::InvalidTarget)
            );
        }
        assert_eq!(
            validate_resource(None, canonical),
            Err(OauthError::InvalidTarget)
        );
    }

    #[test]
    fn redirect_encodes_state_so_a_client_cannot_forge_parameters() {
        let redirect = authorization_redirect(
            "https://client.example/cb",
            "https://oort.example",
            Some("a&b=c#d"),
            Ok("momo_oauth_code_v1.x.y"),
        );
        assert_eq!(
            redirect,
            "https://client.example/cb?code=momo_oauth_code_v1.x.y&state=a%26b%3Dc%23d&iss=https%3A%2F%2Foort.example"
        );
        let denied = authorization_redirect(
            "https://client.example/cb?tenant=1",
            "https://oort.example",
            None,
            Err(OauthError::AccessDenied),
        );
        assert_eq!(
            denied,
            "https://client.example/cb?tenant=1&error=access_denied&iss=https%3A%2F%2Foort.example"
        );
    }

    #[test]
    fn an_oauth_error_body_never_carries_request_material() {
        for error in [
            OauthError::InvalidRequest,
            OauthError::InvalidClient,
            OauthError::InvalidGrant,
            OauthError::InvalidTarget,
            OauthError::AccessDenied,
        ] {
            let body = error.body();
            assert_eq!(body.as_object().map(|object| object.len()), Some(1));
            assert!(body.get("error").is_some());
        }
    }
}
