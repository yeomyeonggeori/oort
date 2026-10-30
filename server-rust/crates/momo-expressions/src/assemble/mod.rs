//! ADR-0218 G3: server-side motion assembly. The agent brings one picture; the server puts motion
//! on it and returns GIF candidates. Nothing is generated and nothing is fetched here.
//!
//! The work runs in the isolated-decoder pattern of [`crate::media`]: a child process
//! (`momo-expression-assembler`) with the same resource limits decodes the picture, composes the
//! frames one at a time, encodes them and sends the result back through the D3 re-encode of
//! [`crate::media::decode`]. The parent owns a decoder slot (an [`OwnedSemaphorePermit`] handed in
//! by the caller) from before the child starts until it has been killed and reaped, so a call
//! without a slot cannot start and a cancelled call cannot free a slot early.
//!
//! The codes of [`AssembleError`] are the closed list of ADR-0218 G3.8, plus
//! [`AssembleError::Unavailable`] for an operator fault that is not a property of the request.
mod input;
mod render;

use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::codecs::gif::{GifEncoder, Repeat};
use image::{ColorType, Delay, DynamicImage, Frame, ImageDecoder, ImageReader, Limits, RgbaImage};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::media::{self, Processed, Rejected, Rendition, ALLOCATION_LIMIT};
use crate::{ImageInfo, INPUT_BYTES};
use render::{Canvas, Pose, Tile};

/// G3.2: canvas sides.
pub const SIZES: [u32; 3] = [240, 360, 480];
pub const DEFAULT_SIZE: u32 = 360;
/// G3.2: a picture carried in a request is at most 4 MiB after base64 decoding.
pub const REQUEST_SOURCE_BYTES: usize = 4 * 1024 * 1024;
/// D3: a stored candidate is at most 1 MiB.
pub const MAX_CANDIDATE_BYTES: usize = 1024 * 1024;
/// One budget for the whole call, all candidates together (G3.5).
pub const DEADLINE: Duration = Duration::from_secs(10);
/// NETSCAPE loop count: repetitions after the first pass. 3 + 1 = four plays (D3).
const REPEAT_AFTER_FIRST_PLAY: u16 = 3;
/// NeuQuant speed of the assembly encoder (1 best .. 30 fastest).
const GIF_SPEED: i32 = 10;
/// Hard ceiling of the encoder sink. Above [`MAX_CANDIDATE_BYTES`] the true size is measured and
/// reported, never truncated.
const SINK_CEILING: usize = 16 * 1024 * 1024;
const SCRATCH: u64 = 16 * 1024 * 1024;
const MAX_PLAY_MS: u32 = 10_000;
/// Worst case child output: 4 candidates x (1 MiB + 2 x 256 KiB) as hex, plus JSON.
const OUTPUT_LIMIT: usize = 16 * 1024 * 1024 + 1;
const HEADER_LIMIT: usize = 64 * 1024;

// ---- request ----------------------------------------------------------------------------
/// G3.3 presets. One candidate per preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Bounce,
    Wobble,
    Pulse,
    Sparkle,
}

impl Preset {
    pub const ALL: [Preset; 4] = [
        Preset::Bounce,
        Preset::Wobble,
        Preset::Pulse,
        Preset::Sparkle,
    ];
    pub const fn id(self) -> &'static str {
        match self {
            Preset::Bounce => "bounce",
            Preset::Wobble => "wobble",
            Preset::Pulse => "pulse",
            Preset::Sparkle => "sparkle",
        }
    }
    /// G3.3 table, "프레임".
    pub const fn frames(self) -> u32 {
        match self {
            Preset::Bounce | Preset::Wobble => 16,
            Preset::Pulse => 12,
            Preset::Sparkle => 20,
        }
    }
    /// G3.3 table, "프레임 지연".
    pub const fn delay_ms(self) -> u32 {
        match self {
            Preset::Bounce | Preset::Wobble => 40,
            Preset::Pulse | Preset::Sparkle => 50,
        }
    }
}

/// The two ways to move a picture (G3.2). The JSON shape is the `AssembleMotion` of G7.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Motion {
    Preset {
        presets: Vec<Preset>,
    },
    Sprite {
        frames: u32,
        sequence: Vec<u32>,
        #[serde(rename = "frameMs")]
        frame_ms: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssembleRequest {
    pub motion: Motion,
    #[serde(default = "default_size")]
    pub size: u32,
}
fn default_size() -> u32 {
    DEFAULT_SIZE
}

/// Where the picture came from, which decides its byte limit (G3.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceFrom {
    /// Carried in an agent request (base64 decoded): at most 4 MiB.
    Request,
    /// Moved inside the server (an attachment): at most 5 MiB, the D3 input limit.
    Server,
}
impl SourceFrom {
    pub const fn limit(self) -> usize {
        match self {
            SourceFrom::Request => REQUEST_SOURCE_BYTES,
            SourceFrom::Server => INPUT_BYTES,
        }
    }
}

impl AssembleRequest {
    pub fn new(motion: Motion) -> Self {
        Self {
            motion,
            size: DEFAULT_SIZE,
        }
    }

    /// G3.2/G3.8 `assembly_params_invalid`: every wrong parameter by name, nothing else.
    pub fn validate(&self) -> Result<(), AssembleError> {
        let mut bad = [false; 5];
        let mark = |bad: &mut [bool; 5], p: Param| bad[p as usize] = true;
        if !SIZES.contains(&self.size) {
            mark(&mut bad, Param::Size);
        }
        match &self.motion {
            Motion::Preset { presets } => {
                let duplicate = presets
                    .iter()
                    .enumerate()
                    .any(|(i, p)| presets[..i].contains(p));
                if presets.is_empty() || presets.len() > Preset::ALL.len() || duplicate {
                    mark(&mut bad, Param::Presets);
                }
            }
            Motion::Sprite {
                frames,
                sequence,
                frame_ms,
            } => {
                let frames_ok = (2..=4).contains(frames);
                if !frames_ok {
                    mark(&mut bad, Param::Frames);
                }
                let cells = if frames_ok { *frames } else { 4 };
                let length_ok = (2..=24).contains(&sequence.len());
                if !length_ok || sequence.iter().any(|cell| *cell >= cells) {
                    mark(&mut bad, Param::Sequence);
                }
                let delay_ok = (40..=500).contains(frame_ms);
                if !delay_ok {
                    mark(&mut bad, Param::FrameMs);
                }
                if length_ok
                    && delay_ok
                    && sequence.len() as u64 * u64::from(*frame_ms) > u64::from(MAX_PLAY_MS)
                {
                    mark(&mut bad, Param::Sequence);
                    mark(&mut bad, Param::FrameMs);
                }
            }
        }
        let params: Vec<Param> = Param::ALL
            .into_iter()
            .filter(|p| bad[*p as usize])
            .collect();
        if params.is_empty() {
            Ok(())
        } else {
            Err(AssembleError::ParamsInvalid { params })
        }
    }
}

