//! Pixel-only renditions. Bounds precede decoding; animations are never collected.
//! The supervisor owns its permit until the codec subprocess is killed/reaped.
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use image::codecs::gif::GifDecoder;
use image::metadata::Orientation;
use image::{
    AnimationDecoder, DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::{ImageInfo, INPUT_BYTES};

mod motion;

pub const ALLOCATION_LIMIT: u64 = 192 * 1024 * 1024;
const SCRATCH: u64 = 16 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(10);
/// The most a codec child's answer may weigh on its stdout, and so the most the parent reads back.
/// An answer has to fit under it **as it is encoded on the wire** (see [`Prepared`]).
const CHILD_OUTPUT_MAX: usize = 8 * 1024 * 1024;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize,
)]
pub enum Rejected {
    #[error("image exceeds byte limit")]
    TooLarge,
    #[error("unsupported or invalid image")]
    Invalid,
    #[error("video processing unavailable")]
    Video,
    #[error("image processing timed out")]
    Timeout,
    /// Both decoder slots are taken. A retryable state of the **server**, not a property of
    /// the picture and not a time limit it exceeded: a link import never records it as
    /// `source_timeout` (ADR-0218 appendix C), it answers 503 or waits for a slot.
    #[error("image processing is busy")]
    Busy,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Rendition {
    pub info: ImageInfo,
    /// On the codec child's wire this is **base64**, as [`Prepared::data`] is: a JSON array of
    /// numbers takes up to four characters a byte, and the four renditions of the §20 table (up to
    /// 4.75 MiB) would not fit [`CHILD_OUTPUT_MAX`] that way (#6071).
    #[serde(with = "wire_bytes")]
    pub data: Vec<u8>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Processed {
    pub small: Rendition,
    pub large: Rendition,
    pub thumb: Rendition,
    /// ADR-0218 §20 (#6071): the stopped frame of a **moving** picture stored at the wide table
    /// ([`RenditionTable::Wide`]): its first composited frame as a still PNG, at `large`'s size.
    /// `None` for a still picture, for the old table and for every assembled or set picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub still: Option<Rendition>,
}
impl Processed {
    /// The stored rows of this picture: three, or four when it has a stopped frame.
    pub fn variants(&self) -> Vec<(&'static str, &Rendition)> {
        let mut rows = vec![
            ("small", &self.small),
            ("large", &self.large),
            ("thumb", &self.thumb),
        ];
        if let Some(still) = &self.still {
            rows.push(("still", still));
        }
        rows
    }
}

/// ADR-0218 §20 (#6071): the size table a picture is stored at when the server encodes it from its
/// input bytes. [`Legacy`](Self::Legacy) is the table every client reads (`small` 128 · `thumb` 128 ·
/// `large` 512, moving canvas 512); [`Wide`](Self::Wide) is §20's (`thumb` 256 · `large` 768 · a
/// `still` for a moving picture, moving canvas 768). The server stores at `Wide` only when the
/// operator turns it on (Z2-7, `EXPRESSION_RENDITION_TABLE`): an older client cannot read a list
/// that holds one wide row. The assembler and the set path never take this; they stay at the old
/// table (Z2-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenditionTable {
    #[default]
    Legacy,
    Wide,
}

/// The longest side and the most bytes of each rendition, and the widest moving canvas, of one
/// [`RenditionTable`]. The decoder limits are **not** here: they are the same for both tables (Z2-2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sizes {
    pub small_edge: u32,
    pub small_bytes: usize,
    pub thumb_edge: u32,
    pub thumb_bytes: usize,
    /// `large`, and `still` when there is one (`still` is `large`'s size, Z1).
    pub large_edge: u32,
    pub large_bytes: usize,
    /// Whether a moving picture also gets a `still`.
    pub still: bool,
    /// The widest and tallest canvas a moving input may have.
    pub motion_canvas: u32,
}

impl Sizes {
    /// The most one stored picture may weigh (Z4): `small + thumb + large`, and `+ still` when
    /// `moving` and the table makes one.
    pub const fn worst_bytes(&self, moving: bool) -> usize {
        self.small_bytes
            + self.thumb_bytes
            + self.large_bytes
            + if moving && self.still {
                self.large_bytes
            } else {
                0
            }
    }
}

impl RenditionTable {
    /// The name of the server setting that chooses the table (ADR-0218 §20 Z2-7).
    pub const SETTING: &'static str = "EXPRESSION_RENDITION_TABLE";

    pub const fn sizes(self) -> Sizes {
        match self {
            RenditionTable::Legacy => Sizes {
                small_edge: 128,
                small_bytes: 256 * 1024,
                thumb_edge: 128,
                thumb_bytes: 256 * 1024,
                large_edge: 512,
                large_bytes: 1024 * 1024,
                still: false,
                motion_canvas: 512,
            },
            RenditionTable::Wide => Sizes {
                small_edge: 128,
                small_bytes: 256 * 1024,
                thumb_edge: 256,
                thumb_bytes: 512 * 1024,
                large_edge: 768,
                large_bytes: 2 * 1024 * 1024,
                still: true,
                motion_canvas: 768,
            },
        }
    }

    /// The setting's value: unset or empty is the old table, `768` the §20 table, and `512` names the
    /// old table explicitly (the way back, Z7). Anything else is `None`: the caller keeps the old table
    /// and says so, because a mistyped way back must not leave the wide table on.
    pub fn from_setting(value: Option<&str>) -> Option<Self> {
        match value.map(str::trim) {
            None | Some("") | Some("512") => Some(RenditionTable::Legacy),
            Some("768") => Some(RenditionTable::Wide),
            Some(_) => None,
        }
    }

    /// The codec child's fixed arguments for this table (see `main.rs`): nothing for the old table,
    /// `--wide` for §20's.
    fn child_args(self, cutout: bool) -> &'static [&'static str] {
        match (cutout, self) {
            (false, RenditionTable::Legacy) => &[],
            (false, RenditionTable::Wide) => &["--wide"],
            (true, RenditionTable::Legacy) => &["--cutout"],
            (true, RenditionTable::Wide) => &["--cutout", "--wide"],
        }
    }
}

/// The two decoder slots every picture path shares: a direct upload, a link import, an agent's
/// candidates and the motion assembler (ADR-0218 G3.5: one semaphore of two across all sources).
/// There is deliberately one: a caller takes a permit from **this** and hands it to its child
/// process, so the cap holds however the work arrives.
pub fn decoder_slots() -> Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(2))).clone()
}

/// A picture's renditions at `table`, made in the isolated codec child. A busy decoder is refused at
/// once ([`Rejected::Busy`]).
pub async fn process(bytes: Vec<u8>, table: RenditionTable) -> Result<Processed, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    supervised(bytes, decoder_path()?, DEADLINE, decoder_slots(), table).await
}

/// The longest [`process_waiting`] stands in line for a decoder slot, whatever its caller's
/// own deadline allows. A person's direct upload and import never wait (`try_acquire`), and
/// the semaphore hands a freed slot to the line before anybody else: so a long wait is a long
/// stretch in which a person is told "busy" because an agent's candidate is queued.
pub const WAIT_MAX: Duration = Duration::from_secs(3);
/// How many callers of [`process_waiting`] may stand in line at once, **process-wide** (every
/// tenant, every agent). A third one is refused at once instead of lengthening the line.
pub const WAITERS_MAX: usize = 2;

/// [`process`], but a busy decoder is **waited for** instead of refused at once: at most
/// `wait` (and never more than [`WAIT_MAX`]), and only if the line is shorter than
/// [`WAITERS_MAX`]. Used by the agent action, whose candidates are decoded one after another
/// inside one deadline. The wait is the only difference: the input bound, the two slots, the
/// supervised child and its limits are the same ones, and a line that is full or a wait that
/// runs out is [`Rejected::Busy`], never `Timeout`.
pub async fn process_waiting(
    bytes: Vec<u8>,
    wait: Duration,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    waiting(
        bytes,
        decoder_path()?,
        DEADLINE,
        decoder_slots(),
        &Line::process_wide(),
        wait,
        table,
    )
    .await
}

/// The line behind the decoder slots: how many may stand in it and for how long.
struct Line<'a> {
    standing: &'a std::sync::atomic::AtomicUsize,
    max: usize,
    longest: Duration,
}

impl Line<'static> {
    fn process_wide() -> Self {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        Line {
            standing: &STANDING,
            max: WAITERS_MAX,
            longest: WAIT_MAX,
        }
    }
}

/// One place in the line. Dropping it gives the place back — also when the waiting future is
/// cancelled with the request that made it.
struct Place<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> Place<'a> {
    // `try_update` (the new name) is stable only from Rust 1.95; the workspace MSRV is 1.88.
    #[allow(deprecated)]
    fn take(line: &Line<'a>) -> Option<Self> {
        use std::sync::atomic::Ordering;
        line.standing
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < line.max).then_some(n + 1)
            })
            .ok()
            .map(|_| Place(line.standing))
    }
}

