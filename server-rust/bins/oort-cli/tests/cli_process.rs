//! The `oort` binary, spawned as a person's shell would, against recording mock servers.
//!
//! Rows of ADR-0216's red-proof table proved here: R16 (a)(c) (credential files are private from
//! their first byte, a wide file is refused, no argument carries a token), R17 (eight processes
//! with an expired login rotate it once), R18 (no plain-http server off the loopback, no redirect
//! followed) and R19 (every command's `--json` document, the exit-code table, no secret in any
//! output but `oort token`'s). The server-side halves of the same flows run against a real router
//! and PostgreSQL in `server_e2e_pg.rs`.
//!
//! | test | proves | goes red if |
//! |---|---|---|
//! | `a_login_leaves_a_private_credential_file_whatever_the_umask_was` | R16 (a): `umask 000`, still 0700/0600 from the first byte | a mode is dropped from a create call |
//! | `a_credential_file_others_can_read_is_refused_and_never_printed` | R16 (a): 0644 → exit 1, nothing printed; 0600 → works again | the permission check is removed |
//! | `no_argument_can_carry_a_token_and_a_mistyped_one_is_not_echoed` | R16 (c): exit 2, no request, the parser's complaint holds no token | a token flag appears, or the complaint prints it |
//! | `eight_processes_with_an_expired_login_rotate_it_once` | R17: one refresh request, none refused as a reuse, eight successes | the store lock around refresh is removed |
//! | `logout_ends_the_stored_login_with_its_own_token_and_leaves_an_env_token_alone` | logout presents only the stored login's token; an `OORT_TOKEN` card is never presented | logout resolves the env token first |
//! | `a_reader_that_closes_the_pipe_ends_a_command_quietly` | `oort read | head -c 1` ends with status 0 and no panic | an output path goes back to `println!` |
//! | `a_redirect_is_never_followed` | R18: the other host sees nothing, the credential went only to the named server | the redirect policy follows |
//! | `a_plain_http_server_off_the_loopback_is_refused_before_any_connection` | R18: exit 2 at once | the scheme check is removed |
//! | `every_command_prints_its_json_document_and_no_secret` | R19: goldens for 9 commands, marker sweep | a document gains a token field |
//! | `statuses_map_to_the_exit_codes_and_the_error_document` | R19: 401/403/403 bare/404/429/5xx/302 → 3/4/5/5/6/7/7 | the table changes |

mod common;

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use oort_cli::store::{Backend, Store};
use serde_json::{json, Value};

fn scopes() -> Value {
    json!([
        "dev:identity",
        "dev:channels:read",
        "dev:messages:read",
        "dev:messages:write",
        "dev:inbox:read"
    ])
}

fn login_card(home: &Home, mock: &Mock) {
    let out = home.run_with_stdin(
        &[
            "login",
            "--with-token",
            "--storage",
            "file",
            "--server",
            &mock.origin(),
            "--json",
        ],
        &format!("{}\n", card()),
    );
    assert_eq!(code(&out), 0, "login failed: {}", stderr(&out));
}

// ---------------------------------------------------------------------------
// R16
// ---------------------------------------------------------------------------

