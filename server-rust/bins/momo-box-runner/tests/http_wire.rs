//! The runner's client against a mock oort server: bearer on every call, the three paths,
//! the request and response shapes the real server speaks, and what each status means.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use momo_box_runner::client::{ClientError, HttpServer, ServerApi};
use momo_box_runner::runner::Runner;
use momo_box_runner::testing::FakeDocker;
use momo_box_runner::wire::{CompleteBody, DeletionReport, Observed};
use serde_json::{json, Value};
use uuid::Uuid;

const TOKEN: &str =
    "oort_runner.11111111-2222-4333-8444-555555555555.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/// (method, path, body, Authorization header)
type Seen = (String, String, Option<Value>, Option<String>);

#[derive(Default)]
struct Mock {
    seen: Mutex<Vec<Seen>>,
    claim: Mutex<Value>,
    status: Mutex<u16>,
}

type Shared = Arc<Mock>;

fn record(mock: &Mock, method: &str, path: String, body: Option<Value>, headers: &HeaderMap) {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    mock.seen
        .lock()
        .expect("mock")
        .push((method.to_string(), path, body, auth));
}

async fn claim(
    State(mock): State<Shared>,
    Path(ws): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    record(
        &mock,
        "POST",
        format!("/v1/workspaces/{ws}/cloud-box-runner/claim"),
        Some(body),
        &headers,
    );
    let status = *mock.status.lock().expect("mock");
    (
        StatusCode::from_u16(if status == 0 { 200 } else { status }).expect("status"),
        Json(mock.claim.lock().expect("mock").clone()),
    )
}

