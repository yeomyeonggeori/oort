use image::{AnimationDecoder, Delay, DynamicImage, Frame, ImageFormat};
use momo_expressions::media::{decode, Rejected};
use std::io::Cursor;
use std::time::{Duration, Instant};

fn still() -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::new_rgba8(200, 100)
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
fn gif(n: usize, delay: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for _ in 0..n {
            encoder
                .encode_frame(Frame::from_parts(
                    image::RgbaImage::from_pixel(8, 8, image::Rgba([20, 200, 50, 255])),
                    0,
                    0,
                    Delay::from_numer_denom_ms(delay, 1),
                ))
                .unwrap();
        }
    }
    bytes
}
fn process(b: &[u8]) -> Result<momo_expressions::media::Processed, Rejected> {
    decode(b, Instant::now() + Duration::from_secs(10))
}

#[tokio::test]
async fn codec_subprocess_accepts_pixels_with_resource_limits_and_cleared_environment() {
    // Exercise the real executable and supervisor used by HTTP, including its
    // platform resource limits. In-process decode alone cannot catch startup
    // failure (which otherwise turns a valid PNG upload into HTTP 415).
    let media = momo_expressions::media::process(still()).await.unwrap();
    assert_eq!(
        (media.large.info.width, media.large.info.height),
        (200, 100)
    );
    assert_eq!(media.small.info.mime, "image/png");
    assert_eq!(
        momo_expressions::media::process(vec![
            0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'
        ])
        .await
        .unwrap_err(),
        Rejected::Video
    );
}

#[test]
fn fresh_pixels_remove_trailing_metadata_preserve_ratio_and_never_enlarge() {
    let mut b = still();
    b.extend_from_slice(b"secret EXIF ICC <script>trailer</script>");
    let m = process(&b).unwrap();
    assert_eq!((m.small.info.width, m.small.info.height), (128, 64));
    assert_eq!((m.large.info.width, m.large.info.height), (200, 100));
    for (_, r) in m.variants() {
        assert!(!r.data.windows(6).any(|w| w == b"secret"));
        assert_eq!(image::guess_format(&r.data).unwrap(), ImageFormat::Png);
        assert_eq!(r.info.bytes, r.data.len());
    }
}

#[test]
fn jpeg_metadata_and_static_webp_are_reencoded_from_pixels() {
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(20, 10)
        .write_to(&mut jpeg, ImageFormat::Jpeg)
        .unwrap();
    let mut jpeg = jpeg.into_inner();
    for (marker, payload) in [
        (0xe1, b"Exif\0\0secret_metadata".as_slice()),
        (0xe2, b"ICC_PROFILE\0secret_metadata"),
        (0xfe, b"secret_metadata"),
    ] {
        let mut segment = vec![0xff, marker];
        segment.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        segment.extend_from_slice(payload);
        jpeg.splice(2..2, segment);
    }
    let mut webp = Cursor::new(Vec::new());
    DynamicImage::new_rgba8(20, 10)
        .write_to(&mut webp, ImageFormat::WebP)
        .unwrap();
    for bytes in [jpeg, webp.into_inner()] {
        let media = process(&bytes).unwrap();
        for (_, r) in media.variants() {
            assert_eq!(r.info.mime, "image/png");
            assert_eq!((r.info.width, r.info.height), (20, 10));
            assert!(!r.data.windows(15).any(|w| w == b"secret_metadata"));
        }
    }
}

#[test]
fn gif_all_frames_delays_and_four_plays_are_encoded_with_static_thumb() {
    let m = process(&gif(3, 0)).unwrap();
    assert_eq!(
        (m.large.info.frame_count, m.large.info.duration_ms),
        (3, 60)
    );
    assert_eq!(m.thumb.info.mime, "image/png");
    for r in [&m.small, &m.large] {
        // NETSCAPE2.0 stores the repeat count after the first pass. Three
        // repetitions plus initial display is four complete plays.
        let p = r
            .data
            .windows(11)
            .position(|w| w == b"NETSCAPE2.0")
            .unwrap()
            + 11;
        assert_eq!(&r.data[p..p + 5], &[3, 1, 3, 0, 0]);
        let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(&r.data)).unwrap();
        let frames: Vec<_> = decoder.into_frames().map(Result::unwrap).collect();
        assert_eq!(frames.len(), 3);
        assert!(frames.iter().all(|f| f.delay().numer_denom_ms() == (20, 1)));
    }
    assert_eq!(process(&gif(1, 0)).unwrap().large.info.mime, "image/png");
}