#[test]
fn a_login_leaves_a_private_credential_file_whatever_the_umask_was() {
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    // `umask 000` takes away nothing: the modes asked for at creation are the whole story, so a
    // create call that forgot its mode would leave 0666 / 0777 here.
    let script = r#"umask 000 && exec "$OORT_BIN" login --with-token --storage file --server "$OORT_ORIGIN" --json"#;
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(script)
        .env_clear()
        .env("HOME", home.home())
        .env("XDG_CONFIG_HOME", home.xdg())
        .env("OORT_BIN", env!("CARGO_BIN_EXE_oort"))
        .env("OORT_ORIGIN", mock.origin())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sh");
    {
        use std::io::Write;
        let stdin = child.stdin.as_mut().expect("stdin");
        stdin
            .write_all(format!("{}\n", card()).as_bytes())
            .expect("token");
    }
    let out = child.wait_with_output().expect("wait");
    assert_eq!(code(&out), 0, "{}", stderr(&out));

    let document = json_of(&stdout(&out));
    assert_eq!(
        document,
        json!({
            "schema": "oort.cli.login.v1",
            "server": mock.origin(),
            "workspaceId": WS,
            "scopes": scopes(),
            "storage": "file",
            "method": "token",
        })
    );
    let root = home.oort_dir();
    assert_eq!(mode_of(&root), 0o700, "config directory");
    assert_eq!(
        mode_of(&root.join("credentials")),
        0o700,
        "credentials directory"
    );
    let files: Vec<_> = std::fs::read_dir(root.join("credentials"))
        .expect("credentials")
        .map(|entry| entry.expect("entry").path())
        .collect();
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(mode_of(&files[0]), 0o600, "credential file");
    assert_eq!(
        mode_of(&root.join("current.json")),
        0o600,
        "profile pointer"
    );
    assert_eq!(mode_of(&root.join("lock")), 0o600, "lock file");
    // the server saw the token once, on the whoami route, in the header and nowhere else
    let seen = mock.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, format!("/v1/workspaces/{WS}/dev-access/self"));
    assert_eq!(
        seen[0].header("authorization"),
        Some(format!("Bearer {}", card()).as_str())
    );
    let needles = leak_needles(&card());
    assert_no_leak("login stdout", &stdout(&out), &needles);
    assert_no_leak("login stderr", &stderr(&out), &needles);
}

#[test]
fn a_credential_file_others_can_read_is_refused_and_never_printed() {
    use std::os::unix::fs::PermissionsExt;
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    login_card(&home, &mock);
    let file = std::fs::read_dir(home.oort_dir().join("credentials"))
        .expect("dir")
        .next()
        .expect("one file")
        .expect("entry")
        .path();

    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).expect("chmod");
    let before = mock.count();
    let refused = home.run(&["whoami", "--json"]);
    assert_eq!(code(&refused), 1, "{}", stderr(&refused));
    let error = json_of(&stderr(&refused));
    assert_eq!(error["schema"], "oort.cli.error.v1");
    assert_eq!(error["code"], "credential_permissions");
    assert_eq!(
        mock.count(),
        before,
        "a credential that was not trusted was not sent anywhere"
    );
    let needles = leak_needles(&card());
    assert_no_leak("refused stdout", &stdout(&refused), &needles);
    assert_no_leak("refused stderr", &stderr(&refused), &needles);

    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    let fixed = home.run(&["whoami", "--json"]);
    assert_eq!(code(&fixed), 0, "{}", stderr(&fixed));
}

#[test]
fn no_argument_can_carry_a_token_and_a_mistyped_one_is_not_echoed() {
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    let needles = leak_needles(&card());
    for args in [
        vec![
            "login",
            "--with-token",
            card().leak() as &str,
            "--storage",
            "file",
        ],
        vec![
            "login",
            "--token",
            card().leak() as &str,
            "--storage",
            "file",
        ],
        vec!["login", card().leak() as &str],
        vec!["whoami", "--token", card().leak() as &str],
    ] {
        let mut full: Vec<&str> = args;
        let origin = mock.origin();
        full.extend(["--server", origin.as_str()]);
        let out = home.run(&full);
        assert_eq!(code(&out), 2, "{full:?}: {}", stderr(&out));
        assert_no_leak("usage stdout", &stdout(&out), &needles);
        assert_no_leak("usage stderr", &stderr(&out), &needles);
    }
    assert_eq!(
        mock.count(),
        0,
        "nothing was sent for a command line that was refused"
    );
    assert!(!home.oort_dir().exists(), "nothing was stored");
}

// ---------------------------------------------------------------------------
// R17
// ---------------------------------------------------------------------------

