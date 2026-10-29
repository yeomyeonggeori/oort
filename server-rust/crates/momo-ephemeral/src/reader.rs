//! The read half of the transport — 「who has a live connection to this
//! workspace right now」 (ADR-0160 ②, #4692).
//!
//! ADR-0160 D1 calls availability 「전송이 이미 소유한 사실」, and its rejected
//! alternative D says a client must not read that fact for itself: it goes
//! through a **server seam** that composes it with the declared status. This is
//! the seam. Like [`crate::publisher`] it is a wall made of types, not a rule:
//!
//! * the only question it can ask is [`PresenceReader::online_members`], and that
//!   takes a **workspace id** and builds the channel name itself. There is no
//!   `presence(channel)` to reach for, so a handler cannot ask about a channel it
//!   made up, and cannot ask about another tenant's workspace unless it is
//!   handed that tenant's id (the roster route only ever hands it the caller's
//!   own, which `workspace_scope` has already pinned to the credential);
//! * what comes back is a set of **member ids**. A Centrifugo client id, a
//!   connection's `conn_info` and every other field of a presence entry are
//!   dropped in [`parse_online_members`], so nothing that identifies a *device*
//!   leaves this file;
//! * a failure is [`OnlineRead::Unavailable`], **never an empty set**. 「I could
//!   not ask」 and 「nobody is connected」 are different statements, and collapsing
//!   them would paint every colleague offline the moment Centrifugo hiccups. A
//!   missing `result.presence` key is a failure for the same reason: it is a
//!   protocol surprise, not an answer;
//! * Postgres is not reachable from here (`lib.rs::the_publisher_has_no_database_dependency`
//!   covers this crate's whole manifest), so availability stays a fact that was
//!   never stored (ADR-0160 guard 2).
//!
//! It holds no state: no cache, no map of who was online a second ago, no timer.
//! Every call is one `POST {api}/presence` (ADR-0149 guard 4, inherited). Whether
//! that is cheap enough is a question for the roster's poll rate, which is the
//! client's; a cache here would be the first server-held availability state.

use std::collections::HashSet;
use std::time::Duration;

use uuid::Uuid;

use crate::publisher::logical_error;
use crate::signal::online_channel;

/// How long the roster waits on Centrifugo before answering without availability.
///
/// The roster is the hot path of every client's first paint, and the read runs
/// beside the Postgres read (not after it), so this is the most a slow broker can
/// add. It is deliberately a little over what Centrifugo needs inside one private
/// network, and far under the publisher's reasoning for a typing indicator: a
/// roster that is 1.5s late is a visible regression, a roster without dots is not.
pub const PRESENCE_READ_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Largest presence body this reader will take.
///
/// A presence table lists **one entry per connection**, so its size follows the
/// workspace's connections, not the answer's. The cap keeps a runaway channel (or
/// a hostile hop) from making the api buffer an unbounded body for a boolean per
/// person; over the cap the read is `Unavailable`, and the roster simply carries
/// no availability.
pub const PRESENCE_MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// What one availability read established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnlineRead {
    /// The members that have at least one live connection to the workspace, as of
    /// this call. A member who is **not** in the set is offline — this variant is
    /// only returned when the broker actually answered.
    Known(HashSet<Uuid>),
    /// The question could not be answered (broker down, slow, refused, or an
    /// answer this reader does not understand). The caller must treat every
    /// member's availability as **unknown**, which is not the same as offline.
    Unavailable(String),
}

/// The only object in `momo-server`'s reach that can read Centrifugo's presence.
///
/// Built from the same credential as [`crate::EphemeralPublisher`] and absent on
/// exactly the same instances (`CENT_API_URL` + `CENT_API_KEY`), so an instance
/// that never configured the transport simply reports no availability.
#[derive(Clone)]
pub struct PresenceReader {
    http: reqwest::Client,
    presence_url: String,
    api_key: String,
}