#[test]
fn rejects_all_frame_bombs_duration_dimensions_apng_webp_svg_and_bad_magic() {
    assert!(process(&gif(101, 20)).is_err());
    assert!(process(&gif(2, 6000)).is_err());
    let mut dimensions = gif(2, 20);
    dimensions[6..10].copy_from_slice(&[1, 2, 1, 2]);
    assert!(process(&dimensions).is_err()); // 513x513 animation
    let mut bad = still();
    bad[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(process(&bad).is_err());
    // A valid one-frame APNG: a malformed acTL would also be rejected by the
    // PNG decoder and could not prove the explicit animation prohibition.
    use base64::Engine;
    let apng = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAABAAAAALQt6aAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYII=").unwrap();
    assert!(image::load_from_memory(&apng).is_ok());
    assert!(process(&apng).is_err());
    for b in [b"<svg/>".as_slice(), b"RIFF0000WEBPANIM", b"not an image"] {
        assert!(process(b).is_err());
    }
    assert_eq!(
        process(&[0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm']).unwrap_err(),
        Rejected::Video
    );
    assert!(process(&vec![0; 5 * 1024 * 1024 + 1]).is_err());
    let mut padded = still();
    padded.resize(5 * 1024 * 1024 + 1, 0);
    assert_eq!(process(&padded).unwrap_err(), Rejected::TooLarge);
    assert_eq!(
        decode(&still(), Instant::now() - Duration::from_secs(1)).unwrap_err(),
        Rejected::Timeout
    );
}

#[test]
fn rendition_overflow_fails_without_truncating_or_substituting_pixels() {
    let mut seed = 0x719d_2901u32;
    let image = image::RgbaImage::from_fn(512, 512, |_, _| {
        let mut pixel = [0; 4];
        for c in &mut pixel {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *c = seed as u8;
        }
        image::Rgba(pixel)
    });
    let mut input = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut input, ImageFormat::Png)
        .unwrap();
    assert!(input.get_ref().len() > 1024 * 1024);
    assert!(process(input.get_ref()).is_err());
}

/// #4829: `sniff` is how the link importer tells "not an image at all" from "an image
/// we could not decode" without starting a codec. It must never disagree with `decode`.
#[test]
fn sniff_classifies_by_magic_alone_and_agrees_with_decode() {
    use momo_expressions::media::{sniff, Sniffed};
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(20, 10)
        .write_to(&mut jpeg, ImageFormat::Jpeg)
        .unwrap();
    let mut webp = Cursor::new(Vec::new());
    DynamicImage::new_rgba8(20, 10)
        .write_to(&mut webp, ImageFormat::WebP)
        .unwrap();
    let mut mp4 = vec![0, 0, 0, 0x18];
    mp4.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2mp41");
    mp4.extend_from_slice(&[0; 64]);
    let mut quicktime = vec![0, 0, 0, 0x14];
    quicktime.extend_from_slice(b"ftypqt  \0\0\0\0qt  ");
    quicktime.extend_from_slice(&[0; 64]);
    let mut webm = vec![0x1a, 0x45, 0xdf, 0xa3, 0x9f];
    webm.extend_from_slice(&[0; 64]);
    let mut heic = vec![0, 0, 0, 0x18];
    heic.extend_from_slice(b"ftypheic\0\0\0\0mif1heic");
    heic.extend_from_slice(&[0; 64]);

    let images: Vec<(&str, Vec<u8>)> = vec![
        ("png", still()),
        ("gif", gif(3, 80)),
        ("jpeg", jpeg.into_inner()),
        ("webp", webp.into_inner()),
    ];
    for (what, bytes) in &images {
        assert_eq!(sniff(bytes), Sniffed::Image, "{what}");
        assert!(process(bytes).is_ok(), "{what}: sniffed Image, decodes");
    }
    // Magic is all it reads: a header that claims PNG is Image even if nothing follows,
    // and decode is what then says it is invalid.
    let hollow = b"\x89PNG\r\n\x1a\n".to_vec();
    assert_eq!(sniff(&hollow), Sniffed::Image);
    assert_eq!(process(&hollow).unwrap_err(), Rejected::Invalid);

    for (what, bytes) in [("mp4", &mp4), ("quicktime", &quicktime), ("webm", &webm)] {
        assert_eq!(sniff(bytes), Sniffed::Video, "{what}");
        assert_eq!(
            process(bytes).unwrap_err(),
            Rejected::Video,
            "{what}: sniffed Video, decode agrees"
        );
    }
    let page = b"<!doctype html><html><body>not a picture</body></html>".to_vec();
    let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>".to_vec();
    let xml = b"<?xml version=\"1.0\"?><svg/>".to_vec();
    let script = b"alert(document.cookie)".to_vec();
    let mut tail_only = vec![0; 32];
    tail_only.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut avif = vec![0, 0, 0, 0x18];
    avif.extend_from_slice(b"ftypavif\0\0\0\0mif1avif");
    avif.extend_from_slice(&[0; 64]);
    for (what, bytes) in [
        ("empty", Vec::new()),
        ("one byte", vec![0x89]),
        ("html page", page),
        ("svg", svg),
        ("xml", xml),
        ("javascript", script),
        ("png magic that does not start the body", tail_only),
        ("heic", heic),
        ("avif", avif),
        ("zeroes", vec![0; 4096]),
    ] {
        assert_eq!(sniff(&bytes), Sniffed::Unsupported, "{what}");
        assert!(
            process(&bytes).is_err(),
            "{what}: sniffed Unsupported, never decodes"
        );
    }
}

// ---- #5455: smaller bytes, the same picture --------------------------------------------------

/// Deterministic noise, so a picture is the same on every machine.
fn lcg(seed: &mut u32) -> u8 {
    *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    (*seed >> 24) as u8
}

/// A soft-edged sticker-like picture: a shaded disc with grain on a see-through background.
fn sticker(side: u32, opaque: bool) -> image::RgbaImage {
    let mut seed = 0x5455_0001;
    image::RgbaImage::from_fn(side, side, |x, y| {
        let (dx, dy) = (x as f32 - side as f32 / 2.0, y as f32 - side as f32 / 2.0);
        let r = (dx * dx + dy * dy).sqrt() / (side as f32 / 2.0);
        let grain = lcg(&mut seed) % 7;
        if opaque {
            return image::Rgba([
                (x * 255 / side) as u8 / 2 + grain,
                (y * 255 / side) as u8 / 2,
                120 + grain,
                255,
            ]);
        }
        let alpha = if r < 0.8 {
            255
        } else if r < 0.9 {
            (255.0 * (0.9 - r) / 0.1) as u8
        } else {
            0
        };
        image::Rgba([
            (200.0 * (1.0 - r)) as u8 + grain,
            90 + grain,
            (60.0 + 150.0 * r) as u8,
            alpha,
        ])
    })
}

fn png_bytes(image: &image::RgbaImage) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

/// The pixels a rendition of `edge` must hold: the source shrunk to `edge`, never enlarged.
fn expected(image: &image::RgbaImage, edge: u32) -> image::RgbaImage {
    let edge = edge.min(image.width().max(image.height()));
    DynamicImage::ImageRgba8(image.clone())
        .thumbnail(edge, edge)
        .to_rgba8()
}

fn legacy_png_len(image: &image::RgbaImage) -> usize {
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
    out.len()
}

/// Lossless means the same pixels: every channel of every pixel, both sizes, and never larger than
/// the old encoder's bytes (strictly smaller on a picture with texture).
#[test]
fn still_renditions_are_the_same_pixels_in_fewer_bytes() {
    let source = sticker(300, false);
    let m = process(&png_bytes(&source)).unwrap();
    for (edge, rendition) in [(512, &m.large), (128, &m.small), (128, &m.thumb)] {
        let decoded = image::load_from_memory(&rendition.data).unwrap().to_rgba8();
        let want = expected(&source, edge);
        assert_eq!(decoded.dimensions(), want.dimensions());
        let different = decoded
            .pixels()
            .zip(want.pixels())
            .filter(|(a, b)| a != b)
            .count();
        assert_eq!(different, 0, "{edge}: {different} pixels changed");
        assert_eq!(
            rendition.data[25], 6,
            "a picture with see-through pixels stays RGBA"
        );
        assert!(
            rendition.data.len() < legacy_png_len(&want),
            "{edge}: {} bytes is not smaller than the old {}",
            rendition.data.len(),
            legacy_png_len(&want)
        );
    }
}

/// A picture with no see-through pixel is written without the alpha plane and comes back opaque.
#[test]
fn an_opaque_still_is_written_as_rgb_and_reads_back_identical() {
    let source = sticker(200, true);
    let m = process(&png_bytes(&source)).unwrap();
    let decoded = image::load_from_memory(&m.large.data).unwrap().to_rgba8();
    assert_eq!(decoded, source);
    assert_eq!(m.large.data[25], 2, "RGB, not RGBA");
    assert!(m.large.data.len() < legacy_png_len(&source));
}

/// What a viewer sees of one frame, and its delay as (numerator, denominator) in milliseconds.
type Shown = (Vec<Option<[u8; 3]>>, (u32, u32));

/// What a viewer sees of each frame: `None` where nothing is painted, the colour where something is.
/// (Any visible pixel is opaque in a GIF; the colour of a pixel that is not drawn means nothing.)
fn seen(bytes: &[u8]) -> Vec<Shown> {
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).unwrap();
    decoder
        .into_frames()
        .map(|frame| {
            let frame = frame.unwrap();
            let delay = frame.delay().numer_denom_ms();
            let pixels = frame
                .into_buffer()
                .pixels()
                .map(|p| (p.0[3] != 0).then_some([p.0[0], p.0[1], p.0[2]]))
                .collect();
            (pixels, delay)
        })
        .collect()
}

fn square(canvas: u32, left: u32, top: u32, w: u32, h: u32, color: [u8; 3]) -> image::RgbaImage {
    image::RgbaImage::from_fn(canvas, canvas, |x, y| {
        if (left..left + w).contains(&x) && (top..top + h).contains(&y) {
            image::Rgba([color[0], color[1], color[2], 255])
        } else {
            image::Rgba([0, 0, 0, 0])
        }
    })
}

fn gif_of(frames: &[(image::RgbaImage, u32)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        encoder
            .set_repeat(image::codecs::gif::Repeat::Infinite)
            .unwrap();
        for (image, delay) in frames {
            encoder
                .encode_frame(Frame::from_parts(
                    image.clone(),
                    0,
                    0,
                    Delay::from_numer_denom_ms(*delay, 1),
                ))
                .unwrap();
        }
    }
    bytes
}

/// A square that moves, one frame with nothing in it, a wider one: pixels go from painted to
/// see-through between frames, which only clearing the previous frame can express.
#[test]
fn a_moving_gif_comes_back_pixel_for_pixel_with_its_delays_boxed_and_cleared() {
    let frames = [
        (square(16, 2, 2, 4, 4, [220, 30, 30]), 40),
        (square(16, 8, 8, 4, 4, [30, 200, 60]), 60),
        (square(16, 0, 0, 0, 0, [0, 0, 0]), 80),
        (square(16, 4, 10, 6, 3, [40, 60, 220]), 100),
    ];
    let input = gif_of(&frames);
    let m = process(&input).unwrap();
    let want = seen(&input);
    assert_eq!(want.len(), 4);
    for (what, rendition) in [("small", &m.small), ("large", &m.large)] {
        assert_eq!(
            (rendition.info.width, rendition.info.height),
            (16, 16),
            "{what}"
        );
        assert_eq!(
            (rendition.info.frame_count, rendition.info.duration_ms),
            (4, 280),
            "{what}"
        );
        let got = seen(&rendition.data);
        assert_eq!(got.len(), want.len(), "{what}: frames");
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_eq!(g.1, w.1, "{what}: delay of frame {i}");
            assert!(g.0 == w.0, "{what}: frame {i} shows other pixels");
        }
    }
    // The bytes spell it as a box per frame, cleared after: the shapes below are the contract
    // that makes the pixel check above mean something.
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::Indexed);
    let mut decoder = options.read_info(Cursor::new(&m.large.data)).unwrap();
    let mut boxes = Vec::new();
    while let Some(frame) = decoder.read_next_frame().unwrap() {
        boxes.push((
            (frame.left, frame.top, frame.width, frame.height),
            frame.dispose == gif::DisposalMethod::Background,
            frame.transparent.is_some(),
        ));
    }
    assert_eq!(
        boxes,
        vec![
            ((2, 2, 4, 4), true, true),
            ((8, 8, 4, 4), true, true),
            ((0, 0, 1, 1), true, true),
            ((4, 10, 6, 3), true, true),
        ]
    );
}

