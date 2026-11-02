//! `DriveArchive::file_range` on every backend (ADR-0151 증보 5 D3, #4671).
//!
//! One object, one table of ranges, and every backend — the local volume, the
//! in-memory stub, Google (a recording stand-in on 127.0.0.1) and the trait's
//! default over a double that only knows `file_content` — must hand back the
//! same bytes and the same total. What is specific to one backend (the local
//! lock, chunking and `fsync` order; Google's `Range` forwarding and clocks) is
//! proved next to that backend; this file holds what they must **agree** on.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures::StreamExt;
use uuid::Uuid;

use super::*;
use crate::fake_google::{serve, Behavior};
use crate::google::GoogleDriveArchive;

/// Bigger than one local read chunk (256 KiB), so ranges cross chunk edges.
const OBJECT_LEN: usize = 600_000;

/// A pattern whose period (251) divides nothing in the table, so a read that
/// starts one byte early or late is a different byte.
fn object() -> Vec<u8> {
    (0..OBJECT_LEN).map(|index| (index % 251) as u8).collect()
}

fn range(start: u64, end: u64) -> ByteRange {
    ByteRange::new(start, end).expect("a well-formed range")
}

/// The table every backend answers: first byte, a short span, a span across the
/// 256 KiB read-chunk edge, the last byte, the middle, and the whole object.
fn table() -> Vec<ByteRange> {
    let last = OBJECT_LEN as u64 - 1;
    vec![
        range(0, 0),
        range(0, 9),
        range(5, 9),
        range(262_143, 262_144),
        range(100_000, 400_000),
        range(last, last),
        range(0, last),
    ]
}

async fn collect(content: DriveRangeContent) -> Vec<u8> {
    let mut body = content.body;
    let mut out = Vec::new();
    while let Some(chunk) = body.next().await {
        out.extend_from_slice(&chunk.expect("a chunk"));
    }
    out
}

struct DirGuard(PathBuf);

