//! ADR-0197 D10 / T13: orphan-volume reconciliation and the shred path. The runner never
//! destroys a volume on the server's word alone: unknown volumes are quarantined, destroyed
//! only after a grace period AND an operator's confirmation AND within a daily cap, and a
//! server list it has reason to doubt is acted on not at all.

mod common;

use std::sync::Arc;

use momo_box_runner::config::ShredConfig;
use momo_box_runner::docker::DockerOp;
use momo_box_runner::ledger::{Entry, Ledger};
use momo_box_runner::reconcile::{plan, Action, HoldReason, ServerBox, Suspicion};
use momo_box_runner::runner::{Runner, RunnerError};
use momo_box_runner::testing::{FakeDocker, FakeServer};
use uuid::Uuid;

const DAY: u64 = 86_400;
const NOW: u64 = 2_000_000_000;

fn shred_cfg() -> ShredConfig {
    ShredConfig {
        grace_days: 14,
        daily_cap: 2,
        on_delete: true,
    }
}

fn live(id: Uuid, state: &str) -> ServerBox {
    ServerBox {
        box_id: id,
        state: state.into(),
    }
}

fn ledger_with(entries: &[(Uuid, u64, bool)]) -> Ledger {
    let mut ledger = Ledger::default();
    for (id, at, confirmed) in entries {
        ledger.entries.insert(
            *id,
            Entry {
                quarantined_at: *at,
                confirmed: *confirmed,
            },
        );
    }
    ledger
}

#[test]
fn live_boxes_are_kept_whatever_their_live_state() {
    let ids: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
    let server: Vec<ServerBox> = [
        "creating",
        "running",
        "idle",
        "stopped",
        "deleting",
        "delete_failed",
    ]
    .iter()
    .zip(&ids)
    .map(|(state, id)| live(*id, state))
    .collect();
    let plan = plan(&ids, &server, &Ledger::default(), NOW, &shred_cfg());
    assert!(plan.actions.is_empty(), "{plan:?}");
    assert_eq!(plan.suspicion, None);
}

#[test]
fn an_unknown_or_tombstoned_volume_is_quarantined_not_destroyed() {
    let (kept_a, kept_b, unknown, tombstoned) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let server = vec![
        live(kept_a, "running"),
        live(kept_b, "stopped"),
        live(tombstoned, "deleted"),
    ];
    let plan = plan(
        &[kept_a, kept_b, unknown, tombstoned],
        &server,
        &Ledger::default(),
        NOW,
        &shred_cfg(),
    );
    assert_eq!(
        plan.actions,
        [Action::Quarantine(unknown), Action::Quarantine(tombstoned)]
    );
}

#[test]
fn a_quarantined_volume_waits_for_the_grace_period_the_confirmation_and_the_cap() {
    let kept = Uuid::new_v4();
    let a = Uuid::new_v4();
    let server = vec![live(kept, "running"), live(kept, "running")];
    let local = [kept, a];
    // Inside the grace period, even confirmed.
    let ledger = ledger_with(&[(a, NOW - 13 * DAY, true)]);
    assert_eq!(
        plan(&local, &server, &ledger, NOW, &shred_cfg()).actions,
        [Action::Hold(a, HoldReason::GracePeriod)]
    );
    // Past the grace period, unconfirmed.
    let ledger = ledger_with(&[(a, NOW - 15 * DAY, false)]);
    assert_eq!(
        plan(&local, &server, &ledger, NOW, &shred_cfg()).actions,
        [Action::Hold(a, HoldReason::AwaitingOperatorConfirmation)]
    );
    // Past the grace period and confirmed: destroyed.
    let ledger = ledger_with(&[(a, NOW - 15 * DAY, true)]);
    assert_eq!(
        plan(&local, &server, &ledger, NOW, &shred_cfg()).actions,
        [Action::Shred(a)]
    );
    // The daily cap: two already destroyed today means this one waits.
    let mut capped = ledger_with(&[(a, NOW - 15 * DAY, true)]);
    capped.shredded = vec![NOW - 100, NOW - 200];
    assert_eq!(
        plan(&local, &server, &capped, NOW, &shred_cfg()).actions,
        [Action::Hold(a, HoldReason::DailyCapReached)]
    );
    // Yesterday's do not count.
    capped.shredded = vec![NOW - DAY - 5, NOW - DAY - 6];
    assert_eq!(
        plan(&local, &server, &capped, NOW, &shred_cfg()).actions,
        [Action::Shred(a)]
    );
    // Cap zero: the orphan path never destroys.
    let never = ShredConfig {
        daily_cap: 0,
        ..shred_cfg()
    };
    assert_eq!(
        plan(
            &local,
            &server,
            &ledger_with(&[(a, NOW - 15 * DAY, true)]),
            NOW,
            &never
        )
        .actions,
        [Action::Hold(a, HoldReason::DailyCapReached)]
    );
}