/// The names `assembly_params_invalid` may carry: the parameters of G3.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Param {
    Presets,
    Frames,
    Sequence,
    FrameMs,
    Size,
}
impl Param {
    pub const ALL: [Param; 5] = [
        Param::Presets,
        Param::Frames,
        Param::Sequence,
        Param::FrameMs,
        Param::Size,
    ];
    pub const fn name(self) -> &'static str {
        match self {
            Param::Presets => "presets",
            Param::Frames => "frames",
            Param::Sequence => "sequence",
            Param::FrameMs => "frameMs",
            Param::Size => "size",
        }
    }
}

// ---- result -----------------------------------------------------------------------------
/// G3.8. The first six are the closed list of failure codes. `Unavailable` is not one of them: it
/// means the assembler could not run (missing binary, crash that is not a limit), never shows as
/// a card, and a caller answers it as an internal error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code")]
pub enum AssembleError {
    #[serde(rename = "assembly_params_invalid")]
    #[error("assembly parameters invalid: {params:?}")]
    ParamsInvalid { params: Vec<Param> },
    #[serde(rename = "assembly_source_invalid")]
    #[error("the picture cannot be animated")]
    SourceInvalid,
    #[serde(rename = "assembly_source_too_large")]
    #[error("the picture is too large")]
    SourceTooLarge,
    /// The measured size of the assembled GIF, never shrunk and retried (G3.8). Normally it is
    /// over 1 MiB. The D3 path that follows also caps the small rendition (256 KiB): a GIF that
    /// fits 1 MiB but not that cap ends here too, and then `bytes` is the assembled size, which
    /// can be below 1 MiB.
    #[serde(rename = "assembly_output_too_large")]
    #[error("the animation is {bytes} bytes, over the 1 MiB limit")]
    OutputTooLarge { bytes: u64 },
    /// Wall clock of 10 s or the allocation limit.
    #[serde(rename = "assembly_timeout")]
    #[error("assembly ran out of time or memory")]
    Timeout,
    #[serde(rename = "assembly_busy")]
    #[error("no decoder slot is free")]
    Busy,
    #[serde(rename = "assembly_unavailable")]
    #[error("the assembler is unavailable")]
    Unavailable,
}

impl AssembleError {
    /// The G3.8 code, or `None` for `Unavailable` (not a card).
    pub fn code(&self) -> Option<&'static str> {
        match self {
            AssembleError::ParamsInvalid { .. } => Some("assembly_params_invalid"),
            AssembleError::SourceInvalid => Some("assembly_source_invalid"),
            AssembleError::SourceTooLarge => Some("assembly_source_too_large"),
            AssembleError::OutputTooLarge { .. } => Some("assembly_output_too_large"),
            AssembleError::Timeout => Some("assembly_timeout"),
            AssembleError::Busy => Some("assembly_busy"),
            AssembleError::Unavailable => None,
        }
    }
}

/// The `motion` of an `AssembleResult` candidate (G7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionKind {
    Bounce,
    Wobble,
    Pulse,
    Sparkle,
    Sprite,
}
impl MotionKind {
    pub const fn id(self) -> &'static str {
        match self {
            MotionKind::Bounce => "bounce",
            MotionKind::Wobble => "wobble",
            MotionKind::Pulse => "pulse",
            MotionKind::Sparkle => "sparkle",
            MotionKind::Sprite => "sprite",
        }
    }
}

/// One finished candidate: the output of the D3 path (GIF input check, pixel re-encode,
/// small/large/thumb). `media.large` is the GIF that is shown and stored.
#[derive(Clone)]
pub struct Candidate {
    pub motion: MotionKind,
    pub media: Processed,
}
/// Facts only: a log line or a failed assertion must not print megabytes of picture.
impl std::fmt::Debug for Candidate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Candidate")
            .field("motion", &self.motion)
            .field("frames", &self.frames())
            .field("duration_ms", &self.duration_ms())
            .field("bytes", &self.bytes())
            .field("sha256", &self.sha256())
            .finish()
    }
}

impl Candidate {
    pub fn gif(&self) -> &[u8] {
        &self.media.large.data
    }
    pub fn info(&self) -> &ImageInfo {
        &self.media.large.info
    }
    pub fn frames(&self) -> u32 {
        self.info().frame_count
    }
    /// One play, in ms.
    pub fn duration_ms(&self) -> u32 {
        self.info().duration_ms
    }
    pub fn bytes(&self) -> usize {
        self.info().bytes
    }
    pub fn sha256(&self) -> &str {
        &self.info().sha256
    }
}

/// One entry per requested preset, in request order; a sprite has one. A candidate that is too
/// large stays an error in its own place and does not sink the others (G3.8, partial failure).
/// Every other failure, and every call-level one (parameters, the picture, the clock, a free
/// slot), is the `Err` of the whole call: nothing partial comes back from it.
pub type Outcome = Result<Candidate, AssembleError>;

// ---- plan and scene ---------------------------------------------------------------------
enum Plan {
    Preset(Preset),
    Sprite { sequence: Vec<u32>, delay_ms: u32 },
}
impl Plan {
    fn of(request: &AssembleRequest) -> Vec<Plan> {
        match &request.motion {
            Motion::Preset { presets } => presets.iter().copied().map(Plan::Preset).collect(),
            Motion::Sprite {
                sequence, frame_ms, ..
            } => vec![Plan::Sprite {
                sequence: sequence.clone(),
                // A GIF delay counts 10 ms units. Rounding down keeps `sequence * frameMs`
                // within the 10 s that D3 allows.
                delay_ms: frame_ms / 10 * 10,
            }],
        }
    }
    fn kind(&self) -> MotionKind {
        match self {
            Plan::Preset(Preset::Bounce) => MotionKind::Bounce,
            Plan::Preset(Preset::Wobble) => MotionKind::Wobble,
            Plan::Preset(Preset::Pulse) => MotionKind::Pulse,
            Plan::Preset(Preset::Sparkle) => MotionKind::Sparkle,
            Plan::Sprite { .. } => MotionKind::Sprite,
        }
    }
    fn frame_count(&self) -> u32 {
        match self {
            Plan::Preset(p) => p.frames(),
            Plan::Sprite { sequence, .. } => sequence.len() as u32,
        }
    }
    fn delay_ms(&self) -> u32 {
        match self {
            Plan::Preset(p) => p.delay_ms(),
            Plan::Sprite { delay_ms, .. } => *delay_ms,
        }
    }
}