impl std::fmt::Debug for PresenceReader {
    /// Hand-written: `api_key` is the Centrifugo server-API credential, and a
    /// `{:?}` of the app state is how it would reach a log.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PresenceReader")
            .field("presence_url", &self.presence_url)
            .finish_non_exhaustive()
    }
}

impl PresenceReader {
    pub fn new(api_url: &str, api_key: impl Into<String>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .timeout(PRESENCE_READ_TIMEOUT)
            .build()?;
        Ok(PresenceReader {
            http,
            presence_url: format!("{}/presence", api_url.trim_end_matches('/')),
            api_key: api_key.into(),
        })
    }

    /// Who is connected to `workspace_id` right now. Never returns `Err`: every
    /// failure is classified so the caller can always answer its own client.
    pub async fn online_members(&self, workspace_id: Uuid) -> OnlineRead {
        let channel = online_channel(workspace_id);
        let response = self
            .http
            .post(&self.presence_url)
            .header("X-API-Key", &self.api_key)
            .json(&serde_json::json!({ "channel": channel }))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => return OnlineRead::Unavailable(format!("presence read failed: {error}")),
        };
        let status = response.status();
        if !status.is_success() {
            return OnlineRead::Unavailable(format!("HTTP {}", status.as_u16()));
        }
        let body = match read_capped(response).await {
            Ok(body) => body,
            Err(reason) => return OnlineRead::Unavailable(reason),
        };
        match parse_online_members(&body) {
            Ok(members) => OnlineRead::Known(members),
            Err(reason) => OnlineRead::Unavailable(reason),
        }
    }
}

/// Accumulate a response body, refusing to hold more than
/// [`PRESENCE_MAX_BODY_BYTES`].
async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len().saturating_add(chunk.len()) > PRESENCE_MAX_BODY_BYTES {
                    return Err("presence response exceeds the size cap".to_string());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(error) => return Err(format!("presence response unreadable: {error}")),
        }
    }
}

