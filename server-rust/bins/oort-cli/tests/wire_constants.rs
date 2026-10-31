//! Drift guard: the few values the `oort` binary must share with the server, held against the
//! server's own definitions. The binary links no server crate (`Cargo.toml`), so this file —
//! which does, as a dev-dependency — is the one place the two sides meet.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `the_login_wire_constants_are_the_servers` | client id, the five loopback ports, callback path, resource path, scope vocabulary, the MCP era, both envelope prefixes | either side changes one without the other |
//! | `the_routes_the_cli_calls_are_exactly_the_closed_table` | the eight (method, template) pairs equal `DEV_ROUTE_TABLE` | the server renames or closes a row, or the CLI calls a route off the table |
//! | `the_envelope_grammar_is_the_servers` | what the server mints, the CLI parses; the CLI and the server's workspace readers agree on good and bad strings | the grammar differs on either side |

use std::collections::BTreeSet;

use momo_auth::{
    dev_refresh_workspace_id, dev_token_workspace_id, DEV_REFRESH_PREFIX, DEV_ROUTE_TABLE,
    DEV_SCOPES, DEV_TOKEN_PREFIX,
};
use momo_mcp::oauth::{
    oort_cli_redirect_uri_is_registered, OORT_CLI_CALLBACK_PATH, OORT_CLI_CLIENT_ID,
    OORT_CLI_LOOPBACK_PORTS, OORT_CLI_REDIRECT_URIS,
};
use oort_cli::api::Route;
use oort_cli::login::{CALLBACK_PATH, LOOPBACK_PORTS, REQUESTED_SCOPES, RESOURCE_PATH};
use oort_cli::secret::{parse_envelope, EnvelopeKind, ACCESS_PREFIX, REFRESH_PREFIX};

#[test]
fn the_login_wire_constants_are_the_servers() {
    assert_eq!(oort_cli::session::CLIENT_ID, OORT_CLI_CLIENT_ID);
    assert_eq!(LOOPBACK_PORTS, OORT_CLI_LOOPBACK_PORTS);
    assert_eq!(CALLBACK_PATH, OORT_CLI_CALLBACK_PATH);
    let ours: Vec<String> = LOOPBACK_PORTS
        .iter()
        .map(|port| format!("http://127.0.0.1:{port}{CALLBACK_PATH}"))
        .collect();
    assert_eq!(ours, OORT_CLI_REDIRECT_URIS.to_vec());
    for uri in &ours {
        assert!(oort_cli_redirect_uri_is_registered(uri), "{uri}");
    }
    assert_eq!(RESOURCE_PATH, momo_server::config::DEV_LOGIN_RESOURCE_PATH);
    assert_eq!(REQUESTED_SCOPES, DEV_SCOPES);
    assert_eq!(
        oort_cli::mcp::LEGACY_VERSION,
        momo_mcp::LEGACY_PROTOCOL_VERSION
    );
    assert_eq!(ACCESS_PREFIX, format!("{DEV_TOKEN_PREFIX}."));
    assert_eq!(REFRESH_PREFIX, format!("{DEV_REFRESH_PREFIX}."));
    assert_eq!(oort_cli::mcp::MAX_LINE_BYTES, momo_mcp::MAX_BODY_BYTES);
    // ADR-0218 appendix A: the one larger budget is the same number and the same action on
    // both sides of the bridge.
    assert_eq!(
        oort_cli::mcp::MAX_EXPRESSION_LINE_BYTES,
        momo_mcp::MAX_EXPRESSION_REQUEST_BYTES
    );
    assert_eq!(
        oort_cli::mcp::EXPRESSION_CREATE_ACTION_ID,
        momo_mcp::EXPRESSION_CREATE_ACTION_ID
    );
}

#[test]
fn the_routes_the_cli_calls_are_exactly_the_closed_table() {
    let ours: BTreeSet<(&str, &str)> = Route::ALL
        .iter()
        .map(|route| (route.method(), route.template()))
        .collect();
    let theirs: BTreeSet<(&str, &str)> = DEV_ROUTE_TABLE
        .iter()
        .map(|route| (route.method, route.template))
        .collect();
    assert_eq!(
        ours.len(),
        Route::ALL.len(),
        "no two commands share a (method, route)"
    );
    assert_eq!(ours, theirs);
}

#[test]
fn the_envelope_grammar_is_the_servers() {
    let ws = "6f1c2b0e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
    let secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
    let samples = [
        format!("{DEV_TOKEN_PREFIX}.{ws}.{secret}"),
        format!("{DEV_REFRESH_PREFIX}.{ws}.{secret}"),
        format!("{DEV_TOKEN_PREFIX}.{ws}.{}", &secret[1..]),
        format!("{DEV_TOKEN_PREFIX}.{ws}.{secret}x"),
        format!("{DEV_TOKEN_PREFIX}.{}.{secret}", ws.to_uppercase()),
        format!("{DEV_TOKEN_PREFIX}.not-a-uuid.{secret}"),
        format!("momo_agent_v1.{ws}.{secret}"),
        format!(" {DEV_TOKEN_PREFIX}.{ws}.{secret}"),
        String::new(),
    ];
    // everything the server mints is something the CLI accepts, for both halves
    for _ in 0..16 {
        for (prefix, kind) in [
            (DEV_TOKEN_PREFIX, EnvelopeKind::Access),
            (DEV_REFRESH_PREFIX, EnvelopeKind::Refresh),
        ] {
            let workspace = uuid::Uuid::new_v4();
            let minted = momo_auth::mint_dev_envelope(prefix, workspace).expect("mint");
            let parsed = parse_envelope(&minted).expect("a minted envelope parses");
            assert_eq!((parsed.kind, parsed.workspace_id), (kind, workspace));
        }
    }
    for sample in &samples {
        let mine = parse_envelope(sample);
        let server_access = dev_token_workspace_id(sample);
        let server_refresh = dev_refresh_workspace_id(sample);
        match mine {
            Some(envelope) if envelope.kind == EnvelopeKind::Access => {
                assert_eq!(server_access, Some(envelope.workspace_id), "{sample:?}");
                assert_eq!(server_refresh, None, "{sample:?}");
            }
            Some(envelope) => {
                assert_eq!(server_refresh, Some(envelope.workspace_id), "{sample:?}");
                assert_eq!(server_access, None, "{sample:?}");
            }
            None => {
                assert_eq!(server_access, None, "{sample:?}");
                assert_eq!(server_refresh, None, "{sample:?}");
            }
        }
    }
}
