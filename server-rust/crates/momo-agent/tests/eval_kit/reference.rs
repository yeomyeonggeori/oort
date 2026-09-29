//! Reference model of the criteria — NOT the product.
//!
//! It exists to prove the checkers can both pass and fail: with no flaws it must
//! satisfy every checker; each [`Flaws`] switch models one real bug class
//! (a dropped RLS clause, a dropped audience predicate, ...) and must make the
//! matching checker fail. That is the sabotage evidence for the harness itself.

use std::collections::HashSet;

use super::corpus::{Channel, Class, Corpus, Who};
use super::harness::*;

#[derive(Clone, Copy, Default)]
pub struct Flaws {
    pub ignore_membership: bool,
    pub ignore_left_at: bool,
    pub ignore_deleted: bool,
    pub ignore_audience: bool,
    pub stale_current: bool,
    pub open_ended_timeline: bool,
    pub store_secrets: bool,
    pub bot_as_evidence: bool,
}

#[derive(Default)]
pub struct Reference {
    flaws: Flaws,
    corpus: Option<Corpus>,
    left: HashSet<(Who, Channel)>,
    deleted: HashSet<String>,
}

impl Reference {
    pub fn new(flaws: Flaws) -> Self {
        Reference {
            flaws,
            ..Default::default()
        }
    }
    fn corpus(&self) -> R<&Corpus> {
        self.corpus
            .as_ref()
            .ok_or(EvalError::NotImplemented("ingest first"))
    }
    fn can_read(&self, viewer: Who, ch: Channel) -> bool {
        if self.flaws.ignore_membership {
            return true;
        }
        ch.members().contains(&viewer)
            && (self.flaws.ignore_left_at || !self.left.contains(&(viewer, ch)))
    }
    fn alive(&self, key: &str) -> bool {
        self.flaws.ignore_deleted || !self.deleted.contains(key)
    }
    /// Factual items: decisions, commitments, canaries, controls.
    fn items(&self) -> R<Vec<(Channel, Recalled)>> {
        let c = self.corpus()?;
        Ok(c.messages
            .iter()
            .filter(|m| {
                matches!(
                    m.class,
                    Class::Decision
                        | Class::DecisionChange
                        | Class::Commitment
                        | Class::LeakCanary
                        | Class::Control
                ) || (self.flaws.store_secrets && m.class == Class::Secret)
                    || (self.flaws.bot_as_evidence && m.class == Class::Bot)
            })
            .map(|m| {
                (
                    m.channel,
                    Recalled {
                        text: m.body.clone(),
                        evidence: vec![m.key.clone()],
                    },
                )
            })
            .collect())
    }
}

