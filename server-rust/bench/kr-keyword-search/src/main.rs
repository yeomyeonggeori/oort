//! JSONL(`{"id","text"}`) → JSONL(`{"id","tokens"}`) 토큰화. 모드: space | bigram | bigram_join | lindera.
//! stderr에 총 소요(µs/doc)를 남긴다. 사용: kr-tokenize <mode> < in.jsonl > out.jsonl
use std::io::{BufRead, Write};
use std::time::Instant;

fn is_hangul(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

/// 후보 1: 공백 낱말 + 한글 음절 bigram. 한글 낱말이 3음절 이상이면 낱말 전체도 낸다(2음절 낱말은 bigram=낱말).
/// 한글 1음절 낱말은 unigram. 영문·숫자 런은 소문자 통째 토큰.
fn bigram(text: &str, join_spaces: bool) -> Vec<String> {
    let mut out = Vec::new();
    let chunks: Vec<&str> = text.split_whitespace().collect();
    if join_spaces {
        // 띄어쓴 이웃 한글 낱말을 이어붙인 뒤 bigram도 추가: "팀 기억"에서 "팀기" 생성(붙여쓰기 질의 대응).
        emit_runs(&chunks.join(""), &mut out, true);
    }
    for c in chunks {
        emit_runs(c, &mut out, false);
    }
    out
}

fn emit_runs(word: &str, out: &mut Vec<String>, only_bigram_cross: bool) {
    let cs: Vec<char> = word.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if is_hangul(cs[i]) {
            let mut j = i;
            while j < cs.len() && is_hangul(cs[j]) {
                j += 1;
            }
            let run = &cs[i..j];
            if run.len() == 1 {
                if !only_bigram_cross {
                    out.push(run[0].to_string());
                }
            } else {
                if run.len() > 2 && !only_bigram_cross {
                    out.push(run.iter().collect());
                }
                for k in 0..run.len() - 1 {
                    out.push(run[k..k + 2].iter().collect());
                }
            }
            i = j;
        } else if cs[i].is_alphanumeric() {
            let mut j = i;
            while j < cs.len() && cs[j].is_alphanumeric() && !is_hangul(cs[j]) {
                j += 1;
            }
            if !only_bigram_cross {
                out.push(cs[i..j].iter().collect::<String>().to_lowercase());
            }
            i = j;
        } else {
            i += 1;
        }
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "bigram".into());
    let tokenizer = if mode == "lindera" {
        let dict =
            lindera::dictionary::load_dictionary("embedded://ko-dic").expect("embedded ko-dic");
        Some(lindera::segmenter::Segmenter::new(
            lindera::mode::Mode::Normal,
            dict,
            None,
        ))
    } else {
        None
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut w = std::io::BufWriter::new(stdout.lock());
    let mut n = 0u64;
    let mut tok_time = std::time::Duration::ZERO;
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let text = v["text"].as_str().unwrap();
        let t0 = Instant::now();
        let toks: Vec<String> = match mode.as_str() {
            "space" => text.split_whitespace().map(|s| s.to_lowercase()).collect(),
            "bigram" => bigram(text, false),
            "bigram_join" => bigram(text, true),
            "lindera" => lindera_tokens(tokenizer.as_ref().unwrap(), text),
            m => panic!("unknown mode {m}"),
        };
        tok_time += t0.elapsed();
        n += 1;
        writeln!(
            w,
            "{}",
            serde_json::json!({"id": v["id"], "tokens": toks.join(" ")})
        )
        .unwrap();
    }
    eprintln!(
        "mode={mode} docs={n} tokenize_us_per_doc={:.2}",
        tok_time.as_secs_f64() * 1e6 / n.max(1) as f64
    );
}

/// 후보 2: 형태소 분석 후 내용어만(일반·고유명사, 수사, 동사·형용사 어간, 어근, 외래어, 숫자, 미등록어).
/// 조사(J*)·어미(E*)·접사·기호는 버린다.
fn lindera_tokens(seg: &lindera::segmenter::Segmenter, text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for mut tok in seg.segment(std::borrow::Cow::Borrowed(text)).unwrap() {
        let surface = tok.surface.to_string();
        let pos = tok
            .details()
            .first()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let keep = pos.starts_with("NN")
            || pos == "NR"
            || pos.starts_with("VV")
            || pos.starts_with("VA")
            || pos == "XR"
            || pos == "SL"
            || pos == "SN"
            || pos == "UNKNOWN";
        if keep {
            out.push(surface.to_lowercase());
        }
    }
    out
}