#[test]
fn the_cap_is_spent_across_one_plan() {
    let kept = Uuid::new_v4();
    let orphans: Vec<Uuid> = (0..4).map(|_| Uuid::new_v4()).collect();
    let mut local = vec![kept];
    local.extend(&orphans);
    // Enough live boxes that four orphans are not "too many".
    let extra: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
    local.extend(&extra);
    let mut server = vec![live(kept, "running")];
    server.extend(extra.iter().map(|id| live(*id, "running")));
    let entries: Vec<(Uuid, u64, bool)> = orphans
        .iter()
        .map(|id| (*id, NOW - 20 * DAY, true))
        .collect();
    let plan = plan(&local, &server, &ledger_with(&entries), NOW, &shred_cfg());
    let shreds = plan
        .actions
        .iter()
        .filter(|a| matches!(a, Action::Shred(_)))
        .count();
    let holds = plan
        .actions
        .iter()
        .filter(|a| matches!(a, Action::Hold(_, HoldReason::DailyCapReached)))
        .count();
    assert_eq!((shreds, holds), (2, 2), "{plan:?}");
}

#[test]
fn a_box_the_server_knows_again_is_released_from_quarantine() {
    let a = Uuid::new_v4();
    let ledger = ledger_with(&[(a, NOW - 3 * DAY, false)]);
    let plan = plan(&[a], &[live(a, "stopped")], &ledger, NOW, &shred_cfg());
    assert_eq!(plan.actions, [Action::Release(a)]);
}

#[test]
fn a_list_the_runner_has_reason_to_doubt_is_acted_on_not_at_all() {
    // The server answers with nothing while the host holds volumes (a restored database,
    // an outage, a compromised server).
    let local: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    let empty = plan(
        &local,
        &[],
        &ledger_with(&[(local[0], NOW - 30 * DAY, true)]),
        NOW,
        &shred_cfg(),
    );
    assert_eq!(empty.suspicion, Some(Suspicion::EmptyServerList));
    assert!(
        empty.actions.is_empty(),
        "acted on an empty list: {empty:?}"
    );
    // More than half of the host orphaned at once.
    let (a, b, c, d) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let mass = plan(
        &[a, b, c, d],
        &[live(a, "running")],
        &Ledger::default(),
        NOW,
        &shred_cfg(),
    );
    assert_eq!(mass.suspicion, Some(Suspicion::TooManyOrphans));
    assert!(mass.actions.is_empty(), "{mass:?}");
    // Exactly half is tolerated (one orphan of two is an ordinary leftover).
    let half = plan(
        &[a, b],
        &[live(a, "running")],
        &Ledger::default(),
        NOW,
        &shred_cfg(),
    );
    assert_eq!(half.actions, [Action::Quarantine(b)]);
    // A single volume on the host can be an orphan.
    let one = plan(
        &[a],
        &[live(b, "running")],
        &Ledger::default(),
        NOW,
        &shred_cfg(),
    );
    assert_eq!(one.actions, [Action::Quarantine(a)]);
}

fn name(id: Uuid) -> String {
    format!("momo-m2-{id}")
}