impl Drop for DirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(label: &str) -> (PathBuf, DirGuard) {
    let dir = std::env::temp_dir().join(format!(
        "oort-drive-range-{label}-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    (dir.clone(), DirGuard(dir))
}

/// Store `bytes` through the archive's own upload path, in 100 kB pieces.
async fn put(archive: &dyn DriveArchive, bytes: &[u8]) -> String {
    let session = archive
        .create_resumable_upload(
            Uuid::nil(),
            "range.bin",
            "application/octet-stream",
            bytes.len() as i64,
        )
        .await
        .expect("session");
    let token = session
        .upload_url
        .rsplit('/')
        .next()
        .expect("token")
        .to_string();
    let pieces: Vec<Result<Bytes, std::io::Error>> = bytes
        .chunks(100_000)
        .map(|piece| Ok(Bytes::copy_from_slice(piece)))
        .collect();
    archive
        .accept_stub_upload(
            &token,
            Some("application/octet-stream"),
            Some(bytes.len() as u64),
            futures::StreamExt::boxed(futures::stream::iter(pieces)),
        )
        .await
        .expect("upload");
    session.drive_file_id
}

/// A double that knows only `file_content` — what the 13 test doubles in the
/// workspace look like to the trait. Its `file_range` is the trait's default.
#[derive(Debug)]
struct ContentOnly(Vec<u8>);

#[async_trait::async_trait]
impl DriveArchive for ContentOnly {
    async fn create_resumable_upload(
        &self,
        _channel_id: Uuid,
        _name: &str,
        _mime: &str,
        _size_bytes: i64,
    ) -> Result<DriveUploadSession, DriveError> {
        Err(DriveError::Unavailable)
    }

    async fn file_metadata(&self, _file_id: &str) -> Result<DriveFile, DriveError> {
        Err(DriveError::Unavailable)
    }

    async fn file_content(
        &self,
        _file_id: &str,
        max_bytes: i64,
    ) -> Result<DriveContent, DriveError> {
        if self.0.len() as i64 > max_bytes {
            return Err(DriveError::ContentTooLarge);
        }
        // Three uneven pieces, so the default's skipping crosses piece edges.
        let cuts = [0, 7, 200_001, self.0.len()];
        let pieces: Vec<Result<Bytes, DriveError>> = cuts
            .windows(2)
            .map(|pair| Ok(Bytes::copy_from_slice(&self.0[pair[0]..pair[1]])))
            .collect();
        Ok(DriveContent {
            mime: "application/octet-stream".into(),
            size_bytes: self.0.len() as i64,
            body: futures::StreamExt::boxed(futures::stream::iter(pieces)),
        })
    }
}

#[test]
fn a_byte_range_is_two_checked_integers() {
    assert_eq!(ByteRange::new(5, 4), None, "inverted");
    assert_eq!(
        ByteRange::new(u64::MAX, u64::MAX),
        None,
        "past any file size"
    );
    assert_eq!(
        ByteRange::new(0, i64::MAX as u64),
        None,
        "a length that cannot be an i64 is not a range"
    );
    let widest = ByteRange::new(0, i64::MAX as u64 - 1).expect("the widest range");
    assert_eq!(widest.length(), i64::MAX as u64, "no overflow at the edge");
    let one = ByteRange::new(7, 7).expect("one byte");
    assert_eq!((one.start(), one.end(), one.length()), (7, 7, 1));
}

#[tokio::test]
async fn slicing_a_body_skips_before_and_stops_after_the_range() {
    let pieces = |sizes: &[usize]| -> BoxStream<'static, Result<Bytes, DriveError>> {
        let whole = object();
        let mut offset = 0;
        let mut out: Vec<Result<Bytes, DriveError>> = Vec::new();
        for size in sizes {
            out.push(Ok(Bytes::copy_from_slice(&whole[offset..offset + size])));
            offset += size;
        }
        futures::StreamExt::boxed(futures::stream::iter(out))
    };
    let whole = object();
    // The range starts and ends inside pieces, at piece edges, and across empty
    // pieces: every cut must land on the same bytes.
    for (sizes, start, end) in [
        (vec![10, 10, 10], 3u64, 25u64),
        (vec![10, 10, 10], 10, 19),
        (vec![10, 0, 10, 10], 10, 29),
        (vec![30], 0, 0),
        (vec![1, 1, 1, 1], 1, 2),
    ] {
        let sliced = slice_body(pieces(&sizes), range(start, end));
        let got = collect(DriveRangeContent {
            total_size_bytes: 30,
            body: sliced,
        })
        .await;
        assert_eq!(
            got,
            &whole[start as usize..=end as usize],
            "pieces {sizes:?}, range {start}-{end}"
        );
    }

    // A body that runs dry before the range does is an error item, never a short
    // success.
    let mut dry = slice_body(pieces(&[10, 10]), range(5, 24));
    let mut seen = 0usize;
    let mut failure = None;
    while let Some(item) = dry.next().await {
        match item {
            Ok(chunk) => seen += chunk.len(),
            Err(error) => failure = Some(error),
        }
    }
    assert_eq!(seen, 15, "what was there is delivered");
    assert_eq!(failure, Some(DriveError::UpstreamFailure));

    // A failure in the source is passed on as it is.
    let broken: BoxStream<'static, Result<Bytes, DriveError>> =
        futures::StreamExt::boxed(futures::stream::iter(vec![
            Ok(Bytes::from_static(b"abc")),
            Err(DriveError::AccessDenied),
        ]));
    let mut sliced = slice_body(broken, range(0, 9));
    assert_eq!(sliced.next().await, Some(Ok(Bytes::from_static(b"abc"))));
    assert_eq!(sliced.next().await, Some(Err(DriveError::AccessDenied)));
}

/// **Red proof (D3 백엔드).** The same object read through the local volume, the
/// stub, Google's stand-in and the trait default returns the same bytes for every
/// range in the table, and says the same total.
///
/// Make Google skip its `Range` (it would then be answered 200 and refused), make
/// the local archive seek to the wrong offset, or have the stub's slice end one
/// byte early, and the row for that backend goes red.
#[tokio::test]
async fn a_range_read_returns_only_those_bytes_on_every_backend() {
    let bytes = object();
    let (dir, _guard) = temp_dir("every-backend");
    let local = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("local");
    let local_id = put(&local, &bytes).await;
    let stub = StubDriveArchive::new("http://127.0.0.1:9");
    let stub_id = put(&stub, &bytes).await;
    let stand_in = serve(bytes.clone(), Behavior::default()).await;
    let google = GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(10));
    let content_only = ContentOnly(bytes.clone());

