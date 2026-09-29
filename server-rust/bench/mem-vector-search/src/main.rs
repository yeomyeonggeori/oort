//! MEM-M3 (#3173) 임베딩 벤치. 사용:
//!   mem-embed <model> <cache_dir> <out_prefix> <docs.jsonl> [queries.jsonl]
//! 모델: e5-small | e5-base | minilm | bge-m3 | e5-large
//! 출력: <out_prefix>.docs.f32 (행 우선 f32 LE, L2 정규화 전), <out_prefix>.queries.f32, <out_prefix>.meta.json
use fastembed::{
    EmbeddingModel, InitOptionsUserDefined, Pooling, TextEmbedding, TextInitOptions, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use serde_json::json;
use std::io::Write;
use std::time::Instant;

fn read_texts(path: &str) -> (Vec<String>, Vec<String>) {
    let s = std::fs::read_to_string(path).expect("read input");
    let mut ids = Vec::new();
    let mut texts = Vec::new();
    for l in s.lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(l).expect("jsonl");
        ids.push(v["id"].as_str().unwrap().to_string());
        texts.push(v["text"].as_str().unwrap().to_string());
    }
    (ids, texts)
}

fn write_f32(path: &str, rows: &[Vec<f32>]) {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    for r in rows {
        for x in r {
            f.write_all(&x.to_le_bytes()).unwrap();
        }
    }
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 * p).ceil() as usize).clamp(1, v.len()) - 1]
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (name, cache, out, docs_path) = (&a[1], &a[2], &a[3], &a[4]);
    let q_path = a.get(5);
    // e5-small-q8: HF 저장소의 onnx/model_qint8_avx512_vnni.onnx(118 MB)를 「사용자 정의 모델」로 로드 — 벤더링/양자화 경로 측정.
    // 환경변수 Q8_ONNX(onnx 경로), TOK_DIR(tokenizer.json 등이 있는 스냅샷 디렉터리).
    let q8 = name == "e5-small-q8";
    let (model, qp, dp) = match name.as_str() {
        "e5-small-q8" => (EmbeddingModel::MultilingualE5Small, "query: ", "passage: "),
        "e5-small" => (EmbeddingModel::MultilingualE5Small, "query: ", "passage: "),
        "e5-base" => (EmbeddingModel::MultilingualE5Base, "query: ", "passage: "),
        "e5-large" => (EmbeddingModel::MultilingualE5Large, "query: ", "passage: "),
        "minilm" => (EmbeddingModel::ParaphraseMLMiniLML12V2, "", ""),
        "bge-m3" => (EmbeddingModel::BGEM3, "", ""),
        o => panic!("unknown model {o}"),
    };
    let t0 = Instant::now();
    let mut m = if q8 {
        let dir = std::env::var("TOK_DIR").expect("TOK_DIR");
        let rd = |f: &str| std::fs::read(format!("{dir}/{f}")).expect(f);
        let um = UserDefinedEmbeddingModel::new(
            std::fs::read(std::env::var("Q8_ONNX").expect("Q8_ONNX")).unwrap(),
            TokenizerFiles {
                tokenizer_file: rd("tokenizer.json"),
                config_file: rd("config.json"),
                special_tokens_map_file: rd("special_tokens_map.json"),
                tokenizer_config_file: rd("tokenizer_config.json"),
            },
        )
        .with_pooling(Pooling::Mean);
        TextEmbedding::try_new_from_user_defined(um, InitOptionsUserDefined::default()).expect("q8 model")
    } else {
        TextEmbedding::try_new(
            TextInitOptions::new(model)
                .with_cache_dir(cache.into())
                .with_show_download_progress(true),
        )
        .expect("model")
    };
    let load_s = t0.elapsed().as_secs_f64();
    let (_, docs) = read_texts(docs_path);
    let docs_p: Vec<String> = docs.iter().map(|t| format!("{dp}{t}")).collect();

    // 단건 지연(배치 1): 앞 100건. 첫 호출 워밍업 제외.
    let mut single = Vec::new();
    let _ = m.embed(vec![docs_p[0].clone()], Some(1)).unwrap();
    for t in docs_p.iter().take(100) {
        let s = Instant::now();
        let _ = m.embed(vec![t.clone()], Some(1)).unwrap();
        single.push(s.elapsed().as_secs_f64() * 1e3);
    }
    // 배치 처리량
    let s = Instant::now();
    let emb = m.embed(docs_p.clone(), Some(32)).unwrap();
    let batch_s = s.elapsed().as_secs_f64();
    write_f32(&format!("{out}.docs.f32"), &emb);
    let dim = emb[0].len();
    let mut meta = json!({
        "model": name, "dim": dim, "load_s": load_s, "docs": docs.len(),
        "batch32_docs_per_s": docs.len() as f64 / batch_s,
        "batch32_ms_per_doc": batch_s * 1e3 / docs.len() as f64,
        "single_doc_ms_p50": pct(&mut single.clone(), 0.5),
        "single_doc_ms_p95": pct(&mut single, 0.95),
    });
    if let Some(qp_path) = q_path {
        let (_, qs) = read_texts(qp_path);
        let qs_p: Vec<String> = qs.iter().map(|t| format!("{qp}{t}")).collect();
        let mut lat = Vec::new();
        let mut qe = Vec::new();
        for t in &qs_p {
            let s = Instant::now();
            let e = m.embed(vec![t.clone()], Some(1)).unwrap();
            lat.push(s.elapsed().as_secs_f64() * 1e3);
            qe.push(e[0].clone());
        }
        write_f32(&format!("{out}.queries.f32"), &qe);
        meta["query_ms_p50"] = json!(pct(&mut lat.clone(), 0.5));
        meta["query_ms_p95"] = json!(pct(&mut lat, 0.95));
        meta["queries"] = json!(qs.len());
    }
    std::fs::write(format!("{out}.meta.json"), serde_json::to_string_pretty(&meta).unwrap()).unwrap();
    println!("{meta}");
}
