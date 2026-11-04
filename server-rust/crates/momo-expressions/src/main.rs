//! Single-job codec subprocess. Binary stdin only; no URL/path/env/DB input. The one argument it
//! takes is a fixed mode the parent chooses: none (the renditions of any picture), `--prepare`
//! (a member's photo, made ready to leave for an image model) or `--cutout` (a picture an image
//! model drew, as a cut-out). Anything else is refused before stdin is read.
#[cfg(target_os = "linux")]
use momo_expressions::media::ALLOCATION_LIMIT;
use momo_expressions::{
    media::{self, Rejected},
    INPUT_BYTES,
};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn main() {
    let mode = std::env::args().nth(1);
    if std::env::args().count() > 2
        || !matches!(mode.as_deref(), None | Some("--prepare" | "--cutout"))
    {
        std::process::exit(2);
    }
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
        match mode.as_deref() {
            Some("--prepare") => serde_json::to_vec(&media::prepare(&bytes, end)),
            Some("--cutout") => serde_json::to_vec(&media::decode_cutout(&bytes, end)),
            _ => serde_json::to_vec(&media::decode(&bytes, end)),
        }
    })()
    .unwrap_or_default();
    let _ = std::io::stdout().write_all(&output);
}