    let backends: Vec<(&str, &dyn DriveArchive, &str)> = vec![
        ("local", &local as &dyn DriveArchive, local_id.as_str()),
        ("stub", &stub as &dyn DriveArchive, stub_id.as_str()),
        (
            "google (stand-in)",
            &google as &dyn DriveArchive,
            "stand-in-file",
        ),
        (
            "the trait default",
            &content_only as &dyn DriveArchive,
            "any-id",
        ),
    ];
    for (name, archive, id) in backends {
        for asked in table() {
            let content = archive
                .file_range(id, asked, MAX_ATTACHMENT_BYTES)
                .await
                .unwrap_or_else(|error| panic!("{name} {asked:?}: {error}"));
            assert_eq!(
                content.total_size_bytes, OBJECT_LEN as i64,
                "{name} {asked:?}: the whole length, not the range's"
            );
            let got = collect(content).await;
            assert_eq!(
                got,
                &bytes[asked.start() as usize..=asked.end() as usize],
                "{name} {asked:?}: exactly those bytes"
            );
        }
    }
}

/// What every backend refuses for the same reasons: a range that is not inside
/// the object, and an object over the ceiling the caller passes.
#[tokio::test]
async fn every_backend_refuses_a_range_outside_the_object_and_an_object_over_the_ceiling() {
    let bytes = object();
    let (dir, _guard) = temp_dir("refusals");
    let local = LocalDriveArchive::open(dir.to_str(), "http://127.0.0.1:9").expect("local");
    let local_id = put(&local, &bytes).await;
    let stub = StubDriveArchive::new("http://127.0.0.1:9");
    let stub_id = put(&stub, &bytes).await;
    let stand_in = serve(bytes.clone(), Behavior::default()).await;
    let google = GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(10));
    let content_only = ContentOnly(bytes.clone());

    let backends: Vec<(&str, &dyn DriveArchive, &str)> = vec![
        ("local", &local as &dyn DriveArchive, local_id.as_str()),
        ("stub", &stub as &dyn DriveArchive, stub_id.as_str()),
        (
            "google (stand-in)",
            &google as &dyn DriveArchive,
            "stand-in-file",
        ),
        (
            "the trait default",
            &content_only as &dyn DriveArchive,
            "any-id",
        ),
    ];
    for (name, archive, id) in backends {
        // One byte past the end of the object.
        let past = range(OBJECT_LEN as u64, OBJECT_LEN as u64);
        assert_eq!(
            archive
                .file_range(id, past, MAX_ATTACHMENT_BYTES)
                .await
                .expect_err(name),
            DriveError::UpstreamFailure,
            "{name}: a range the object does not hold"
        );
        // The last byte is fine when the ceiling is the object's own length, and
        // the object is over a ceiling one byte lower.
        let last = OBJECT_LEN as u64 - 1;
        archive
            .file_range(id, range(last, last), OBJECT_LEN as i64)
            .await
            .unwrap_or_else(|error| panic!("{name}: at the ceiling: {error}"));
        assert_eq!(
            archive
                .file_range(id, range(0, 0), OBJECT_LEN as i64 - 1)
                .await
                .expect_err(name),
            DriveError::ContentTooLarge,
            "{name}: over the ceiling"
        );
    }
}

#[tokio::test]
async fn the_unavailable_archive_refuses_a_range_read_as_it_refuses_everything() {
    assert_eq!(
        UnavailableDriveArchive
            .file_range("any", range(0, 0), MAX_ATTACHMENT_BYTES)
            .await
            .expect_err("no archive"),
        DriveError::Unavailable
    );
}

// ---------------------------------------------------------------------------
// Google: what it is sent, what it may answer, which clocks it has
// ---------------------------------------------------------------------------

/// **Red proof (D3 백엔드, Google).** Whatever the caller's range, the upstream is
/// sent **one** `Range` header of the form `bytes=<start>-<end>` built from the
/// two integers, once, with the bearer token and with no metadata call first.
///
/// Forward anything else — a header copied from the client, a list, a wider span
/// — and the recorded value differs; call `files.get` for metadata first and the
/// log holds two requests per read.
#[tokio::test]
async fn google_is_sent_one_normalised_range_and_no_metadata_call() {
    let bytes = object();
    let stand_in = serve(bytes.clone(), Behavior::default()).await;
    let google = GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(10));
    for asked in table() {
        let before = stand_in.requests().len();
        collect(
            google
                .file_range("stand-in-file", asked, MAX_ATTACHMENT_BYTES)
                .await
                .expect("a range"),
        )
        .await;
        let seen = stand_in.requests();
        assert_eq!(
            seen.len(),
            before + 1,
            "{asked:?}: one upstream call, no metadata first"
        );
        let request = seen.last().expect("the call");
        assert_eq!(
            request.ranges,
            vec![format!("bytes={}-{}", asked.start(), asked.end())],
            "{asked:?}: exactly one normalised Range"
        );
        assert!(
            request
                .path_and_query
                .starts_with("/drive/v3/files/stand-in-file?"),
            "{}",
            request.path_and_query
        );
        assert!(request.path_and_query.contains("alt=media"));
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer stand-in-token")
        );
    }
}

