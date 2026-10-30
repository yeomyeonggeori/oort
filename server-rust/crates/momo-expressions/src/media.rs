//! Pixel-only renditions. Bounds precede decoding; animations are never collected.
//! The supervisor owns its permit until the codec subprocess is killed/reaped.
use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
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

/// [`process`], but a busy decoder is **waited for** up to `wait` instead of refused at
/// once. Used by the agent action, whose candidates are decoded one after another inside
/// one deadline. The wait is the only difference: the input bound, the two slots, the
/// supervised child and its limits are the same ones, and an exhausted wait is
/// [`Rejected::Busy`], never `Timeout`.
pub async fn process_waiting(bytes: Vec<u8>, wait: Duration) -> Result<Processed, Rejected> {
    if bytes.len() > INPUT_BYTES {
        return Err(Rejected::TooLarge);
    }
    let permit = tokio::time::timeout(wait, decoder_slots().acquire_owned())
        .await
        .map_err(|_| Rejected::Busy)?
        .map_err(|_| Rejected::Invalid)?;
    run_with_permit(bytes, decoder_path()?, DEADLINE, permit).await
}

async fn supervised(
    bytes: Vec<u8>,
    path: std::path::PathBuf,
    deadline: Duration,
    semaphore: Arc<Semaphore>,
) -> Result<Processed, Rejected> {
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
    let mut child = tokio::process::Command::new(path)
        .env_clear()
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
        serde_json::from_slice::<Result<Processed, Rejected>>(&data)
            .map_err(|_| Rejected::Invalid)?
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

pub fn decode(bytes: &[u8], end: Instant) -> Result<Processed, Rejected> {
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
        return animated(bytes, end);
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
    let decoder = reader.into_decoder().map_err(|_| Rejected::Invalid)?;
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
    let image = DynamicImage::from_decoder(decoder).map_err(|_| Rejected::Invalid)?;
    let small = png(&shrink(&image, 128), 256 * 1024, end)?;
    let large = png(&shrink(&image, 512), 1024 * 1024, end)?;
    Ok(Processed {
        thumb: small.clone(),
        small,
        large,
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