impl Drop for Place<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

async fn waiting(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    semaphore: Arc<Semaphore>,
    line: &Line<'_>,
    wait: Duration,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    let permit = permit_waiting(semaphore, line, wait).await?;
    run_with_permit(bytes, path, deadline, permit, table).await
}

/// What the **parent** can refuse from a body's first bytes alone, before it takes a decoder slot,
/// stands in the line or starts a child (#4900). A video is never decoded here (ADR-0218 D4 is on
/// hold), so it ends as [`Rejected::Video`], the card, whether or not a slot is free: without this
/// a video was told "busy" whenever both slots were taken, for something no slot could ever make.
fn refused_before_a_slot(bytes: &[u8]) -> Option<Rejected> {
    (sniff(bytes) == Sniffed::Video).then_some(Rejected::Video)
}

/// A decoder slot: a free one is taken without standing in line; otherwise the line has room for
/// `max` callers, each for `longest` at most. The place is held until the slot is ours (or the wait
/// ends) and not a moment longer, so decoding never occupies it.
async fn permit_waiting(
    semaphore: Arc<Semaphore>,
    line: &Line<'_>,
    wait: Duration,
) -> Result<tokio::sync::OwnedSemaphorePermit, Rejected> {
    match semaphore.clone().try_acquire_owned() {
        Ok(permit) => Ok(permit),
        Err(_) => {
            let Some(_place) = Place::take(line) else {
                return Err(Rejected::Busy);
            };
            tokio::time::timeout(wait.min(line.longest), semaphore.acquire_owned())
                .await
                .map_err(|_| Rejected::Busy)?
                .map_err(|_| Rejected::Invalid)
        }
    }
}

async fn supervised(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    semaphore: Arc<Semaphore>,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    // Admission happens before detaching: canceled callers cannot accumulate
    // an unbounded queue of 5 MiB inputs waiting behind the two codec slots.
    let permit = semaphore.try_acquire_owned().map_err(|_| Rejected::Busy)?;
    run_with_permit(bytes, path, deadline, permit, table).await
}

async fn run_with_permit(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    permit: tokio::sync::OwnedSemaphorePermit,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    // The supervisor survives cancellation of the HTTP request and retains its
    // permit until the actual child has exited and been reaped.
    let task = tokio::spawn(async move {
        let _permit = permit;
        child_typed::<Processed>(bytes, path, deadline, table.child_args(false)).await
    });
    task.await.map_err(|_| Rejected::Invalid)?
}
fn decoder_path() -> Result<std::path::PathBuf, Rejected> {
    if let Some(path) = std::env::var_os("OORT_EXPRESSION_DECODER") {
        return Ok(path.into());
    }
    let exe = std::env::current_exe().map_err(|_| Rejected::Invalid)?;
    let parent = exe.parent().ok_or(Rejected::Invalid)?;
    let parent = if parent.file_name() == Some(std::ffi::OsStr::new("deps")) {
        parent.parent().ok_or(Rejected::Invalid)?
    } else {
        parent
    };
    Ok(parent.join("momo-expression-decoder"))
}
#[cfg(test)]
async fn child(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
) -> Result<Processed, Rejected> {
    child_typed::<Processed>(bytes, path, deadline, &[]).await
}

/// One job in the codec subprocess. `args` are fixed arguments of the child (`--prepare`,
/// `--cutout`, `--wide`), never anything a member wrote; the bytes go in on stdin, the answer comes
/// back as JSON on stdout, and nothing else (no URL, path, environment or database) is passed.
async fn child_typed<T: serde::de::DeserializeOwned>(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    args: &'static [&'static str],
) -> Result<T, Rejected> {
    let mut command = tokio::process::Command::new(path);
    command.env_clear();
    command.args(args);
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Rejected::Invalid)?;
    DECODER_CHILDREN_STARTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut input = child.stdin.take().ok_or(Rejected::Invalid)?;
    let mut output = child.stdout.take().ok_or(Rejected::Invalid)?;
    let work = async {
        input
            .write_all(&bytes)
            .await
            .map_err(|_| Rejected::Invalid)?;
        input.shutdown().await.map_err(|_| Rejected::Invalid)?;
        drop(input);
        let mut data = Vec::new();
        (&mut output)
            .take(CHILD_OUTPUT_MAX as u64 + 1)
            .read_to_end(&mut data)
            .await
            .map_err(|_| Rejected::Invalid)?;
        if data.len() > CHILD_OUTPUT_MAX {
            return Err(Rejected::Invalid);
        }
        let status = child.wait().await.map_err(|_| Rejected::Invalid)?;
        if !status.success() {
            return Err(Rejected::Invalid);
        }
        serde_json::from_slice::<Result<T, Rejected>>(&data).map_err(|_| Rejected::Invalid)?
    };
    match tokio::time::timeout(deadline, work).await {
        Ok(result) => {
            if child.try_wait().map_err(|_| Rejected::Invalid)?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            result
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(Rejected::Timeout)
        }
    }
}

/// A job that holds its slot until its child has exited and been reaped, even if the request that
/// asked for it is cancelled.
async fn job<T: serde::de::DeserializeOwned + Send + 'static>(
    bytes: Vec<u8>,
    args: &'static [&'static str],
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<T, Rejected> {
    let path = decoder_path()?;
    let task = tokio::spawn(async move {
        let _permit = permit;
        child_typed::<T>(bytes, path, DEADLINE, args).await
    });
    task.await.map_err(|_| Rejected::Invalid)?
}

/// A member's photo made ready to leave for an image model ([`prepare`], in the isolated child).
/// A busy decoder is refused at once ([`Rejected::Busy`]): nothing has been spent yet, so the
/// member simply tries again.
pub async fn prepare_photo(bytes: Vec<u8>) -> Result<Prepared, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    let permit = decoder_slots()
        .try_acquire_owned()
        .map_err(|_| Rejected::Busy)?;
    job(bytes, &["--prepare"], permit).await
}

/// [`prepare_photo`] for a picture the **server** holds and a person is waiting on (ADR-0151 증보 8 W5,
/// #5371: the agent-worker's picture, written through the api): a busy decoder is **waited for**, as an
/// agent's candidates are ([`process_waiting`]) — at most `wait` (and never more than [`WAIT_MAX`]), and
/// only if the line is shorter than [`WAITERS_MAX`]. A line that is full or a wait that runs out is
/// [`Rejected::Busy`], never `Timeout`. The child, its mode (`--prepare`), its limits and its output
/// shape are exactly [`prepare_photo`]'s; the wait is the only difference.
pub async fn prepare_photo_waiting(bytes: Vec<u8>, wait: Duration) -> Result<Prepared, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    let permit = permit_waiting(decoder_slots(), &Line::process_wide(), wait).await?;
    job(bytes, &["--prepare"], permit).await
}

/// How many codec child processes this process has started (ADR-0151 증보 8 WA7). A counter of the
/// parent's own spawns, so a test can say **"the route started exactly one child"** or **"a refused
/// request started none"** with a number instead of a guess. It changes nothing about a spawn.
pub fn decoder_children_started() -> u64 {
    DECODER_CHILDREN_STARTED.load(std::sync::atomic::Ordering::Relaxed)
}

static DECODER_CHILDREN_STARTED: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// How many times **this process** opened a picture with a codec itself (ADR-0151 증보 8 WA7): the
/// decoder child's own `main` does, a parent that only supervises children never does. A test of the
/// api reads **0** here to show the route decoded nothing in its own process.
pub fn in_process_codec_starts() -> u64 {
    IN_PROCESS_CODEC_STARTS.load(std::sync::atomic::Ordering::Relaxed)
}

static IN_PROCESS_CODEC_STARTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// What an image model drew, as a cut-out ([`decode_cutout`], in the isolated child). The model
/// call has been paid for by now, so a busy decoder is **waited for** (as an agent's candidates
/// are, [`WAIT_MAX`]) instead of refused at once.
pub async fn process_cutout(
    bytes: Vec<u8>,
    wait: Duration,
    table: RenditionTable,
) -> Result<Cutout, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    let permit = permit_waiting(decoder_slots(), &Line::process_wide(), wait).await?;
    job(bytes, table.child_args(true), permit).await
}

/// The pause between two asks for a decoder slot in [`permit_patiently`]. A full line is refused at
/// once ([`Place::take`]), so without a pause a busy decoder would be asked about in a tight loop.
const ASK_AGAIN_AFTER: Duration = Duration::from_millis(250);