struct Scene {
    size: u32,
    fill: Option<[u8; 3]>,
    /// Fitted pictures by sheet cell; a preset uses index 0.
    tiles: Vec<Option<Tile>>,
}
impl Scene {
    fn build(
        request: &AssembleRequest,
        source: &[u8],
        end: Instant,
        allocation: u64,
    ) -> Result<Scene, AssembleError> {
        let (mut rgba, fill) = decode_source(source, end, allocation)?;
        render::premultiply(&mut rgba);
        let (w, h) = rgba.dimensions();
        let box_px = render::box_px(request.size);
        let mut tiles: Vec<Option<Tile>> = (0..4).map(|_| None).collect();
        match &request.motion {
            Motion::Preset { .. } => tiles[0] = Some(render::fit_tile(&rgba, 0, 0, w, h, box_px)),
            Motion::Sprite {
                frames, sequence, ..
            } => {
                for &cell in sequence {
                    if tiles[cell as usize].is_none() {
                        expire(end)?;
                        let (x, y, cw, ch) = render::cell_rect(w, h, *frames, cell)
                            .ok_or(AssembleError::SourceInvalid)?;
                        tiles[cell as usize] = Some(render::fit_tile(&rgba, x, y, cw, ch, box_px));
                    }
                }
            }
        }
        Ok(Scene {
            size: request.size,
            fill,
            tiles,
        })
    }

    /// Frame `i` of `plan`, composed on its own: nothing keeps earlier frames.
    fn frame(&self, plan: &Plan, i: u32) -> RgbaImage {
        let mut canvas = Canvas::new(self.size, self.fill);
        let (cell, pose) = match plan {
            Plan::Preset(p) => (0, render::pose(*p, i, self.size)),
            Plan::Sprite { sequence, .. } => (sequence[i as usize] as usize, Pose::REST),
        };
        if let Some(tile) = &self.tiles[cell] {
            canvas.draw_tile(tile, &pose);
        }
        if let Some(k) = pose.star {
            canvas.draw_star(k);
        }
        canvas.into_frame()
    }
}

// ---- source -----------------------------------------------------------------------------
struct TimedReader<'a> {
    input: Cursor<&'a [u8]>,
    end: Instant,
}
impl Read for TimedReader<'_> {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        deadline_io(self.end)?;
        Read::read(&mut self.input, b)
    }
}
impl Seek for TimedReader<'_> {
    fn seek(&mut self, p: SeekFrom) -> io::Result<u64> {
        deadline_io(self.end)?;
        self.input.seek(p)
    }
}
fn deadline_io(end: Instant) -> io::Result<()> {
    if Instant::now() >= end {
        Err(io::Error::new(io::ErrorKind::TimedOut, "assembly deadline"))
    } else {
        Ok(())
    }
}
fn expire(end: Instant) -> Result<(), AssembleError> {
    if Instant::now() >= end {
        Err(AssembleError::Timeout)
    } else {
        Ok(())
    }
}
/// A codec reports a deadline that expired under it as an ordinary failure.
fn late(error: AssembleError, end: Instant) -> AssembleError {
    expire(end).err().unwrap_or(error)
}

/// Straight-alpha RGBA of the whole picture plus the margin colour (edge median). The input rules
/// of D3 run first and before any codec exists ([`input::check`]); the pixels then come from one
/// full-resolution decode under the same limits as every other decode of this crate.
fn decode_source(
    bytes: &[u8],
    end: Instant,
    allocation: u64,
) -> Result<(RgbaImage, Option<[u8; 3]>), AssembleError> {
    let (format, claimed) = input::check(bytes).map_err(|_| AssembleError::SourceInvalid)?;
    expire(end)?;
    let mut reader = ImageReader::with_format(
        BufReader::new(TimedReader {
            input: Cursor::new(bytes),
            end,
        }),
        format,
    );
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(SCRATCH);
    reader.limits(limits);
    let decoder = reader
        .into_decoder()
        .map_err(|_| late(AssembleError::SourceInvalid, end))?;
    let (w, h) = decoder.dimensions();
    if (w, h) != claimed {
        return Err(AssembleError::SourceInvalid); // the codec disagrees with the container
    }
    let pixels = u64::from(w) * u64::from(h);
    let native = decoder.total_bytes();
    // The RGBA copy exists beside the native buffer unless the picture is already RGBA8.
    let copy = if decoder.color_type() == ColorType::Rgba8 {
        0
    } else {
        pixels * 4
    };
    if !within_allocation_budget(native, copy, bytes.len(), allocation) {
        return Err(AssembleError::Timeout); // G3.8: the allocation limit is `assembly_timeout`
    }
    let image =
        DynamicImage::from_decoder(decoder).map_err(|_| late(AssembleError::SourceInvalid, end))?;
    let rgba = image.into_rgba8();
    let fill = render::edge_fill(&rgba);
    Ok((rgba, fill))
}

/// The native buffer, its RGBA copy, the codec scratch and the source bytes must fit the 192 MiB
/// of one job before anything is allocated.
fn within_allocation_budget(native: u64, copy: u64, source_len: usize, limit: u64) -> bool {
    native + copy + SCRATCH + source_len as u64 <= limit
}

