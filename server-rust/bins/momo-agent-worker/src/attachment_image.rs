//! A picture a person attached, made ready for the team's model (ADR-0201 증보 v3 B6-1, #4970).
//!
//! Every other picture path in this server re-encodes what it is given (avatars, expressions), and this
//! one does too: the bytes a person uploaded are **not** what the provider receives. They are
//!
//! 1. sniffed — PNG, JPEG or a still WebP, by the bytes (a declared type has no vote); an animated
//!    WebP is refused;
//! 2. measured from the header before a decoder allocates anything (a small file that claims a
//!    60000×60000 canvas never reaches it), then decoded under the decoder's own limits;
//! 3. turned upright by its EXIF orientation (after the shrink, which is cheap) and fitted inside
//!    [`MODEL_IMAGE_MAX_DIM`] — the size a vision model reads at, which also bounds the provider's
//!    token bill;
//! 4. encoded fresh: JPEG for a picture without transparency, PNG for one with. Metadata (location,
//!    camera, owner) does not survive the round trip.
//!
//! Work runs on the blocking pool behind [`DECODE_SLOTS`] permits and a deadline, so a hostile file
//! costs a bounded slice of CPU and memory and never a runtime thread. Failures are the closed
//! [`ImageRejected`]; none names the file.

use std::io::Cursor;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use momo_messaging::bytes_match_mime;
use tokio::sync::Semaphore;

use crate::provider::ModelImage;

/// The longest side the model is shown.
pub const MODEL_IMAGE_MAX_DIM: u32 = 1568;
/// What a file may declare before it is refused: a phone photo (4032×3024) fits; a 48-megapixel one
/// does not (the avatar's own ceiling, ADR-0186 P7-2).
const IN_MAX_DIM: u32 = 4096;
const IN_MAX_PIXELS: u64 = 16_000_000;
/// The decoder's allocation ceiling: 16 megapixels of RGBA is 64 MiB, plus the shrink's working set.
const DECODE_ALLOC_LIMIT: u64 = 96 * 1024 * 1024;
/// What is allowed to leave: a fitted JPEG is a few hundred KiB, a PNG with transparency can be more.
const OUT_MAX_BYTES: usize = 3 * 1024 * 1024;
/// JPEG quality of the re-encode.
const JPEG_QUALITY: u8 = 85;
/// How many pictures are decoded at once, process-wide.
pub const DECODE_SLOTS: usize = 2;
/// The longest a decode may take.
pub const DECODE_DEADLINE: Duration = Duration::from_secs(10);

/// Why a picture could not be made ready. Closed: no variant names the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageRejected {
    /// Not a PNG, JPEG or WebP (by its bytes).
    Unsupported,
    /// An animated WebP.
    Animated,
    /// Larger than [`IN_MAX_DIM`] / [`IN_MAX_PIXELS`] allow, or larger than the output may be.
    TooBig,
    /// The decoder could not read it (damaged, or it lied about its own size).
    Decode,
    /// Both [`DECODE_SLOTS`] are taken.
    Busy,
    /// The decode ran past [`DECODE_DEADLINE`].
    Timeout,
}

fn format_of(bytes: &[u8]) -> Option<(ImageFormat, &'static str)> {
    [
        ("image/png", ImageFormat::Png),
        ("image/jpeg", ImageFormat::Jpeg),
        ("image/webp", ImageFormat::WebP),
    ]
    .into_iter()
    .find(|(mime, _)| bytes_match_mime(mime, bytes))
    .map(|(mime, format)| (format, mime))
}

/// `VP8X` with the animation flag (bit 1 of the flags byte at offset 20).
fn webp_is_animated(bytes: &[u8]) -> bool {
    bytes.len() >= 21 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0
}

