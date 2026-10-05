//! Test doubles: a small in-memory docker and a scripted server. Public so the integration
//! tests under `tests/` can use them; nothing in the binary does.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

use crate::client::{ClientError, PendingRegistration, ServerApi};
use crate::docker::{Docker, DockerError, DockerOp, DockerOutput};
use crate::reconcile::ServerBox;
use crate::wire::{ClaimEnvelope, CompleteBody};

#[derive(Debug, Default)]
struct FakeState {
    /// volume name → workspace label
    volumes: BTreeMap<String, String>,
    /// container name → (running, workspace label)
    containers: BTreeMap<String, (bool, String)>,
    failing: BTreeSet<DockerOp>,
    /// Volume names `volume rm` refuses (an in-use or stuck volume).
    stuck_volumes: BTreeSet<String>,
    /// A started container that exits at once (a crash loop).
    crash_on_start: bool,
    calls: Vec<(DockerOp, Vec<String>)>,
}

/// An in-memory docker. It understands exactly the nine ops.
#[derive(Debug, Default)]
pub struct FakeDocker {
    state: Mutex<FakeState>,
}

fn ok(stdout: impl Into<String>) -> Result<DockerOutput, DockerError> {
    Ok(DockerOutput {
        success: true,
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

fn failed() -> Result<DockerOutput, DockerError> {
    Ok(DockerOutput {
        success: false,
        stdout: String::new(),
        stderr: "Error: simulated failure; ANTHROPIC_API_KEY=sk-should-never-leave".into(),
    })
}

fn label(args: &[String], key: &str) -> String {
    args.windows(2)
        .find(|pair| pair[0] == "--label" && pair[1].starts_with(&format!("{key}=")))
        .map(|pair| pair[1][key.len() + 1..].to_string())
        .unwrap_or_default()
}

fn option(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
}

impl FakeDocker {
    pub fn new() -> Self {
        FakeDocker::default()
    }

    pub fn fail(&self, op: DockerOp) {
        self.state.lock().expect("fake").failing.insert(op);
    }

    pub fn heal(&self, op: DockerOp) {
        self.state.lock().expect("fake").failing.remove(&op);
    }

    pub fn stick_volume(&self, name: &str) {
        self.state
            .lock()
            .expect("fake")
            .stuck_volumes
            .insert(name.to_string());
    }

    pub fn crash_on_start(&self, crash: bool) {
        self.state.lock().expect("fake").crash_on_start = crash;
    }

    /// Put a volume on the "host" as if something else made it.
    pub fn add_volume(&self, name: &str, workspace: &str) {
        self.state
            .lock()
            .expect("fake")
            .volumes
            .insert(name.to_string(), workspace.to_string());
    }

    pub fn add_container(&self, name: &str, running: bool, workspace: &str) {
        self.state
            .lock()
            .expect("fake")
            .containers
            .insert(name.to_string(), (running, workspace.to_string()));
    }

    pub fn volumes(&self) -> Vec<String> {
        self.state
            .lock()
            .expect("fake")
            .volumes
            .keys()
            .cloned()
            .collect()
    }

    pub fn containers(&self) -> Vec<(String, bool)> {
        self.state
            .lock()
            .expect("fake")
            .containers
            .iter()
            .map(|(name, (running, _))| (name.clone(), *running))
            .collect()
    }

    pub fn calls(&self) -> Vec<(DockerOp, Vec<String>)> {
        self.state.lock().expect("fake").calls.clone()
    }

    pub fn calls_of(&self, op: DockerOp) -> Vec<Vec<String>> {
        self.calls()
            .into_iter()
            .filter(|(called, _)| *called == op)
            .map(|(_, args)| args)
            .collect()
    }
}

#[async_trait]
impl Docker for FakeDocker {
    async fn run(&self, op: DockerOp, args: Vec<String>) -> Result<DockerOutput, DockerError> {
        let mut state = self.state.lock().expect("fake");
        state.calls.push((op, args.clone()));
        if state.failing.contains(&op) {
            return failed();
        }
        match op {
            DockerOp::VolumeCreate => {
                let name = args.last().cloned().unwrap_or_default();
                let workspace = label(&args, "io.oort.workspace");
                state.volumes.insert(name.clone(), workspace);
                ok(name)
            }
            DockerOp::VolumeRemove => {
                let name = args.last().cloned().unwrap_or_default();
                if state.stuck_volumes.contains(&name) {
                    return failed();
                }
                if state.volumes.remove(&name).is_none() {
                    return failed();
                }
                ok(name)
            }
            DockerOp::VolumeList => ok(state
                .volumes
                .iter()
                .map(|(name, ws)| format!("{name}\t{ws}\n"))
                .collect::<String>()),
            DockerOp::ContainerCreate => {
                let name = option(&args, "--name").unwrap_or_default();
                let workspace = label(&args, "io.oort.workspace");
                if state.containers.contains_key(&name) {
                    return failed();
                }
                state.containers.insert(name, (false, workspace));
                // Docker prints the new container's id; the runner must not forward it.
                ok("3f2a9c1e0b7d4a5e8c6b1d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b\n")
            }
            DockerOp::ContainerStart => {
                let name = args.last().cloned().unwrap_or_default();
                let crash = state.crash_on_start;
                match state.containers.get_mut(&name) {
                    Some(entry) => {
                        entry.0 = !crash;
                        ok(name)
                    }
                    None => failed(),
                }
            }
            DockerOp::ContainerStop => {
                let name = args.last().cloned().unwrap_or_default();
                match state.containers.get_mut(&name) {
                    Some(entry) => {
                        entry.0 = false;
                        ok(name)
                    }
                    None => failed(),
                }
            }
            DockerOp::ContainerRemove => {
                let name = args.last().cloned().unwrap_or_default();
                if state.containers.remove(&name).is_none() {
                    return failed();
                }
                ok(name)
            }
            DockerOp::ContainerList => ok(state
                .containers
                .iter()
                .map(|(name, (running, ws))| {
                    format!(
                        "{name}\t{}\t{ws}\n",
                        if *running { "running" } else { "exited" }
                    )
                })
                .collect::<String>()),
            DockerOp::OneShotRun => ok("shredded\n"),
        }
    }
}

/// A scripted server: queued claim answers, recorded completions, a fixed box list.
#[derive(Default)]
pub struct FakeServer {
    claims: Mutex<VecDeque<Value>>,
    completions: Mutex<Vec<(Uuid, Value)>>,
    boxes: Mutex<Vec<ServerBox>>,
    stale_on_complete: Mutex<bool>,
    /// ADR-0197 M4: the box's first owner list, the parked registrations, and what the runner answered.
    owner_list: Mutex<Option<Vec<u8>>>,
    registrations: Mutex<Vec<PendingRegistration>>,
    attested: Mutex<Vec<(Uuid, [u8; 32], [u8; 64])>>,
    rejected: Mutex<Vec<(Uuid, [u8; 32])>>,
    identity: Mutex<Option<[u8; 32]>>,
}

impl FakeServer {
    pub fn new() -> Self {
        FakeServer::default()
    }

    /// Queue the JSON a `claim` will answer with next.
    pub fn queue_claim(&self, json: Value) {
        self.claims.lock().expect("fake").push_back(json);
    }

    pub fn set_boxes(&self, boxes: Vec<ServerBox>) {
        *self.boxes.lock().expect("fake") = boxes;
    }

    pub fn stale_on_complete(&self, stale: bool) {
        *self.stale_on_complete.lock().expect("fake") = stale;
    }

    pub fn completions(&self) -> Vec<(Uuid, Value)> {
        self.completions.lock().expect("fake").clone()
    }

    pub fn set_owner_list(&self, list: Option<Vec<u8>>) {
        *self.owner_list.lock().expect("fake") = list;
    }

    pub fn park_registration(&self, registration: PendingRegistration) {
        self.registrations.lock().expect("fake").push(registration);
    }

    pub fn attested(&self) -> Vec<(Uuid, [u8; 32], [u8; 64])> {
        self.attested.lock().expect("fake").clone()
    }

    pub fn rejected(&self) -> Vec<(Uuid, [u8; 32])> {
        self.rejected.lock().expect("fake").clone()
    }

    pub fn announced_identity(&self) -> Option<[u8; 32]> {
        *self.identity.lock().expect("fake")
    }
}

#[async_trait]
impl ServerApi for FakeServer {
    async fn claim(&self, _limit: u32) -> Result<ClaimEnvelope, ClientError> {
        let next = self
            .claims
            .lock()
            .expect("fake")
            .pop_front()
            .unwrap_or_else(|| serde_json::json!({"controls": [], "poisoned": []}));
        serde_json::from_value(next).map_err(|_| ClientError::Shape)
    }

    async fn complete(&self, control_id: Uuid, body: &CompleteBody) -> Result<(), ClientError> {
        self.completions
            .lock()
            .expect("fake")
            .push((control_id, serde_json::to_value(body).expect("serialize")));
        if *self.stale_on_complete.lock().expect("fake") {
            return Err(ClientError::Stale);
        }
        Ok(())
    }

    async fn boxes(&self) -> Result<Vec<ServerBox>, ClientError> {
        Ok(self.boxes.lock().expect("fake").clone())
    }

    async fn provisioning(&self, _box_id: Uuid) -> Result<Vec<u8>, ClientError> {
        self.owner_list
            .lock()
            .expect("fake")
            .clone()
            .ok_or(ClientError::Status(404))
    }

    async fn registrations(&self) -> Result<Vec<PendingRegistration>, ClientError> {
        Ok(self.registrations.lock().expect("fake").clone())
    }

    async fn attest(
        &self,
        box_id: Uuid,
        host_public_key: &[u8; 32],
        attestation: &[u8; 64],
    ) -> Result<(), ClientError> {
        self.attested
            .lock()
            .expect("fake")
            .push((box_id, *host_public_key, *attestation));
        // The slot is no longer parked.
        self.registrations
            .lock()
            .expect("fake")
            .retain(|r| r.box_id != box_id);
        Ok(())
    }

    async fn reject(&self, box_id: Uuid, host_public_key: &[u8; 32]) -> Result<(), ClientError> {
        self.rejected
            .lock()
            .expect("fake")
            .push((box_id, *host_public_key));
        self.registrations
            .lock()
            .expect("fake")
            .retain(|r| r.box_id != box_id);
        Ok(())
    }

    async fn set_identity(&self, public_key: &[u8; 32]) -> Result<(), ClientError> {
        *self.identity.lock().expect("fake") = Some(*public_key);
        Ok(())
    }
}