#[test]
fn eight_processes_with_an_expired_login_rotate_it_once() {
    let rotated = Arc::new(AtomicUsize::new(0));
    let refused = Arc::new(AtomicUsize::new(0));
    let new_access = access(NEW_ACCESS_SECRET);
    let new_refresh = refresh(NEW_REFRESH_SECRET);
    let old_refresh = refresh(OLD_REFRESH_SECRET);
    let mock = Mock::start({
        let (rotated, refused) = (rotated.clone(), refused.clone());
        let (new_access, new_refresh) = (new_access.clone(), new_refresh.clone());
        move |request| {
            let base = format!("/v1/workspaces/{WS}");
            if request.method == "POST" && request.path == "/v1/oauth/token" {
                let form = request.form();
                let right = form.get("grant_type").map(String::as_str) == Some("refresh_token")
                    && form.get("refresh_token").map(String::as_str) == Some(old_refresh.as_str())
                    && form.get("client_id").map(String::as_str) == Some("oort-cli");
                // The first presentation of the old refresh half wins; every later one is what
                // the real server reads as theft and answers by ending the whole login.
                if right && rotated.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Response::json(
                        200,
                        &json!({
                            "access_token": new_access,
                            "token_type": "Bearer",
                            "expires_in": 900,
                            "refresh_token": new_refresh,
                            "scope": "dev:identity dev:channels:read",
                            "workspace_id": WS,
                        }),
                    )
                    .header("Cache-Control", "no-store")
                    .delayed(Duration::from_millis(400));
                }
                refused.fetch_add(1, Ordering::SeqCst);
                return Response::json(400, &json!({"error": "invalid_grant"}));
            }
            if request.method == "GET" && request.path == format!("{base}/dev-access/self") {
                if request.header("authorization") == Some(format!("Bearer {new_access}").as_str())
                {
                    return Response::json(200, &self_info("session"));
                }
                return Response::json(401, &json!({"error": {"message": "invalid token"}}));
            }
            Response::json(404, &json!({"error": {"message": "not found"}}))
        }
    });
    let home = Home::new();
    home.seed_session(
        &mock.origin(),
        &access(OLD_ACCESS_SECRET),
        &refresh(OLD_REFRESH_SECRET),
        now_ms() - 3_600_000,
        &format!("{}/v1/oauth/token", mock.origin()),
    );

    let children: Vec<_> = (0..8).map(|_| home.spawn(&["whoami", "--json"])).collect();
    let mut needles = leak_needles(&new_access);
    needles.extend(leak_needles(&new_refresh));
    needles.extend(leak_needles(&refresh(OLD_REFRESH_SECRET)));
    for (index, child) in children.into_iter().enumerate() {
        let out = child.wait_with_output().expect("wait");
        assert_eq!(code(&out), 0, "process {index}: {}", stderr(&out));
        let document = json_of(&stdout(&out));
        assert_eq!(document["schema"], "oort.cli.whoami.v1");
        assert_eq!(document["source"], "stored");
        assert_no_leak("whoami stdout", &stdout(&out), &needles);
        assert_no_leak("whoami stderr", &stderr(&out), &needles);
    }
    assert_eq!(
        mock.count_of("POST", "/v1/oauth/token"),
        1,
        "the refresh half is presented once, not once per process"
    );
    assert_eq!(rotated.load(Ordering::SeqCst), 1);
    assert_eq!(
        refused.load(Ordering::SeqCst),
        0,
        "no process presented a refresh half that was already spent"
    );

    // and the rotated pair is what is stored now
    let store = Store::locate(Some(&home.xdg()), None).expect("store");
    let current = store.current().expect("current").expect("a profile");
    let saved = store
        .file_backend()
        .load(&current.key())
        .expect("load")
        .expect("credential");
    assert_eq!(saved.access.expose(), new_access);
    assert_eq!(saved.refresh.expect("refresh").expose(), new_refresh);
}