// ---- encode -----------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    Deadline,
    Ceiling,
}
/// GIF sink: bounded, deadline-aware, and it remembers why it refused a write.
struct Sink {
    data: Vec<u8>,
    end: Instant,
    fault: Option<Fault>,
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if Instant::now() >= self.end {
            self.fault = Some(Fault::Deadline);
            return Err(io::Error::new(io::ErrorKind::TimedOut, "assembly deadline"));
        }
        if bytes.len() > SINK_CEILING - self.data.len() {
            self.fault = Some(Fault::Ceiling);
            return Err(io::Error::other("assembly output ceiling"));
        }
        self.data.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The GIF as assembled, before the D3 path: every frame composed on its own and encoded the
/// moment it exists, four plays, and a measured size even when it is too large.
fn first_pass(scene: &Scene, plan: &Plan, end: Instant) -> Result<Vec<u8>, AssembleError> {
    let (frames, delay) = (plan.frame_count(), plan.delay_ms());
    let mut sink = Sink {
        data: Vec::new(),
        end,
        fault: None,
    };
    let encoded = {
        let mut encoder = GifEncoder::new_with_speed(&mut sink, GIF_SPEED);
        encoder
            .set_repeat(Repeat::Finite(REPEAT_AFTER_FIRST_PLAY))
            .map_err(|_| AssembleError::Unavailable)
            .and_then(|()| {
                (0..frames).try_for_each(|i| {
                    expire(end)?;
                    let frame = Frame::from_parts(
                        scene.frame(plan, i),
                        0,
                        0,
                        Delay::from_numer_denom_ms(delay, 1),
                    );
                    encoder
                        .encode_frame(frame)
                        .map_err(|_| AssembleError::Unavailable)
                })
            })
    }; // the encoder drops here and writes the trailer
    match sink.fault {
        Some(Fault::Deadline) => Err(AssembleError::Timeout),
        Some(Fault::Ceiling) => Err(AssembleError::OutputTooLarge {
            bytes: SINK_CEILING as u64,
        }),
        None => encoded.map(|()| sink.data),
    }
}

/// What the D3 re-encode must hand back: a GIF of the canvas size with every frame and every
/// delay that was assembled, within 1 MiB. Anything else means a frame or a delay was lost on the
/// way, and that is never passed off as a smaller animation.
fn is_exact(large: &Rendition, size: u32, frames: u32, delay: u32) -> bool {
    let info = &large.info;
    info.mime == "image/gif"
        && (info.width, info.height) == (size, size)
        && info.frame_count == frames
        && info.duration_ms == frames * delay
        && large.data.len() <= MAX_CANDIDATE_BYTES
}

fn candidate(scene: &Scene, plan: &Plan, end: Instant) -> Result<Candidate, AssembleError> {
    let (frames, delay) = (plan.frame_count(), plan.delay_ms());
    let gif = first_pass(scene, plan, end)?;
    if gif.len() > MAX_CANDIDATE_BYTES {
        return Err(AssembleError::OutputTooLarge {
            bytes: gif.len() as u64,
        });
    }
    // D3: GIF input check -> pixel re-encode -> small/large/thumb. Our own output is valid by
    // construction, so a refusal here means a rendition went over its cap.
    let media = media::decode(&gif, end).map_err(|rejected| match rejected {
        Rejected::Timeout => AssembleError::Timeout,
        _ => late(
            AssembleError::OutputTooLarge {
                bytes: gif.len() as u64,
            },
            end,
        ),
    })?;
    if !is_exact(&media.large, scene.size, frames, delay) {
        return Err(AssembleError::Unavailable);
    }
    Ok(Candidate {
        motion: plan.kind(),
        media,
    })
}

/// The whole assembly in this process, without isolation. This is what the child process runs;
/// callers use [`assemble`]. `end` is the shared deadline of all candidates.
#[doc(hidden)]
pub fn assemble_in_process(
    request: &AssembleRequest,
    source: &[u8],
    from: SourceFrom,
    end: Instant,
) -> Result<Vec<Outcome>, AssembleError> {
    assemble_within(request, source, from, end, ALLOCATION_LIMIT)
}

fn assemble_within(
    request: &AssembleRequest,
    source: &[u8],
    from: SourceFrom,
    end: Instant,
    allocation: u64,
) -> Result<Vec<Outcome>, AssembleError> {
    request.validate()?;
    if source.len() > from.limit() {
        return Err(AssembleError::SourceTooLarge);
    }
    expire(end)?;
    let scene = Scene::build(request, source, end, allocation)?;
    collect(Plan::of(request), |plan| candidate(&scene, plan, end))
}

/// One outcome per plan, in order. Too large is a property of that candidate and stays in its own
/// place; running out of time or a broken invariant ends the whole call (nothing is half done).
fn collect(
    plans: Vec<Plan>,
    mut build: impl FnMut(&Plan) -> Result<Candidate, AssembleError>,
) -> Result<Vec<Outcome>, AssembleError> {
    let mut outcomes = Vec::new();
    for plan in plans {
        match build(&plan) {
            Ok(done) => outcomes.push(Ok(done)),
            Err(e @ AssembleError::OutputTooLarge { .. }) => outcomes.push(Err(e)),
            Err(e) => return Err(e),
        }
    }
    Ok(outcomes)
}

// ---- wire (child <-> parent) ------------------------------------------------------------
mod hexbytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(bytes))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        hex::decode(String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Serialize, Deserialize)]
struct WireRendition {
    info: ImageInfo,
    #[serde(with = "hexbytes")]
    data: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
struct WireCandidate {
    motion: MotionKind,
    small: WireRendition,
    large: WireRendition,
    thumb: WireRendition,
}
type WireOutcome = Result<WireCandidate, AssembleError>;
type WireResult = Result<Vec<WireOutcome>, AssembleError>;

impl From<Rendition> for WireRendition {
    fn from(r: Rendition) -> Self {
        Self {
            info: r.info,
            data: r.data,
        }
    }
}
impl From<WireRendition> for Rendition {
    fn from(r: WireRendition) -> Self {
        Self {
            info: r.info,
            data: r.data,
        }
    }
}
fn to_wire(result: Result<Vec<Outcome>, AssembleError>) -> WireResult {
    result.map(|outcomes| {
        outcomes
            .into_iter()
            .map(|o| {
                o.map(|c| WireCandidate {
                    motion: c.motion,
                    small: c.media.small.into(),
                    large: c.media.large.into(),
                    thumb: c.media.thumb.into(),
                })
            })
            .collect()
    })
}
fn from_wire(wire: WireResult) -> Result<Vec<Outcome>, AssembleError> {
    wire.map(|outcomes| {
        outcomes
            .into_iter()
            .map(|o| {
                o.map(|c| Candidate {
                    motion: c.motion,
                    media: Processed {
                        small: c.small.into(),
                        large: c.large.into(),
                        thumb: c.thumb.into(),
                    },
                })
            })
            .collect()
    })
}

/// stdin of the child: `u32 BE header length | header JSON | picture bytes`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    request: AssembleRequest,
    from: SourceFrom,
    budget_ms: u64,
}

