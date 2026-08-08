//! Byte-identical conformance for the WorkHost signing format.
//!
//! Fixed inputs → exact expected string, hand-constructed to match the Swift
//! sources so a drift in either the Rust builder or a future workd port fails
//! loudly:
//!   * signer:   `workers/WorkHostDaemon/.../Signing.swift:26-64`
//!   * verifier: `server/.../Auth/WorkHostAuthenticator.swift:128-154`

use momo_wire::signing::{heartbeat_payload, request_payload, sha256_hex};
use uuid::Uuid;

fn ws() -> Uuid {
    Uuid::from_u128(1)
}
fn host() -> Uuid {
    Uuid::from_u128(2)
}
fn req() -> Uuid {
    Uuid::from_u128(3)
}

#[test]
fn heartbeat_v1_bytes_are_exact() {
    let bytes = heartbeat_payload(ws(), host(), 1_730_000_000_000);
    let expected = "momo.work_host.heartbeat.v1\n\
                    00000000-0000-0000-0000-000000000001\n\
                    00000000-0000-0000-0000-000000000002\n\
                    1730000000000";
    assert_eq!(bytes, expected.as_bytes());
}

#[test]
fn request_v2_bytes_are_exact() {
    // Empty-body digest, cross-checked against the SHA-256 empty vector.
    let digest = sha256_hex(b"");
    assert_eq!(
        digest,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );

    let path = "/v1/workspaces/00000000-0000-0000-0000-000000000001\
                /work-hosts/00000000-0000-0000-0000-000000000002/pending-controls";

    // Lower-case method input proves the builder upper-cases it (Swift parity).
    let bytes = request_payload("get", path, ws(), host(), 1_730_000_000_000, &digest, req());

    let expected = format!(
        "momo.work_host.request.v2\n\
         GET\n\
         {path}\n\
         00000000-0000-0000-0000-000000000001\n\
         00000000-0000-0000-0000-000000000002\n\
         1730000000000\n\
         {digest}\n\
         00000000-0000-0000-0000-000000000003"
    );
    assert_eq!(bytes, expected.into_bytes());
}
