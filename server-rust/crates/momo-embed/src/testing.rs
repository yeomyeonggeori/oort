//! Deterministic offline embedders for tests (unit, PG conformance, eval kit). Not a model:
//! a hashed bag of *concepts*. Words listed as synonyms share a concept, so a paraphrase that
//! shares no surface word with the stored text still lands close to it — the property real
//! sentence embeddings give and keyword search cannot.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use crate::{normalise, EmbedError, TextEmbedder, DIMS};

/// What the mock does when asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Works,
    /// Every call fails (model file corrupt, out of memory, …).
    Fails,
    /// Every call sleeps this long first (a saturated CPU).
    Slow(Duration),
    /// Queries come back as the zero vector (a broken model): the database refuses it.
    ZeroQuery,
}

pub struct MockEmbedder {
    concepts: HashMap<String, String>,
    mode: Mode,
    calls: AtomicUsize,
    id: String,
}

impl MockEmbedder {
    /// `synonyms`: groups of words that mean the same thing. Everything else is its own concept.
    pub fn new(synonyms: &[&[&str]]) -> MockEmbedder {
        let mut concepts = HashMap::new();
        for group in synonyms {
            if let Some(first) = group.first() {
                for word in *group {
                    concepts.insert(word.to_lowercase(), first.to_lowercase());
                }
            }
        }
        MockEmbedder {
            concepts,
            mode: Mode::Works,
            calls: AtomicUsize::new(0),
            id: "mock-concepts:v1".to_string(),
        }
    }

    pub fn with_mode(mut self, mode: Mode) -> MockEmbedder {
        self.mode = mode;
        self
    }

    pub fn with_model_id(mut self, id: &str) -> MockEmbedder {
        self.id = id.to_string();
        self
    }

    /// Calls made so far (a slow/failing embedder still counts).
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn gate(&self) -> Result<(), EmbedError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.mode {
            Mode::Works | Mode::ZeroQuery => Ok(()),
            Mode::Fails => Err(EmbedError::Infer(
                "mock embedder is set to fail".to_string(),
            )),
            Mode::Slow(d) => {
                std::thread::sleep(d);
                Ok(())
            }
        }
    }

    fn one(&self, text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; DIMS];
        for word in text
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
        {
            let concept = self.concepts.get(word).map(String::as_str).unwrap_or(word);
            // Three hashed slots per concept keep two unrelated words from colliding on one.
            for salt in 0..3u64 {
                let mut h: u64 = 0xcbf29ce484222325 ^ salt.wrapping_mul(0x9e3779b97f4a7c15);
                for b in concept.bytes() {
                    h ^= u64::from(b);
                    h = h.wrapping_mul(0x100000001b3);
                }
                v[(h % DIMS as u64) as usize] += 1.0;
            }
        }
        normalise(&mut v);
        v
    }
}

impl TextEmbedder for MockEmbedder {
    fn model_id(&self) -> &str {
        &self.id
    }

    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        self.gate()?;
        if self.mode == Mode::ZeroQuery {
            return Ok(vec![0.0; DIMS]);
        }
        Ok(self.one(text))
    }

    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.gate()?;
        Ok(texts.iter().map(|t| self.one(t)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cos(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn synonyms_land_close_and_strangers_do_not() {
        let m = MockEmbedder::new(&[&["배포", "릴리스", "release"], &["연기", "미루기"]]);
        let q = m.embed_query("배포 미루기").unwrap();
        let near = &m.embed_passages(&["릴리스 연기 결정".to_string()]).unwrap()[0];
        let far = &m.embed_passages(&["점심 메뉴는 김밥".to_string()]).unwrap()[0];
        assert!(cos(&q, near) > 0.8, "{}", cos(&q, near));
        assert!(cos(&q, far) < 0.2, "{}", cos(&q, far));
    }

    #[test]
    fn failing_and_slow_modes_are_counted() {
        let m = MockEmbedder::new(&[]).with_mode(Mode::Fails);
        assert!(m.embed_query("x").is_err());
        assert_eq!(m.calls(), 1);
    }
}