/// Body of the `momo-expression-assembler` binary. Binary stdin only: no URL, path, env or DB
/// input. Returns the process exit code.
#[doc(hidden)]
pub fn child_main() -> i32 {
    let started = Instant::now();
    let result = (|| -> Result<Vec<Outcome>, AssembleError> {
        let mut input = Vec::new();
        io::stdin()
            .take((4 + HEADER_LIMIT + INPUT_BYTES + 1) as u64)
            .read_to_end(&mut input)
            .map_err(|_| AssembleError::Unavailable)?;
        let len = input
            .get(..4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
            .filter(|len| *len <= HEADER_LIMIT && input.len() >= 4 + len)
            .ok_or(AssembleError::Unavailable)?;
        let job: Job =
            serde_json::from_slice(&input[4..4 + len]).map_err(|_| AssembleError::Unavailable)?;
        // Finish a little before the parent's kill so the answer is a clean `Timeout`.
        let budget = Duration::from_millis(job.budget_ms / 10 * 9);
        assemble_in_process(&job.request, &input[4 + len..], job.from, started + budget)
    })();
    match serde_json::to_writer(io::stdout().lock(), &to_wire(result)) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

// ---- parent -----------------------------------------------------------------------------
/// `OORT_EXPRESSION_ASSEMBLER`, or `momo-expression-assembler` next to this executable (the
/// `deps/` directory of a cargo test run is skipped), like the decoder.
pub fn assembler_path() -> Result<PathBuf, AssembleError> {
    if let Some(path) = std::env::var_os("OORT_EXPRESSION_ASSEMBLER") {
        return Ok(path.into());
    }
    let exe = std::env::current_exe().map_err(|_| AssembleError::Unavailable)?;
    let parent = exe.parent().ok_or(AssembleError::Unavailable)?;
    let parent = if parent.file_name() == Some(std::ffi::OsStr::new("deps")) {
        parent.parent().ok_or(AssembleError::Unavailable)?
    } else {
        parent
    };
    Ok(parent.join("momo-expression-assembler"))
}

/// Assemble in the isolated child. `permit` is a decoder slot owned by the caller and is the
/// only way to start: without one there is no call. It is kept until the child has been killed
/// and reaped, even when this future is dropped.
pub async fn assemble(
    request: &AssembleRequest,
    source: Vec<u8>,
    from: SourceFrom,
    permit: OwnedSemaphorePermit,
) -> Result<Vec<Outcome>, AssembleError> {
    assemble_with_program(&assembler_path()?, DEADLINE, request, source, from, permit).await
}

/// [`assemble`] taking its slot from `slots`: with none free it answers `assembly_busy` at once,
/// starts nothing and queues nothing.
pub async fn try_assemble(
    request: &AssembleRequest,
    source: Vec<u8>,
    from: SourceFrom,
    slots: &Arc<Semaphore>,
) -> Result<Vec<Outcome>, AssembleError> {
    try_assemble_with_program(&assembler_path()?, DEADLINE, request, source, from, slots).await
}

#[doc(hidden)]
pub async fn try_assemble_with_program(
    program: &Path,
    deadline: Duration,
    request: &AssembleRequest,
    source: Vec<u8>,
    from: SourceFrom,
    slots: &Arc<Semaphore>,
) -> Result<Vec<Outcome>, AssembleError> {
    request.validate()?;
    let permit = slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AssembleError::Busy)?;
    assemble_with_program(program, deadline, request, source, from, permit).await
}

#[doc(hidden)]
pub async fn assemble_with_program(
    program: &Path,
    deadline: Duration,
    request: &AssembleRequest,
    source: Vec<u8>,
    from: SourceFrom,
    permit: OwnedSemaphorePermit,
) -> Result<Vec<Outcome>, AssembleError> {
    // Everything that needs no child is answered before one starts.
    request.validate()?;
    if source.len() > from.limit() {
        return Err(AssembleError::SourceTooLarge);
    }
    let job = Job {
        request: request.clone(),
        from,
        budget_ms: u64::try_from(deadline.as_millis()).unwrap_or(u64::MAX),
    };
    let header = serde_json::to_vec(&job).map_err(|_| AssembleError::Unavailable)?;
    let mut input = Vec::with_capacity(4 + header.len() + source.len());
    input.extend_from_slice(&(header.len() as u32).to_be_bytes());
    input.extend_from_slice(&header);
    input.extend_from_slice(&source);
    drop(source);
    let program = program.to_path_buf();
    // The supervisor outlives the caller: it holds the slot until the child is reaped.
    let task = tokio::spawn(async move {
        let _permit = permit;
        run_child(&program, deadline, input).await
    });
    let output = task.await.map_err(|_| AssembleError::Unavailable)??;
    // Up to 16 MiB of JSON and hex: parsed off the async workers. The slot is already free.
    tokio::task::spawn_blocking(move || {
        let wire: WireResult =
            serde_json::from_slice(&output).map_err(|_| AssembleError::Unavailable)?;
        from_wire(wire)
    })
    .await
    .map_err(|_| AssembleError::Unavailable)?
}

/// The child died without an answer. A signal is the limits at work (the allocation cap aborts,
/// the CPU limit kills): that is `Timeout`. Anything else is not the request's doing.
fn died(status: std::process::ExitStatus) -> AssembleError {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if status.signal().is_some() {
            return AssembleError::Timeout;
        }
    }
    let _ = status;
    AssembleError::Unavailable
}

