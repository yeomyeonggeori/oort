//! ADR-0197 D2: the control schema is closed. A control carries `{box id, four limits}`
//! and nothing else; an unknown field — an image, a command, a mount, an env var, a
//! network profile — gets the control refused, never executed.

mod common;

use std::sync::Arc;

use momo_box_runner::runner::Runner;
use momo_box_runner::testing::{FakeDocker, FakeServer};
use momo_box_runner::wire::{intake, Intake, Limits, Refusal, Task};
use serde_json::{json, Value};
use uuid::Uuid;

fn caps() -> Limits {
    Limits::ADR_CEILING
}

fn refusal(raw: &Value) -> Refusal {
    match intake(raw, &caps()) {
        Intake::Refused(refused) => refused.reason,
        Intake::Accepted(control) => panic!("accepted {control:?}"),
    }
}

#[test]
fn a_well_formed_control_of_each_verb_is_accepted() {
    let id = Uuid::new_v4();
    let create = common::control_json("create", id, Some(common::limits_json()));
    match intake(&create, &caps()) {
        Intake::Accepted(control) => {
            assert_eq!(control.box_id, id);
            assert_eq!(control.task, Task::Create(Limits::ADR_CEILING));
        }
        other => panic!("{other:?}"),
    }
    for verb in ["start", "stop", "delete", "status"] {
        assert!(
            matches!(
                intake(&common::control_json(verb, id, None), &caps()),
                Intake::Accepted(_)
            ),
            "{verb}"
        );
    }
}

#[test]
fn an_unknown_field_is_refused_whatever_it_is_called() {
    let id = Uuid::new_v4();
    for field in [
        "image",
        "command",
        "cmd",
        "entrypoint",
        "mounts",
        "mount",
        "volumes",
        "binds",
        "env",
        "environment",
        "network",
        "networkMode",
        "privileged",
        "capAdd",
        "securityOpt",
        "user",
        "devices",
        "pid",
        "extra",
        "script",
    ] {
        let mut control = common::control_json("create", id, Some(common::limits_json()));
        control[field] = json!("anything");
        assert_eq!(
            refusal(&control),
            Refusal::NotTheClosedSchema,
            "a control with `{field}` must be refused"
        );
        // The same on a verb without limits.
        let mut control = common::control_json("start", id, None);
        control[field] = json!(["x"]);
        assert_eq!(
            refusal(&control),
            Refusal::NotTheClosedSchema,
            "{field} on start"
        );
    }
}

#[test]
fn an_unknown_field_inside_the_limits_is_refused_too() {
    let mut limits = common::limits_json();
    limits["swapMb"] = json!(4096);
    let control = common::control_json("create", Uuid::new_v4(), Some(limits));
    assert_eq!(refusal(&control), Refusal::NotTheClosedSchema);
}

#[test]
fn a_refused_control_is_reportable_when_it_can_be_identified() {
    let mut control = common::control_json("create", Uuid::new_v4(), Some(common::limits_json()));
    control["image"] = json!("evil/image:latest");
    let Intake::Refused(refused) = intake(&control, &caps()) else {
        panic!("accepted");
    };
    let (id, lease, attempts) = refused.reportable.expect("identifiable");
    assert_eq!(id.to_string(), control["id"].as_str().expect("id"));
    assert_eq!(
        lease.to_string(),
        control["leaseId"].as_str().expect("lease")
    );
    assert_eq!(attempts, 1);
    // Nothing identifiable → only logged.
    let Intake::Refused(refused) = intake(&json!({"verb": "exec"}), &caps()) else {
        panic!("accepted");
    };
    assert_eq!(refused.reportable, None);
}

#[test]
fn verbs_outside_the_five_are_refused() {
    for verb in [
        "exec", "cp", "commit", "export", "snapshot", "logs", "attach", "", "Create",
    ] {
        let control = common::control_json(verb, Uuid::new_v4(), None);
        assert_eq!(refusal(&control), Refusal::UnknownVerb, "{verb:?}");
    }
}