/// **Red proof (D3 백엔드, Google).** The archive hands back the total Drive
/// reports and never papers over it, so the route's comparison with the row can
/// refuse a disagreement; and everything that is not an exact 206 for the span it
/// asked is refused.
#[tokio::test]
async fn google_reports_its_own_total_and_refuses_anything_but_an_exact_206() {
    let bytes = object();
    let asked = range(10, 19);

    // A total that is not the row's is reported as Drive says it.
    let lying = serve(
        bytes.clone(),
        Behavior {
            claimed_total: Some(OBJECT_LEN as u64 + 5),
            ..Behavior::default()
        },
    )
    .await;
    let google = GoogleDriveArchive::against_stand_in(&lying.api_base, Duration::from_secs(10));
    let content = google
        .file_range("stand-in-file", asked, MAX_ATTACHMENT_BYTES)
        .await
        .expect("a 206");
    assert_eq!(content.total_size_bytes, OBJECT_LEN as i64 + 5);

    // Not an exact 206 for the asked span: every one is a 502 and no body.
    for (what, behavior, expected) in [
        (
            "a 200 that ignored Range (its whole body would be wrong bytes under a 206)",
            Behavior {
                ignore_range: true,
                ..Behavior::default()
            },
            DriveError::UpstreamFailure,
        ),
        (
            "a 416: the object is shorter than the row says",
            Behavior {
                status: Some(416),
                ..Behavior::default()
            },
            DriveError::UpstreamFailure,
        ),
        (
            "a 206 for other bytes than were asked",
            Behavior {
                wrong_span: true,
                ..Behavior::default()
            },
            DriveError::UpstreamFailure,
        ),
        (
            "a 206 whose total is `*`",
            Behavior {
                unknown_total: true,
                ..Behavior::default()
            },
            DriveError::UpstreamFailure,
        ),
        (
            "a 403",
            Behavior {
                status: Some(403),
                ..Behavior::default()
            },
            DriveError::AccessDenied,
        ),
        (
            "a 404",
            Behavior {
                status: Some(404),
                ..Behavior::default()
            },
            DriveError::FileNotFound,
        ),
        (
            "a 500",
            Behavior {
                status: Some(500),
                ..Behavior::default()
            },
            DriveError::UpstreamFailure,
        ),
    ] {
        let stand_in = serve(bytes.clone(), behavior).await;
        let google =
            GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(10));
        assert_eq!(
            google
                .file_range("stand-in-file", asked, MAX_ATTACHMENT_BYTES)
                .await
                .expect_err(what),
            expected,
            "{what}"
        );
    }

    // An id that is not in Drive's alphabet never becomes a path.
    let google = GoogleDriveArchive::against_stand_in(&lying.api_base, Duration::from_secs(10));
    let calls = lying.requests().len();
    assert!(matches!(
        google
            .file_range("../escape", asked, MAX_ATTACHMENT_BYTES)
            .await
            .expect_err("a bad id"),
        DriveError::InvalidArguments(_)
    ));
    assert_eq!(lying.requests().len(), calls, "nothing was sent");
}

/// **Red proof (D3 백엔드, Google 시계).** There is no total time limit: a body
/// that keeps flowing for longer than the idle limit is received whole.
///
/// This is the same property the 60-second version proves at full scale (the
/// `#[ignore]`d `a_consumer_slower_than_the_old_total_limit_still_gets_every_byte`),
/// scaled so it runs in every build: 6 pieces 400 ms apart take over two seconds,
/// the idle limit is 1.5 s, and no gap is longer than 400 ms. Make the idle limit
/// a total one and the body is cut mid-stream.
#[tokio::test]
async fn a_body_that_keeps_flowing_is_never_cut_by_the_idle_limit() {
    let bytes: Vec<u8> = (0..60_000).map(|index| (index % 251) as u8).collect();
    let stand_in = serve(
        bytes.clone(),
        Behavior {
            pace: Some((10_000, Duration::from_millis(400))),
            ..Behavior::default()
        },
    )
    .await;
    let google =
        GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_millis(1500));
    let started = Instant::now();
    let content = google
        .file_range("stand-in-file", range(0, 59_999), MAX_ATTACHMENT_BYTES)
        .await
        .expect("a range");
    let got = collect(content).await;
    assert!(
        started.elapsed() > Duration::from_millis(1500),
        "the premise: the read outlasted the idle limit ({:?})",
        started.elapsed()
    );
    assert_eq!(got, bytes, "every byte arrived");
}

