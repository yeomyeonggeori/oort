//! Single-job assembly subprocess (ADR-0218 G3.5). Binary stdin only; no URL/path/env/DB input.
//! Same resource limits as `momo-expression-decoder`.
#[cfg(target_os = "linux")]
use momo_expressions::media::ALLOCATION_LIMIT;

fn main() {
    // Linux deployment: AS also bounds codec-internal allocations not covered by image::Limits.
    // macOS has no effective AS cap; hard-memory runtime evidence must be measured on Linux.
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
    std::process::exit(momo_expressions::assemble::child_main());
}