async fn run_child(
    program: &Path,
    deadline: Duration,
    input: Vec<u8>,
) -> Result<Vec<u8>, AssembleError> {
    let mut child = tokio::process::Command::new(program)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| AssembleError::Unavailable)?;
    let mut stdin = child.stdin.take().ok_or(AssembleError::Unavailable)?;
    let mut stdout = child.stdout.take().ok_or(AssembleError::Unavailable)?;
    let work = async {
        // A child that exits early closes the pipe: its status below is the better answer.
        let _ = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
        let mut data = Vec::new();
        (&mut stdout)
            .take(OUTPUT_LIMIT as u64)
            .read_to_end(&mut data)
            .await
            .map_err(|_| AssembleError::Unavailable)?;
        if data.len() >= OUTPUT_LIMIT {
            return Err(AssembleError::Unavailable);
        }
        let status = child.wait().await.map_err(|_| AssembleError::Unavailable)?;
        if status.success() {
            Ok(data)
        } else {
            Err(died(status))
        }
    };
    let result = match tokio::time::timeout(deadline, work).await {
        Ok(result) => result,
        Err(_) => Err(AssembleError::Timeout),
    };
    // Whatever happened, the slot is released only after the child is gone.
    if child
        .try_wait()
        .map_err(|_| AssembleError::Unavailable)?
        .is_none()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presets(list: &[Preset], size: u32) -> AssembleRequest {
        AssembleRequest {
            motion: Motion::Preset {
                presets: list.to_vec(),
            },
            size,
        }
    }
    fn sprite(frames: u32, sequence: &[u32], frame_ms: u32) -> AssembleRequest {
        AssembleRequest::new(Motion::Sprite {
            frames,
            sequence: sequence.to_vec(),
            frame_ms,
        })
    }
    /// The names `assembly_params_invalid` carries for a request.
    fn wrong(request: &AssembleRequest) -> Vec<&'static str> {
        match request.validate() {
            Err(AssembleError::ParamsInvalid { params }) => {
                params.iter().map(|p| p.name()).collect()
            }
            other => panic!("expected assembly_params_invalid, got {other:?}"),
        }
    }
    fn ok(request: &AssembleRequest) {
        assert_eq!(request.validate(), Ok(()), "{request:?}");
    }
    fn dummy(motion: MotionKind) -> Candidate {
        let rendition = |n: usize| Rendition {
            info: ImageInfo {
                mime: "image/gif".into(),
                sha256: "0".repeat(64),
                bytes: n,
                width: 1,
                height: 1,
                frame_count: 2,
                duration_ms: 80,
            },
            data: vec![0; n],
        };
        Candidate {
            motion,
            media: Processed {
                small: rendition(1),
                large: rendition(2),
                thumb: rendition(3),
            },
        }
    }

    #[test]
    fn the_edges_of_every_allowed_range_are_accepted() {
        for size in SIZES {
            ok(&presets(&Preset::ALL, size));
        }
        for n in 1..=4 {
            ok(&presets(&Preset::ALL[..n], 360));
        }
        ok(&sprite(2, &[0, 1], 40));
        ok(&sprite(3, &[2, 1, 0], 500));
        ok(&sprite(4, &[3; 24], 416)); // 24 x 416 = 9,984
        ok(&sprite(4, &[0; 20], 500)); // exactly 10,000 ms
        assert_eq!(
            AssembleRequest::new(Motion::Preset {
                presets: vec![Preset::Pulse]
            })
            .size,
            360
        );
    }

    #[test]
    fn presets_must_be_one_to_four_and_distinct() {
        let (b, w, p, s) = (
            Preset::Bounce,
            Preset::Wobble,
            Preset::Pulse,
            Preset::Sparkle,
        );
        assert_eq!(wrong(&presets(&[], 360)), ["presets"]);
        assert_eq!(wrong(&presets(&[b, b], 360)), ["presets"], "duplicates");
        assert_eq!(wrong(&presets(&[b, w, p, s, b], 360)), ["presets"], "five");
        assert_eq!(
            wrong(&presets(&[b, w, p, s, b, w], 360)),
            ["presets"],
            "six"
        );
    }

    #[test]
    fn size_must_be_one_of_the_three_canvases() {
        for size in [0, 100, 239, 241, 359, 361, 479, 481, 512, u32::MAX] {
            assert_eq!(wrong(&presets(&[Preset::Pulse], size)), ["size"], "{size}");
        }
    }

    #[test]
    fn sprite_rules_name_each_wrong_parameter_and_only_that_one() {
        assert_eq!(wrong(&sprite(1, &[0, 0], 100)), ["frames"]);
        assert_eq!(wrong(&sprite(5, &[0, 1], 100)), ["frames"]);
        assert_eq!(wrong(&sprite(0, &[0, 1], 100)), ["frames"]);
        assert_eq!(
            wrong(&sprite(3, &[0], 100)),
            ["sequence"],
            "one step is no animation"
        );
        assert_eq!(wrong(&sprite(3, &[0; 25], 100)), ["sequence"], "25 steps");
        assert_eq!(
            wrong(&sprite(2, &[0, 2], 100)),
            ["sequence"],
            "cell 2 of a 2-cell sheet"
        );
        assert_eq!(wrong(&sprite(3, &[0, 3], 100)), ["sequence"]);
        assert_eq!(wrong(&sprite(4, &[0, 4], 100)), ["sequence"]);
        assert_eq!(wrong(&sprite(2, &[0, 1], 39)), ["frameMs"]);
        assert_eq!(wrong(&sprite(2, &[0, 1], 501)), ["frameMs"]);
        // Each factor is fine, the product is not: both are named.
        assert_eq!(wrong(&sprite(2, &[0; 21], 500)), ["sequence", "frameMs"]); // 10,500
        assert_eq!(wrong(&sprite(2, &[0; 24], 417)), ["sequence", "frameMs"]); // 10,008
                                                                               // Several mistakes at once come back in one stable order, once each.
        let mut many = sprite(7, &[9], 9);
        many.size = 1;
        assert_eq!(wrong(&many), ["frames", "sequence", "frameMs", "size"]);
        // A bad sheet size does not hide a bad cell: with no valid grid every cell above 3 is wrong.
        assert_eq!(wrong(&sprite(9, &[0, 5], 100)), ["frames", "sequence"]);
    }

    #[test]
    fn json_shapes_are_the_g7_motion_and_request() {
        let p: AssembleRequest =
            serde_json::from_str(r#"{"motion":{"kind":"preset","presets":["bounce","sparkle"]}}"#)
                .unwrap();
        assert_eq!(
            p,
            presets(&[Preset::Bounce, Preset::Sparkle], 360),
            "size defaults to 360"
        );
        let s: AssembleRequest = serde_json::from_str(
            r#"{"motion":{"kind":"sprite","frames":3,"sequence":[0,1,2,1],"frameMs":80},"size":480}"#,
        )
        .unwrap();
        assert_eq!(
            s,
            AssembleRequest {
                size: 480,
                ..sprite(3, &[0, 1, 2, 1], 80)
            }
        );
        for bad in [
            r#"{"motion":{"kind":"preset","presets":["spin"]},"size":360}"#, // unknown preset
            r#"{"motion":{"kind":"preset","presets":["bounce"],"extra":1}}"#,
            r#"{"motion":{"kind":"preset","presets":["bounce"]},"extra":1}"#,
            r#"{"motion":{"kind":"video","presets":["bounce"]}}"#,
            r#"{"size":360}"#,
        ] {
            assert!(
                serde_json::from_str::<AssembleRequest>(bad).is_err(),
                "{bad}"
            );
        }
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({"motion":{"kind":"sprite","frames":3,"sequence":[0,1,2,1],"frameMs":80},"size":480})
        );
    }

    #[test]
    fn failure_codes_are_the_closed_g38_list() {
        let all = [
            (
                AssembleError::ParamsInvalid {
                    params: vec![Param::FrameMs, Param::Size],
                },
                "assembly_params_invalid",
                serde_json::json!({"code":"assembly_params_invalid","params":["frameMs","size"]}),
            ),
            (
                AssembleError::SourceInvalid,
                "assembly_source_invalid",
                serde_json::json!({"code":"assembly_source_invalid"}),
            ),
            (
                AssembleError::SourceTooLarge,
                "assembly_source_too_large",
                serde_json::json!({"code":"assembly_source_too_large"}),
            ),
            (
                AssembleError::OutputTooLarge { bytes: 1_048_577 },
                "assembly_output_too_large",
                serde_json::json!({"code":"assembly_output_too_large","bytes":1_048_577}),
            ),
            (
                AssembleError::Timeout,
                "assembly_timeout",
                serde_json::json!({"code":"assembly_timeout"}),
            ),
            (
                AssembleError::Busy,
                "assembly_busy",
                serde_json::json!({"code":"assembly_busy"}),
            ),
        ];
        for (error, code, json) in all {
            assert_eq!(error.code(), Some(code));
            assert_eq!(serde_json::to_value(&error).unwrap(), json, "{code}");
            assert_eq!(
                serde_json::from_value::<AssembleError>(json).unwrap(),
                error
            );
        }
        // `generation_failed` is the hosting door's, and an operator fault is not a card.
        assert_eq!(AssembleError::Unavailable.code(), None);
        assert!(serde_json::from_str::<AssembleError>(r#"{"code":"generation_failed"}"#).is_err());
    }

    #[test]
    fn a_gif_delay_counts_ten_millisecond_units_so_frame_ms_rounds_down() {
        let delay = |ms| match Plan::of(&sprite(2, &[0, 1], ms)).remove(0) {
            Plan::Sprite { delay_ms, .. } => delay_ms,
            Plan::Preset(_) => unreachable!(),
        };
        assert_eq!(
            [40, 45, 49, 50, 99, 100, 495, 499, 500].map(delay),
            [40, 40, 40, 50, 90, 100, 490, 490, 500]
        );
        // Rounding down never lets the played length pass the 10 s the request was checked for.
        for ms in 40..=500u32 {
            assert!(24 * (ms / 10 * 10) <= 24 * ms);
        }
    }

    #[test]
    fn the_source_limit_depends_on_where_the_picture_came_from() {
        assert_eq!(SourceFrom::Request.limit(), 4 * 1024 * 1024);
        assert_eq!(SourceFrom::Server.limit(), 5 * 1024 * 1024);
        assert_eq!(SourceFrom::Server.limit(), INPUT_BYTES);
    }

    #[test]
    fn the_allocation_budget_is_the_192_mib_of_one_job() {
        let mib = 1024 * 1024u64;
        // 16 MP RGB8: 48 MB native + 64 MB copy + 16 MiB scratch + 5 MiB input: fits.
        let job = ALLOCATION_LIMIT;
        assert_eq!(job, 192 * mib);
        assert!(within_allocation_budget(
            48_000_000,
            64_000_000,
            5 * 1024 * 1024,
            job
        ));
        // 16 MP RGBA16: 128 MB native + 64 MB copy: over.
        assert!(!within_allocation_budget(
            128_000_000,
            64_000_000,
            1024,
            job
        ));
        // The exact edge.
        let room = 192 * mib - 16 * mib - 1000;
        assert!(within_allocation_budget(room, 0, 1000, job));
        assert!(!within_allocation_budget(room + 1, 0, 1000, job));
        assert!(!within_allocation_budget(0, room + 1, 1000, job));
        assert!(!within_allocation_budget(0, 0, (192 * mib) as usize, job));
    }

    #[test]
    fn too_large_stays_in_its_place_while_time_and_faults_end_the_whole_call() {
        let plans = || {
            Plan::of(&presets(
                &[Preset::Bounce, Preset::Wobble, Preset::Pulse],
                360,
            ))
        };
        let big = AssembleError::OutputTooLarge { bytes: 2_000_000 };
        let script = |results: Vec<Result<Candidate, AssembleError>>| {
            let mut calls = 0;
            let mut results = results.into_iter();
            let out = collect(plans(), |_| {
                calls += 1;
                results.next().expect("one result per call")
            });
            (out, calls)
        };
        // One preset too large: the others are still delivered, in request order.
        let (out, calls) = script(vec![
            Ok(dummy(MotionKind::Bounce)),
            Err(big.clone()),
            Ok(dummy(MotionKind::Pulse)),
        ]);
        let out = out.unwrap();
        assert_eq!(calls, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].as_ref().unwrap().motion, MotionKind::Bounce);
        assert_eq!(out[1].as_ref().unwrap_err(), &big);
        assert_eq!(out[2].as_ref().unwrap().motion, MotionKind::Pulse);
        // Every candidate too large is still one entry each, never an empty success.
        let (out, _) = script(vec![Err(big.clone()), Err(big.clone()), Err(big.clone())]);
        assert!(out.unwrap().iter().all(|o| o.as_ref().unwrap_err() == &big));
        // Out of time: the shared budget is gone, so nothing partial comes back and the rest
        // is not started.
        let (out, calls) = script(vec![
            Ok(dummy(MotionKind::Bounce)),
            Err(AssembleError::Timeout),
        ]);
        assert_eq!((out.err(), calls), (Some(AssembleError::Timeout), 2));
        let (out, calls) = script(vec![Err(AssembleError::Unavailable)]);
        assert_eq!((out.err(), calls), (Some(AssembleError::Unavailable), 1));
    }
}