/// The whole preparation, synchronously (what runs on the blocking pool; also what the unit tests call).
pub fn prepare_model_image_sync(bytes: &[u8]) -> Result<ModelImage, ImageRejected> {
    let Some((format, mime)) = format_of(bytes) else {
        return Err(ImageRejected::Unsupported);
    };
    if mime == "image/webp" && webp_is_animated(bytes) {
        return Err(ImageRejected::Animated);
    }
    // 2. The header's own dimensions, before any decoder allocates.
    let (width, height) = ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| ImageRejected::Decode)?;
    if width == 0
        || height == 0
        || width > IN_MAX_DIM
        || height > IN_MAX_DIM
        || u64::from(width) * u64::from(height) > IN_MAX_PIXELS
    {
        return Err(ImageRejected::TooBig);
    }
    // …and under the decoder's own limits too: the header may lie about what the stream then does.
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(IN_MAX_DIM);
    limits.max_image_height = Some(IN_MAX_DIM);
    limits.max_alloc = Some(DECODE_ALLOC_LIMIT);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| ImageRejected::Decode)?;
    // The orientation is read here but applied after the shrink: a rotation copies the whole frame.
    let orientation = decoder.orientation().ok();
    let mut picture = DynamicImage::from_decoder(decoder).map_err(|_| ImageRejected::Decode)?;
    if picture.width() == 0 || picture.height() == 0 {
        return Err(ImageRejected::Decode);
    }
    if picture.width().max(picture.height()) > MODEL_IMAGE_MAX_DIM {
        picture = picture.resize(
            MODEL_IMAGE_MAX_DIM,
            MODEL_IMAGE_MAX_DIM,
            FilterType::Triangle,
        );
    }
    if let Some(orientation) = orientation {
        picture.apply_orientation(orientation);
    }
    // 4. Encoded fresh.
    let mut out = Vec::new();
    let media_type = if picture.color().has_alpha() {
        picture
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .map_err(|_| ImageRejected::Decode)?;
        "image/png"
    } else {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
            .encode_image(&DynamicImage::ImageRgb8(picture.to_rgb8()))
            .map_err(|_| ImageRejected::Decode)?;
        "image/jpeg"
    };
    if out.is_empty() || out.len() > OUT_MAX_BYTES {
        return Err(ImageRejected::TooBig);
    }
    Ok(ModelImage {
        media_type,
        data: out,
    })
}

fn slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(Semaphore::new(DECODE_SLOTS)))
        .clone()
}

