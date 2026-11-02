//! The local archive's read memory does not follow the object's size
//! (ADR-0151 증보 5 D3 「메모리」, #4671).
//!
//! Four 300 MiB objects are read at the same time by consumers that throw every
//! byte away, and the process's resident set may grow by at most 64 MiB while they
//! do. The old `file_content` held a whole object in memory per reader (and read it
//! under the archive lock), which is over a gigabyte for this scenario; a range
//! read holds one 256 KiB chunk per reader.
//!
//! **Linux only** (`/proc/self/status`), and **the only test in this binary**: a
//! sibling test's allocations would count against the bound, which is why this is
//! an integration test and not a unit test of the crate. The objects are sparse
//! files, so nothing is written to disk and the holes read back as zeros.
//!
//! Run it alone, as the stack verification does:
//!
//! ```text
//! cargo test -p momo-drive --test local_read_memory -- --nocapture
//! ```

#![cfg(target_os = "linux")]

use std::fs::OpenOptions;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use momo_drive::{ByteRange, DriveArchive, LocalDriveArchive};

const OBJECT_BYTES: u64 = 300 * 1024 * 1024;
const READERS: usize = 4;
const GROWTH_BOUND_BYTES: u64 = 64 * 1024 * 1024;

/// Resident set size of this process, in bytes.
fn resident_bytes() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").expect("/proc/self/status");
    let line = status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))
        .expect("a VmRSS line");
    let kib: u64 = line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .expect("VmRSS in kB");
    kib * 1024
}

/// Samples the resident set from a thread of its own (so a busy runtime cannot
/// starve it) every couple of milliseconds and keeps the highest value.
struct PeakSampler {
    peak: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PeakSampler {
    fn start() -> PeakSampler {
        let peak = Arc::new(AtomicU64::new(resident_bytes()));
        let stop = Arc::new(AtomicBool::new(false));
        let (peak_in, stop_in) = (peak.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stop_in.load(Ordering::Relaxed) {
                peak_in.fetch_max(resident_bytes(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(2));
            }
            peak_in.fetch_max(resident_bytes(), Ordering::Relaxed);
        });
        PeakSampler {
            peak,
            stop,
            thread: Some(thread),
        }
    }

    fn finish(mut self) -> u64 {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("the sampler thread");
        }
        self.peak.load(Ordering::Relaxed)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_local_read_is_flat_in_memory() {
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-memory-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let archive =
        LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("local archive");

    // Four 300 MiB sparse objects, laid out the way the archive itself lays them
    // out: `objects/<id>` and `objects/<id>.meta`.
    let mut ids = Vec::new();
    for _ in 0..READERS {
        let id = format!("local-{}", uuid::Uuid::new_v4());
        let object = dir.join("objects").join(&id);
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&object)
            .expect("create the object")
            .set_len(OBJECT_BYTES)
            .expect("make it sparse");
        std::fs::write(
            dir.join("objects").join(format!("{id}.meta")),
            format!(
                r#"{{"name":"big.bin","mime":"application/octet-stream","size_bytes":{OBJECT_BYTES}}}"#
            ),
        )
        .expect("its metadata");
        ids.push(id);
    }
    let ceiling = OBJECT_BYTES as i64;
    let whole = ByteRange::new(0, OBJECT_BYTES - 1).expect("the whole object");

    // The instrument can see a leak: holding 128 MiB shows up as at least 100 MiB
    // of growth. Without this control a sampler that read the wrong thing would
    // report "flat" for everything.
    {
        let before = resident_bytes();
        let sampler = PeakSampler::start();
        let held = vec![1u8; 128 * 1024 * 1024];
        std::thread::sleep(Duration::from_millis(50));
        let peak = sampler.finish();
        assert!(
            peak.saturating_sub(before) >= 100 * 1024 * 1024,
            "the sampler did not see 128 MiB held (grew {} bytes)",
            peak.saturating_sub(before)
        );
        drop(held);
    }

    // Warm up what is allocated once per process (the runtime's threads, the
    // blocking pool, the first chunk buffers) so the baseline is the steady state.
    let warm = archive
        .file_range(
            &ids[0],
            ByteRange::new(0, 1_048_575).expect("1 MiB"),
            ceiling,
        )
        .await
        .expect("warm-up range");
    let mut warm_body = warm.body;
    while warm_body.next().await.is_some() {}
    tokio::time::sleep(Duration::from_millis(100)).await;

    let baseline = resident_bytes();
    let sampler = PeakSampler::start();
    // All four reads are opened **before** any is drained, so an implementation
    // that buffers an object holds all four at once instead of getting by on how
    // quickly one consumer happens to finish. A streaming one holds a chunk each.
    let mut opened = Vec::new();
    for id in &ids {
        let content = archive
            .file_range(id, whole, ceiling)
            .await
            .expect("a range over the whole object");
        assert_eq!(content.total_size_bytes, OBJECT_BYTES as i64);
        opened.push(content);
    }
    let mut readers = Vec::new();
    for content in opened {
        readers.push(tokio::spawn(async move {
            let mut body = content.body;
            let mut read = 0u64;
            while let Some(chunk) = body.next().await {
                read += chunk.expect("a chunk").len() as u64;
            }
            read
        }));
    }
    for reader in readers {
        assert_eq!(
            reader.await.expect("a reader"),
            OBJECT_BYTES,
            "every reader got its whole object"
        );
    }
    let peak = sampler.finish();
    let growth = peak.saturating_sub(baseline);
    println!(
        "4 x 300 MiB read concurrently: baseline {} KiB, peak {} KiB, growth {} KiB (bound {} KiB)",
        baseline / 1024,
        peak / 1024,
        growth / 1024,
        GROWTH_BOUND_BYTES / 1024
    );
    assert!(
        growth <= GROWTH_BOUND_BYTES,
        "resident memory grew by {growth} bytes while four 300 MiB objects were read; \
         the bound is {GROWTH_BOUND_BYTES}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