/// A decoder slot for a picture that has already been paid for (#4992, L2). Where [`permit_waiting`]
/// gives up with [`Rejected::Busy`] when the line is full or its wait ran out, this **asks again**,
/// `pause` after each refusal, until `patience` has passed: only then is it `Busy`. Each ask is a
/// [`permit_waiting`] of what is left of the patience, so it never stands in line past the line's own
/// cap ([`WAIT_MAX`]) nor past the end; and between two asks the place in line is given back, so a
/// person's upload or import (which never stands in line) is not kept waiting behind it.
async fn permit_patiently(
    semaphore: Arc<Semaphore>,
    line: &Line<'_>,
    patience: Duration,
    pause: Duration,
) -> Result<tokio::sync::OwnedSemaphorePermit, Rejected> {
    let end = Instant::now() + patience;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        match permit_waiting(semaphore.clone(), line, left).await {
            Err(Rejected::Busy) => {
                let left = end.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(Rejected::Busy);
                }
                tokio::time::sleep(pause.min(left)).await;
            }
            outcome => return outcome,
        }
    }
}

/// [`process_cutout`] for a picture the team has already paid for: a decoder that stays busy is asked
/// again for `patience` ([`permit_patiently`]) before the picture is given up. The caller never asks
/// the provider again: the picture is held here, in memory, and decoded when a slot is free.
pub async fn process_cutout_patiently(
    bytes: Vec<u8>,
    patience: Duration,
    table: RenditionTable,
) -> Result<Cutout, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    let permit = permit_patiently(
        decoder_slots(),
        &Line::process_wide(),
        patience,
        ASK_AGAIN_AFTER,
    )
    .await?;
    job(bytes, table.child_args(true), permit).await
}

/// [`process_waiting`] with [`process_cutout_patiently`]'s patience: the ordinary picture path for a
/// picture that has already been paid for.
pub async fn process_waiting_patiently(
    bytes: Vec<u8>,
    patience: Duration,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    let permit = permit_patiently(
        decoder_slots(),
        &Line::process_wide(),
        patience,
        ASK_AGAIN_AFTER,
    )
    .await?;
    run_with_permit(bytes, decoder_path()?, DEADLINE, permit, table).await
}

struct TimedReader<'a> {
    input: Cursor<&'a [u8]>,
    end: Instant,
}
impl Read for TimedReader<'_> {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        check(self.end)?;
        Read::read(&mut self.input, b)
    }
}
impl Seek for TimedReader<'_> {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        check(self.end)?;
        self.input.seek(p)
    }
}
fn check(end: Instant) -> io::Result<()> {
    if Instant::now() >= end {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "expression deadline",
        ))
    } else {
        Ok(())
    }
}
struct Output {
    data: Vec<u8>,
    max: usize,
    end: Instant,
}
impl Write for Output {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        check(self.end)?;
        if data.len() > self.max.saturating_sub(self.data.len()) {
            return Err(io::Error::other("expression output limit"));
        }
        self.data.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        check(self.end)
    }
}
fn output(max: usize, end: Instant) -> Output {
    Output {
        data: Vec::new(),
        max,
        end,
    }
}
fn limits(dim: u32) -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(dim);
    l.max_image_height = Some(dim);
    l.max_alloc = Some(SCRATCH);
    l
}
fn rendition(data: Vec<u8>, mime: &str, w: u32, h: u32, n: u32, ms: u32) -> Rendition {
    Rendition {
        info: ImageInfo {
            mime: mime.into(),
            sha256: hex::encode(Sha256::digest(&data)),
            bytes: data.len(),
            width: w,
            height: h,
            frame_count: n,
            duration_ms: ms,
        },
        data,
    }
}
fn shrink(image: &DynamicImage, max: u32) -> image::RgbaImage {
    // Resize the native image BEFORE conversion to rgba8: even 16-bit 16MP PNG
    // retains one native (<=128 MB) allocation, never a second full-size copy.
    let max = max.min(image.width().max(image.height()));
    image.thumbnail(max, max).to_rgba8()
}
/// How far a trial encoding may grow while the search is only comparing sizes against each other.
const TRIAL_CAP: usize = 8 * 1024 * 1024;

/// A still rendition, as small as the same pixels will go (#5455). The picture is stored exactly:
/// the search only chooses how the PNG spells it.
///
/// 1. A picture with no see-through pixel is stored as RGB; the alpha plane would only repeat 255.
/// 2. The old settings (fast deflate, adaptive filter) are tried first, so the answer is never
///    larger than it was, and they stay the answer if nothing below fits `max`.
/// 3. All six PNG filters are compared at a cheap deflate level, and the winner is written again at
///    level 9. On AI-drawn sticker art `NoFilter` won every time measured and on photo-like pictures the
///    adaptive filter does; ranking at the cheap level named the level-9 winner in every case measured.
///
/// Only `max` decides whether a result is acceptable: a trial that outgrows it is not a candidate,
/// and when none fits the rendition fails as before. A trial that runs into the deadline is not a
/// candidate either, so a slow machine ends with the old settings' answer, not with an error.
fn png(image: &image::RgbaImage, max: usize, end: Instant) -> Result<Rendition, Rejected> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    let (width, height) = (image.width(), image.height());
    let opaque = image.pixels().all(|p| p.0[3] == 255);
    let rgb: Vec<u8>;
    let (raw, color) = if opaque {
        rgb = image
            .pixels()
            .flat_map(|p| [p.0[0], p.0[1], p.0[2]])
            .collect();
        (rgb.as_slice(), image::ExtendedColorType::Rgb8)
    } else {
        (image.as_raw().as_slice(), image::ExtendedColorType::Rgba8)
    };
    let trial = |compression: CompressionType, filter: FilterType, cap: usize| -> Option<Vec<u8>> {
        let mut out = output(cap, end);
        PngEncoder::new_with_quality(&mut out, compression, filter)
            .write_image(raw, width, height, color)
            .ok()?;
        Some(out.data)
    };
    let mut best = trial(CompressionType::Fast, FilterType::Adaptive, max);
    let mut chosen: Option<(FilterType, usize)> = None;
    for filter in [
        FilterType::NoFilter,
        FilterType::Sub,
        FilterType::Up,
        FilterType::Avg,
        FilterType::Paeth,
        FilterType::Adaptive,
    ] {
        if let Some(data) = trial(CompressionType::Level(3), filter, TRIAL_CAP) {
            if chosen.is_none_or(|(_, len)| data.len() < len) {
                chosen = Some((filter, data.len()));
            }
        }
    }
    if let Some((filter, _)) = chosen {
        let cap = best.as_ref().map_or(max, |b| b.len().saturating_sub(1));
        if let Some(data) = trial(CompressionType::Level(9), filter, cap) {
            best = Some(data);
        }
    }
    let data = best.ok_or(Rejected::Invalid)?;
    Ok(rendition(data, "image/png", width, height, 1, 0))
}

/// Container preflight for GIF: count ALL images and delays without allocating
/// frames. Reject oversized subrects before the decoder allocates its buffer.
fn gif_spec(b: &[u8], canvas: u32) -> Result<(u32, u32, u32, u32), Rejected> {
    let bad = || Rejected::Invalid;
    if b.len() < 13 {
        return Err(bad());
    }
    let u16at = |p| u16::from_le_bytes([b[p], b[p + 1]]) as u32;
    let (w, h) = (u16at(6), u16at(8));
    if w == 0 || h == 0 || w > 4096 || h > 4096 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(bad());
    }
    let mut p = 13
        + if b[10] & 128 != 0 {
            3 * (1usize << ((b[10] & 7) + 1))
        } else {
            0
        };
    let (mut frames, mut ms, mut delay) = (0u32, 0u32, 20u32);
    fn blocks(b: &[u8], p: &mut usize) -> Result<(), Rejected> {
        loop {
            let n = *b.get(*p).ok_or(Rejected::Invalid)? as usize;
            *p += 1;
            if n == 0 {
                return Ok(());
            }
            *p = p
                .checked_add(n)
                .filter(|p| *p <= b.len())
                .ok_or(Rejected::Invalid)?;
        }
    }
    loop {
        let marker = *b.get(p).ok_or_else(bad)?;
        p += 1;
        match marker {
            0x3b => break,
            0x21 => {
                let label = *b.get(p).ok_or_else(bad)?;
                p += 1;
                if label == 0xf9 {
                    if b.get(p) != Some(&4) || b.get(p + 5) != Some(&0) {
                        return Err(bad());
                    }
                    delay = u16at(p + 2).saturating_mul(10).max(20);
                }
                blocks(b, &mut p)?;
            }
            0x2c => {
                if p + 9 > b.len() {
                    return Err(bad());
                }
                let (x, y, fw, fh) = (u16at(p), u16at(p + 2), u16at(p + 4), u16at(p + 6));
                if fw == 0 || fh == 0 || x + fw > w || y + fh > h {
                    return Err(bad());
                }
                let flags = b[p + 8];
                p += 9;
                if flags & 128 != 0 {
                    p += 3 * (1usize << ((flags & 7) + 1));
                }
                p += 1; // LZW code width; decoder validates it.
                blocks(b, &mut p)?;
                frames += 1;
                ms = ms.checked_add(delay).ok_or_else(bad)?;
                delay = 20;
                if frames > 100
                    || (frames > 1 && (w > canvas || h > canvas || ms > 10000))
                    || u64::from(w) * u64::from(h) * u64::from(frames) > 32_000_000
                {
                    return Err(bad());
                }
            }
            _ => return Err(bad()),
        }
    }
    if frames == 0 || (frames > 1 && ms > 10000) {
        return Err(bad());
    }
    Ok((w, h, frames, ms))
}