#[test]
fn a_login_the_server_has_ended_asks_for_a_new_one_and_sends_nothing_further() {
    let mock = Mock::start(|request| {
        if request.path == "/v1/oauth/token" {
            return Response::json(400, &json!({"error": "invalid_grant"}));
        }
        Response::json(401, &json!({"error": {"message": "invalid token"}}))
    });
    let home = Home::new();
    home.seed_session(
        &mock.origin(),
        &access(OLD_ACCESS_SECRET),
        &refresh(OLD_REFRESH_SECRET),
        now_ms() - 3_600_000,
        &format!("{}/v1/oauth/token", mock.origin()),
    );
    let out = home.run(&["whoami", "--json"]);
    assert_eq!(code(&out), 3, "{}", stderr(&out));
    let error = json_of(&stderr(&out));
    assert_eq!(error["code"], "login_expired");
    assert_eq!(mock.count(), 1, "one refresh attempt, then it stops");
    let mut needles = leak_needles(&access(OLD_ACCESS_SECRET));
    needles.extend(leak_needles(&refresh(OLD_REFRESH_SECRET)));
    assert_no_leak("stderr", &stderr(&out), &needles);
}

// ---------------------------------------------------------------------------
// R18
// ---------------------------------------------------------------------------

#[test]
fn a_redirect_is_never_followed() {
    let elsewhere = Mock::start(|_| Response::empty(200));
    let target = format!("{}/steal", elsewhere.origin());
    let named = Mock::start(move |_| Response::redirect(&target));
    let home = Home::new();
    let out = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["whoami", "--json", "--server", &named.origin()])
        .output()
        .expect("run");
    assert_eq!(code(&out), 7, "{}", stderr(&out));
    assert_eq!(json_of(&stderr(&out))["code"], "unexpected_redirect");
    assert_eq!(
        elsewhere.count(),
        0,
        "the host a redirect pointed at was never contacted"
    );
    let seen = named.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].header("authorization"),
        Some(format!("Bearer {}", card()).as_str())
    );
    assert_no_leak("stderr", &stderr(&out), &leak_needles(&card()));
}

#[test]
fn a_plain_http_server_off_the_loopback_is_refused_before_any_connection() {
    let home = Home::new();
    for args in [
        vec!["whoami", "--json", "--server", "http://203.0.113.9:8080"],
        vec![
            "login",
            "--with-token",
            "--storage",
            "file",
            "--json",
            "--server",
            "http://203.0.113.9:8080",
        ],
    ] {
        let started = Instant::now();
        let out = home
            .command()
            .env("OORT_TOKEN", card())
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .expect("run");
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert_eq!(
            json_of(&stderr(&out))["code"],
            "insecure_server",
            "{args:?}"
        );
        // A connection attempt to an address nobody answers takes the whole connect timeout.
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{args:?} took {:?}",
            started.elapsed()
        );
        assert_no_leak("stderr", &stderr(&out), &leak_needles(&card()));
    }
}

// ---------------------------------------------------------------------------
// R19
// ---------------------------------------------------------------------------