/// The error of `got` against `want`, over painted pixels: (mean, worst) of the largest channel
/// difference of a pixel. Which pixels are painted must agree exactly.
fn drift(got: &[Shown], want: &[Shown]) -> (f64, u32) {
    assert_eq!(got.len(), want.len(), "frames");
    let (mut total, mut worst, mut count) = (0u64, 0u32, 0u64);
    for ((g, _), (w, _)) in got.iter().zip(want) {
        for (a, b) in g.iter().zip(w) {
            match (a, b) {
                (None, None) => {}
                (Some(a), Some(b)) => {
                    let error: u32 = a
                        .iter()
                        .zip(b)
                        .map(|(x, y)| u32::from(x.abs_diff(*y)))
                        .max()
                        .unwrap();
                    worst = worst.max(error);
                    total += u64::from(error);
                    count += 1;
                }
                _ => panic!("a pixel is painted in one and not in the other"),
            }
        }
    }
    (total as f64 / count as f64, worst)
}

/// What a viewer sees of `frames` once they are shrunk to `edge`: the picture the output must show.
fn shrunk_view(frames: &[(image::RgbaImage, u32)], edge: u32) -> Vec<Shown> {
    frames
        .iter()
        .map(|(image, delay)| {
            let pixels = expected(image, edge)
                .pixels()
                .map(|p| (p.0[3] != 0).then_some([p.0[0], p.0[1], p.0[2]]))
                .collect();
            (pixels, (*delay, 1))
        })
        .collect()
}

