//! #3509 review M5: the runner does not destroy a box on a `delete` control alone. The
//! server's own box list must show the box as `deleting`, and a daily cap bounds the damage
//! of a server that lies in both places.

mod common;

use std::sync::Arc;

use momo_box_runner::docker::DockerOp;
use momo_box_runner::ledger::Ledger;
use momo_box_runner::reconcile::ServerBox;
use momo_box_runner::runner::Runner;
use momo_box_runner::testing::{FakeDocker, FakeServer};
use serde_json::json;
use uuid::Uuid;

fn name(id: Uuid) -> String {
    format!("momo-m2-{id}")
}

struct Rig {
    docker: Arc<FakeDocker>,
    server: Arc<FakeServer>,
    runner: Runner,
    dir: std::path::PathBuf,
}

fn rig(cap: u32) -> Rig {
    let dir = common::temp_dir("delete-guard");
    let docker = Arc::new(FakeDocker::new());
    let server = Arc::new(FakeServer::new());
    let cfg = common::config_with(&dir, |cfg| cfg.shred.delete_daily_cap = cap);
    let (executor, engine, cfg) = common::executor(docker.clone(), cfg);
    let runner = Runner::new(cfg, engine, executor, server.clone());
    Rig {
        docker,
        server,
        runner,
        dir,
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

fn delete_claim(server: &FakeServer, box_id: Uuid) {
    let control = common::control_json("delete", box_id, None);
    server.queue_claim(json!({"controls": [control], "poisoned": []}));
}

fn add_box(rig: &Rig, id: Uuid) {
    rig.docker.add_volume(&name(id), common::WORKSPACE);
    rig.docker.add_container(&name(id), true, common::WORKSPACE);
}

#[tokio::test]
async fn a_delete_for_a_box_the_server_does_not_list_as_deleting_destroys_nothing() {
    for state in ["running", "stopped", "deleted", "delete_failed", "creating"] {
        let rig = rig(10);
        let id = Uuid::new_v4();
        add_box(&rig, id);
        rig.server.set_boxes(vec![ServerBox {
            box_id: id,
            state: state.into(),
        }]);
        delete_claim(&rig.server, id);
        rig.runner.poll_once().await.expect("poll");
        assert_eq!(
            rig.docker.volumes(),
            [name(id)],
            "{state}: the volume was destroyed"
        );
        assert_eq!(
            rig.docker.containers(),
            [(name(id), true)],
            "{state}: the container was touched"
        );
        assert!(rig.docker.calls_of(DockerOp::OneShotRun).is_empty());
        let completions = rig.server.completions();
        assert_eq!(completions[0].1["ok"], false, "{state}");
        assert!(completions[0].1.get("deletion").is_none());
    }
    // Not listed at all.
    let rig = rig(10);
    let id = Uuid::new_v4();
    add_box(&rig, id);
    delete_claim(&rig.server, id);
    rig.runner.poll_once().await.expect("poll");
    assert_eq!(rig.docker.volumes(), [name(id)]);
}

#[tokio::test]
async fn a_delete_the_server_lists_as_deleting_runs_and_counts_against_the_cap() {
    let rig = rig(2);
    let ids: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();
    for id in &ids {
        add_box(&rig, *id);
    }
    rig.server.set_boxes(
        ids.iter()
            .map(|id| ServerBox {
                box_id: *id,
                state: "deleting".into(),
            })
            .collect(),
    );
    for id in &ids {
        delete_claim(&rig.server, *id);
        rig.runner.poll_once().await.expect("poll");
    }
    let completions = rig.server.completions();
    assert_eq!(
        completions
            .iter()
            .map(|c| c.1["ok"].as_bool())
            .collect::<Vec<_>>(),
        [Some(true), Some(true), Some(false)]
    );
    assert!(
        !rig.docker.volumes().contains(&name(ids[0]))
            && !rig.docker.volumes().contains(&name(ids[1]))
    );
    assert!(
        rig.docker.volumes().contains(&name(ids[2])),
        "the third delete went past the daily cap"
    );
    assert_eq!(Ledger::load(&rig.dir).expect("ledger").deleted.len(), 2);
}