#[test]
fn every_command_prints_its_json_document_and_no_secret() {
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    let origin = mock.origin();
    let needles = leak_needles(&card());
    let mut sweep: Vec<(String, String)> = Vec::new();
    let mut run = |label: &str, args: &[&str], stdin: Option<&str>| {
        let out = match stdin {
            Some(text) => home.run_with_stdin(args, text),
            None => home.run(args),
        };
        sweep.push((format!("{label} stdout"), stdout(&out)));
        sweep.push((format!("{label} stderr"), stderr(&out)));
        out
    };

    // login (the card goes in on standard input)
    let out = run(
        "login",
        &[
            "login",
            "--with-token",
            "--storage",
            "file",
            "--server",
            &origin,
            "--json",
        ],
        Some(&format!("{}\n", card())),
    );
    assert_eq!(code(&out), 0);
    assert_eq!(json_of(&stdout(&out))["schema"], "oort.cli.login.v1");

    // whoami
    let out = run("whoami", &["whoami", "--json"], None);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(
        json_of(&stdout(&out)),
        json!({
            "schema": "oort.cli.whoami.v1",
            "server": origin,
            "workspaceId": WS,
            "memberId": MEMBER,
            "credential": {"id": CRED_ID, "kind": "card", "name": "노트북 Claude Code", "tool": "claude_code"},
            "scopes": scopes(),
            "channelRestricted": false,
            "createdAt": "2026-10-28T09:30:00Z",
            "expiresAt": "2026-11-27T09:30:00Z",
            "lastUsedAt": "2026-10-28T09:31:40Z",
            "source": "stored",
            "storage": "file",
        })
    );

    // channels
    let out = run("channels", &["channels", "--json"], None);
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.channels.v1", "channels": [
            {"id": CHANNEL, "kind": "public", "name": "general", "topic": "공지", "muted": false},
            {"id": "66666666-6666-4666-8666-666666666666", "kind": "dm", "muted": true},
        ]})
    );

    // read: oldest first, with the cursor for older messages
    let first = printed_message(11, MEMBER, "첫 번째\n둘째 줄", 1_793_179_800_000, None);
    let second = printed_message(12, OTHER_MEMBER, "두 번째", 1_793_179_860_000, Some("dev"));
    let out = run("read", &["read", CHANNEL, "--json"], None);
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.read.v1", "channelId": CHANNEL, "messages": [first, second], "nextBefore": 11})
    );
    // a channel by name is the same read
    let by_name = run("read by name", &["read", "#general", "--json"], None);
    assert_eq!(stdout(&by_name), stdout(&out));
    // newer than a seq: ascending already, and the cursor to continue
    let out = run(
        "read since",
        &["read", CHANNEL, "--since", "10", "--json"],
        None,
    );
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.read.v1", "channelId": CHANNEL, "messages": [
            printed_message(12, OTHER_MEMBER, "두 번째", 1_793_179_860_000, Some("dev")),
            printed_message(13, MEMBER, "세 번째", 1_793_179_920_000, None),
        ], "nextSince": 13})
    );
    // a thread
    let out = run(
        "read thread",
        &["read", CHANNEL, "--thread", ROOT, "--json"],
        None,
    );
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.read.v1", "channelId": CHANNEL, "threadRootId": ROOT, "messages": [
            printed_message(21, OTHER_MEMBER, "답글 하나", 1_793_179_870_000, None),
            printed_message(22, MEMBER, "답글 둘", 1_793_179_880_000, Some("dev")),
        ], "nextSince": 22})
    );

    // post: only the five allowed keys can ever be on the wire
    let id = "99999999-9999-4999-8999-999999999999";
    let out = run(
        "post",
        &["post", CHANNEL, "안녕", "--client-msg-id", id, "--json"],
        None,
    );
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let mut sent = printed_message(14, MEMBER, "안녕", 1_793_179_990_000, Some("dev"));
    sent["clientMsgId"] = json!(id);
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.post.v1", "message": sent})
    );
    let post_request = mock
        .requests()
        .into_iter()
        .rev()
        .find(|request| request.method == "POST")
        .expect("a send");
    assert_eq!(
        post_request.json(),
        json!({"clientMsgId": id, "body": "안녕"})
    );
    // a reply in a thread, text from standard input
    let reply = "88888888-8888-4888-8888-888888888888";
    let out = run(
        "post thread",
        &[
            "post",
            CHANNEL,
            "-",
            "--thread",
            ROOT,
            "--reply-to",
            reply,
            "--json",
        ],
        Some("표준입력의 글\n"),
    );
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let post_request = mock
        .requests()
        .into_iter()
        .rev()
        .find(|request| request.method == "POST")
        .expect("a send");
    let body = post_request.json();
    assert_eq!(body["body"], "표준입력의 글");
    assert_eq!(body["rootId"], ROOT);
    assert_eq!(body["replyToId"], reply);
    assert!(body["clientMsgId"]
        .as_str()
        .is_some_and(|value| value.len() == 36));
    let mut keys: Vec<_> = body.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["body", "clientMsgId", "replyToId", "rootId"]);

    // inbox
    let out = run("inbox", &["inbox", "--json"], None);
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.inbox.v1", "unreadCount": 1, "items": [{
            "id": "77777777-7777-4777-8777-777777777777",
            "kind": "mention",
            "reasons": ["mention"],
            "channel": {"id": CHANNEL, "name": "general", "kind": "public"},
            "message": {"id": "aaaaaaaa-0000-4000-8000-000000000012", "seq": 12, "authorMemberId": OTHER_MEMBER, "preview": "안녕하세요\n두 번째 줄", "deleted": false},
            "actorMemberId": OTHER_MEMBER,
            "createdAt": "2026-10-28T09:31:00Z",
            "readAt": null,
        }]})
    );

    // the human forms print readable lines and no secret
    for (label, args) in [
        ("whoami", vec!["whoami"]),
        ("channels", vec!["channels"]),
        ("read", vec!["read", CHANNEL]),
        ("inbox", vec!["inbox"]),
        ("post", vec!["post", CHANNEL, "사람이 읽는 출력"]),
    ] {
        let out = run(&format!("{label} (text)"), &args, None);
        assert_eq!(code(&out), 0, "{label}: {}", stderr(&out));
        assert!(!stdout(&out).trim().is_empty(), "{label}");
        assert!(
            !stdout(&out).trim_start().starts_with('{'),
            "{label} printed JSON without --json"
        );
    }
    let text = run("read (text)", &["read", CHANNEL], None);
    let lines = stdout(&text);
    assert!(lines.contains("(명령줄에서)"), "{lines}");
    assert!(lines.contains("[11]") && lines.contains("[12]"), "{lines}");
    assert!(
        lines.find("[11]").expect("11") < lines.find("[12]").expect("12"),
        "oldest first: {lines}"
    );
    assert!(
        lines.contains("\n    둘째 줄"),
        "continuation lines are indented: {lines}"
    );

    // logout ends it on the server and here
    let out = run("logout", &["logout", "--json"], None);
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.logout.v1", "server": origin, "workspaceId": WS, "localRemoved": true, "serverRevocation": "revoked"})
    );
    assert_eq!(
        mock.count_of("DELETE", &format!("/v1/workspaces/{WS}/dev-access/self")),
        1
    );
    let again = run("whoami after logout", &["whoami", "--json"], None);
    assert_eq!(code(&again), 3);
    assert_eq!(json_of(&stderr(&again))["code"], "login_required");
    assert!(
        std::fs::read_dir(home.oort_dir().join("credentials"))
            .expect("dir")
            .next()
            .is_none(),
        "the credential file is gone"
    );

    // `token` is the one command that prints the secret — through the env path, on purpose
    let out = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["token", "--server", &origin])
        .output()
        .expect("token");
    assert_eq!(stdout(&out), format!("{}\n", card()));
    let headers = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["token", "--headers", "--server", &origin])
        .output()
        .expect("token headers");
    assert_eq!(
        json_of(&stdout(&headers)),
        json!({"Authorization": format!("Bearer {}", card())})
    );
    let as_json = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["token", "--json", "--server", &origin])
        .output()
        .expect("token json");
    assert_eq!(
        json_of(&stdout(&as_json)),
        json!({"schema": "oort.cli.token.v1", "token": card(), "tokenType": "Bearer", "source": "env"})
    );
    // whoami through the env path: stored is null, source says env
    let env_whoami = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["whoami", "--json", "--server", &origin])
        .output()
        .expect("whoami env");
    let document = json_of(&stdout(&env_whoami));
    assert_eq!(
        (document["source"].as_str(), document["storage"].clone()),
        (Some("env"), Value::Null)
    );
    sweep.push(("whoami env stdout".into(), stdout(&env_whoami)));
    sweep.push(("whoami env stderr".into(), stderr(&env_whoami)));

    // No command but `token` printed any part of the token, anywhere, in any form.
    for (label, text) in &sweep {
        assert_no_leak(label, text, &needles);
    }
}

