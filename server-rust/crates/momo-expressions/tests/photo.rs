//! The photo route's two child jobs (ADR-0218 §8 H9), through the real decoder executable: a
//! member's photo is made ready to leave (upright, small, and re-encoded from its pixels, so what
//! it carried — where it was taken, a comment, trailing bytes — stays behind), and a picture an
//! image model drew is cut out. The decoder's two slots are process-wide, so these tests take
//! turns.

use image::{DynamicImage, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use momo_expressions::cutout::Outcome;
use momo_expressions::media::{self, Rejected};
use std::io::Cursor;
use std::time::{Duration, Instant};

static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const LOCATION: &[u8] = b"GPS-37.5665N-126.9780E-MEMBER-HOME";
const TAIL: &[u8] = b"TRAILING-BYTES-OF-THE-ORIGINAL";

fn png_of(image: &RgbaImage) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}

/// A JPEG that carries an EXIF orientation, a comment naming where it was taken, and bytes after
/// its end: the three things a pass-through would hand to a stranger.
fn jpeg_taken_at_home(image: &RgbImage, orientation: u16) -> Vec<u8> {
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image.clone())
        .write_to(&mut jpeg, ImageFormat::Jpeg)
        .unwrap();
    let jpeg = jpeg.into_inner();
    let mut tiff = b"MM\0*".to_vec();
    tiff.extend_from_slice(&8u32.to_be_bytes());
    tiff.extend_from_slice(&1u16.to_be_bytes());
    tiff.extend_from_slice(&0x0112u16.to_be_bytes());
    tiff.extend_from_slice(&3u16.to_be_bytes());
    tiff.extend_from_slice(&1u32.to_be_bytes());
    tiff.extend_from_slice(&orientation.to_be_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_be_bytes());
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    // A COM segment: `FF FE`, a length that counts itself, the text.
    out.extend_from_slice(&[0xFF, 0xFE]);
    out.extend_from_slice(&((LOCATION.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(LOCATION);
    out.extend_from_slice(&jpeg[2..]);
    out.extend_from_slice(TAIL);
    out
}

fn has(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn disc(image: &mut RgbaImage, cx: i64, cy: i64, r: i64, colour: [u8; 4]) {
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (dx, dy) = (i64::from(x) - cx, i64::from(y) - cy);
        if dx * dx + dy * dy <= r * r {
            *pixel = Rgba(colour);
        }
    }
}

fn gif(frames: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new_with_speed(&mut bytes, 30);
        for _ in 0..frames {
            encoder
                .encode_frame(image::Frame::from_parts(
                    RgbaImage::from_pixel(8, 8, Rgba([20, 200, 50, 255])),
                    0,
                    0,
                    image::Delay::from_numer_denom_ms(100, 1),
                ))
                .unwrap();
        }
    }
    bytes
}

#[tokio::test]
async fn a_photo_leaves_upright_small_and_without_what_it_arrived_with() {
    let _turn = TURN.lock().await;
    // 3000 x 2000, stored sideways (EXIF 6: turn it a quarter clockwise to see it upright). Its
    // top-left quarter is red, the rest blue, so the turn can be seen in the pixels.
    let mut stored = RgbImage::from_pixel(3000, 2000, Rgb([0, 0, 255]));
    for y in 0..1000 {
        for x in 0..1500 {
            stored.put_pixel(x, y, Rgb([255, 0, 0]));
        }
    }
    let original = jpeg_taken_at_home(&stored, 6);
    assert!(has(&original, LOCATION) && has(&original, TAIL) && has(&original, b"Exif"));

    let prepared = media::prepare_photo(original)
        .await
        .expect("a prepared photo");
    assert_eq!(prepared.mime, "image/jpeg");
    assert!(prepared.data.len() <= media::PREPARED_MAX_BYTES);
    for gone in [LOCATION, TAIL, b"Exif".as_slice()] {
        assert!(
            !has(&prepared.data, gone),
            "{:?} must not leave with the photo",
            String::from_utf8_lossy(gone)
        );
    }
    let sent = image::load_from_memory(&prepared.data).unwrap().to_rgb8();
    // Upright: 2000 wide x 3000 tall, shrunk to 1024 on its long side.
    assert!(
        sent.height() == 1024 && (682..=684).contains(&sent.width()),
        "{}x{}",
        sent.width(),
        sent.height()
    );
    // The red quarter went to the top-right; the top-left is now blue.
    let corner = |x: u32, y: u32| sent.get_pixel(x, y).0;
    let (right, left) = (corner(sent.width() - 20, 20), corner(20, 20));
    assert!(
        right[0] > 200 && right[2] < 60,
        "top-right should be red, got {right:?}"
    );
    assert!(
        left[2] > 200 && left[0] < 60,
        "top-left should be blue, got {left:?}"
    );
}

#[tokio::test]
async fn a_photo_with_an_alpha_channel_stays_a_png_and_is_never_enlarged() {
    let _turn = TURN.lock().await;
    let mut picture = RgbaImage::from_pixel(300, 200, Rgba([10, 120, 60, 255]));
    disc(&mut picture, 150, 100, 40, [0, 0, 0, 0]);
    let mut with_tail = png_of(&picture);
    with_tail.extend_from_slice(TAIL);
    let prepared = media::prepare_photo(with_tail).await.expect("prepared");
    assert_eq!(prepared.mime, "image/png");
    assert!(
        !has(&prepared.data, TAIL),
        "bytes after IEND are not carried along"
    );
    let sent = image::load_from_memory(&prepared.data).unwrap().to_rgba8();
    assert_eq!(
        sent.dimensions(),
        (300, 200),
        "a small picture is not enlarged"
    );
    assert_eq!(sent.get_pixel(150, 100).0[3], 0, "the hole is still a hole");
    assert_eq!(sent.get_pixel(5, 5).0, [10, 120, 60, 255]);
}

/// Deterministic RGBA noise with a transparent hole: a picture a PNG encoder cannot make smaller, so
/// its file weighs about as much as its pixels (width x height x 4 bytes).
fn noise_with_a_hole(width: u32, height: u32) -> RgbaImage {
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let mut image = RgbaImage::new(width, height);
    for byte in image.iter_mut() {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        *byte = (state >> 24) as u8;
    }
    for y in 100..200 {
        for x in 100..200 {
            image.put_pixel(x, y, Rgba([0, 0, 0, 0]));
        }
    }
    image
}

/// #4992 (L4): the prepared photo came back from the child as a JSON list of numbers, up to four
/// characters a byte, so a PNG over about 2.3 MB overran the 8 MiB the parent reads and a photo with
/// an alpha channel was refused as invalid media. Both sides of the boundary, through the real child.
#[tokio::test]
async fn a_large_photo_with_an_alpha_channel_comes_back_from_the_child_whole() {
    let _turn = TURN.lock().await;
    let old_break = 2_500_000; // above what the old encoding carried (about 2.3 MB), below the bound
    let sizes = [(900u32, 900u32), (1024, 1000)];
    for (width, height) in sizes {
        let photo = noise_with_a_hole(width, height);
        let original = png_of(&photo);
        assert!(
            (old_break..=media::PREPARED_MAX_BYTES).contains(&original.len()),
            "{width}x{height}: the test picture is {} bytes: past the old break, within the bound",
            original.len()
        );
        let prepared = media::prepare_photo(original)
            .await
            .unwrap_or_else(|rejected| panic!("{width}x{height} was refused: {rejected:?}"));
        assert_eq!(prepared.mime, "image/png");
        assert!(prepared.data.len() >= old_break, "{}", prepared.data.len());
        let sent = image::load_from_memory(&prepared.data).unwrap().to_rgba8();
        assert_eq!(sent.dimensions(), (width, height));
        assert_eq!(sent.get_pixel(150, 150).0[3], 0, "the hole is still a hole");
        assert!(
            sent.as_raw() == photo.as_raw(),
            "{width}x{height}: every pixel came back as it went in"
        );
    }
    // One row more and the picture no longer fits the 4 MiB a prepared photo may weigh: refused as
    // invalid, by the bound, and not for the size of the child's answer.
    let over = noise_with_a_hole(1024, 1024);
    let original = png_of(&over);
    assert!(
        original.len() > media::PREPARED_MAX_BYTES
            && original.len() <= momo_expressions::INPUT_BYTES,
        "the test picture is {} bytes: it goes in, and cannot come out",
        original.len()
    );
    assert_eq!(
        media::prepare_photo(original)
            .await
            .map(|prepared| prepared.data.len()),
        Err(Rejected::Invalid)
    );
}

#[tokio::test]
async fn what_is_not_a_still_picture_is_refused_before_anything_can_leave() {
    let _turn = TURN.lock().await;
    let mp4 = vec![0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'];
    let svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".to_vec();
    let sideways = png_of(&RgbaImage::new(5000, 10));
    let table: [(&str, Vec<u8>, Rejected); 6] = [
        ("an animated GIF", gif(3), Rejected::Invalid),
        ("a video", mp4, Rejected::Video),
        ("an SVG", svg, Rejected::Invalid),
        ("nothing", Vec::new(), Rejected::Invalid),
        ("a picture wider than 4096", sideways, Rejected::Invalid),
        (
            "more than 5 MiB",
            vec![0u8; 5 * 1024 * 1024 + 1],
            Rejected::TooLarge,
        ),
    ];
    for (what, bytes, want) in table {
        assert_eq!(
            media::prepare_photo(bytes).await.unwrap_err(),
            want,
            "{what}"
        );
    }
}

#[tokio::test]
async fn a_busy_decoder_refuses_a_photo_at_once_and_a_paid_for_picture_waits_its_turn() {
    let _turn = TURN.lock().await;
    let slots = media::decoder_slots();
    let first = slots.clone().acquire_owned().await.unwrap();
    let second = slots.clone().acquire_owned().await.unwrap();
    let photo = png_of(&RgbaImage::from_pixel(64, 64, Rgba([1, 2, 3, 255])));
    let started = Instant::now();
    assert_eq!(
        media::prepare_photo(photo.clone()).await.unwrap_err(),
        Rejected::Busy
    );
    assert!(
        started.elapsed() < Duration::from_millis(150),
        "refused at once, not after a wait"
    );
    let started = Instant::now();
    assert_eq!(
        media::process_cutout(photo.clone(), Duration::from_millis(250))
            .await
            .unwrap_err(),
        Rejected::Busy,
        "the wait ran out"
    );
    assert!(
        started.elapsed() >= Duration::from_millis(200),
        "it did wait: {:?}",
        started.elapsed()
    );
    // A slot frees up while it waits: the picture gets it.
    let waiting = tokio::spawn(media::process_cutout(photo, Duration::from_secs(2)));
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(first);
    assert!(waiting.await.unwrap().is_ok());
    drop(second);
}

#[tokio::test]
async fn a_picture_a_model_drew_is_cut_out_in_the_child_and_says_how() {
    let _turn = TURN.lock().await;
    let wait = Duration::from_secs(3);
    // Drawn on one flat colour: erased from the edges in.
    let mut flat = RgbaImage::from_pixel(600, 600, Rgba([0, 200, 0, 255]));
    disc(&mut flat, 300, 300, 200, [255, 0, 0, 255]);
    let cut = media::process_cutout(png_of(&flat), wait)
        .await
        .expect("cut out");
    assert_eq!(cut.outcome, Outcome::Erased);
    let large = image::load_from_memory(&cut.processed.large.data)
        .unwrap()
        .to_rgba8();
    assert!(
        large.width().max(large.height()) <= 512 && large.width() > 400,
        "{:?}",
        large.dimensions()
    );
    assert_eq!(
        large.get_pixel(0, 0).0[3],
        0,
        "the corner is background now"
    );
    assert_eq!(
        large.get_pixel(large.width() / 2, large.height() / 2).0,
        [255, 0, 0, 255]
    );
    assert_eq!(cut.processed.small.info.mime, "image/png");
    assert!(
        cut.processed
            .small
            .info
            .width
            .max(cut.processed.small.info.height)
            <= 128
    );

    // Drawn with a transparent background by the model: kept, and only cropped.
    let mut drawn = RgbaImage::from_pixel(600, 600, Rgba([0, 0, 0, 0]));
    disc(&mut drawn, 300, 300, 150, [20, 40, 220, 255]);
    let cut = media::process_cutout(png_of(&drawn), wait).await.unwrap();
    assert_eq!(cut.outcome, Outcome::Model);

    // Not provably flat: untouched, and the renditions are an ordinary picture's.
    let mut gradient = RgbaImage::new(600, 600);
    for (x, _, pixel) in gradient.enumerate_pixels_mut() {
        let v = (x * 255 / 599) as u8;
        *pixel = Rgba([v, v, v, 255]);
    }
    disc(&mut gradient, 300, 300, 150, [255, 0, 0, 255]);
    let cut = media::process_cutout(png_of(&gradient), wait)
        .await
        .unwrap();
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert_eq!(
        (
            cut.processed.large.info.width,
            cut.processed.large.info.height
        ),
        (512, 512)
    );

    // What is not a picture is refused the same way as anywhere.
    assert_eq!(
        media::process_cutout(b"<html>".to_vec(), wait)
            .await
            .unwrap_err(),
        Rejected::Invalid
    );
}

#[test]
fn the_renditions_of_a_cut_out_have_no_coloured_fringe() {
    // The left half is opaque red; the right half is transparent, but its hidden colour is green.
    // Shrinking must not let that green into the visible edge.
    let mut picture = RgbaImage::new(1024, 1024);
    for (x, _, pixel) in picture.enumerate_pixels_mut() {
        *pixel = if x < 512 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 255, 0, 0])
        };
    }
    let cut =
        media::decode_cutout(&png_of(&picture), Instant::now() + Duration::from_secs(10)).unwrap();
    assert_eq!(cut.outcome, Outcome::Model);
    for rendition in [&cut.processed.small, &cut.processed.large] {
        let image = image::load_from_memory(&rendition.data).unwrap().to_rgba8();
        let greenest = image
            .pixels()
            .filter(|p| p.0[3] > 0)
            .map(|p| p.0[1])
            .max()
            .unwrap();
        assert!(greenest <= 2, "a visible pixel has green {greenest}");
    }
}

#[test]
fn the_codec_child_takes_only_its_three_modes() {
    let child = env!("CARGO_BIN_EXE_momo-expression-decoder");
    for args in [
        vec!["--bogus"],
        vec!["--prepare", "--cutout"],
        vec!["--cutout", "extra"],
        vec![""],
    ] {
        let output = std::process::Command::new(child)
            .args(&args)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}: nothing is answered");
    }
}
