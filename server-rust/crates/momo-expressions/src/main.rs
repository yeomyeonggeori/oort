//! Single-job codec subprocess. Binary stdin only; no URL/path/env/DB input. Its arguments are a fixed
//! mode the parent chooses: none (the renditions of any picture), `--prepare` (a member's photo,
//! made ready to leave for an image model) or `--cutout` (a picture an image model drew, as a
//! cut-out); the renditions and the cut-out may be followed by `--wide` (the ADR-0218 §20 size
//! table, #6071). Anything else is refused before stdin is read.
#[cfg(target_os = "linux")]
use momo_expressions::media::ALLOCATION_LIMIT;
use momo_expressions::{
    media::{self, Rejected, RenditionTable},
    INPUT_BYTES,
};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (mode, table) = match args.as_slice() {
        [] => (None, RenditionTable::Legacy),
        ["--wide"] => (None, RenditionTable::Wide),
        ["--prepare"] => (Some("--prepare"), RenditionTable::Legacy),
        ["--cutout"] => (Some("--cutout"), RenditionTable::Legacy),
        ["--cutout", "--wide"] => (Some("--cutout"), RenditionTable::Wide),
        _ => std::process::exit(2),
    };
    // Linux deployment: AS also bounds codec-internal allocations not covered
    // by image::Limits (e.g. WebP Huffman tables). macOS has no effective AS
    // cap; hard-memory runtime evidence must be measured on Linux at stack QA.
    #[cfg(target_os = "linux")]
    for resource in [rlimit::Resource::AS, rlimit::Resource::DATA] {
        if resource.set(ALLOCATION_LIMIT, ALLOCATION_LIMIT).is_err() {
            std::process::exit(2);
        }
    }
    for (resource, limit) in [(rlimit::Resource::CPU, 10), (rlimit::Resource::CORE, 0)] {
        if resource.set(limit, limit).is_err() {
            std::process::exit(2);
        }
    }
    let output = (|| {
        let mut bytes = Vec::new();
        if std::io::stdin()
            .take(INPUT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return serde_json::to_vec(&Err::<(), _>(Rejected::Invalid));
        }
        if bytes.len() > INPUT_BYTES {
            return serde_json::to_vec(&Err::<(), _>(Rejected::TooLarge));
        }
        let end = Instant::now() + Duration::from_secs(10);
        match mode {
            Some("--prepare") => serde_json::to_vec(&media::prepare(&bytes, end)),
            Some("--cutout") => serde_json::to_vec(&media::decode_cutout_with(&bytes, end, table)),
            _ => serde_json::to_vec(&media::decode_with(&bytes, end, table)),
        }
    })()
    .unwrap_or_default();
    let _ = std::io::stdout().write_all(&output);
}