fn no_apng(b: &[u8]) -> Result<(), Rejected> {
    let mut p = 8usize;
    while p + 12 <= b.len() {
        let n = u32::from_be_bytes(b[p..p + 4].try_into().map_err(|_| Rejected::Invalid)?) as usize;
        if &b[p + 4..p + 8] == b"acTL" {
            return Err(Rejected::Invalid);
        }
        let end = p
            .checked_add(n)
            .and_then(|p| p.checked_add(12))
            .filter(|p| *p <= b.len())
            .ok_or(Rejected::Invalid)?;
        if &b[p + 4..p + 8] == b"IEND" {
            break;
        }
        p = end;
    }
    Ok(())
}

fn dimensions(w: u32, h: u32) -> Result<(u32, u32), Rejected> {
    if w == 0 || h == 0 || w > 4096 || h > 4096 || u64::from(w) * u64::from(h) > 16_000_000 {
        Err(Rejected::Invalid)
    } else {
        Ok((w, h))
    }
}

/// This runs BEFORE any codec constructor (some constructors allocate). In
/// particular, image-webp checks VP8X/VP8 agreement only AFTER VP8 allocation.
fn preflight(format: ImageFormat, b: &[u8], canvas: u32) -> Result<(u32, u32), Rejected> {
    match format {
        ImageFormat::Png => {
            if b.len() < 33 || &b[12..16] != b"IHDR" {
                return Err(Rejected::Invalid);
            }
            dimensions(
                u32::from_be_bytes(b[16..20].try_into().map_err(|_| Rejected::Invalid)?),
                u32::from_be_bytes(b[20..24].try_into().map_err(|_| Rejected::Invalid)?),
            )
        }
        ImageFormat::Jpeg => {
            let mut p = 2;
            while p < b.len() {
                if b[p] != 0xff {
                    return Err(Rejected::Invalid);
                }
                while b.get(p) == Some(&0xff) {
                    p += 1;
                }
                let marker = *b.get(p).ok_or(Rejected::Invalid)?;
                p += 1;
                if marker == 0xda || marker == 0xd9 {
                    return Err(Rejected::Invalid);
                }
                if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
                    continue;
                }
                if p + 2 > b.len() {
                    return Err(Rejected::Invalid);
                }
                let len = u16::from_be_bytes([b[p], b[p + 1]]) as usize;
                if len < 2 || p + len > b.len() {
                    return Err(Rejected::Invalid);
                }
                if [
                    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
                ]
                .contains(&marker)
                {
                    if len < 8 {
                        return Err(Rejected::Invalid);
                    }
                    return dimensions(
                        u16::from_be_bytes([b[p + 5], b[p + 6]]) as u32,
                        u16::from_be_bytes([b[p + 3], b[p + 4]]) as u32,
                    );
                }
                p += len;
            }
            Err(Rejected::Invalid)
        }
        ImageFormat::WebP => {
            if b.len() < 12 {
                return Err(Rejected::Invalid);
            }
            let riff =
                u32::from_le_bytes(b[4..8].try_into().map_err(|_| Rejected::Invalid)?) as usize;
            let end = riff
                .checked_add(8)
                .filter(|p| *p <= b.len())
                .ok_or(Rejected::Invalid)?;
            let mut p = 12;
            let (mut outer, mut inner) = (None, None);
            while p + 8 <= end {
                let kind = &b[p..p + 4];
                let len =
                    u32::from_le_bytes(b[p + 4..p + 8].try_into().map_err(|_| Rejected::Invalid)?)
                        as usize;
                let next = p
                    .checked_add(8)
                    .and_then(|p| p.checked_add(len))
                    .filter(|p| *p <= end)
                    .ok_or(Rejected::Invalid)?;
                let data = &b[p + 8..next];
                match kind {
                    b"ANIM" | b"ANMF" => return Err(Rejected::Invalid),
                    b"VP8X" => {
                        if len != 10 || data[0] & 2 != 0 || outer.is_some() {
                            return Err(Rejected::Invalid);
                        }
                        let u24 =
                            |p| u32::from_le_bytes([data[p], data[p + 1], data[p + 2], 0]) + 1;
                        outer = Some(dimensions(u24(4), u24(7))?);
                    }
                    b"VP8 " => {
                        if len < 10
                            || inner.is_some()
                            || &data[3..6] != b"\x9d\x01\x2a"
                            || data[0] & 1 != 0
                        {
                            return Err(Rejected::Invalid);
                        }
                        inner = Some(dimensions(
                            u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                            u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                        )?);
                    }
                    b"VP8L" => {
                        if len < 5 || inner.is_some() || data[0] != 0x2f {
                            return Err(Rejected::Invalid);
                        }
                        let bits = u32::from_le_bytes(
                            data[1..5].try_into().map_err(|_| Rejected::Invalid)?,
                        );
                        if bits >> 29 != 0 {
                            return Err(Rejected::Invalid);
                        }
                        inner = Some(dimensions(
                            (bits & 0x3fff) + 1,
                            ((bits >> 14) & 0x3fff) + 1,
                        )?);
                    }
                    _ => {}
                }
                p = next.checked_add(len & 1).ok_or(Rejected::Invalid)?;
            }
            let inner = inner.ok_or(Rejected::Invalid)?;
            if p != end || outer.is_some_and(|outer| outer != inner) {
                return Err(Rejected::Invalid);
            }
            Ok(inner)
        }
        ImageFormat::Gif => {
            let (w, h, _, _) = gif_spec(b, canvas)?;
            Ok((w, h))
        }
        _ => Err(Rejected::Invalid),
    }
}

#[cfg(test)]
thread_local! { static CODEC_STARTS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)}; }

/// ISO base media (MP4/MOV) whose major brand is one of the video brands.
fn is_mp4_video(bytes: &[u8]) -> bool {
    bytes.get(4..8) == Some(b"ftyp")
        && matches!(
            bytes.get(8..12),
            Some(b"isom" | b"iso2" | b"mp41" | b"mp42" | b"avc1" | b"M4V " | b"qt  ")
        )
}
/// The EBML header that opens WebM/Matroska.
fn is_ebml(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
}

/// What a body's leading bytes claim to be (ADR-0218 D3: names, MIME types and
/// extensions are never believed). Decoding stays the only authority on whether an
/// image is acceptable. This only lets the link importer tell "a web page or some
/// other format" (`source_unsupported`) from "an image we could not decode"
/// (`source_invalid_media`) without starting a codec process for either (#4829).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sniffed {
    /// PNG, JPEG, WebP or GIF magic: worth decoding.
    Image,
    /// MP4/MOV with a video brand, or WebM/Matroska: [`decode`] answers `Video`.
    Video,
    /// Anything else: HTML, SVG, HEIC/AVIF, a script, an empty body.
    Unsupported,
}

/// Classify by magic only; never reads past the first bytes.
pub fn sniff(bytes: &[u8]) -> Sniffed {
    if is_mp4_video(bytes) || is_ebml(bytes) {
        return Sniffed::Video;
    }
    match image::guess_format(bytes) {
        Ok(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif) => {
            Sniffed::Image
        }
        _ => Sniffed::Unsupported,
    }
}

/// What [`open`] found behind the bytes.
enum Opened {
    /// A still picture, and the orientation its camera recorded (EXIF; `NoTransforms` for a
    /// format that carries none or one that cannot be read).
    Still(DynamicImage, Orientation),
    /// A GIF with more than one frame.
    Animated,
}