#[test]
fn limits_are_checked_against_the_runner_local_caps() {
    let id = Uuid::new_v4();
    assert_eq!(
        refusal(&common::control_json("create", id, None)),
        Refusal::LimitsMissing
    );
    assert_eq!(
        refusal(&common::control_json(
            "stop",
            id,
            Some(common::limits_json())
        )),
        Refusal::LimitsUnexpected
    );
    for (field, value) in [
        ("cpuMillis", 0),
        ("memoryMb", 0),
        ("diskGb", 0),
        ("pids", 0),
    ] {
        let mut limits = common::limits_json();
        limits[field] = json!(value);
        assert_eq!(
            refusal(&common::control_json("create", id, Some(limits))),
            Refusal::LimitsZero,
            "{field}=0"
        );
    }
    for (field, value) in [
        ("cpuMillis", 1001),
        ("memoryMb", 2049),
        ("diskGb", 11),
        ("pids", 513),
    ] {
        let mut limits = common::limits_json();
        limits[field] = json!(value);
        assert_eq!(
            refusal(&common::control_json("create", id, Some(limits))),
            Refusal::LimitsAboveCap,
            "{field} above the cap"
        );
    }
    // A lower local cap bites on a control the ADR ceiling would allow.
    let lower = Limits {
        cpu_millis: 500,
        memory_mb: 1024,
        disk_gb: 5,
        pids: 256,
    };
    assert!(matches!(
        intake(
            &common::control_json("create", id, Some(common::limits_json())),
            &lower
        ),
        Intake::Refused(_)
    ));
    // Wrong types and negative numbers are the closed shape's business, not a panic.
    let mut limits = common::limits_json();
    limits["pids"] = json!(-1);
    assert_eq!(
        refusal(&common::control_json("create", id, Some(limits))),
        Refusal::NotTheClosedSchema
    );
}

/// Through the whole loop: a control that smuggles an image never reaches docker, is
/// reported failed with the lease it came with, and the next valid control still runs.
#[tokio::test]
async fn the_loop_never_executes_a_refused_control_and_reports_it_failed() {
    let dir = common::temp_dir("closed-schema");
    let docker = Arc::new(FakeDocker::new());
    let server = Arc::new(FakeServer::new());
    let (executor, engine, cfg) = common::executor(docker.clone(), common::config(&dir));
    let runner = Runner::new(cfg, engine, executor, server.clone());
    let box_id = Uuid::new_v4();

    let mut smuggled = common::control_json("create", box_id, Some(common::limits_json()));
    smuggled["image"] = json!("attacker/miner:latest");
    smuggled["mounts"] = json!(["/:/host"]);
    let smuggled_id = smuggled["id"].as_str().expect("id").to_string();
    let smuggled_lease = smuggled["leaseId"].as_str().expect("lease").to_string();
    let valid = common::control_json("create", box_id, Some(common::limits_json()));
    server.queue_claim(json!({"controls": [smuggled, valid], "poisoned": []}));

    let summary = runner.poll_once().await.expect("poll");
    assert_eq!((summary.refused, summary.executed), (1, 1));
    let completions = server.completions();
    assert_eq!(completions.len(), 2);
    assert_eq!(completions[0].0.to_string(), smuggled_id);
    assert_eq!(completions[0].1["ok"], false);
    assert_eq!(
        completions[0].1["leaseId"].as_str(),
        Some(smuggled_lease.as_str())
    );
    assert_eq!(
        completions[1].1["ok"], true,
        "the valid control after it still ran"
    );
    // Only the valid control touched docker: one volume, one container, and the image is the configured one.
    let created = docker.calls_of(momo_box_runner::docker::DockerOp::ContainerCreate);
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].last().map(String::as_str), Some(common::IMAGE));
    assert!(!created[0]
        .iter()
        .any(|arg| arg.contains("attacker") || arg.contains("/:/host")));
    std::fs::remove_dir_all(&dir).ok();
}
