//! Pixel-only renditions. Bounds precede decoding; animations are never collected.
//! The supervisor owns its permit until the codec subprocess is killed/reaped.
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::metadata::Orientation;
use image::{
    AnimationDecoder, Delay, DynamicImage, Frame, ImageDecoder, ImageEncoder, ImageFormat,
    ImageReader, Limits,
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::{ImageInfo, INPUT_BYTES};

pub const ALLOCATION_LIMIT: u64 = 192 * 1024 * 1024;
const SCRATCH: u64 = 16 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(10);

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
    pub data: Vec<u8>,
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Processed {
    pub small: Rendition,
    pub large: Rendition,
    pub thumb: Rendition,
}
impl Processed {
    pub fn variants(&self) -> [(&'static str, &Rendition); 3] {
        [
            ("small", &self.small),
            ("large", &self.large),
            ("thumb", &self.thumb),
        ]
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

pub async fn process(bytes: Vec<u8>) -> Result<Processed, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    supervised(bytes, decoder_path()?, DEADLINE, decoder_slots()).await
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
pub async fn process_waiting(bytes: Vec<u8>, wait: Duration) -> Result<Processed, Rejected> {
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
) -> Result<Processed, Rejected> {
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    let permit = permit_waiting(semaphore, line, wait).await?;
    run_with_permit(bytes, path, deadline, permit).await
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
) -> Result<Processed, Rejected> {
    if let Some(rejected) = refused_before_a_slot(&bytes) {
        return Err(rejected);
    }
    // Admission happens before detaching: canceled callers cannot accumulate
    // an unbounded queue of 5 MiB inputs waiting behind the two codec slots.
    let permit = semaphore.try_acquire_owned().map_err(|_| Rejected::Busy)?;
    run_with_permit(bytes, path, deadline, permit).await
}

async fn run_with_permit(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Processed, Rejected> {
    // The supervisor survives cancellation of the HTTP request and retains its
    // permit until the actual child has exited and been reaped.
    let task = tokio::spawn(async move {
        let _permit = permit;
        child(bytes, path, deadline).await
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
async fn child(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
) -> Result<Processed, Rejected> {
    child_typed::<Processed>(bytes, path, deadline, None).await
}

/// One job in the codec subprocess. `mode` is a fixed argument of the child (`--prepare`,
/// `--cutout`), never anything a member wrote; the bytes go in on stdin, the answer comes back as
/// JSON on stdout, and nothing else (no URL, path, environment or database) is passed.
async fn child_typed<T: serde::de::DeserializeOwned>(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    mode: Option<&'static str>,
) -> Result<T, Rejected> {
    let mut command = tokio::process::Command::new(path);
    command.env_clear();
    if let Some(mode) = mode {
        command.arg(mode);
    }
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Rejected::Invalid)?;
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
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .await
            .map_err(|_| Rejected::Invalid)?;
        if data.len() > 8 * 1024 * 1024 {
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
    mode: &'static str,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<T, Rejected> {
    let path = decoder_path()?;
    let task = tokio::spawn(async move {
        let _permit = permit;
        child_typed::<T>(bytes, path, DEADLINE, Some(mode)).await
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
    job(bytes, "--prepare", permit).await
}

/// What an image model drew, as a cut-out ([`decode_cutout`], in the isolated child). The model
/// call has been paid for by now, so a busy decoder is **waited for** (as an agent's candidates
/// are, [`WAIT_MAX`]) instead of refused at once.
pub async fn process_cutout(bytes: Vec<u8>, wait: Duration) -> Result<Cutout, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    let permit = permit_waiting(decoder_slots(), &Line::process_wide(), wait).await?;
    job(bytes, "--cutout", permit).await
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
fn png(image: &image::RgbaImage, max: usize, end: Instant) -> Result<Rendition, Rejected> {
    let mut out = output(max, end);
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| Rejected::Invalid)?;
    Ok(rendition(
        out.data,
        "image/png",
        image.width(),
        image.height(),
        1,
        0,
    ))
}

/// Container preflight for GIF: count ALL images and delays without allocating
/// frames. Reject oversized subrects before the decoder allocates its buffer.
fn gif_spec(b: &[u8]) -> Result<(u32, u32, u32, u32), Rejected> {
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
                    || (frames > 1 && (w > 512 || h > 512 || ms > 10000))
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
fn preflight(format: ImageFormat, b: &[u8]) -> Result<(u32, u32), Rejected> {
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
            let (w, h, _, _) = gif_spec(b)?;
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
/// opened, whatever it is opened for. Bounds come first, animations are never collected.
fn open(bytes: &[u8], end: Instant) -> Result<Opened, Rejected> {
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
    let expected = preflight(format, bytes)?;
    if format == ImageFormat::Gif && gif_spec(bytes)?.2 > 1 {
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

pub fn decode(bytes: &[u8], end: Instant) -> Result<Processed, Rejected> {
    match open(bytes, end)? {
        Opened::Animated => animated(bytes, end),
        Opened::Still(image, _) => {
            let small = png(&shrink(&image, 128), 256 * 1024, end)?;
            let large = png(&shrink(&image, 512), 1024 * 1024, end)?;
            Ok(Processed {
                thumb: small.clone(),
                small,
                large,
            })
        }
    }
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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Prepared {
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    pub data: Vec<u8>,
}

pub fn prepare(bytes: &[u8], end: Instant) -> Result<Prepared, Rejected> {
    // A moving picture is not a photo: it is refused here, not sampled.
    let Opened::Still(mut image, orientation) = open(bytes, end)? else {
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
    let Opened::Still(image, _) = open(bytes, end)? else {
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
    let small = png(&shrink(&image, 128), 256 * 1024, end)?;
    let large = png(&shrink(&image, 512), 1024 * 1024, end)?;
    Ok(Cutout {
        processed: Processed {
            thumb: small.clone(),
            small,
            large,
        },
        outcome,
    })
}

fn animated(bytes: &[u8], end: Instant) -> Result<Processed, Rejected> {
    let (_, _, count, ms) = gif_spec(bytes)?;
    let input = std::io::BufReader::new(TimedReader {
        input: Cursor::new(bytes),
        end,
    });
    let mut decoder = GifDecoder::new(input).map_err(|_| Rejected::Invalid)?;
    decoder
        .set_limits(limits(512))
        .map_err(|_| Rejected::Invalid)?;
    let (mut small_out, mut large_out) = (output(256 * 1024, end), output(1024 * 1024, end));
    let (mut small_wh, mut large_wh) = ((0, 0), (0, 0));
    let mut thumb = None;
    {
        let mut small = GifEncoder::new_with_speed(&mut small_out, 30);
        let mut large = GifEncoder::new_with_speed(&mut large_out, 30);
        // NETSCAPE repeat count is repetitions AFTER the initial pass: 3+1=4.
        small
            .set_repeat(Repeat::Finite(3))
            .map_err(|_| Rejected::Invalid)?;
        large
            .set_repeat(Repeat::Finite(3))
            .map_err(|_| Rejected::Invalid)?;
        let mut seen = 0;
        for frame in decoder.into_frames() {
            check(end).map_err(|_| Rejected::Timeout)?;
            let frame = frame.map_err(|_| Rejected::Invalid)?;
            let (num, denom) = frame.delay().numer_denom_ms();
            let delay = Delay::from_numer_denom_ms((num / denom.max(1)).max(20), 1);
            let image = DynamicImage::ImageRgba8(frame.into_buffer());
            let s = shrink(&image, 128);
            let l = shrink(&image, 512);
            small_wh = s.dimensions();
            large_wh = l.dimensions();
            if thumb.is_none() {
                thumb = Some(png(&s, 256 * 1024, end)?);
            }
            small
                .encode_frame(Frame::from_parts(s, 0, 0, delay))
                .map_err(|_| Rejected::Invalid)?;
            large
                .encode_frame(Frame::from_parts(l, 0, 0, delay))
                .map_err(|_| Rejected::Invalid)?;
            seen += 1;
        }
        if seen != count {
            return Err(Rejected::Invalid);
        }
    }
    Ok(Processed {
        small: rendition(
            small_out.data,
            "image/gif",
            small_wh.0,
            small_wh.1,
            count,
            ms,
        ),
        large: rendition(
            large_out.data,
            "image/gif",
            large_wh.0,
            large_wh.1,
            count,
            ms,
        ),
        thumb: thumb.ok_or(Rejected::Invalid)?,
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
            process_waiting(vec![0; 8], Duration::from_secs(40)),
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
            .map(|_| tokio::spawn(process_waiting(vec![0; 8], Duration::from_secs(40))))
            .collect();
        until_standing(Line::process_wide().standing, 2).await;
        let started = Instant::now();
        let third = tokio::time::timeout(
            Duration::from_millis(500),
            process_waiting(vec![0; 8], Duration::from_secs(40)),
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
}
