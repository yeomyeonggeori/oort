//! Evaluation-harness skeleton: the seam the M1~M3 implementations plug into.
//!
//! A product backend implements [`MemoryBackend`]; the checkers below score it
//! against the ground truth in [`Corpus`]. Checkers return `Err(EvalError)`
//! when the backend cannot answer, so an absent implementation is RED, never a
//! vacuous PASS (every leak case also carries a positive control).

use super::corpus::{Channel, Corpus, Who};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalError {
    /// The backend (or one of its methods) does not exist yet.
    NotImplemented(&'static str),
}
pub type R<T> = Result<T, EvalError>;

/// One recalled item. `evidence` are corpus message keys (`m0001`).
#[derive(Debug, Clone)]
pub struct Recalled {
    pub text: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum Surface {
    /// The memory browser list.
    Browser,
    /// Keyword search.
    Search(String),
    /// Serving receipts ("what was loaded for this answer").
    Receipts,
}

#[derive(Debug, Clone)]
pub enum Mutation {
    /// Set `membership.left_at` for `who` in `channel`.
    Leave(Who, Channel),
    /// Mark the source message deleted (`state = 'deleted'`).
    Delete(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub value: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Period {
    pub value: String,
    pub valid_from_minute: u32,
    /// `None` = still open (only the current value may be open).
    pub valid_to_minute: Option<u32>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Commitment {
    pub owner: Who,
    pub task: String,
    pub evidence: Vec<String>,
}

/// Contract for the team-memory implementation (M1 digests, M2 items, M3 cleanup).
pub trait MemoryBackend {
    /// Ingest the whole corpus through the product's collection path.
    fn ingest(&mut self, corpus: &Corpus) -> R<()>;
    /// Apply a source-side change after ingestion.
    fn apply(&mut self, mutation: &Mutation) -> R<()>;
    /// What `viewer` can see through a user-facing surface.
    fn recall(&self, viewer: Who, surface: &Surface) -> R<Vec<Recalled>>;
    /// The full text an agent run would receive when `invoker` calls the agent
    /// in `channel` (summaries included; plan §4.6 audience rule).
    fn agent_context(&self, invoker: Who, channel: Channel) -> R<String>;
    /// Everything persisted, for the collection-policy check.
    fn stored(&self) -> R<Vec<Recalled>>;
    /// Current decision value as `viewer` sees it.
    fn current_value(&self, viewer: Who, topic: &str) -> R<Option<Answer>>;
    /// Decision timeline (old values must stay, with closed `valid_to`).
    fn timeline(&self, viewer: Who, topic: &str) -> R<Vec<Period>>;
    /// Promises / ownership as `viewer` sees them.
    fn commitments(&self, viewer: Who) -> R<Vec<Commitment>>;
}

pub type Factory<'a> = &'a dyn Fn() -> Box<dyn MemoryBackend>;

/// Stated leak assertions (plan §8.1). Ids are stable; `labels.json` lists them.
pub const LEAK_CASES: [(&str, &str); 8] = [
    (
        "z_sees_no_hr",
        "Z (not in #hr) gets 0 hr canaries from browser, search and receipts",
    ),
    (
        "x_sees_hr",
        "X (member of #hr) does see the hr canaries (positive control)",
    ),
    (
        "left_member_sees_none",
        "after X's left_at is set, X gets 0 hr canaries",
    ),
    (
        "deleted_source_hidden",
        "after the source message is deleted, no surface returns its canary",
    ),
    (
        "general_call_excludes_hr",
        "X calling the agent in #general: no hr/dm text in the answer context",
    ),
    (
        "dm_context_has_dm_fact",
        "X's DM with the agent does carry the DM fact, and Y never sees it",
    ),
    (
        "no_cross_channel_text",
        "for every member and channel, context holds no canary from another channel (ADR-0196 D6-4: except the invoker's own 1:1 agent DM, where their readable channels apply)",
    ),
    (
        "public_control_visible",
        "Z sees the public #general controls (a backend returning nothing must not pass)",
    ),
];

fn texts(items: &[Recalled]) -> String {
    items
        .iter()
        .map(|i| i.text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn all_surfaces(b: &dyn MemoryBackend, viewer: Who, token: &str) -> R<String> {
    let mut out = String::new();
    for s in [
        Surface::Browser,
        Surface::Search(token.to_string()),
        Surface::Receipts,
    ] {
        out.push_str(&texts(&b.recall(viewer, &s)?));
        out.push('\n');
    }
    Ok(out)
}

fn fresh(factory: Factory<'_>, corpus: &Corpus) -> R<Box<dyn MemoryBackend>> {
    let mut b = factory();
    b.ingest(corpus)?;
    Ok(b)
}

/// Returns the violated case ids with a reason. Empty = permission leak count 0.
pub fn leak_violations(factory: Factory<'_>, corpus: &Corpus) -> R<Vec<String>> {
    let mut v = Vec::new();
    let restricted: Vec<_> = corpus
        .canaries
        .iter()
        .filter(|c| c.channel != Channel::General)
        .collect();
    let hr: Vec<_> = restricted
        .iter()
        .filter(|c| c.channel == Channel::Hr)
        .collect();
    let dm: Vec<_> = restricted
        .iter()
        .filter(|c| c.channel == Channel::DmXAgent)
        .collect();

    // 1 + 2 + 8
    let b = fresh(factory, corpus)?;
    for c in &hr {
        if all_surfaces(&*b, Who::Z, &c.token)?.contains(&c.token) {
            v.push(format!("z_sees_no_hr: Z saw {}", c.token));
        }
        if !all_surfaces(&*b, Who::X, &c.token)?.contains(&c.token) {
            v.push(format!("x_sees_hr: X cannot see {}", c.token));
        }
    }
    for c in &corpus.controls {
        if !all_surfaces(&*b, Who::Z, &c.token)?.contains(&c.token) {
            v.push(format!("public_control_visible: Z cannot see {}", c.token));
        }
    }

    // 3
    let mut b = fresh(factory, corpus)?;
    b.apply(&Mutation::Leave(Who::X, Channel::Hr))?;
    for c in &hr {
        if all_surfaces(&*b, Who::X, &c.token)?.contains(&c.token) {
            v.push(format!("left_member_sees_none: X still saw {}", c.token));
        }
        // ...nor does an agent answer to X: not even in X's own DM, where the union of what X can
        // read applies (ADR-0196 D6-4) — a channel X has left is no longer one X can read.
        if b.agent_context(Who::X, Channel::DmXAgent)?
            .contains(&c.token)
        {
            v.push(format!(
                "left_member_sees_none: X's DM context still carried {}",
                c.token
            ));
        }
    }

    // 4
    for c in &hr {
        let mut b = fresh(factory, corpus)?;
        b.apply(&Mutation::Delete(c.message_key.clone()))?;
        for viewer in [Who::X, Who::Y] {
            if all_surfaces(&*b, viewer, &c.token)?.contains(&c.token) {
                v.push(format!(
                    "deleted_source_hidden: {viewer:?} saw deleted {}",
                    c.token
                ));
            }
        }
        if agent_texts(&*b)?.contains(&c.token) {
            v.push(format!(
                "deleted_source_hidden: agent context kept {}",
                c.token
            ));
        }
    }

    // 5
    let b = fresh(factory, corpus)?;
    let ctx = b.agent_context(Who::X, Channel::General)?;
    for c in &restricted {
        if ctx.contains(&c.token) {
            v.push(format!(
                "general_call_excludes_hr: {} reached the #general context",
                c.token
            ));
        }
    }

    // 6
    for c in &dm {
        if !b
            .agent_context(Who::X, Channel::DmXAgent)?
            .contains(&c.token)
        {
            v.push(format!(
                "dm_context_has_dm_fact: DM context misses {}",
                c.token
            ));
        }
        if all_surfaces(&*b, Who::Y, &c.token)?.contains(&c.token) {
            v.push(format!("dm_context_has_dm_fact: Y saw {}", c.token));
        }
    }

    // 7: the grep over EVERYTHING a run could receive (summary bypass included).
    for invoker in Who::HUMANS {
        for channel in Channel::ALL {
            if !channel.members().contains(&invoker) {
                continue;
            }
            let ctx = b.agent_context(invoker, channel)?;
            for c in corpus.canaries.iter().chain(corpus.controls.iter()) {
                // ADR-0196 D6-4 (accepted after this kit was written): in the invoker's own
                // 1:1 DM with the agent the answer is seen by that person alone, so the union of
                // what they can read applies. Every canary here sits in a channel the DM's
                // human belongs to; a group channel gets no such exemption.
                if channel == Channel::DmXAgent && c.channel.members().contains(&invoker) {
                    continue;
                }
                if c.channel != channel && ctx.contains(&c.token) {
                    v.push(format!(
                        "no_cross_channel_text: {invoker:?} in {} got {} from {}",
                        channel.label(),
                        c.token,
                        c.channel.label()
                    ));
                }
            }
        }
    }
    Ok(v)
}

fn agent_texts(b: &dyn MemoryBackend) -> R<String> {
    let mut out = String::new();
    for who in Who::HUMANS {
        for ch in Channel::ALL {
            if ch.members().contains(&who) {
                out.push_str(&b.agent_context(who, ch)?);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
pub struct DecisionScore {
    pub current_correct: usize,
    pub current_total: usize,
    pub closed_ok: usize,
    pub closed_total: usize,
}
impl DecisionScore {
    pub fn passes(&self) -> bool {
        self.current_correct as f64 >= 0.9 * self.current_total as f64
            && self.closed_ok == self.closed_total
    }
}

/// Plan §8.2: current-value accuracy over the 30 queries and 100 percent of the
/// 10 changed decisions keeping their old value with a closed `valid_to`.
pub fn decision_score(b: &dyn MemoryBackend, corpus: &Corpus) -> R<DecisionScore> {
    let mut s = DecisionScore {
        current_correct: 0,
        current_total: 0,
        closed_ok: 0,
        closed_total: 0,
    };
    for q in &corpus.queries {
        s.current_total += 1;
        if let Some(a) = b.current_value(Who::A, &q.topic)? {
            if a.value == q.expected {
                s.current_correct += 1;
            }
        }
    }
    for d in corpus.decisions.iter().filter(|d| d.changed()) {
        s.closed_total += 1;
        let t = b.timeline(Who::A, &d.topic)?;
        let ok = t.len() == d.values.len()
            && t.iter()
                .zip(&d.values)
                .enumerate()
                .all(|(i, (p, (key, val, minute)))| {
                    let closed = if i + 1 < d.values.len() {
                        p.valid_to_minute == Some(d.values[i + 1].2)
                    } else {
                        p.valid_to_minute.is_none()
                    };
                    &p.value == val
                        && p.valid_from_minute == *minute
                        && closed
                        && p.evidence.contains(key)
                });
        if ok {
            s.closed_ok += 1;
        }
    }
    Ok(s)
}

/// Promises and owners: fraction recalled with the right owner and evidence.
pub fn commitment_recall(b: &dyn MemoryBackend, corpus: &Corpus) -> R<f64> {
    let got = b.commitments(Who::A)?;
    let hit = corpus
        .commitments
        .iter()
        .filter(|c| {
            got.iter().any(|g| {
                g.owner == c.owner && g.task == c.task && g.evidence.contains(&c.message_key)
            })
        })
        .count();
    Ok(hit as f64 / corpus.commitments.len() as f64)
}

/// Collection policy + provenance existence (plan §8.3, first half; whether the
/// evidence *supports* the claim is judged by an LLM/human sample later).
pub fn policy_and_provenance_violations(b: &dyn MemoryBackend, corpus: &Corpus) -> R<Vec<String>> {
    use super::corpus::Class;
    let mut v = Vec::new();
    for item in b.stored()? {
        for secret in corpus.secrets.iter().map(|(_, s)| s) {
            if item.text.contains(secret.as_str()) {
                v.push("stored a secret-shaped string".to_string());
            }
        }
        if item.evidence.is_empty() {
            v.push(format!("item without evidence: {}", item.text));
        }
        for e in &item.evidence {
            match corpus.msg(e) {
                None => v.push(format!("evidence {e} does not exist")),
                Some(m) if matches!(m.class, Class::Secret | Class::Bot | Class::AgentReply) => {
                    v.push(format!("evidence {e} is a {} message", m.class.label()))
                }
                Some(_) => {}
            }
        }
    }
    Ok(v)
}