async fn complete(
    State(mock): State<Shared>,
    Path((ws, control)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    record(
        &mock,
        "POST",
        format!("/v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete"),
        Some(body),
        &headers,
    );
    let status = *mock.status.lock().expect("mock");
    (
        StatusCode::from_u16(if status == 0 { 200 } else { status }).expect("status"),
        Json(json!({"boxState": "running"})),
    )
}

async fn boxes(
    State(mock): State<Shared>,
    Path(ws): Path<String>,
    headers: HeaderMap,
) -> Json<Value> {
    record(
        &mock,
        "GET",
        format!("/v1/workspaces/{ws}/cloud-box-runner/boxes"),
        None,
        &headers,
    );
    Json(json!({"boxes": [{"boxId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "state": "running"}]}))
}

async fn serve() -> (String, Shared) {
    let mock = Shared::default();
    let app = Router::new()
        .route("/v1/workspaces/{ws}/cloud-box-runner/claim", post(claim))
        .route(
            "/v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete",
            post(complete),
        )
        .route("/v1/workspaces/{ws}/cloud-box-runner/boxes", get(boxes))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address: SocketAddr = listener.local_addr().expect("addr");
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    (format!("http://{address}"), mock)
}

fn workspace() -> Uuid {
    Uuid::parse_str(common::WORKSPACE).expect("uuid")
}

#[tokio::test]
async fn every_call_carries_the_bearer_and_uses_the_three_paths() {
    let (base, mock) = serve().await;
    *mock.claim.lock().expect("mock") = json!({"controls": [], "poisoned": []});
    let client = HttpServer::new(&base, workspace(), TOKEN.to_string()).expect("client");
    client.claim(7).await.expect("claim");
    let control = Uuid::new_v4();
    client
        .complete(
            control,
            &CompleteBody {
                lease_id: Uuid::new_v4(),
                attempts: 2,
                ok: true,
                observed: Some(Observed::Stopped),
                deletion: None,
            },
        )
        .await
        .expect("complete");
    let listed = client.boxes().await.expect("boxes");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].state, "running");
    let seen = mock.seen.lock().expect("mock").clone();
    assert_eq!(seen.len(), 3);
    for (_, _, _, auth) in &seen {
        assert_eq!(auth.as_deref(), Some(&*format!("Bearer {TOKEN}")));
    }
    let ws = common::WORKSPACE;
    assert_eq!(
        seen[0].1,
        format!("/v1/workspaces/{ws}/cloud-box-runner/claim")
    );
    assert_eq!(seen[0].2, Some(json!({"limit": 7})));
    assert_eq!(
        seen[1].1,
        format!("/v1/workspaces/{ws}/cloud-box-runner/controls/{control}/complete")
    );
    let body = seen[1].2.clone().expect("body");
    assert_eq!(body["ok"], true);
    assert_eq!(body["attempts"], 2);
    assert_eq!(body["observed"], "stopped");
    assert!(body.get("deletion").is_none());
    assert_eq!(
        seen[2].1,
        format!("/v1/workspaces/{ws}/cloud-box-runner/boxes")
    );
}

#[tokio::test]
async fn the_deletion_report_goes_up_as_two_booleans() {
    let (base, mock) = serve().await;
    let client = HttpServer::new(&base, workspace(), TOKEN.to_string()).expect("client");
    client
        .complete(
            Uuid::new_v4(),
            &CompleteBody {
                lease_id: Uuid::new_v4(),
                attempts: 1,
                ok: true,
                observed: None,
                deletion: Some(DeletionReport {
                    container_absent: true,
                    volume_absent: false,
                }),
            },
        )
        .await
        .expect("complete");
    let body = mock.seen.lock().expect("mock")[0].2.clone().expect("body");
    assert_eq!(
        body["deletion"],
        json!({"containerAbsent": true, "volumeAbsent": false})
    );
    let keys: std::collections::BTreeSet<&str> = body
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["attempts", "deletion", "leaseId", "ok"]
            .into_iter()
            .collect()
    );
}

#[tokio::test]
async fn statuses_mean_what_the_runner_does_with_them() {
    let (base, mock) = serve().await;
    let client = HttpServer::new(&base, workspace(), TOKEN.to_string()).expect("client");
    for (status, check) in [
        (
            401u16,
            (|e: &ClientError| matches!(e, ClientError::Unauthorized)) as fn(&ClientError) -> bool,
        ),
        (404, |e| matches!(e, ClientError::NotEnabled)),
        (500, |e| matches!(e, ClientError::Status(500))),
    ] {
        *mock.status.lock().expect("mock") = status;
        let error = client.claim(1).await.expect_err("refused");
        assert!(check(&error), "{status}: {error}");
    }
    *mock.status.lock().expect("mock") = 409;
    let error = client
        .complete(
            Uuid::new_v4(),
            &CompleteBody {
                lease_id: Uuid::new_v4(),
                attempts: 1,
                ok: true,
                observed: None,
                deletion: None,
            },
        )
        .await
        .expect_err("stale");
    assert!(matches!(error, ClientError::Stale));
    // The error text never contains the credential.
    assert!(!format!("{error:?} {error}").contains("AAAAAAAA"));
    assert!(
        !format!("{client:?}").contains("AAAAAAAA"),
        "the client's Debug leaked the credential"
    );
}

/// The server's own claim answer, parsed by the runner and executed against an in-memory
/// docker: create, then delete with the verification report, through real HTTP.
#[tokio::test]
async fn a_poll_runs_what_the_server_sent_and_reports_through_http() {
    let (base, mock) = serve().await;
    let dir = common::temp_dir("http-loop");
    let docker = Arc::new(FakeDocker::new());
    let (executor, engine, cfg) = common::executor(docker.clone(), common::config(&dir));
    let client = Arc::new(HttpServer::new(&base, workspace(), TOKEN.to_string()).expect("client"));
    let runner = Runner::new(cfg, engine, executor, client);
    let box_id = Uuid::new_v4();
    let (create, lease) = (Uuid::new_v4(), Uuid::new_v4());
    *mock.claim.lock().expect("mock") = json!({
        "controls": [{
            "id": create, "leaseId": lease, "attempts": 1, "seq": 1, "boxId": box_id,
            "verb": "create", "limits": {"cpuMillis": 1000, "memoryMb": 2048, "diskGb": 10, "pids": 512}
        }],
        "poisoned": []
    });
    let summary = runner.poll_once().await.expect("poll");
    assert_eq!(summary.executed, 1);
    assert_eq!(docker.volumes(), [format!("momo-m2-{box_id}")]);
    let seen = mock.seen.lock().expect("mock").clone();
    let completion = seen
        .iter()
        .find(|(_, path, _, _)| path.ends_with("/complete"))
        .expect("completion");
    assert!(completion.1.contains(&create.to_string()));
    assert_eq!(
        completion.2.clone().expect("body")["leaseId"],
        lease.to_string()
    );
    assert_eq!(completion.2.clone().expect("body")["ok"], true);
    // A 401 from the server surfaces as an error the loop treats as fatal.
    *mock.status.lock().expect("mock") = 401;
    assert!(matches!(
        runner.poll_once().await,
        Err(momo_box_runner::runner::RunnerError::Client(
            ClientError::Unauthorized
        ))
    ));
    std::fs::remove_dir_all(&dir).ok();
}