/// Reduce a Centrifugo `presence` answer to the members it names.
///
/// Centrifugo answers `{"result":{"presence":{"<client id>":{"user":"<id>",
/// "client":"<client id>", …}}}}`, **one entry per connection**, so a person on a
/// laptop and a phone is two entries with one `user`; the set is how
/// multi-device coalesces. Entries whose `user` is not a UUID (an anonymous
/// connection reports `""`) name no member and are skipped.
///
/// Anything that is not that shape is an `Err`, and so is a logical failure
/// Centrifugo reports inside a 200 (`unknown channel` when the namespace is not
/// configured, `not available` when presence is off for it): the caller turns
/// both into [`OnlineRead::Unavailable`], never into an empty set.
pub(crate) fn parse_online_members(body: &[u8]) -> Result<HashSet<Uuid>, String> {
    let text =
        std::str::from_utf8(body).map_err(|_| "presence response is not UTF-8".to_string())?;
    if let Some(error) = logical_error(text) {
        return Err(format!("centrifugo: {error}"));
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| format!("presence response is not JSON: {error}"))?;
    let presence = value
        .get("result")
        .and_then(|result| result.get("presence"))
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "presence response has no result.presence object".to_string())?;
    Ok(presence
        .values()
        .filter_map(|entry| entry.get("user").and_then(serde_json::Value::as_str))
        .filter_map(|user| Uuid::parse_str(user).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// A body captured from a real Centrifugo 6.9.1 (`POST /api/presence`): two
    /// devices of one user and one device of another.
    const REAL_CENTRIFUGO_BODY: &str = r#"{"result":{"presence":{"0c98148d-7cb3-40b9-b92b-9a4daf2db196":{"user":"EF09F965-68CB-442F-A908-B1A5F7471D51","client":"0c98148d-7cb3-40b9-b92b-9a4daf2db196"},"4facba9c-ca87-443e-a444-399d8200f6c0":{"user":"EF09F965-68CB-442F-A908-B1A5F7471D51","client":"4facba9c-ca87-443e-a444-399d8200f6c0"},"fa80e4bf-7d81-40e7-8ae3-a2971b993c93":{"user":"071FB4B6-486E-4D5F-B9E2-8C0EE95EA2B9","client":"fa80e4bf-7d81-40e7-8ae3-a2971b993c93"}}}}"#;

    fn uuid(text: &str) -> Uuid {
        Uuid::parse_str(text).expect("uuid")
    }

    #[test]
    fn two_devices_of_one_person_and_one_of_another_are_two_members() {
        let members = parse_online_members(REAL_CENTRIFUGO_BODY.as_bytes()).expect("parse");
        assert_eq!(
            members,
            HashSet::from([
                uuid("EF09F965-68CB-442F-A908-B1A5F7471D51"),
                uuid("071FB4B6-486E-4D5F-B9E2-8C0EE95EA2B9"),
            ])
        );
    }

    /// Nobody connected is a real answer, and it is the only way an empty set is
    /// ever produced.
    #[test]
    fn an_empty_presence_table_is_nobody_online() {
        assert_eq!(
            parse_online_members(br#"{"result":{"presence":{}}}"#),
            Ok(HashSet::new())
        );
    }

    /// The lie this reader exists not to tell: a body that is not an answer must
    /// not read as 「nobody is online」.
    #[test]
    fn a_body_that_is_not_an_answer_is_never_an_empty_set() {
        for body in [
            r#"{"error":{"code":102,"message":"unknown channel"}}"#,
            r#"{"error":{"code":108,"message":"not available"}}"#,
            r#"{"result":{}}"#,
            r#"{"result":{"presence":null}}"#,
            r#"{"result":{"presence":[]}}"#,
            r#"{}"#,
            r#"[]"#,
            "not json",
            "",
        ] {
            assert!(
                parse_online_members(body.as_bytes()).is_err(),
                "{body:?} must be Unavailable, not an empty presence set"
            );
        }
    }

    /// An anonymous connection (`user: ""`) and anything that is not a member id
    /// name nobody, and a presence entry's other fields never surface.
    #[test]
    fn entries_that_name_no_member_are_skipped() {
        let body = r#"{"result":{"presence":{
            "a":{"user":"","client":"a"},
            "b":{"user":"not-a-uuid","client":"b"},
            "c":{"client":"c"},
            "d":{"user":"071FB4B6-486E-4D5F-B9E2-8C0EE95EA2B9","client":"d","conn_info":{"secret":"x"}}
        }}}"#;
        assert_eq!(
            parse_online_members(body.as_bytes()),
            Ok(HashSet::from([uuid(
                "071FB4B6-486E-4D5F-B9E2-8C0EE95EA2B9"
            )]))
        );
    }

    // -- the HTTP half, against a stand-in Centrifugo on a loopback socket --------

    /// One canned HTTP response, and the request the reader actually sent.
    struct Stub {
        url: String,
        request: Arc<Mutex<String>>,
    }

    async fn stub(status_line: &'static str, body: String) -> Stub {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/api", listener.local_addr().expect("addr"));
        let request = Arc::new(Mutex::new(String::new()));
        let seen = request.clone();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            // Read until the JSON body (one `{…}` after the blank line) is complete.
            while let Ok(read) = socket.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some((head, tail)) = text.split_once("\r\n\r\n") {
                    let wanted = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if tail.len() >= wanted {
                        break;
                    }
                }
            }
            *seen.lock().expect("request") = String::from_utf8_lossy(&received).to_string();
            let response = format!(
                "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        });
        Stub { url, request }
    }

    #[tokio::test]
    async fn it_asks_for_the_callers_workspace_roll_call_and_nothing_else() {
        let workspace = uuid("5A3209BF-023B-45F9-BF76-D28F83B16E0B");
        let stub = stub("200 OK", REAL_CENTRIFUGO_BODY.to_string()).await;
        let reader = PresenceReader::new(&stub.url, "api-key-under-test").expect("reader");

        let read = reader.online_members(workspace).await;

        assert_eq!(
            read,
            OnlineRead::Known(HashSet::from([
                uuid("EF09F965-68CB-442F-A908-B1A5F7471D51"),
                uuid("071FB4B6-486E-4D5F-B9E2-8C0EE95EA2B9"),
            ]))
        );
        let request = stub.request.lock().expect("request").clone();
        assert!(
            request.starts_with("POST /api/presence "),
            "request line: {request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-api-key: api-key-under-test"),
            "the server API key authenticates the call: {request}"
        );
        assert!(
            request.contains(r#""channel":"online:ws5A3209BF-023B-45F9-BF76-D28F83B16E0B""#),
            "the channel is computed from the workspace id: {request}"
        );
    }

    #[tokio::test]
    async fn a_logical_error_inside_a_200_is_unavailable_not_offline() {
        let stub = stub(
            "200 OK",
            r#"{"error":{"code":102,"message":"unknown channel"}}"#.to_string(),
        )
        .await;
        let reader = PresenceReader::new(&stub.url, "k").expect("reader");
        match reader.online_members(Uuid::new_v4()).await {
            OnlineRead::Unavailable(reason) => {
                assert!(reason.contains("unknown channel"), "{reason}")
            }
            other => panic!("an unconfigured namespace is not an empty roll-call: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_server_error_is_unavailable() {
        let stub = stub("503 Service Unavailable", "{}".to_string()).await;
        let reader = PresenceReader::new(&stub.url, "k").expect("reader");
        assert!(matches!(
            reader.online_members(Uuid::new_v4()).await,
            OnlineRead::Unavailable(_)
        ));
    }

    /// The roster is every client's first paint: a broker that accepts the
    /// connection and then says nothing must cost the roster at most the read
    /// timeout, and must not read as 「nobody is online」.
    #[tokio::test]
    async fn a_broker_that_never_answers_is_unavailable_within_the_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/api", listener.local_addr().expect("addr"));
        // Accept and hold the socket open without ever replying.
        let held = tokio::spawn(async move {
            let accepted = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
            drop(accepted);
        });
        let reader = PresenceReader::new(&url, "k").expect("reader");
        let started = std::time::Instant::now();
        let read = tokio::time::timeout(
            PRESENCE_READ_TIMEOUT + Duration::from_secs(3),
            reader.online_members(Uuid::new_v4()),
        )
        .await
        .expect("the read must give up on its own, not hang the roster");
        held.abort();
        assert!(matches!(read, OnlineRead::Unavailable(_)), "{read:?}");
        assert!(
            started.elapsed() < PRESENCE_READ_TIMEOUT + Duration::from_secs(2),
            "gave up after {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_refused_connection_is_unavailable() {
        // Bind then drop, so the port is closed by the time the reader dials it.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/api", listener.local_addr().expect("addr"));
        drop(listener);
        let reader = PresenceReader::new(&url, "k").expect("reader");
        assert!(matches!(
            reader.online_members(Uuid::new_v4()).await,
            OnlineRead::Unavailable(_)
        ));
    }

    /// A table bigger than the cap is not buffered, and is not read as an empty
    /// roll-call either.
    #[tokio::test]
    async fn a_body_over_the_cap_is_unavailable() {
        let filler = "x".repeat(PRESENCE_MAX_BODY_BYTES + 1);
        let stub = stub(
            "200 OK",
            format!(r#"{{"result":{{"presence":{{}},"padding":"{filler}"}}}}"#),
        )
        .await;
        let reader = PresenceReader::new(&stub.url, "k").expect("reader");
        match reader.online_members(Uuid::new_v4()).await {
            OnlineRead::Unavailable(reason) => assert!(reason.contains("cap"), "{reason}"),
            other => panic!("an oversized body must not be parsed: {other:?}"),
        }
    }

    #[test]
    fn the_debug_form_never_prints_the_api_key() {
        let reader =
            PresenceReader::new("http://centrifugo:8000/api", "super-secret-key").expect("reader");
        let printed = format!("{reader:?}");
        assert!(!printed.contains("super-secret-key"), "{printed}");
        assert!(printed.contains("/api/presence"), "{printed}");
    }
}
