//! Single-job codec subprocess. Binary stdin only; no URL/path/env/DB input.
#[cfg(target_os = "linux")]
use momo_expressions::media::ALLOCATION_LIMIT;
use momo_expressions::{
    media::{self, Rejected},
    INPUT_BYTES,
};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn main() {
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
    let result = (|| {
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(INPUT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Rejected::Invalid)?;
        if bytes.len() > INPUT_BYTES {
            return Err(Rejected::TooLarge);
        }
        media::decode(&bytes, Instant::now() + Duration::from_secs(10))
    })();
    let output = serde_json::to_vec(&result).unwrap_or_default();
    let _ = std::io::stdout().write_all(&output);
}