/// A frame of `side` x `side` with `levels` x `levels` distinct colours (so under a palette's
/// worth), in a blue that moves by `shade`, with the pattern slid `slide` pixels to the right.
/// A see-through margin surrounds it.
fn banded(side: u32, levels: u32, shade: u32, slide: u32) -> image::RgbaImage {
    image::RgbaImage::from_fn(side, side, |x, y| {
        if x < 6 || y < 6 || x + 6 >= side || y + 6 >= side {
            return image::Rgba([0, 0, 0, 0]);
        }
        let (a, b) = (
            (x - 6 + slide) % side * levels / side,
            (y - 6) * levels / side,
        );
        image::Rgba([
            (a * 255 / levels) as u8,
            (b * 255 / levels) as u8,
            40 + shade as u8,
            255,
        ])
    })
}

/// A site's GIF: every frame has a palette of its own, so together they hold far more colours than
/// one table, though each frame by itself is exact. It must come back exactly, as it did before.
#[test]
fn a_gif_whose_frames_each_fit_a_palette_comes_back_exactly() {
    let frames: Vec<(image::RgbaImage, u32)> =
        (0..4).map(|f| (banded(64, 14, f * 40, 0), 80)).collect();
    let input = gif_of(&frames);
    let want = seen(&input);
    let colors: std::collections::HashSet<_> =
        want.iter().flat_map(|(p, _)| p.iter().flatten()).collect();
    assert!(
        colors.len() > 256,
        "together too many for one table ({})",
        colors.len()
    );
    let m = process(&input).unwrap();
    for (what, rendition) in [("small", &m.small), ("large", &m.large)] {
        let (mean, worst) = drift(&seen(&rendition.data), &want);
        assert_eq!((mean, worst), (0.0, 0), "{what}");
    }
}

