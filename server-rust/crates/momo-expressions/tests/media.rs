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