impl MemoryBackend for Reference {
    fn ingest(&mut self, corpus: &Corpus) -> R<()> {
        self.corpus = Some(corpus.clone());
        Ok(())
    }
    fn apply(&mut self, m: &Mutation) -> R<()> {
        match m {
            Mutation::Leave(w, c) => {
                self.left.insert((*w, *c));
            }
            Mutation::Delete(k) => {
                self.deleted.insert(k.clone());
            }
        }
        Ok(())
    }
    fn recall(&self, viewer: Who, surface: &Surface) -> R<Vec<Recalled>> {
        Ok(self
            .items()?
            .into_iter()
            .filter(|(ch, r)| {
                self.can_read(viewer, *ch) && r.evidence.iter().all(|k| self.alive(k))
            })
            .filter(|(_, r)| match surface {
                Surface::Search(q) => r.text.contains(q.as_str()),
                _ => true,
            })
            .map(|(_, r)| r)
            .collect())
    }
    fn agent_context(&self, invoker: Who, channel: Channel) -> R<String> {
        let mut out = String::new();
        for (ch, r) in self.items()? {
            let in_scope = if self.flaws.ignore_audience {
                self.can_read(invoker, ch)
            } else {
                // Audience narrowing (plan §4.6): only the channel the answer lands in.
                ch == channel && self.can_read(invoker, ch)
            };
            if in_scope && r.evidence.iter().all(|k| self.alive(k)) {
                out.push_str(&r.text);
                out.push('\n');
            }
        }
        Ok(out)
    }
    fn stored(&self) -> R<Vec<Recalled>> {
        Ok(self.items()?.into_iter().map(|(_, r)| r).collect())
    }
    fn current_value(&self, viewer: Who, topic: &str) -> R<Option<Answer>> {
        let c = self.corpus()?;
        if !self.can_read(viewer, Channel::General) {
            return Ok(None);
        }
        Ok(c.decisions.iter().find(|d| d.topic == topic).map(|d| {
            let (k, v, _) = if self.flaws.stale_current {
                &d.values[0]
            } else {
                d.values.last().unwrap()
            };
            Answer {
                value: v.clone(),
                evidence: vec![k.clone()],
            }
        }))
    }
    fn timeline(&self, _viewer: Who, topic: &str) -> R<Vec<Period>> {
        let c = self.corpus()?;
        let Some(d) = c.decisions.iter().find(|d| d.topic == topic) else {
            return Ok(vec![]);
        };
        Ok(d.values
            .iter()
            .enumerate()
            .map(|(i, (k, v, m))| Period {
                value: v.clone(),
                valid_from_minute: *m,
                valid_to_minute: if self.flaws.open_ended_timeline {
                    None
                } else {
                    d.values.get(i + 1).map(|n| n.2)
                },
                evidence: vec![k.clone()],
            })
            .collect())
    }
    fn commitments(&self, _viewer: Who) -> R<Vec<Commitment>> {
        Ok(self
            .corpus()?
            .commitments
            .iter()
            .map(|c| Commitment {
                owner: c.owner,
                task: c.task.clone(),
                evidence: vec![c.message_key.clone()],
            })
            .collect())
    }
}

/// Stand-in for "the product": every method is absent, so any checker run against
/// it must fail. Replace [`product_backend`] when M1 lands.
pub struct Unimplemented;
const NO: EvalError = EvalError::NotImplemented("MEM-M1..M3 memory backend");
impl MemoryBackend for Unimplemented {
    fn ingest(&mut self, _: &Corpus) -> R<()> {
        Err(NO)
    }
    fn apply(&mut self, _: &Mutation) -> R<()> {
        Err(NO)
    }
    fn recall(&self, _: Who, _: &Surface) -> R<Vec<Recalled>> {
        Err(NO)
    }
    fn agent_context(&self, _: Who, _: Channel) -> R<String> {
        Err(NO)
    }
    fn stored(&self) -> R<Vec<Recalled>> {
        Err(NO)
    }
    fn current_value(&self, _: Who, _: &str) -> R<Option<Answer>> {
        Err(NO)
    }
    fn timeline(&self, _: Who, _: &str) -> R<Vec<Period>> {
        Err(NO)
    }
    fn commitments(&self, _: Who) -> R<Vec<Commitment>> {
        Err(NO)
    }
}

/// A product adapter, registered by the suite that owns the runtime it needs (a database, a
/// worker). Kept out of this file so the offline `memory_eval` test binary stays dependency-free.
pub type ProductFactory = Box<dyn Fn() -> Box<dyn MemoryBackend> + Send + Sync>;
static PRODUCT: std::sync::OnceLock<ProductFactory> = std::sync::OnceLock::new();

/// Register the product adapter for this test process (first registration wins).
pub fn register_product_backend(factory: ProductFactory) {
    let _ = PRODUCT.set(factory);
}

/// THE seam: the registered product adapter, or [`Unimplemented`] when the running suite
/// registered none (so an absent implementation is RED, never a vacuous PASS).
///
/// #3168 (M2) registers the items path from `momo-agent-worker`'s
/// `tests/memory_eval_items_pg.rs`: the real worker sweep writes digests + items into Postgres and
/// the surfaces read them back through RLS. M3 fills the timeline / current-value methods.
pub fn product_backend() -> Box<dyn MemoryBackend> {
    match PRODUCT.get() {
        Some(factory) => factory(),
        None => Box::new(Unimplemented),
    }
}
