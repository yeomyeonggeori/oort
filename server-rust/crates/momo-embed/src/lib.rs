//! Local sentence embedding for team-memory vector search (#3173, ADR-0196 D8 증보).
//!
//! One model: `intfloat/multilingual-e5-small` (MIT, 384 dimensions), int8-quantised ONNX,
//! run by ONNX Runtime inside the `momo-agent-worker` process. The model directory is supplied
//! by the operator/image (see `server-rust/Dockerfile`, stage `model-payload`); this crate never
//! downloads anything at run time and never phones home.
//!
//! ## Shape
//!
//! * [`TextEmbedder`] — the blocking contract the worker codes against. Tests use
//!   [`testing::MockEmbedder`] (deterministic, offline); production uses [`OnnxEmbedder`].
//! * e5 models expect a role prefix: `query: ` for the question, `passage: ` for what is stored.
//!   The prefix lives **here** so no caller can embed a stored item as a query by mistake.
//! * Vectors are L2-normalised on the way out, so cosine similarity is a dot product and the
//!   database's cosine distance (`<=>`) is `1 - similarity`.
//! * [`vector_literal`] renders a vector in pgvector's text form (`[0.1,0.2,…]`), which the SQL
//!   functions cast — the worker needs no pgvector binding crate.

use std::path::Path;
use std::sync::Mutex;

use fastembed::{
    InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel,
};

pub mod testing;

/// Output dimensions of the model (the `vector(384)` column of `mem_item_embedding`).
pub const DIMS: usize = 384;

/// Identity of the embedding space, stored beside every vector (`mem_item_embedding.model`).
/// A different value means "re-embed": the worker's backfill fills the new model in parallel
/// and search only reads rows of the model it queries with. Bump the suffix if the pooling,
/// prefixes or preprocessing here ever change, not only when the weights do.
pub const MODEL_ID: &str = "intfloat/multilingual-e5-small@614241f6:int8:v1";

/// Files the model directory must hold (see the Dockerfile's `model-payload` stage).
pub const ONNX_FILE: &str = "model_qint8.onnx";
pub const TOKENIZER_FILES: [&str; 4] = [
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
];

const QUERY_PREFIX: &str = "query: ";
const PASSAGE_PREFIX: &str = "passage: ";
/// Longest text handed to the tokenizer (chars). Items are <= 600 and queries <= 400 by their
/// own SQL/DB limits; this keeps a stray oversized input from costing a 512-token forward pass.
const MAX_TEXT_CHARS: usize = 1_000;

#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error("embedding model unavailable: {0}")]
    Load(String),
    #[error("embedding failed: {0}")]
    Infer(String),
    #[error("model returned {got} dimensions, expected {DIMS}")]
    Dimensions { got: usize },
    #[error("model returned {got} vectors for {want} texts")]
    Count { got: usize, want: usize },
}

/// A blocking text embedder. Implementations may take tens of milliseconds; async callers run
/// them on the blocking pool under their own deadline.
pub trait TextEmbedder: Send + Sync {
    /// The embedding space this embedder writes ([`MODEL_ID`] for the real model).
    fn model_id(&self) -> &str;
    /// A search question.
    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedError>;
    /// Stored items, in order. One vector per text.
    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError>;
}

/// pgvector text form of a vector: `[0.1,0.2,…]`. Non-finite components are refused (pgvector
/// rejects them too; failing here keeps the error next to its cause).
pub fn vector_literal(v: &[f32]) -> Result<String, EmbedError> {
    if v.len() != DIMS {
        return Err(EmbedError::Dimensions { got: v.len() });
    }
    let mut out = String::with_capacity(DIMS * 10 + 2);
    out.push('[');
    for (i, x) in v.iter().enumerate() {
        if !x.is_finite() {
            return Err(EmbedError::Infer("non-finite component".to_string()));
        }
        if i > 0 {
            out.push(',');
        }
        out.push_str(&x.to_string());
    }
    out.push(']');
    Ok(out)
}

/// L2-normalise in place. A zero vector stays zero (the database refuses it).
pub fn normalise(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT_CHARS).collect()
}