/// Every check that precedes a picture's pixels, then the pixels: the one place a still image is
/// opened, whatever it is opened for. Bounds come first, animations are never collected. `canvas` is
/// the widest moving canvas the caller's table admits ([`Sizes::motion_canvas`]); every other bound is
/// the same for every caller.
fn open(bytes: &[u8], end: Instant, canvas: u32) -> Result<Opened, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    if check(end).is_err() {
        return Err(Rejected::Timeout);
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        return if is_mp4_video(bytes) {
            Err(Rejected::Video)
        } else {
            Err(Rejected::Invalid)
        };
    }
    if is_ebml(bytes) {
        return Err(Rejected::Video);
    }
    let format = image::guess_format(bytes).map_err(|_| Rejected::Invalid)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(Rejected::Invalid);
    }
    if format == ImageFormat::Png {
        no_apng(bytes)?;
    }
    let expected = preflight(format, bytes, canvas)?;
    if format == ImageFormat::Gif && gif_spec(bytes, canvas)?.2 > 1 {
        return Ok(Opened::Animated);
    }
    let input = || {
        std::io::BufReader::new(TimedReader {
            input: Cursor::new(bytes),
            end,
        })
    };
    #[cfg(test)]
    CODEC_STARTS.with(|n| n.set(n.get() + 1));
    IN_PROCESS_CODEC_STARTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut reader = ImageReader::with_format(input(), format);
    reader.limits(limits(4096));
    let mut decoder = reader.into_decoder().map_err(|_| Rejected::Invalid)?;
    let (w, h) = decoder.dimensions();
    // Native <=128MB + scratch16MiB + input5MiB + bounded renditions +
    // thumbnails (<8MiB) stays below the 192MiB per-job allocation budget.
    if (w, h) != expected
        || w == 0
        || h == 0
        || u64::from(w) * u64::from(h) > 16_000_000
        || decoder.total_bytes() + SCRATCH + INPUT_BYTES as u64 + 8 * 1024 * 1024 > ALLOCATION_LIMIT
    {
        return Err(Rejected::Invalid);
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let image = DynamicImage::from_decoder(decoder).map_err(|_| Rejected::Invalid)?;
    Ok(Opened::Still(image, orientation))
}

/// The renditions of a picture at the old table: what the assembler and every test that reads the
/// old sizes use. [`decode_with`] chooses the table.
pub fn decode(bytes: &[u8], end: Instant) -> Result<Processed, Rejected> {
    decode_with(bytes, end, RenditionTable::Legacy)
}

/// The renditions of a picture at `table` (D3, ADR-0218 §20 Z1): a still gets `small`, `thumb` and
/// `large`; a moving picture also gets `still` when the table makes one. Never larger than the input.
pub fn decode_with(
    bytes: &[u8],
    end: Instant,
    table: RenditionTable,
) -> Result<Processed, Rejected> {
    let sizes = table.sizes();
    match open(bytes, end, sizes.motion_canvas)? {
        Opened::Animated => animated(bytes, end, sizes),
        Opened::Still(image, _) => still_renditions(&image, end, sizes),
    }
}

/// The three renditions of a still picture. At the old table `thumb` is `small` itself (the same
/// edge and cap); at a table where they differ it is drawn on its own.
fn still_renditions(
    image: &DynamicImage,
    end: Instant,
    sizes: Sizes,
) -> Result<Processed, Rejected> {
    let small = png(&shrink(image, sizes.small_edge), sizes.small_bytes, end)?;
    let thumb = if (sizes.thumb_edge, sizes.thumb_bytes) == (sizes.small_edge, sizes.small_bytes) {
        small.clone()
    } else {
        png(&shrink(image, sizes.thumb_edge), sizes.thumb_bytes, end)?
    };
    let large = png(&shrink(image, sizes.large_edge), sizes.large_bytes, end)?;
    Ok(Processed {
        small,
        large,
        thumb,
        still: None,
    })
}

/// The longest side of a photo that is sent to an image model (ADR-0218 §8 H9): enough for a
/// face, small enough that the request is a fraction of the provider's limit.
pub const PREPARED_EDGE: u32 = 1024;
/// What a prepared photo may weigh.
pub const PREPARED_MAX_BYTES: usize = 4 * 1024 * 1024;

/// A member's photo made ready to leave for an image model: opened by the same checks as every
/// picture, turned upright by its EXIF orientation, shrunk to [`PREPARED_EDGE`], and **encoded
/// again from its pixels**, so no EXIF (where it was taken), GPS, ICC profile, comment or trailing
/// byte of the original goes with it. A picture with an alpha channel stays a PNG; any other is a
/// JPEG at quality 90.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Prepared {
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    /// The encoded picture. On the child's wire it is **base64**, not the JSON array of numbers a
    /// `Vec<u8>` is by default: a number takes up to four characters a byte, so a PNG over about
    /// 2.3 MB no longer fitted the parent's [`CHILD_OUTPUT_MAX`] read and a photo with an alpha
    /// channel was refused as invalid media (#4992, L4). Base64 is four characters for three
    /// bytes, so all of [`PREPARED_MAX_BYTES`] fits with room to spare.
    #[serde(with = "wire_bytes")]
    pub data: Vec<u8>,
}

/// The photo is a member's own: it is printed as its size and never as its bytes.
impl std::fmt::Debug for Prepared {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Prepared")
            .field("mime", &self.mime)
            .field("bytes", &self.data.len())
            .finish()
    }
}

/// `Prepared.data` as one base64 string on the child's stdout.
mod wire_bytes {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        STANDARD
            .decode(text.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

pub fn prepare(bytes: &[u8], end: Instant) -> Result<Prepared, Rejected> {
    // A moving picture is not a photo: it is refused here, not sampled.
    // A moving picture is refused whatever its canvas, so the old canvas is as good as any.
    let Opened::Still(mut image, orientation) =
        open(bytes, end, RenditionTable::Legacy.sizes().motion_canvas)?
    else {
        return Err(Rejected::Invalid);
    };
    let has_alpha = image.color().has_alpha();
    // Smaller first, turned second: a quarter turn builds a second buffer beside the first, and
    // beside a 16-megapixel photograph that would not fit the child's 192 MiB.
    if image.width().max(image.height()) > PREPARED_EDGE {
        image = image.thumbnail(PREPARED_EDGE, PREPARED_EDGE);
    }
    image.apply_orientation(orientation);
    let mut out = output(PREPARED_MAX_BYTES, end);
    let (width, height) = (image.width(), image.height());
    if has_alpha {
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                image.to_rgba8().as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|_| Rejected::Invalid)?;
        Ok(Prepared {
            mime: "image/png".into(),
            data: out.data,
        })
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .write_image(
                image.to_rgb8().as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|_| Rejected::Invalid)?;
        Ok(Prepared {
            mime: "image/jpeg".into(),
            data: out.data,
        })
    }
}

/// A picture an image model drew, as a cut-out: [`crate::cutout::cut_out`] applied to its pixels,
/// then the three renditions every picture gets. `outcome` says whether the background was the
/// model's own transparency, was erased here, or was left alone.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Cutout {
    pub processed: Processed,
    pub outcome: crate::cutout::Outcome,
}

pub fn decode_cutout(bytes: &[u8], end: Instant) -> Result<Cutout, Rejected> {
    decode_cutout_with(bytes, end, RenditionTable::Legacy)
}

/// [`decode_cutout`] at `table`: the photo path's result is a picture the server encodes from bytes,
/// so it is stored at the table every such picture is (ADR-0218 §20 Z2-4).
pub fn decode_cutout_with(
    bytes: &[u8],
    end: Instant,
    table: RenditionTable,
) -> Result<Cutout, Rejected> {
    let sizes = table.sizes();
    let Opened::Still(image, _) = open(bytes, end, sizes.motion_canvas)? else {
        return Err(Rejected::Invalid);
    };
    // A picture a model drew is 1024 or 1536 px a side. A larger one is not worked on: it gets the
    // renditions of any other picture, from the decoded pixels, without a second copy of them.
    let (image, outcome) =
        if u64::from(image.width()) * u64::from(image.height()) > crate::cutout::MAX_PIXELS {
            (image, crate::cutout::Outcome::Untouched)
        } else {
            let cut = crate::cutout::cut_out(&image.to_rgba8());
            (DynamicImage::ImageRgba8(cut.image), cut.outcome)
        };
    Ok(Cutout {
        processed: still_renditions(&image, end, sizes)?,
        outcome,
    })
}

/// The composited frames of a GIF, read with the same limits every time it is read.
fn motion_frames(bytes: &[u8], end: Instant, canvas: u32) -> Result<image::Frames<'_>, Rejected> {
    let input = std::io::BufReader::new(TimedReader {
        input: Cursor::new(bytes),
        end,
    });
    let mut decoder = GifDecoder::new(input).map_err(|_| Rejected::Invalid)?;
    decoder
        .set_limits(limits(canvas))
        .map_err(|_| Rejected::Invalid)?;
    Ok(decoder.into_frames())
}

/// A frame's delay in hundredths of a second, with the 20 ms floor of ADR-0218 D3.
fn centiseconds(frame: &image::Frame) -> u16 {
    let (num, denom) = frame.delay().numer_denom_ms();
    (((num / denom.max(1)).max(20)) / 10).min(u32::from(u16::MAX)) as u16
}