/// A frame with more colours than a palette holds (a 400 px picture shrunk to 128 blends them) has
/// to move its colours, a little, and nothing else may move. The bound is a number, and it is the
/// old encoder's own error on the same frames (a palette trained for each frame, as `gif_of`
/// does): the new shared palette must not be further from the picture than that.
#[test]
fn a_shrunk_gif_past_a_palette_of_colours_is_no_further_from_its_picture_than_before() {
    let frames: Vec<(image::RgbaImage, u32)> =
        (0..6).map(|f| (banded(400, 30, 0, f * 21), 80)).collect();
    let input = gif_of(&frames);
    let decoded: Vec<(image::RgbaImage, u32)> =
        image::codecs::gif::GifDecoder::new(Cursor::new(&input))
            .unwrap()
            .into_frames()
            .map(|f| (f.unwrap().into_buffer(), 80))
            .collect();
    let ideal = shrunk_view(&decoded, 128);
    for (i, (pixels, _)) in ideal.iter().enumerate() {
        let colors: std::collections::HashSet<_> = pixels.iter().flatten().collect();
        assert!(
            colors.len() > 256,
            "frame {i} must not fit a table by itself ({} colours)",
            colors.len()
        );
    }
    // The old encoder's answer: the shrunk frames, a palette trained for each.
    let shrunk: Vec<(image::RgbaImage, u32)> = decoded
        .iter()
        .map(|(f, d)| (expected(f, 128), *d))
        .collect();
    let (old_mean, old_worst) = drift(&seen(&gif_of(&shrunk)), &ideal);
    let m = process(&input).unwrap();
    let (mean, worst) = drift(&seen(&m.small.data), &ideal);
    assert!(
        mean <= old_mean,
        "mean channel error {mean:.2} is above the old encoder's {old_mean:.2}"
    );
    assert!(
        worst <= old_worst,
        "worst channel error {worst} is above the old encoder's {old_worst}"
    );
}