/// `multilingual-e5-small` int8 on ONNX Runtime (CPU).
pub struct OnnxEmbedder {
    model: Mutex<TextEmbedding>,
}

impl OnnxEmbedder {
    /// Load the model files in `dir` (see [`ONNX_FILE`], [`TOKENIZER_FILES`]).
    /// `intra_threads` caps ONNX Runtime's CPU threads (`None` = all cores); the worker uses a
    /// small number so embedding never starves the reply path.
    pub fn load(dir: &Path, intra_threads: Option<usize>) -> Result<OnnxEmbedder, EmbedError> {
        let read = |name: &str| {
            std::fs::read(dir.join(name))
                .map_err(|e| EmbedError::Load(format!("{}: {e}", dir.join(name).display())))
        };
        let onnx = read(ONNX_FILE)?;
        let files = TokenizerFiles {
            tokenizer_file: read(TOKENIZER_FILES[0])?,
            config_file: read(TOKENIZER_FILES[1])?,
            special_tokens_map_file: read(TOKENIZER_FILES[2])?,
            tokenizer_config_file: read(TOKENIZER_FILES[3])?,
        };
        let model = UserDefinedEmbeddingModel::new(onnx, files).with_pooling(Pooling::Mean);
        let mut options = InitOptionsUserDefined::default();
        options.intra_threads = intra_threads;
        let model = TextEmbedding::try_new_from_user_defined(model, options)
            .map_err(|e| EmbedError::Load(e.to_string()))?;
        Ok(OnnxEmbedder {
            model: Mutex::new(model),
        })
    }

    fn run(&self, prefixed: Vec<String>) -> Result<Vec<Vec<f32>>, EmbedError> {
        let want = prefixed.len();
        let mut model = self
            .model
            .lock()
            .map_err(|_| EmbedError::Infer("embedder lock poisoned".to_string()))?;
        let mut out = model
            .embed(prefixed, Some(16))
            .map_err(|e| EmbedError::Infer(e.to_string()))?;
        if out.len() != want {
            return Err(EmbedError::Count {
                got: out.len(),
                want,
            });
        }
        for v in &mut out {
            if v.len() != DIMS {
                return Err(EmbedError::Dimensions { got: v.len() });
            }
            normalise(v);
        }
        Ok(out)
    }
}

impl TextEmbedder for OnnxEmbedder {
    fn model_id(&self) -> &str {
        MODEL_ID
    }

    fn embed_query(&self, text: &str) -> Result<Vec<f32>, EmbedError> {
        let mut out = self.run(vec![format!("{QUERY_PREFIX}{}", clip(text))])?;
        Ok(out.remove(0))
    }

    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        self.run(
            texts
                .iter()
                .map(|t| format!("{PASSAGE_PREFIX}{}", clip(t)))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vector_literal_is_pgvector_text_and_refuses_bad_input() {
        let mut v = vec![0.0f32; DIMS];
        v[0] = 0.5;
        v[1] = -0.25;
        let lit = vector_literal(&v).unwrap();
        assert!(lit.starts_with("[0.5,-0.25,0,"));
        assert!(lit.ends_with(",0]"));
        assert_eq!(lit.matches(',').count(), DIMS - 1);
        assert!(matches!(
            vector_literal(&v[..10]),
            Err(EmbedError::Dimensions { got: 10 })
        ));
        v[3] = f32::NAN;
        assert!(vector_literal(&v).is_err());
    }

    #[test]
    fn normalise_makes_unit_length_and_keeps_zero() {
        let mut v = vec![3.0, 4.0];
        normalise(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        let mut z = vec![0.0, 0.0];
        normalise(&mut z);
        assert_eq!(z, vec![0.0, 0.0]);
    }

    #[test]
    fn loading_a_missing_directory_is_a_load_error_not_a_panic() {
        let err = OnnxEmbedder::load(Path::new("/nonexistent/momo-models"), None)
            .err()
            .expect("must fail");
        assert!(matches!(err, EmbedError::Load(_)), "{err}");
    }
}