/// [`prepare_model_image_sync`] on the blocking pool, behind [`DECODE_SLOTS`] permits and
/// [`DECODE_DEADLINE`]. A third asker is [`ImageRejected::Busy`] at once (it is told to try again).
pub async fn prepare_model_image(
    bytes: Vec<u8>,
    deadline: Duration,
) -> Result<ModelImage, ImageRejected> {
    let permit = slots()
        .try_acquire_owned()
        .map_err(|_| ImageRejected::Busy)?;
    let work = tokio::task::spawn_blocking(move || {
        // held until the decode itself has ended, not merely until the caller stopped waiting
        let _held = permit;
        prepare_model_image_sync(&bytes)
    });
    match tokio::time::timeout(deadline, work).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(ImageRejected::Decode),
        Err(_) => Err(ImageRejected::Timeout),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn png_of(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if alpha {
            let buffer = ImageBuffer::from_fn(width, height, |x, y| {
                Rgba([(x % 255) as u8, (y % 255) as u8, 128, 200])
            });
            DynamicImage::ImageRgba8(buffer)
                .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
                .unwrap();
        } else {
            let buffer = ImageBuffer::from_fn(width, height, |x, y| {
                Rgb([(x % 255) as u8, (y % 255) as u8, 90])
            });
            DynamicImage::ImageRgb8(buffer)
                .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
                .unwrap();
        }
        out
    }

    #[test]
    fn a_picture_is_fitted_and_encoded_fresh() {
        let big = png_of(3200, 2000, false);
        let ready = prepare_model_image_sync(&big).expect("a PNG is readable");
        // the original was a PNG; what leaves is a JPEG no longer than the model reads at
        assert_eq!(ready.media_type, "image/jpeg");
        assert!(ready.data.starts_with(&[0xFF, 0xD8, 0xFF]));
        let out = image::load_from_memory(&ready.data).unwrap();
        assert_eq!(out.width(), MODEL_IMAGE_MAX_DIM);
        assert!(
            out.height() < MODEL_IMAGE_MAX_DIM,
            "the aspect ratio is kept"
        );
        assert_eq!(out.height(), 980);
        // a small picture is not enlarged
        let small = prepare_model_image_sync(&png_of(120, 80, false)).unwrap();
        let small = image::load_from_memory(&small.data).unwrap();
        assert_eq!((small.width(), small.height()), (120, 80));
        // transparency is kept, so it stays a PNG
        let alpha = prepare_model_image_sync(&png_of(64, 64, true)).unwrap();
        assert_eq!(alpha.media_type, "image/png");
        assert!(alpha.data.starts_with(b"\x89PNG"));
    }

    #[test]
    fn what_a_person_uploaded_is_not_what_the_provider_receives() {
        // A JPEG carrying an EXIF block with a marker string: the re-encode must not carry it over.
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 90)
            .encode_image(&DynamicImage::ImageRgb8(ImageBuffer::from_fn(
                40,
                30,
                |x, y| Rgb([x as u8, y as u8, 7]),
            )))
            .unwrap();
        // splice an APP1/Exif segment right after SOI
        let marker = b"GPS-LAT-37.5665-OWNER-HONG";
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(marker);
        let mut spliced = vec![0xFF, 0xD8, 0xFF, 0xE1];
        spliced.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        spliced.extend_from_slice(&exif);
        spliced.extend_from_slice(&jpeg[2..]);
        assert!(spliced.windows(marker.len()).any(|w| w == marker));
        let ready = prepare_model_image_sync(&spliced).expect("still a JPEG");
        assert!(
            !ready.data.windows(marker.len()).any(|w| w == marker),
            "metadata survived the re-encode"
        );
        assert_ne!(ready.data, spliced);
    }

    #[test]
    fn what_is_not_a_still_picture_is_a_closed_refusal() {
        assert_eq!(
            prepare_model_image_sync(b""),
            Err(ImageRejected::Unsupported)
        );
        assert_eq!(
            prepare_model_image_sync(b"GIF89a....."),
            Err(ImageRejected::Unsupported)
        );
        assert_eq!(
            prepare_model_image_sync(b"<svg></svg>"),
            Err(ImageRejected::Unsupported)
        );
        // right magic, no picture behind it
        assert_eq!(
            prepare_model_image_sync(b"\x89PNG\r\n\x1a\nnot really"),
            Err(ImageRejected::Decode)
        );
        // an animated WebP (VP8X with the animation flag)
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&[10, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            prepare_model_image_sync(&webp),
            Err(ImageRejected::Animated)
        );
        // a file that claims a canvas over the ceiling never reaches the decoder
        let wide = png_of(4097, 8, false);
        assert_eq!(prepare_model_image_sync(&wide), Err(ImageRejected::TooBig));
        // over the pixel ceiling with every side inside the dimension ceiling: 4001 × 4000 > 16 MP
        let many = png_of(4001, 4000, false);
        assert_eq!(prepare_model_image_sync(&many), Err(ImageRejected::TooBig));
        // …and the ceiling itself is open: exactly 16 MP is read (a phone photo is 12)
        assert!(prepare_model_image_sync(&png_of(4000, 4000, false)).is_ok());
    }

    #[test]
    fn the_model_image_debug_prints_no_byte() {
        let image = ModelImage {
            media_type: "image/jpeg",
            data: b"SECRET-PIXELS-SECRET".to_vec(),
        };
        for text in [
            format!("{image:?}"),
            format!("{image:#?}"),
            format!("{:?}", vec![image.clone()]),
        ] {
            assert!(!text.contains("SECRET"), "{text}");
            assert!(
                text.contains("bytes: 20") && text.contains("image/jpeg"),
                "{text}"
            );
        }
    }
}