/// Two passes over the animation, neither holding more than one frame: the first learns the colours
/// each size will use, the second writes the frames with them (#5455, see [`motion`]).
/// The `thumb` (and, at a table that makes one, the `still`) is the **first composited frame**, the
/// same frame for both (ADR-0218 §20 Z2-1).
fn animated(bytes: &[u8], end: Instant, sizes: Sizes) -> Result<Processed, Rejected> {
    let (_, _, count, ms) = gif_spec(bytes, sizes.motion_canvas)?;
    let (mut small_colors, mut large_colors) = (motion::Census::new(), motion::Census::new());
    let mut seen = 0;
    for frame in motion_frames(bytes, end, sizes.motion_canvas)? {
        check(end).map_err(|_| Rejected::Timeout)?;
        let image = DynamicImage::ImageRgba8(frame.map_err(|_| Rejected::Invalid)?.into_buffer());
        small_colors.add(&shrink(&image, sizes.small_edge));
        large_colors.add(&shrink(&image, sizes.large_edge));
        seen += 1;
    }
    if seen != count {
        return Err(Rejected::Invalid);
    }
    let mut small = motion::Strip::new(output(sizes.small_bytes, end), small_colors.finish())?;
    let mut large = motion::Strip::new(output(sizes.large_bytes, end), large_colors.finish())?;
    let (small_wh, large_wh) = (small.size(), large.size());
    let mut thumb = None;
    let mut still = None;
    let mut seen = 0;
    for frame in motion_frames(bytes, end, sizes.motion_canvas)? {
        check(end).map_err(|_| Rejected::Timeout)?;
        let frame = frame.map_err(|_| Rejected::Invalid)?;
        let delay = centiseconds(&frame);
        let image = DynamicImage::ImageRgba8(frame.into_buffer());
        let s = shrink(&image, sizes.small_edge);
        let l = shrink(&image, sizes.large_edge);
        if thumb.is_none() {
            thumb = Some(if sizes.thumb_edge == sizes.small_edge {
                png(&s, sizes.thumb_bytes, end)?
            } else {
                png(&shrink(&image, sizes.thumb_edge), sizes.thumb_bytes, end)?
            });
            if sizes.still {
                still = Some(png(&l, sizes.large_bytes, end)?);
            }
        }
        small.push(&s, delay)?;
        large.push(&l, delay)?;
        seen += 1;
    }
    if seen != count {
        return Err(Rejected::Invalid);
    }
    Ok(Processed {
        small: rendition(
            small.finish()?,
            "image/gif",
            small_wh.0,
            small_wh.1,
            count,
            ms,
        ),
        large: rendition(
            large.finish()?,
            "image/gif",
            large_wh.0,
            large_wh.1,
            count,
            ms,
        ),
        thumb: thumb.ok_or(Rejected::Invalid)?,
        still,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn saturated_decoder_rejects_inputs_before_spawning_or_queuing() {
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        for _ in 0..8 {
            let result = tokio::time::timeout(
                Duration::from_millis(100),
                supervised(
                    vec![0; INPUT_BYTES],
                    std::path::PathBuf::from("/nonexistent-expression-decoder"),
                    DEADLINE,
                    sem.clone(),
                    RenditionTable::Legacy,
                ),
            )
            .await;
            assert!(
                matches!(result, Ok(Err(Rejected::Busy))),
                "busy inputs must finish without a queued supervisor"
            );
        }
        drop(held);
        assert_eq!(sem.available_permits(), 2);
    }
    const NO_DECODER: &str = "/nonexistent-expression-decoder";

    /// Wait until `standing` reads `want` (the waiters registered themselves), or fail.
    async fn until_standing(standing: &std::sync::atomic::AtomicUsize, want: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while standing.load(std::sync::atomic::Ordering::Acquire) != want {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "the line never reached {want}: {}",
                standing.load(std::sync::atomic::Ordering::Acquire)
            )
        });
    }

    #[tokio::test]
    async fn a_waiter_never_stands_in_line_longer_than_the_cap_whatever_it_is_allowed() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        let line = Line {
            standing: &STANDING,
            max: 2,
            longest: Duration::from_millis(150),
        };
        let started = Instant::now();
        // The caller allows 40 s; the line's own cap is 150 ms. The outer 3 s is only the
        // test's way of failing instead of hanging if the cap is gone.
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            waiting(
                vec![0; 8],
                std::path::PathBuf::from(NO_DECODER),
                DEADLINE,
                sem.clone(),
                &line,
                Duration::from_secs(40),
                RenditionTable::Legacy,
            ),
        )
        .await;
        let waited = started.elapsed();
        assert!(
            matches!(outcome, Ok(Err(Rejected::Busy))),
            "a wait that ran out is Busy: {outcome:?}"
        );
        assert!(
            waited >= Duration::from_millis(120),
            "it did stand in line for the cap: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(2),
            "and not for the 40 s it was allowed: {waited:?}"
        );
        assert_eq!(
            STANDING.load(std::sync::atomic::Ordering::Acquire),
            0,
            "the place went back with the wait"
        );
        drop(held);
    }

    #[tokio::test]
    async fn only_the_cap_may_stand_in_line_and_the_next_is_refused_at_once() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let line = || Line {
            standing: &STANDING,
            max: 2,
            longest: Duration::from_secs(5),
        };
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        let mut queued = Vec::new();
        for _ in 0..2 {
            let sem = sem.clone();
            queued.push(tokio::spawn(async move {
                waiting(
                    vec![0; 8],
                    std::path::PathBuf::from(NO_DECODER),
                    DEADLINE,
                    sem,
                    &line(),
                    Duration::from_secs(5),
                    RenditionTable::Legacy,
                )
                .await
            }));
        }
        until_standing(&STANDING, 2).await;
        // The line is full: a third caller is refused without waiting at all.
        let started = Instant::now();
        let third = tokio::time::timeout(
            Duration::from_millis(500),
            waiting(
                vec![0; 8],
                std::path::PathBuf::from(NO_DECODER),
                DEADLINE,
                sem.clone(),
                &line(),
                Duration::from_secs(5),
                RenditionTable::Legacy,
            ),
        )
        .await;
        assert!(
            matches!(third, Ok(Err(Rejected::Busy))),
            "a full line refuses at once: {third:?}"
        );
        assert!(started.elapsed() < Duration::from_millis(400));
        assert_eq!(
            STANDING.load(std::sync::atomic::Ordering::Acquire),
            2,
            "the refused caller took no place"
        );
        // The two in line were really queued, not refused: once the slots free up they run
        // (and meet the missing decoder, which is `Invalid`, not `Busy`).
        drop(held);
        for waiter in queued {
            let outcome = tokio::time::timeout(Duration::from_secs(3), waiter)
                .await
                .expect("a queued waiter is served when a slot frees")
                .expect("the waiter task finished");
            assert!(
                matches!(outcome, Err(Rejected::Invalid)),
                "served, not refused: {outcome:?}"
            );
        }
        assert_eq!(STANDING.load(std::sync::atomic::Ordering::Acquire), 0);
        assert_eq!(sem.available_permits(), 2);
    }

    #[tokio::test]
    async fn a_cancelled_waiter_gives_its_place_back() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        let waiter = tokio::spawn({
            let sem = sem.clone();
            async move {
                waiting(
                    vec![0; 8],
                    std::path::PathBuf::from(NO_DECODER),
                    DEADLINE,
                    sem,
                    &Line {
                        standing: &STANDING,
                        max: 1,
                        longest: Duration::from_secs(30),
                    },
                    Duration::from_secs(30),
                    RenditionTable::Legacy,
                )
                .await
            }
        });
        until_standing(&STANDING, 1).await;
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        until_standing(&STANDING, 0).await;
        drop(held);
    }

    /// The line **`process_waiting` really stands in** — the process-wide one, with the
    /// documented caps — and not one a test built for itself: two places, three seconds. (One
    /// test, because the slots and the line are the process's own and other tests of this
    /// binary must not meet it half-way.)
    ///
    /// The two numbers are written out below as numbers (#4900). A test that takes its
    /// expectation from the constant it is testing is green for any value of that constant: the
    /// caps are what the process promises a person who is waiting behind an agent, so they are
    /// pinned here by value and every measurement uses the value, not the name.
    #[tokio::test]
    async fn process_waiting_stands_in_the_process_wide_line_for_two_places_and_three_seconds() {
        assert_eq!(WAIT_MAX, Duration::from_secs(3), "the documented wait cap");
        assert_eq!(WAITERS_MAX, 2, "the documented line");
        let wide = Line::process_wide();
        assert_eq!(
            (wide.max, wide.longest),
            (2, Duration::from_secs(3)),
            "the line `process_waiting` stands in is built from those two numbers"
        );
        let held = decoder_slots().acquire_many_owned(2).await.unwrap();
        // A caller that would wait 40 s waits three seconds, and is told Busy.
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(7),
            process_waiting(vec![0; 8], Duration::from_secs(40), RenditionTable::Legacy),
        )
        .await;
        let waited = started.elapsed();
        assert!(
            matches!(outcome, Ok(Err(Rejected::Busy))),
            "a wait that ran out is Busy: {outcome:?}"
        );
        assert!(
            waited >= Duration::from_millis(2_800) && waited < Duration::from_secs(4),
            "it stood in line for three seconds and no longer: {waited:?}"
        );
        // Two callers fill the line; the third is refused at once.
        let queued: Vec<_> = (0..2)
            .map(|_| {
                tokio::spawn(process_waiting(
                    vec![0; 8],
                    Duration::from_secs(40),
                    RenditionTable::Legacy,
                ))
            })
            .collect();
        until_standing(Line::process_wide().standing, 2).await;
        let started = Instant::now();
        let third = tokio::time::timeout(
            Duration::from_millis(500),
            process_waiting(vec![0; 8], Duration::from_secs(40), RenditionTable::Legacy),
        )
        .await;
        assert!(
            matches!(third, Ok(Err(Rejected::Busy))),
            "a full line refuses at once: {third:?}"
        );
        assert!(started.elapsed() < Duration::from_millis(400));
        // Free the slots: the two in line are served (whatever the decoder makes of eight
        // zero bytes, it is not `Busy`), and the line empties.
        drop(held);
        for waiter in queued {
            let outcome = tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .expect("a queued caller is served when the slots free up")
                .expect("the caller's task finished");
            assert!(
                !matches!(outcome, Err(Rejected::Busy)),
                "served, not refused: {outcome:?}"
            );
        }
        until_standing(Line::process_wide().standing, 0).await;
    }

    fn mp4_video() -> Vec<u8> {
        let mut b = vec![0, 0, 0, 0x18];
        b.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2mp41");
        b.extend_from_slice(&[0; 64]);
        b
    }
    fn quicktime_video() -> Vec<u8> {
        let mut b = vec![0, 0, 0, 0x14];
        b.extend_from_slice(b"ftypqt  \0\0\0\0qt  ");
        b.extend_from_slice(&[0; 64]);
        b
    }
    fn webm_video() -> Vec<u8> {
        let mut b = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f];
        b.extend_from_slice(&[0; 64]);
        b
    }

    /// #4900: a video is refused by the parent from its first bytes. Both slots are taken and the
    /// line has no room, and the answer is still the card (`Video`), at once: not `Busy` (nothing
    /// a slot does could ever help it), not a place in the line, not a child process (the decoder
    /// path is one that does not exist, so a spawn would have been `Invalid`). A picture in the
    /// very same situation **is** `Busy`, which is what makes the first half mean something.
    #[tokio::test]
    async fn a_video_asks_for_no_slot_no_place_in_line_and_no_child() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        let no_room = || Line {
            standing: &STANDING,
            max: 0,
            longest: Duration::from_secs(5),
        };
        let picture = png_still();
        for (what, bytes) in [
            ("mp4", mp4_video()),
            ("quicktime", quicktime_video()),
            ("webm", webm_video()),
        ] {
            let direct = tokio::time::timeout(
                Duration::from_millis(150),
                supervised(
                    bytes.clone(),
                    std::path::PathBuf::from(NO_DECODER),
                    DEADLINE,
                    sem.clone(),
                    RenditionTable::Legacy,
                ),
            )
            .await;
            assert!(
                matches!(direct, Ok(Err(Rejected::Video))),
                "{what}: a video that is not allowed to wait is a card, not busy: {direct:?}"
            );
            let started = Instant::now();
            let waited = tokio::time::timeout(
                Duration::from_millis(150),
                waiting(
                    bytes,
                    std::path::PathBuf::from(NO_DECODER),
                    DEADLINE,
                    sem.clone(),
                    &no_room(),
                    Duration::from_secs(40),
                    RenditionTable::Legacy,
                ),
            )
            .await;
            assert!(
                matches!(waited, Ok(Err(Rejected::Video))),
                "{what}: a video that may wait is a card too, at once: {waited:?}"
            );
            assert!(started.elapsed() < Duration::from_millis(140), "{what}");
            assert_eq!(STANDING.load(std::sync::atomic::Ordering::Acquire), 0);
        }
        // The control: the same slots and the same line, a picture. It is busy, in both doors.
        let direct = tokio::time::timeout(
            Duration::from_millis(150),
            supervised(
                picture.clone(),
                std::path::PathBuf::from(NO_DECODER),
                DEADLINE,
                sem.clone(),
                RenditionTable::Legacy,
            ),
        )
        .await;
        assert!(matches!(direct, Ok(Err(Rejected::Busy))), "{direct:?}");
        let waited = tokio::time::timeout(
            Duration::from_millis(150),
            waiting(
                picture,
                std::path::PathBuf::from(NO_DECODER),
                DEADLINE,
                sem.clone(),
                &no_room(),
                Duration::from_secs(40),
                RenditionTable::Legacy,
            ),
        )
        .await;
        assert!(matches!(waited, Ok(Err(Rejected::Busy))), "{waited:?}");
        assert_eq!(sem.available_permits(), 0, "the slots were never touched");
        drop(held);
        assert_eq!(sem.available_permits(), 2);
    }

    fn png_still() -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(8, 6)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn webp_inner_dimension_bomb_never_constructs_a_codec() {
        let bomb=hex::decode("524946462800000057454250565038580a00000000000000000000000000565038200a0000001000009d012aff3fff3f").unwrap();
        CODEC_STARTS.with(|n| n.set(0));
        assert_eq!(
            decode(&bomb, Instant::now() + DEADLINE).unwrap_err(),
            Rejected::Invalid
        );
        CODEC_STARTS.with(|n| assert_eq!(n.get(), 0, "decoder allocated before validation"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn canceled_requests_keep_both_permits_until_children_are_killed_and_reaped() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("oort-expression-child-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("decoder");
        // exec preserves the PID: only this fixture process is supervised.
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\necho $$ > '{}/pid-'$$\nexec /bin/sleep 30\n",
                dir.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sem = Arc::new(Semaphore::new(2));
        let mut jobs = Vec::new();
        for _ in 0..2 {
            let s = sem.clone();
            let p = path.clone();
            jobs.push(tokio::spawn(supervised(
                Vec::new(),
                p,
                Duration::from_secs(1),
                s,
                RenditionTable::Legacy,
            )));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("pid-"))
                .count()
                != 2
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(sem.available_permits(), 0);
        for job in jobs {
            job.abort();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(20), sem.clone().acquire_owned())
                .await
                .is_err()
        );
        let permits =
            tokio::time::timeout(Duration::from_secs(3), sem.clone().acquire_many_owned(2))
                .await
                .unwrap()
                .unwrap();
        for entry in std::fs::read_dir(&dir).unwrap().map(Result::unwrap) {
            if entry.file_name().to_string_lossy().starts_with("pid-") {
                let pid = std::fs::read_to_string(entry.path()).unwrap();
                assert!(
                    !std::process::Command::new("/bin/kill")
                        .args(["-0", pid.trim()])
                        .stderr(std::process::Stdio::null())
                        .status()
                        .unwrap()
                        .success(),
                    "permit released before child exit/reap"
                );
            }
            std::fs::remove_file(entry.path()).unwrap();
        }
        drop(permits);
        std::fs::remove_dir(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn child_deadline_is_enforced_and_never_returns_unbounded_output() {
        use std::os::unix::fs::PermissionsExt;
        let path =
            std::env::temp_dir().join(format!("oort-expression-decoder-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            child(Vec::new(), path.clone(), Duration::from_millis(30)).await,
            Err(Rejected::Timeout)
        ));
        std::fs::write(
            &path,
            "#!/bin/sh\nexec /usr/bin/head -c 8388609 /dev/zero\n",
        )
        .unwrap();
        assert!(matches!(
            child(Vec::new(), path.clone(), Duration::from_secs(5)).await,
            Err(Rejected::Invalid)
        ));
        std::fs::remove_file(path).unwrap();
    }

    /// #6071: the four renditions of the §20 table at their byte caps (4.75 MiB) come back through the
    /// child's stdout. As a JSON array of numbers they would be about 19 MiB, past the 8 MiB the parent
    /// reads, and a valid moving picture would end as `Invalid`.
    #[test]
    fn the_largest_wide_picture_fits_what_the_parent_reads_back() {
        let sizes = RenditionTable::Wide.sizes();
        let full = |bytes: usize| rendition(vec![0xFF; bytes], "image/png", 1, 1, 1, 0);
        let worst = Processed {
            small: full(sizes.small_bytes),
            thumb: full(sizes.thumb_bytes),
            large: full(sizes.large_bytes),
            still: Some(full(sizes.large_bytes)),
        };
        let wire = serde_json::to_vec(&Ok::<Processed, Rejected>(worst.clone())).unwrap();
        assert!(
            wire.len() <= CHILD_OUTPUT_MAX,
            "{} bytes of answer, the parent reads {CHILD_OUTPUT_MAX}",
            wire.len()
        );
        let back: Result<Processed, Rejected> = serde_json::from_slice(&wire).unwrap();
        let back = back.unwrap();
        assert!(
            back.large.data == worst.large.data && back.still.unwrap().data == worst.large.data
        );
        // An answer from before this field (no `still`) still reads.
        let mut old = serde_json::to_value(Ok::<Processed, Rejected>(Processed {
            still: None,
            ..worst
        }))
        .unwrap();
        assert!(old["Ok"].get("still").is_none(), "no still, no key");
        old["Ok"].as_object_mut().unwrap().remove("still");
        let back: Result<Processed, Rejected> = serde_json::from_value(old).unwrap();
        assert!(back.unwrap().still.is_none());
    }

    /// The tables are the shared vectors (`docs/api/expression-rendition-table.vectors.json`), which the
    /// core's reader bounds are checked against too: the server cannot start storing a size the readers
    /// it was turned on for refuse, without one of the two tests going red.
    #[test]
    fn the_tables_are_the_shared_vectors_the_readers_are_checked_against() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/api/expression-rendition-table.vectors.json"
        );
        let vectors: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("the shared vectors"))
                .expect("vectors are JSON");
        for (name, table) in [("legacy", RenditionTable::Legacy), ("wide", RenditionTable::Wide)] {
            let v = &vectors[name];
            let s = table.sizes();
            let pair = |key: &str| (v[key]["edge"].as_u64(), v[key]["bytes"].as_u64());
            let ours = |edge: u32, bytes: usize| (Some(u64::from(edge)), Some(bytes as u64));
            assert_eq!(pair("small"), ours(s.small_edge, s.small_bytes), "{name} small");
            assert_eq!(pair("thumb"), ours(s.thumb_edge, s.thumb_bytes), "{name} thumb");
            assert_eq!(pair("large"), ours(s.large_edge, s.large_bytes), "{name} large");
            if s.still {
                assert_eq!(pair("still"), ours(s.large_edge, s.large_bytes), "{name} still");
            } else {
                assert!(v["still"].is_null(), "{name} still");
            }
            assert_eq!(v["motionCanvas"].as_u64(), Some(u64::from(s.motion_canvas)));
            let worst = &vectors["worstBytes"][name];
            assert_eq!(worst["still"].as_u64(), Some(s.worst_bytes(false) as u64));
            assert_eq!(worst["moving"].as_u64(), Some(s.worst_bytes(true) as u64));
        }
    }

    /// ZA11 · ZA6: the worst stored bytes of one picture are the sum of the caps (Z4), and the table
    /// moves only the rendition caps and the canvas — the decoder's own limits are one set of
    /// constants that neither table names.
    #[test]
    fn the_tables_worst_bytes_are_the_sum_of_their_caps() {
        const MIB: usize = 1024 * 1024;
        let wide = RenditionTable::Wide.sizes();
        assert_eq!(wide.worst_bytes(false) * 4, 11 * MIB, "a still: 2.75 MiB");
        assert_eq!(
            wide.worst_bytes(true) * 4,
            19 * MIB,
            "a moving picture: 4.75 MiB"
        );
        let old = RenditionTable::Legacy.sizes();
        assert_eq!(old.worst_bytes(false) * 2, 3 * MIB, "1.5 MiB, as D2 said");
        assert_eq!(
            old.worst_bytes(true),
            old.worst_bytes(false),
            "no still at the old table"
        );
        assert_eq!(
            (ALLOCATION_LIMIT, DEADLINE),
            (192 * MIB as u64, Duration::from_secs(10))
        );
        assert_eq!(RenditionTable::default(), RenditionTable::Legacy);
        assert_eq!(
            RenditionTable::from_setting(None),
            Some(RenditionTable::Legacy)
        );
        assert_eq!(
            RenditionTable::from_setting(Some(" ")),
            Some(RenditionTable::Legacy)
        );
        assert_eq!(
            RenditionTable::from_setting(Some("512")),
            Some(RenditionTable::Legacy)
        );
        assert_eq!(
            RenditionTable::from_setting(Some("768")),
            Some(RenditionTable::Wide)
        );
        for unreadable in ["wide", "1", "true", "7680", "768px"] {
            assert_eq!(
                RenditionTable::from_setting(Some(unreadable)),
                None,
                "{unreadable}"
            );
        }
    }

    /// What the child writes for a prepared photo, the way it writes it (`main.rs`).
    fn child_answer(data: Vec<u8>) -> Vec<u8> {
        serde_json::to_vec(&Ok::<Prepared, Rejected>(Prepared {
            mime: "image/png".into(),
            data,
        }))
        .unwrap()
    }

    #[test]
    fn a_prepared_photo_of_the_largest_size_fits_what_the_parent_reads_back() {
        // The worst bytes for a list of numbers (`255,` is four characters); base64 does not care.
        let largest = vec![0xFF; PREPARED_MAX_BYTES];
        let wire = child_answer(largest.clone());
        assert!(
            wire.len() <= CHILD_OUTPUT_MAX,
            "{} bytes of answer for {} bytes of picture, the parent reads {CHILD_OUTPUT_MAX}",
            wire.len(),
            largest.len()
        );
        let back: Result<Prepared, Rejected> = serde_json::from_slice(&wire).unwrap();
        assert!(
            back.unwrap().data == largest,
            "the picture came back unchanged"
        );
        // Every byte value survives, and so does nothing at all.
        let every: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        let back: Result<Prepared, Rejected> =
            serde_json::from_slice(&child_answer(every.clone())).unwrap();
        assert!(back.unwrap().data == every);
        let back: Result<Prepared, Rejected> =
            serde_json::from_slice(&child_answer(Vec::new())).unwrap();
        assert!(back.unwrap().data.is_empty());
        // A string that is not base64 is not a picture: the parent answers `Invalid` for it.
        assert!(serde_json::from_str::<Result<Prepared, Rejected>>(
            r#"{"Ok":{"mime":"image/png","data":"not base64 ***"}}"#
        )
        .is_err());
    }

    #[test]
    fn a_prepared_photo_prints_its_size_and_never_its_bytes() {
        let photo = Prepared {
            mime: "image/png".into(),
            data: b"MEMBERS-OWN-PHOTO-BYTES".to_vec(),
        };
        let shown = format!("{photo:?} {photo:#?}");
        // Neither the bytes as numbers (`77, 69, 77` is "MEM") nor as text.
        assert!(
            !shown.contains("77, 69, 77") && !shown.contains("MEMBERS"),
            "{shown}"
        );
        assert!(
            shown.contains("image/png") && shown.contains("23"),
            "{shown}"
        );
    }

    #[tokio::test]
    async fn a_slot_that_frees_up_within_the_patience_is_taken_after_the_line_gave_up_once() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        // One stint in line is 40 ms and the slots come free after 250 ms: a single ask is long over.
        let line = Line {
            standing: &STANDING,
            max: 2,
            longest: Duration::from_millis(40),
        };
        let freeing = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            drop(held);
        });
        let started = Instant::now();
        let permit = tokio::time::timeout(
            Duration::from_secs(3),
            permit_patiently(
                sem.clone(),
                &line,
                Duration::from_secs(2),
                Duration::from_millis(10),
            ),
        )
        .await
        .expect("it did not hang")
        .expect("the slot is taken once it is free");
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(200) && waited < Duration::from_secs(1),
            "it took the slot when it came free: {waited:?}"
        );
        drop(permit);
        freeing.await.unwrap();
        assert_eq!(
            STANDING.load(std::sync::atomic::Ordering::Acquire),
            0,
            "no place is left standing in line"
        );
    }

    #[tokio::test]
    async fn the_asking_stops_when_the_patience_is_gone_and_not_when_the_line_cap_is() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let _held = sem.clone().acquire_many_owned(2).await.unwrap();
        // The line would let it stand for 5 s; the patience is 300 ms.
        let line = Line {
            standing: &STANDING,
            max: 2,
            longest: Duration::from_secs(5),
        };
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(3),
            permit_patiently(
                sem.clone(),
                &line,
                Duration::from_millis(300),
                Duration::from_millis(20),
            ),
        )
        .await;
        let waited = started.elapsed();
        assert!(
            matches!(outcome, Ok(Err(Rejected::Busy))),
            "a patience that ran out is Busy: {outcome:?}"
        );
        assert!(
            waited >= Duration::from_millis(280),
            "it asked for the whole patience: {waited:?}"
        );
        assert!(
            waited < Duration::from_millis(1500),
            "and not for the line's 5 s: {waited:?}"
        );
        assert_eq!(STANDING.load(std::sync::atomic::Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn a_full_line_does_not_end_the_asking() {
        static STANDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sem = Arc::new(Semaphore::new(2));
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        // A line with no room at all: every ask is refused at once.
        let line = Line {
            standing: &STANDING,
            max: 0,
            longest: Duration::from_millis(50),
        };
        assert!(matches!(
            permit_waiting(sem.clone(), &line, Duration::from_secs(1)).await,
            Err(Rejected::Busy)
        ));
        let freeing = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            drop(held);
        });
        let permit = tokio::time::timeout(
            Duration::from_secs(3),
            permit_patiently(
                sem.clone(),
                &line,
                Duration::from_secs(2),
                Duration::from_millis(10),
            ),
        )
        .await
        .expect("it did not hang");
        assert!(permit.is_ok(), "{permit:?}");
        freeing.await.unwrap();
    }
}