#[cfg(test)]
mod exactness {
    use super::*;

    fn gif(frames: u32, duration_ms: u32, bytes: usize) -> Rendition {
        Rendition {
            info: ImageInfo {
                mime: "image/gif".into(),
                sha256: "0".repeat(64),
                bytes,
                width: 240,
                height: 240,
                frame_count: frames,
                duration_ms,
            },
            data: vec![0; bytes],
        }
    }

    #[test]
    fn a_lost_frame_delay_size_or_format_is_never_passed_off_as_a_smaller_animation() {
        assert!(is_exact(&gif(16, 640, 1000), 240, 16, 40));
        assert!(
            is_exact(&gif(16, 640, MAX_CANDIDATE_BYTES), 240, 16, 40),
            "1 MiB itself fits"
        );
        assert!(!is_exact(
            &gif(16, 640, MAX_CANDIDATE_BYTES + 1),
            240,
            16,
            40
        ));
        assert!(
            !is_exact(&gif(15, 640, 1000), 240, 16, 40),
            "a frame is missing"
        );
        assert!(
            !is_exact(&gif(17, 640, 1000), 240, 16, 40),
            "a frame was added"
        );
        assert!(
            !is_exact(&gif(16, 600, 1000), 240, 16, 40),
            "the play is shorter"
        );
        assert!(
            !is_exact(&gif(16, 680, 1000), 240, 16, 40),
            "the play is longer"
        );
        assert!(
            !is_exact(&gif(16, 640, 1000), 360, 16, 40),
            "the canvas is another size"
        );
        let mut tall = gif(16, 640, 1000);
        tall.info.height = 239;
        assert!(!is_exact(&tall, 240, 16, 40));
        let mut wide = gif(16, 640, 1000);
        wide.info.width = 239;
        assert!(!is_exact(&wide, 240, 16, 40));
        let mut still = gif(16, 640, 1000);
        still.info.mime = "image/png".into();
        assert!(
            !is_exact(&still, 240, 16, 40),
            "a still is not the animation"
        );
    }
}