#[test]
fn statuses_map_to_the_exit_codes_and_the_error_document() {
    let cases: [(u16, Value, Option<&str>, i32, &str); 8] = [
        (
            401,
            json!({"error": {"message": "invalid token"}}),
            None,
            3,
            "login_required",
        ),
        (
            403,
            json!({"error": {"message": "no scope", "code": "dev_scope_denied"}}),
            None,
            4,
            "dev_scope_denied",
        ),
        (
            403,
            json!({"error": {"message": "not a member of this channel"}}),
            None,
            5,
            "not_found",
        ),
        (
            404,
            json!({"error": {"message": "gone"}}),
            None,
            5,
            "not_found",
        ),
        (
            429,
            json!({"error": {"message": "slow down"}}),
            Some("17"),
            6,
            "rate_limited",
        ),
        (
            500,
            json!({"error": {"message": "boom"}}),
            None,
            7,
            "server_error",
        ),
        (502, json!("<html>"), None, 7, "server_error"),
        (302, json!(null), None, 7, "unexpected_redirect"),
    ];
    for (status, body, retry, exit, wanted_code) in cases {
        let body_for_mock = body.clone();
        let mock = Mock::start(move |_| {
            let mut response = if status == 302 {
                Response::redirect("http://127.0.0.1:9/never")
            } else {
                Response::json(status, &body_for_mock)
            };
            if let Some(seconds) = retry {
                response = response.header("Retry-After", seconds);
            }
            response
        });
        let home = Home::new();
        let out = home
            .command()
            .env("OORT_TOKEN", card())
            .args(["whoami", "--json", "--server", &mock.origin()])
            .output()
            .expect("run");
        assert_eq!(code(&out), exit, "status {status}: {}", stderr(&out));
        assert!(
            stdout(&out).is_empty(),
            "an error prints nothing on standard output"
        );
        let error = json_of(&stderr(&out));
        assert_eq!(error["schema"], "oort.cli.error.v1", "status {status}");
        assert_eq!(error["code"], wanted_code, "status {status}");
        assert_eq!(error["status"], status, "status {status}");
        if retry.is_some() {
            assert_eq!(error["retryAfterSeconds"], 17);
        }
        assert_no_leak("stderr", &stderr(&out), &leak_needles(&card()));
    }
    // usage errors are 2, as JSON when asked
    let home = Home::new();
    for args in [
        vec!["read", "--json"],
        vec!["frobnicate", "--json"],
        vec!["read", "x", "--limit", "999", "--json"],
    ] {
        let out = home.command().args(&args).output().expect("run");
        assert_eq!(code(&out), 2, "{args:?}: {}", stderr(&out));
        assert_eq!(
            json_of(&stderr(&out))["schema"],
            "oort.cli.error.v1",
            "{args:?}"
        );
    }
    // help and version succeed and say which crate this is (ADR-0216 D10 rule 3)
    let version = home.run(&["--version"]);
    assert_eq!(code(&version), 0);
    assert!(
        stdout(&version).starts_with("oort-cli "),
        "{}",
        stdout(&version)
    );
    assert_eq!(code(&home.run(&["--help"])), 0);
}

