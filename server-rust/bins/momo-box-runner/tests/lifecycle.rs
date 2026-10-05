//! ADR-0197 D2/D3/D10: each verb against an in-memory docker — creating with the fixed
//! template, starting, stopping, deleting with a verification report, and `status` reporting
//! one of three words and nothing else.

mod common;

use std::sync::Arc;

use momo_box_runner::docker::DockerOp;
use momo_box_runner::testing::FakeDocker;
use momo_box_runner::wire::{CompleteBody, Control, Limits, Observed, Task};
use uuid::Uuid;

fn control(box_id: Uuid, task: Task) -> Control {
    Control {
        id: Uuid::new_v4(),
        lease_id: Uuid::new_v4(),
        attempts: 1,
        box_id,
        task,
    }
}

fn name(id: Uuid) -> String {
    format!("momo-m2-{id}")
}

struct Rig {
    docker: Arc<FakeDocker>,
    executor: momo_box_runner::executor::Executor,
    dir: std::path::PathBuf,
}

fn rig() -> Rig {
    let dir = common::temp_dir("lifecycle");
    let docker = Arc::new(FakeDocker::new());
    let (executor, _, _) = common::executor(docker.clone(), common::config(&dir));
    Rig {
        docker,
        executor,
        dir,
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

#[tokio::test]
async fn create_makes_the_volume_then_the_container_and_leaves_it_running() {
    let rig = rig();
    let id = Uuid::new_v4();
    let body = rig
        .executor
        .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
        .await;
    assert!(body.ok);
    assert_eq!(rig.docker.volumes(), [name(id)]);
    assert_eq!(rig.docker.containers(), [(name(id), true)]);
    let ops: Vec<DockerOp> = rig.docker.calls().into_iter().map(|(op, _)| op).collect();
    let first_volume = ops
        .iter()
        .position(|o| *o == DockerOp::VolumeCreate)
        .expect("volume");
    let first_create = ops
        .iter()
        .position(|o| *o == DockerOp::ContainerCreate)
        .expect("create");
    assert!(
        first_volume < first_create,
        "the volume exists before the container is created"
    );
    // The report is a flag and nothing else for a create.
    assert_eq!((body.observed, body.deletion), (None, None));
    // Create again (a re-issued lease): idempotent, no second volume or container.
    let again = rig
        .executor
        .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
        .await;
    assert!(again.ok);
    assert_eq!(rig.docker.calls_of(DockerOp::ContainerCreate).len(), 1);
    assert_eq!(rig.docker.calls_of(DockerOp::VolumeCreate).len(), 1);
}

#[tokio::test]
async fn a_box_that_cannot_start_fails_the_create_and_leaves_nothing_behind() {
    let rig = rig();
    let id = Uuid::new_v4();
    rig.docker.crash_on_start(true);
    let body = rig
        .executor
        .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
        .await;
    assert!(!body.ok);
    assert_eq!(
        rig.docker.volumes(),
        Vec::<String>::new(),
        "a failed create left a volume"
    );
    assert_eq!(
        rig.docker.containers(),
        Vec::<(String, bool)>::new(),
        "a failed create left a container"
    );
    // It retried before giving up (3 attempts), it did not stop at the first.
    assert_eq!(rig.docker.calls_of(DockerOp::ContainerStart).len(), 3);
}

#[tokio::test]
async fn start_stop_and_status_round_trip() {
    let rig = rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    let status = |executor: &momo_box_runner::executor::Executor| {
        let executor = executor.clone();
        async move { executor.execute(&control(id, Task::Status)).await }
    };
    assert_eq!(
        status(&rig.executor).await.observed,
        Some(Observed::Running)
    );
    assert!(rig.executor.execute(&control(id, Task::Stop)).await.ok);
    assert_eq!(rig.docker.containers(), [(name(id), false)]);
    assert_eq!(
        status(&rig.executor).await.observed,
        Some(Observed::Stopped)
    );
    // Stopping a stopped box is fine; starting brings it back.
    assert!(rig.executor.execute(&control(id, Task::Stop)).await.ok);
    assert!(rig.executor.execute(&control(id, Task::Start)).await.ok);
    assert_eq!(rig.docker.containers(), [(name(id), true)]);
    assert!(
        rig.executor.execute(&control(id, Task::Start)).await.ok,
        "starting a running box is a no-op"
    );
    // A box that does not exist cannot be started or stopped; status says absent.
    let ghost = Uuid::new_v4();
    assert!(!rig.executor.execute(&control(ghost, Task::Start)).await.ok);
    assert!(!rig.executor.execute(&control(ghost, Task::Stop)).await.ok);
    let absent = status_for(&rig.executor, ghost).await;
    assert_eq!((absent.ok, absent.observed), (true, Some(Observed::Absent)));
}

async fn status_for(executor: &momo_box_runner::executor::Executor, id: Uuid) -> CompleteBody {
    executor.execute(&control(id, Task::Status)).await
}

/// `status` never carries docker's own words: whatever docker prints or fails with, the
/// report is a flag plus one of three words, and no `inspect` exists to call.
#[tokio::test]
async fn status_carries_no_docker_output_and_no_environment() {
    let rig = rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    let body = status_for(&rig.executor, id).await;
    let json = serde_json::to_value(body).expect("serialize");
    let keys: std::collections::BTreeSet<&str> = json
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["attempts", "leaseId", "observed", "ok"]
            .into_iter()
            .collect()
    );
    assert_eq!(json["observed"], "running");
    // Docker failing noisily: the failure is `ok:false` with no words at all.
    rig.docker.fail(DockerOp::ContainerList);
    let failed = status_for(&rig.executor, id).await;
    assert!(!failed.ok);
    let text = serde_json::to_string(&failed).expect("serialize");
    assert!(
        !text.contains("ANTHROPIC") && !text.contains("sk-") && !text.contains("simulated"),
        "{text}"
    );
    assert_eq!(failed.observed, None);
    // And no call in the whole run was anything but a list for a status.
    let docker_args: Vec<String> = rig
        .docker
        .calls()
        .into_iter()
        .flat_map(|(_, a)| a)
        .collect();
    assert!(!docker_args.iter().any(|a| a.contains("inspect")));
}

#[tokio::test]
async fn delete_removes_everything_and_reports_what_it_verified() {
    let rig = rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    let body = rig.executor.execute(&control(id, Task::Delete)).await;
    assert!(body.ok);
    assert_eq!(
        serde_json::to_value(body.deletion).expect("serialize"),
        serde_json::json!({"containerAbsent": true, "volumeAbsent": true})
    );
    assert_eq!(rig.docker.volumes(), Vec::<String>::new());
    assert_eq!(rig.docker.containers(), Vec::<(String, bool)>::new());
    // The volume is overwritten BEFORE it is removed.
    let ops: Vec<DockerOp> = rig.docker.calls().into_iter().map(|(op, _)| op).collect();
    let shred = ops
        .iter()
        .rposition(|o| *o == DockerOp::OneShotRun)
        .expect("overwrite ran");
    let remove = ops
        .iter()
        .rposition(|o| *o == DockerOp::VolumeRemove)
        .expect("volume rm");
    assert!(shred < remove);
    // Deleting what is already gone verifies the absence and says so.
    let again = rig.executor.execute(&control(id, Task::Delete)).await;
    assert!(again.ok);
}

#[tokio::test]
async fn a_delete_that_cannot_verify_absence_reports_failure_not_success() {
    // A stuck volume: removal refused, so the report must say the volume is still there.
    let rig = rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    rig.docker.stick_volume(&name(id));
    let body = rig.executor.execute(&control(id, Task::Delete)).await;
    assert!(!body.ok, "a delete with a surviving volume claimed success");
    let report = body.deletion.expect("report");
    assert_eq!(
        (report.container_absent, report.volume_absent),
        (true, false)
    );

    // A check that cannot be made is not an absence.
    let rig = self::rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    rig.docker.fail(DockerOp::ContainerList);
    rig.docker.fail(DockerOp::VolumeList);
    let body = rig.executor.execute(&control(id, Task::Delete)).await;
    let report = body.deletion.expect("report");
    assert_eq!(
        (body.ok, report.container_absent, report.volume_absent),
        (false, false, false)
    );

    // A container that will not go.
    let rig = self::rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    rig.docker.fail(DockerOp::ContainerRemove);
    let body = rig.executor.execute(&control(id, Task::Delete)).await;
    let report = body.deletion.expect("report");
    assert_eq!((body.ok, report.container_absent), (false, false));
}

#[tokio::test]
async fn the_overwrite_before_removal_can_be_switched_off_and_never_blocks_deletion() {
    let dir = common::temp_dir("lifecycle-noshred");
    let docker = Arc::new(FakeDocker::new());
    let cfg = common::config_with(&dir, |cfg| cfg.shred.on_delete = false);
    let (executor, _, _) = common::executor(docker.clone(), cfg);
    let id = Uuid::new_v4();
    assert!(
        executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    assert!(executor.execute(&control(id, Task::Delete)).await.ok);
    assert!(docker.calls_of(DockerOp::OneShotRun).is_empty());
    std::fs::remove_dir_all(&dir).ok();

    // A failing overwrite helper does not stop the volume from being removed.
    let rig = rig();
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    rig.docker.fail(DockerOp::OneShotRun);
    assert!(rig.executor.execute(&control(id, Task::Delete)).await.ok);
}

#[tokio::test]
async fn only_this_runners_named_resources_are_ever_touched() {
    let rig = rig();
    // Someone else's things on the same machine (other project, other prefix, a lookalike).
    rig.docker.add_container("other-project-db", true, "");
    rig.docker.add_volume("other-project-data", "");
    rig.docker
        .add_volume("momo-m2-not-a-uuid", common::WORKSPACE);
    let id = Uuid::new_v4();
    assert!(
        rig.executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    assert!(rig.executor.execute(&control(id, Task::Delete)).await.ok);
    assert!(rig
        .docker
        .containers()
        .iter()
        .any(|(n, running)| n == "other-project-db" && *running));
    assert!(rig
        .docker
        .volumes()
        .contains(&"other-project-data".to_string()));
    assert!(rig
        .docker
        .volumes()
        .contains(&"momo-m2-not-a-uuid".to_string()));
    // Every docker call that names a resource names one of this box's two.
    for (op, args) in rig.docker.calls() {
        if matches!(
            op,
            DockerOp::ContainerStart
                | DockerOp::ContainerStop
                | DockerOp::ContainerRemove
                | DockerOp::VolumeRemove
        ) {
            assert_eq!(
                args.last().map(String::as_str),
                Some(name(id).as_str()),
                "{op:?} {args:?}"
            );
        }
    }
}

/// #3509 review M4: a failed create removes only what this call made.
#[tokio::test]
async fn a_failed_create_leaves_a_pre_existing_volume_alone() {
    let rig = rig();
    let id = Uuid::new_v4();
    rig.docker.add_volume(&name(id), common::WORKSPACE);
    rig.docker.crash_on_start(true);
    for _ in 0..3 {
        let body = rig
            .executor
            .execute(&control(id, Task::Create(Limits::ADR_CEILING)))
            .await;
        assert!(!body.ok);
    }
    assert_eq!(
        rig.docker.volumes(),
        [name(id)],
        "a failed create deleted a volume it did not create"
    );
    assert_eq!(
        rig.docker.containers(),
        Vec::<(String, bool)>::new(),
        "the container this call made is removed"
    );
    let rig2 = self::rig();
    let id2 = Uuid::new_v4();
    rig2.docker
        .add_container(&name(id2), false, common::WORKSPACE);
    rig2.docker.crash_on_start(true);
    assert!(
        !rig2
            .executor
            .execute(&control(id2, Task::Create(Limits::ADR_CEILING)))
            .await
            .ok
    );
    assert_eq!(rig2.docker.containers(), [(name(id2), false)]);
}