#[cfg(test)]
mod in_process {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba};

    fn encoded(image: DynamicImage) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    fn bar(side: u32) -> Vec<u8> {
        let mut img = RgbaImage::from_pixel(side, side, Rgba([240, 240, 240, 255]));
        for y in side / 2 - 8..side / 2 + 8 {
            for x in side / 4..side * 3 / 4 {
                img.put_pixel(x, y, Rgba([200, 30, 30, 255]));
            }
        }
        encoded(DynamicImage::ImageRgba8(img))
    }
    fn request(preset: Preset, size: u32) -> AssembleRequest {
        AssembleRequest {
            motion: Motion::Preset {
                presets: vec![preset],
            },
            size,
        }
    }
    const LONG: Duration = Duration::from_secs(60);

    #[test]
    fn checks_that_need_no_work_come_first_and_in_a_fixed_order() {
        let png = bar(64);
        let past = Instant::now() - Duration::from_secs(1);
        let bad = AssembleRequest {
            size: 7,
            ..request(Preset::Pulse, 240)
        };
        // Parameters, then the byte limit, then the clock.
        assert!(matches!(
            assemble_in_process(&bad, &png, SourceFrom::Request, past),
            Err(AssembleError::ParamsInvalid { .. })
        ));
        let huge = vec![0u8; REQUEST_SOURCE_BYTES + 1];
        let ok = request(Preset::Pulse, 240);
        assert_eq!(
            assemble_in_process(&ok, &huge, SourceFrom::Request, past).err(),
            Some(AssembleError::SourceTooLarge)
        );
        assert_eq!(
            assemble_in_process(&ok, &png, SourceFrom::Request, past).err(),
            Some(AssembleError::Timeout),
            "an expired deadline ends the call before any picture is decoded"
        );
    }

    #[test]
    fn the_frame_loop_stops_at_the_deadline_instead_of_finishing_every_frame() {
        let req = request(Preset::Sparkle, 480);
        let scene = Scene::build(&req, &bar(384), Instant::now() + LONG, ALLOCATION_LIMIT).unwrap();
        let plan = Plan::of(&req).remove(0);
        let started = Instant::now();
        let result = candidate(&scene, &plan, Instant::now() + Duration::from_millis(30));
        assert_eq!(result.err(), Some(AssembleError::Timeout));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "it did not run all 20 frames"
        );
    }

    #[test]
    fn the_192_mib_budget_is_checked_from_the_pictures_own_claim_before_it_is_decoded() {
        let end = Instant::now() + LONG;
        // RGB8 1000x1000: native 3 MB + an RGBA copy of 4 MB.
        let rgb = encoded(DynamicImage::ImageRgb8(RgbImage::from_pixel(
            1000,
            1000,
            Rgb([9, 9, 9]),
        )));
        let need = 3_000_000 + 4_000_000 + SCRATCH + rgb.len() as u64;
        assert!(decode_source(&rgb, end, need).is_ok());
        assert_eq!(
            decode_source(&rgb, end, need - 1).err(),
            Some(AssembleError::Timeout)
        );
        // RGBA8 is already the working format: no second copy is budgeted.
        let rgba = encoded(DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            1000,
            1000,
            Rgba([9, 9, 9, 255]),
        )));
        let need = 4_000_000 + SCRATCH + rgba.len() as u64;
        assert!(decode_source(&rgba, end, need).is_ok());
        assert_eq!(
            decode_source(&rgba, end, need - 1).err(),
            Some(AssembleError::Timeout)
        );
        // And the whole call carries the limit it was given down to that check.
        let req = request(Preset::Pulse, 240);
        assert_eq!(
            assemble_within(&req, &rgb, SourceFrom::Request, end, 20 * 1024 * 1024).err(),
            Some(AssembleError::Timeout)
        );
    }

    /// What a GIF consists of, read block by block.
    struct Blocks {
        version: Vec<u8>,
        apps: Vec<Vec<Vec<u8>>>,
        comments: usize,
        delays: Vec<u16>,
        images: usize,
        clean_end: bool,
    }
    fn blocks(b: &[u8]) -> Blocks {
        let skip = |p: &mut usize| {
            let mut blocks = Vec::new();
            loop {
                let len = b[*p] as usize;
                *p += 1;
                if len == 0 {
                    return blocks;
                }
                blocks.push(b[*p..*p + len].to_vec());
                *p += len;
            }
        };
        let flags = b[10];
        let mut p = 13
            + if flags & 0x80 != 0 {
                3 << ((flags & 7) + 1)
            } else {
                0
            };
        let (mut apps, mut comments, mut delays, mut images) = (vec![], 0, vec![], 0);
        loop {
            match b[p] {
                0x3b => {
                    return Blocks {
                        version: b[..6].to_vec(),
                        apps,
                        comments,
                        delays,
                        images,
                        clean_end: p + 1 == b.len(),
                    }
                }
                0x21 => {
                    let label = b[p + 1];
                    p += 2;
                    match label {
                        0xf9 => {
                            delays.push(u16::from_le_bytes([b[p + 2], b[p + 3]]));
                            p += 6;
                        }
                        0xff => apps.push(skip(&mut p)),
                        0xfe => {
                            comments += 1;
                            skip(&mut p);
                        }
                        other => panic!("extension {other:#x}"),
                    }
                }
                0x2c => {
                    images += 1;
                    let local = b[p + 9];
                    p += 10;
                    if local & 0x80 != 0 {
                        p += 3 << ((local & 7) + 1);
                    }
                    p += 1;
                    skip(&mut p);
                }
                other => panic!("block {other:#x}"),
            }
        }
    }

    #[test]
    fn what_is_handed_to_the_d3_path_is_already_a_four_play_gif89a_without_comments() {
        // The D3 re-encode writes its own loop count, so this is the only place the assembled
        // GIF's own header, loop, delays and extensions can be seen.
        let req = request(Preset::Pulse, 240);
        let scene = Scene::build(&req, &bar(192), Instant::now() + LONG, ALLOCATION_LIMIT).unwrap();
        let gif = first_pass(&scene, &Plan::of(&req).remove(0), Instant::now() + LONG).unwrap();
        let g = blocks(&gif);
        assert_eq!(g.version, b"GIF89a");
        assert_eq!((g.images, g.comments), (12, 0));
        assert_eq!(g.delays, vec![5; 12], "50 ms in GIF's 10 ms units");
        assert_eq!(
            g.apps,
            vec![vec![b"NETSCAPE2.0".to_vec(), vec![1, 3, 0]]],
            "one loop extension: 3 + 1 plays"
        );
        assert!(g.clean_end, "the trailer is the last byte");
        assert_eq!(u16::from_le_bytes([gif[6], gif[7]]), 240);
        assert_eq!(u16::from_le_bytes([gif[8], gif[9]]), 240);
    }

    #[test]
    fn a_codec_error_under_an_expired_deadline_is_a_timeout_and_the_reader_stops_at_it() {
        let (past, future) = (
            Instant::now() - Duration::from_secs(1),
            Instant::now() + LONG,
        );
        assert_eq!(
            late(AssembleError::SourceInvalid, past),
            AssembleError::Timeout
        );
        assert_eq!(
            late(AssembleError::SourceInvalid, future),
            AssembleError::SourceInvalid
        );
        assert_eq!(expire(past), Err(AssembleError::Timeout));
        assert_eq!(expire(future), Ok(()));
        let data = [1u8, 2, 3, 4];
        let mut buf = [0u8; 4];
        let mut live = TimedReader {
            input: Cursor::new(&data),
            end: future,
        };
        assert_eq!(live.read(&mut buf).unwrap(), 4);
        let mut dead = TimedReader {
            input: Cursor::new(&data),
            end: past,
        };
        assert_eq!(
            dead.read(&mut buf).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert_eq!(
            dead.seek(SeekFrom::Start(0)).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
    }

    #[test]
    fn the_sink_refuses_what_it_cannot_hold_and_never_keeps_half_a_write() {
        let mut sink = Sink {
            data: Vec::new(),
            end: Instant::now() + LONG,
            fault: None,
        };
        sink.write_all(&vec![1u8; SINK_CEILING]).unwrap();
        assert_eq!(
            (sink.data.len(), sink.fault),
            (SINK_CEILING, None),
            "the ceiling itself fits"
        );
        assert!(sink.write(&[2]).is_err());
        assert_eq!(
            (sink.data.len(), sink.fault),
            (SINK_CEILING, Some(Fault::Ceiling))
        );
        let mut late = Sink {
            data: Vec::new(),
            end: Instant::now() - Duration::from_secs(1),
            fault: None,
        };
        assert!(late.write(&[1]).is_err());
        assert_eq!((late.data.len(), late.fault), (0, Some(Fault::Deadline)));
    }
}