// ---------------------------------------------------------------------------
// logout and the places a login can be missing from
// ---------------------------------------------------------------------------

#[test]
fn logout_removes_the_local_login_even_when_the_server_cannot_be_reached() {
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    login_card(&home, &mock);
    let dead = Mock::start(|_| Response::empty(200));
    let dead_origin = dead.origin();
    drop(dead); // nobody listens there any more
                // point the stored profile at the dead address
    home.seed_card(&dead_origin, &card());

    let out = home.run(&["logout", "--json"]);
    assert_eq!(code(&out), 7, "{}", stderr(&out));
    let document = json_of(&stdout(&out));
    assert_eq!(document["localRemoved"], true);
    assert_eq!(document["serverRevocation"], "unreachable");
    assert_eq!(json_of(&stderr(&out))["code"], "server_revocation_failed");
    let after = home.run(&["whoami", "--json"]);
    assert_eq!(
        code(&after),
        3,
        "the secret is gone locally whatever the network said"
    );
    assert_no_leak("logout stderr", &stderr(&out), &leak_needles(&card()));
}

#[test]
fn a_reader_that_closes_the_pipe_ends_a_command_quietly() {
    // `oort read | head -c 1`: the reader is gone after one byte. The standard `println!` panics
    // (exit 101, a backtrace hint on standard error) when that happens; the command must end
    // without either. The output is made much larger than a pipe's buffer so the write really
    // meets a closed pipe.
    let big = "가".repeat(4000);
    let token = card();
    let mock = Mock::start(move |request| {
        if request.header("authorization") != Some(format!("Bearer {token}").as_str()) {
            return Response::json(401, &json!({"error": {"message": "invalid token"}}));
        }
        let messages: Vec<Value> = (1..=200)
            .map(|seq| server_message(seq, MEMBER, &big, 1_793_179_800_000 + seq, None))
            .collect();
        Response::json(200, &json!({"messages": messages, "nextBefore": 1}))
    });
    let home = Home::new();
    let script = r#"set -o pipefail; "$OORT_BIN" read "$OORT_CHANNEL" | head -c 1 > /dev/null; echo "status=$?""#;
    let out = Command::new("bash")
        .arg("-c")
        .arg(script)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home.home())
        .env("XDG_CONFIG_HOME", home.xdg())
        .env("OORT_BIN", env!("CARGO_BIN_EXE_oort"))
        .env("OORT_CHANNEL", CHANNEL)
        .env("OORT_TOKEN", card())
        .env("OORT_SERVER", mock.origin())
        .stdin(Stdio::null())
        .output()
        .expect("run bash");
    assert!(
        stdout(&out).contains("status=0"),
        "{} / {}",
        stdout(&out),
        stderr(&out)
    );
    assert!(!stderr(&out).contains("panicked"), "{}", stderr(&out));
    assert_no_leak("stderr", &stderr(&out), &leak_needles(&card()));
}

