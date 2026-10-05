//! ADR-0197 M4 (#3511) — the blind relay through the real routes. See `Cargo.toml` for what is real.
//!
//! `#[ignore]` — needs an isolated PostgreSQL 18 (`DATABASE_URL` + `PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD`):
//!
//! ```text
//! cargo test -p momo-box-e2e --test relay_pg -- --ignored --test-threads=1
//! ```

use std::time::Duration;

use momo_blind_pty::session::FrameKind;
use momo_box_e2e::bench::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs an isolated PostgreSQL 18 (3511)"]
async fn an_owner_types_in_the_box_and_reads_the_output_through_the_real_relay() {
    let bench = Bench::up(BenchOptions::default()).await;
    let client = bench.pinned_client(&bench.owner_device).await;
    let mut conn = bench
        .attach(&client, &bench.owner_device)
        .await
        .expect("the owner attaches");
    conn.open_terminal(80, 24).await.expect("open the terminal");
    conn.type_bytes(b"hello-from-the-owner\n").await.expect("type");
    let seen = conn
        .read_until(Duration::from_secs(10), |got| {
            String::from_utf8_lossy(got).contains("hello-from-the-owner")
        })
        .await
        .expect("the PTY's echo comes back");
    assert!(String::from_utf8_lossy(&seen).contains("hello-from-the-owner"));
    conn.send(FrameKind::Close, &[]).await.ok();
}