/// The orphan path end to end: quarantine (container stopped, volume kept), hold through
/// the grace period, destroy only once an operator has confirmed and the grace has passed.
#[tokio::test]
async fn an_orphan_volume_is_quarantined_then_shredded_only_after_grace_and_confirmation() {
    let dir = common::temp_dir("orphan");
    let docker = Arc::new(FakeDocker::new());
    let server = Arc::new(FakeServer::new());
    let (executor, engine, cfg) = common::executor(docker.clone(), common::config(&dir));
    let runner = Runner::new(cfg, engine, executor, server.clone());

    let (live_a, live_b, orphan) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    for id in [live_a, live_b, orphan] {
        docker.add_volume(&name(id), common::WORKSPACE);
        docker.add_container(&name(id), true, common::WORKSPACE);
    }
    // Other people's things stay out of it.
    docker.add_volume("someone-elses", "");
    server.set_boxes(vec![live(live_a, "running"), live(live_b, "stopped")]);

    // Round 1: quarantine. The container stops; the volume stays.
    let first = runner.reconcile_once().await.expect("reconcile");
    assert_eq!(first.actions, [Action::Quarantine(orphan)]);
    assert!(docker.volumes().contains(&name(orphan)));
    assert!(
        docker.containers().contains(&(name(orphan), false)),
        "the orphan's container was not stopped"
    );
    assert!(
        docker.containers().contains(&(name(live_a), true)),
        "a live box was disturbed"
    );
    assert!(docker.calls_of(DockerOp::OneShotRun).is_empty());
    let ledger = Ledger::load(&dir).expect("ledger");
    assert!(ledger.entries.contains_key(&orphan));

    // Round 2: still inside the grace period → held, nothing destroyed.
    let second = runner.reconcile_once().await.expect("reconcile");
    assert_eq!(
        second.actions,
        [Action::Hold(orphan, HoldReason::GracePeriod)]
    );
    assert!(docker.volumes().contains(&name(orphan)));

    // The grace period passes but nobody confirmed: held.
    let mut ledger = Ledger::load(&dir).expect("ledger");
    ledger
        .entries
        .get_mut(&orphan)
        .expect("entry")
        .quarantined_at -= 15 * DAY;
    ledger.save(&dir).expect("save");
    let third = runner.reconcile_once().await.expect("reconcile");
    assert_eq!(
        third.actions,
        [Action::Hold(
            orphan,
            HoldReason::AwaitingOperatorConfirmation
        )]
    );
    assert!(
        docker.volumes().contains(&name(orphan)),
        "destroyed without an operator's confirmation"
    );

    // An operator confirms on this host (what `confirm-shred` writes): now it is destroyed.
    let mut ledger = Ledger::load(&dir).expect("ledger");
    ledger.entries.get_mut(&orphan).expect("entry").confirmed = true;
    ledger.save(&dir).expect("save");
    let fourth = runner.reconcile_once().await.expect("reconcile");
    assert_eq!(fourth.actions, [Action::Shred(orphan)]);
    assert!(
        !docker.volumes().contains(&name(orphan)),
        "the orphan volume survived the shred"
    );
    assert!(docker.containers().iter().all(|(n, _)| n != &name(orphan)));
    assert_eq!(
        docker.calls_of(DockerOp::OneShotRun).len(),
        1,
        "overwritten once, before removal"
    );
    // Live boxes and strangers' volumes are exactly where they were.
    assert!(docker.volumes().contains(&name(live_a)) && docker.volumes().contains(&name(live_b)));
    assert!(docker.volumes().contains(&"someone-elses".to_string()));
    let ledger = Ledger::load(&dir).expect("ledger");
    assert!(ledger.entries.is_empty());
    assert_eq!(
        ledger.shredded.len(),
        1,
        "the destruction counts against the daily cap"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_server_that_lists_nothing_costs_no_box_a_container_or_a_volume() {
    let dir = common::temp_dir("orphan-empty");
    let docker = Arc::new(FakeDocker::new());
    let server = Arc::new(FakeServer::new());
    let (executor, engine, cfg) = common::executor(docker.clone(), common::config(&dir));
    let runner = Runner::new(cfg, engine, executor, server);
    let ids: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    for id in &ids {
        docker.add_volume(&name(*id), common::WORKSPACE);
        docker.add_container(&name(*id), true, common::WORKSPACE);
    }
    let plan = runner.reconcile_once().await.expect("reconcile");
    assert_eq!(plan.suspicion, Some(Suspicion::EmptyServerList));
    assert_eq!(docker.volumes().len(), 3);
    assert!(
        docker.containers().iter().all(|(_, running)| *running),
        "an empty list stopped a box"
    );
    assert!(docker.calls_of(DockerOp::ContainerStop).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_host_that_carries_another_workspaces_boxes_refuses_to_start() {
    let dir = common::temp_dir("one-workspace");
    let docker = Arc::new(FakeDocker::new());
    let server = Arc::new(FakeServer::new());
    let (executor, engine, cfg) = common::executor(docker.clone(), common::config(&dir));
    let runner = Runner::new(cfg, engine, executor, server);
    runner.preflight().await.expect("an empty host is fine");
    docker.add_volume(&name(Uuid::new_v4()), common::WORKSPACE);
    runner
        .preflight()
        .await
        .expect("our own workspace's boxes are fine");
    docker.add_container(
        &name(Uuid::new_v4()),
        true,
        "99999999-0000-4000-8000-000000000000",
    );
    assert!(matches!(
        runner.preflight().await,
        Err(RunnerError::ForeignWorkspace)
    ));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_damaged_ledger_is_an_error_not_an_empty_ledger() {
    let dir = common::temp_dir("ledger");
    std::fs::write(momo_box_runner::ledger::path_in(&dir), "{not json").expect("write");
    assert!(
        Ledger::load(&dir).is_err(),
        "a damaged ledger must not silently forget quarantines"
    );
    std::fs::write(
        momo_box_runner::ledger::path_in(&dir),
        r#"{"entries": {}, "shredded": [], "extra": 1}"#,
    )
    .expect("write");
    assert!(Ledger::load(&dir).is_err(), "the ledger is a closed shape");
    std::fs::remove_dir_all(&dir).ok();
}