#[test]
fn logout_ends_the_stored_login_with_its_own_token_and_leaves_an_env_token_alone() {
    // Two different cards: the one `login` stored, and the one a deployment put in the environment.
    // `logout` is about the stored login; presenting (and so revoking) the other would end a
    // credential this command never made.
    let stored = card();
    let env_card = access(OTHER_CARD_SECRET);
    let (stored_for_mock, env_for_mock) = (stored.clone(), env_card.clone());
    let mock = Mock::start(move |request| {
        let bearer = request.header("authorization").unwrap_or("").to_string();
        if bearer == format!("Bearer {stored_for_mock}")
            || bearer == format!("Bearer {env_for_mock}")
        {
            return Response::json(200, &json!({"revokedNow": true}));
        }
        Response::json(401, &json!({"error": {"message": "invalid token"}}))
    });
    let home = Home::new();
    home.seed_card(&mock.origin(), &stored);
    let out = home
        .command()
        .env("OORT_TOKEN", &env_card)
        .args(["logout", "--json"])
        .output()
        .expect("run");
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    let document = json_of(&stdout(&out));
    assert_eq!(document["serverRevocation"], "revoked");
    assert_eq!(document["localRemoved"], true);
    let presented: Vec<_> = mock
        .requests()
        .iter()
        .map(|request| request.header("authorization").unwrap_or("").to_string())
        .collect();
    assert_eq!(
        presented,
        [format!("Bearer {stored}")],
        "only the stored login was presented and ended"
    );
    assert!(std::fs::read_dir(home.oort_dir().join("credentials"))
        .expect("dir")
        .next()
        .is_none());
    let mut needles = leak_needles(&stored);
    needles.extend(leak_needles(&env_card));
    assert_no_leak("logout stdout", &stdout(&out), &needles);
    assert_no_leak("logout stderr", &stderr(&out), &needles);
}

#[test]
fn logout_does_not_touch_an_env_token_and_does_not_fail_with_no_login() {
    let mock = Mock::start(dev_api(card()));
    let home = Home::new();
    let out = home
        .command()
        .env("OORT_TOKEN", card())
        .args(["logout", "--json", "--server", &mock.origin()])
        .output()
        .expect("run");
    assert_eq!(code(&out), 0, "{}", stderr(&out));
    assert_eq!(
        json_of(&stdout(&out)),
        json!({"schema": "oort.cli.logout.v1", "server": null, "workspaceId": null, "localRemoved": false, "serverRevocation": "skipped"})
    );
    assert_eq!(
        mock.count(),
        0,
        "an env card is somebody's deployment: logout never revokes it"
    );
}