/// **Red proof (D3 백엔드, Google 시계).** A connection that goes silent in the
/// middle of the body ends the body in an error after the idle limit — not never,
/// and not as a clean end that would look like a finished download.
#[tokio::test]
async fn a_body_that_goes_silent_is_cut_at_the_idle_limit_with_an_error() {
    let bytes: Vec<u8> = (0..60_000).map(|index| (index % 251) as u8).collect();
    let stand_in = serve(
        bytes,
        Behavior {
            stall_after: Some(20_000),
            ..Behavior::default()
        },
    )
    .await;
    let google = GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(1));
    let started = Instant::now();
    let content = google
        .file_range("stand-in-file", range(0, 59_999), MAX_ATTACHMENT_BYTES)
        .await
        .expect("the headers arrive");
    let mut body = content.body;
    // The deadline is the test's own: without an idle limit the stand-in's silence
    // lasts an hour, and this must fail in seconds rather than hang.
    let drained = tokio::time::timeout(Duration::from_secs(10), async {
        let mut received = 0usize;
        let mut failure = None;
        while let Some(item) = body.next().await {
            match item {
                Ok(chunk) => received += chunk.len(),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        (received, failure)
    })
    .await
    .expect("the silence was cut by the idle limit, not waited out");
    let (received, failure) = drained;
    assert_eq!(
        received, 20_000,
        "what came before the silence is delivered"
    );
    assert_eq!(failure, Some(DriveError::UpstreamFailure));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the silence was cut by the idle limit ({:?})",
        started.elapsed()
    );
}

/// **Red proof (D3 백엔드, Google 시계).** The same idle limit also covers the wait
/// **before the response starts**: an upstream that accepts the connection and
/// never sends a header ends the call in an error after the idle limit. With no
/// total time limit on the request this is the only thing that stops a silent
/// upstream from holding the call (and the member's request) open for good.
///
/// Take the client's read limit away and the call is still waiting when this
/// test's own deadline passes.
#[tokio::test]
async fn a_response_that_never_starts_is_cut_at_the_idle_limit() {
    let stand_in = serve(
        vec![0u8; 100],
        Behavior {
            delay_headers: Some(Duration::from_secs(3600)),
            ..Behavior::default()
        },
    )
    .await;
    let google = GoogleDriveArchive::against_stand_in(&stand_in.api_base, Duration::from_secs(1));
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        google.file_range("stand-in-file", range(0, 99), MAX_ATTACHMENT_BYTES),
    )
    .await
    .expect("the wait for headers was cut by the idle limit, not waited out");
    assert_eq!(
        outcome.expect_err("no header ever came"),
        DriveError::UpstreamFailure
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cut by the idle limit ({:?})",
        started.elapsed()
    );
}

/// **Red proof (D3 백엔드, Google 시계) at full scale.** The old content read had a
/// 60-second limit on the **whole** request, so a reader slower than about 42
/// Mbit/s of a 300 MiB object was cut off mid-body after `Content-Length` had
/// gone out. Here a body is trickled for 65 seconds — longer than that limit, with
/// the production idle limit (30 s) — and arrives whole.
///
/// Put a total limit back on the content request (`.timeout(60 s)`) and this
/// goes red at second 60. Ignored by default because it is 65 seconds of wall
/// clock; the nightly lane runs every `#[ignore]`d test.
#[tokio::test]
#[ignore = "65 s of wall clock; run with --ignored (the nightly lane does)"]
async fn a_consumer_slower_than_the_old_total_limit_still_gets_every_byte() {
    let bytes: Vec<u8> = (0..14u8).collect();
    let stand_in = serve(
        bytes.clone(),
        Behavior {
            pace: Some((1, Duration::from_secs(5))),
            ..Behavior::default()
        },
    )
    .await;
    let google = GoogleDriveArchive::against_stand_in(
        &stand_in.api_base,
        crate::google::CONTENT_IDLE_TIMEOUT,
    );
    let started = Instant::now();
    let content = google
        .file_range("stand-in-file", range(0, 13), MAX_ATTACHMENT_BYTES)
        .await
        .expect("a range");
    let got = collect(content).await;
    assert!(
        started.elapsed() > Duration::from_secs(64),
        "the premise: the read outlasted the old total limit by a clear margin ({:?})",
        started.elapsed()
    );
    assert_eq!(got, bytes);
}
