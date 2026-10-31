//! ADR-0218 G3: the assembly through the real isolated child (`momo-expression-assembler`).
//! Pixel formulas are measured on the decoded GIF; the supervision tests use fixture scripts in
//! place of the child, like the decoder tests do.
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::codecs::gif::{GifDecoder, GifEncoder, Repeat};
use image::{AnimationDecoder, Delay, DynamicImage, Frame, ImageFormat, Rgba, RgbaImage};
use momo_expressions::assemble::*;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

const BG: [u8; 3] = [240, 240, 240];
const FG: [u8; 3] = [200, 30, 30];
const MIB: usize = 1024 * 1024;
/// A debug build of the child is slow and tests run side by side: only the timeout tests use the
/// real 10 s budget.
const PATIENT: Duration = Duration::from_secs(60);

fn program() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_momo-expression-assembler"))
}
fn slots() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(2))
}
async fn run(request: &AssembleRequest, source: Vec<u8>) -> Result<Vec<Outcome>, AssembleError> {
    try_assemble_with_program(
        program(),
        PATIENT,
        request,
        source,
        SourceFrom::Request,
        &slots(),
    )
    .await
}
async fn candidates(request: &AssembleRequest, source: Vec<u8>) -> Vec<Candidate> {
    run(request, source)
        .await
        .unwrap()
        .into_iter()
        .map(|o| o.expect("every candidate is made"))
        .collect()
}
/// The error of a call that must have failed.
fn failure(r: Result<Vec<Outcome>, AssembleError>, what: &str) -> AssembleError {
    match r {
        Err(e) => e,
        Ok(v) => panic!("{what}: assembled {v:?}"),
    }
}
fn presets(list: &[Preset], size: u32) -> AssembleRequest {
    AssembleRequest {
        motion: Motion::Preset {
            presets: list.to_vec(),
        },
        size,
    }
}
fn sprite(frames: u32, sequence: &[u32], frame_ms: u32, size: u32) -> AssembleRequest {
    AssembleRequest {
        motion: Motion::Sprite {
            frames,
            sequence: sequence.to_vec(),
            frame_ms,
        },
        size,
    }
}

fn encode(img: &RgbaImage, format: ImageFormat) -> Vec<u8> {
    let mut bytes = Cursor::new(Vec::new());
    let image = DynamicImage::ImageRgba8(img.clone());
    match format {
        ImageFormat::Jpeg => DynamicImage::ImageRgb8(image.to_rgb8()).write_to(&mut bytes, format),
        _ => image.write_to(&mut bytes, format),
    }
    .unwrap();
    bytes.into_inner()
}
fn png(img: &RgbaImage) -> Vec<u8> {
    encode(img, ImageFormat::Png)
}
fn solid(w: u32, h: u32, c: [u8; 3]) -> RgbaImage {
    RgbaImage::from_pixel(w, h, Rgba([c[0], c[1], c[2], 255]))
}
fn fill_rect(img: &mut RgbaImage, rect: (u32, u32, u32, u32), c: [u8; 3]) {
    for y in rect.1..rect.1 + rect.3 {
        for x in rect.0..rect.0 + rect.2 {
            img.put_pixel(x, y, Rgba([c[0], c[1], c[2], 255]));
        }
    }
}
/// 192 square (the 80% box of a 240 canvas: no resampling) with one red bar at its centre.
fn bar_source() -> RgbaImage {
    let mut img = solid(192, 192, BG);
    fill_rect(&mut img, (30, 86, 132, 20), FG);
    img
}
/// Deterministic noise from a small palette (exact palette per frame, so cheap to encode).
fn noise(w: u32, h: u32, colors: u32) -> RgbaImage {
    let mut seed = 0x9e37_79b9u32;
    RgbaImage::from_fn(w, h, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let k = seed % colors;
        Rgba([
            (k * 37 % 256) as u8,
            (k * 91 % 256) as u8,
            (k * 53 % 256) as u8,
            255,
        ])
    })
}

// ---- reading a GIF back, independently of the code that wrote it -------------------------
#[derive(Default, Debug)]
struct Gif {
    version: Vec<u8>,
    width: u16,
    height: u16,
    apps: Vec<(Vec<u8>, Vec<Vec<u8>>)>,
    comments: usize,
    plain_text: usize,
    delays_cs: Vec<u16>,
    disposals: Vec<u8>,
    images: usize,
    trailer: bool,
}
fn sub_blocks(b: &[u8], p: &mut usize) -> Vec<Vec<u8>> {
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
}
fn walk(b: &[u8]) -> Gif {
    let mut g = Gif {
        version: b[..6].to_vec(),
        width: u16::from_le_bytes([b[6], b[7]]),
        height: u16::from_le_bytes([b[8], b[9]]),
        ..Gif::default()
    };
    let flags = b[10];
    let mut p = 13
        + if flags & 0x80 != 0 {
            3 << ((flags & 7) + 1)
        } else {
            0
        };
    loop {
        match b[p] {
            0x3b => {
                g.trailer = true;
                assert_eq!(p + 1, b.len(), "nothing follows the trailer");
                return g;
            }
            0x21 => {
                let label = b[p + 1];
                p += 2;
                match label {
                    0xf9 => {
                        assert_eq!(b[p], 4);
                        g.disposals.push((b[p + 1] >> 2) & 7);
                        g.delays_cs.push(u16::from_le_bytes([b[p + 2], b[p + 3]]));
                        assert_eq!(b[p + 5], 0);
                        p += 6;
                    }
                    0xff => {
                        let mut blocks = sub_blocks(b, &mut p);
                        let id = blocks.remove(0);
                        g.apps.push((id, blocks));
                    }
                    0xfe => {
                        g.comments += 1;
                        sub_blocks(b, &mut p);
                    }
                    0x01 => {
                        g.plain_text += 1;
                        sub_blocks(b, &mut p);
                    }
                    other => panic!("extension {other:#x}"),
                }
            }
            0x2c => {
                g.images += 1;
                let local = b[p + 9];
                p += 10;
                if local & 0x80 != 0 {
                    p += 3 << ((local & 7) + 1);
                }
                p += 1; // LZW minimum code size
                sub_blocks(b, &mut p);
            }
            other => panic!("block {other:#x} at {p}"),
        }
    }
}
/// Composited frames with their delay in ms, exactly as a player shows them.
fn frames_of(bytes: &[u8]) -> Vec<(RgbaImage, u32)> {
    GifDecoder::new(Cursor::new(bytes))
        .unwrap()
        .into_frames()
        .map(|f| {
            let f = f.unwrap();
            let (n, d) = f.delay().numer_denom_ms();
            (f.into_buffer(), n / d)
        })
        .collect()
}

// ---- measuring the red marker ------------------------------------------------------------
struct Blob {
    cx: f64,
    cy: f64,
    vxx: f64,
    vyy: f64,
    vxy: f64,
}
impl Blob {
    fn width(&self) -> f64 {
        (12.0 * self.vxx).sqrt()
    }
    fn height(&self) -> f64 {
        (12.0 * self.vyy).sqrt()
    }
    fn degrees(&self) -> f64 {
        (0.5 * (2.0 * self.vxy).atan2(self.vxx - self.vyy)).to_degrees()
    }
}
fn blob(img: &RgbaImage) -> Blob {
    let cover = |p: &Rgba<u8>| {
        ((f64::from(BG[1]) - f64::from(p.0[1])) / f64::from(BG[1] - FG[1])).clamp(0.0, 1.0)
    };
    // The stars of `sparkle` live in the margin corners: look at the picture box only.
    let inside = |x: u32, y: u32| {
        let m = img.width() / 10;
        x >= m && y >= m && x < img.width() - m && y < img.height() - m
    };
    let (mut area, mut sx, mut sy) = (0.0, 0.0, 0.0);
    for (x, y, p) in img.enumerate_pixels().filter(|(x, y, _)| inside(*x, *y)) {
        let c = cover(p);
        area += c;
        sx += c * (f64::from(x) + 0.5);
        sy += c * (f64::from(y) + 0.5);
    }
    let (cx, cy) = (sx / area, sy / area);
    let (mut vxx, mut vyy, mut vxy) = (0.0, 0.0, 0.0);
    for (x, y, p) in img.enumerate_pixels().filter(|(x, y, _)| inside(*x, *y)) {
        let c = cover(p);
        let (dx, dy) = (f64::from(x) + 0.5 - cx, f64::from(y) + 0.5 - cy);
        vxx += c * dx * dx;
        vyy += c * dy * dy;
        vxy += c * dx * dy;
    }
    Blob {
        cx,
        cy,
        vxx: vxx / area,
        vyy: vyy / area,
        vxy: vxy / area,
    }
}
fn near(got: f64, want: f64, tol: f64, what: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{what}: got {got}, want {want} +- {tol}"
    );
}

// ---- the four presets, end to end ---------------------------------------------------------
#[tokio::test]
async fn the_four_presets_are_exact_four_play_gif89a_with_the_table_timing_and_moves() {
    let made = candidates(&presets(&Preset::ALL, 240), png(&bar_source())).await;
    assert_eq!(made.len(), 4, "one candidate per preset, in request order");
    let table = [
        (MotionKind::Bounce, 16usize, 40u32),
        (MotionKind::Wobble, 16, 40),
        (MotionKind::Pulse, 12, 50),
        (MotionKind::Sparkle, 20, 50),
    ];
    for (c, (kind, frames, delay)) in made.iter().zip(table) {
        assert_eq!(c.motion, kind);
        // The bytes themselves.
        let g = walk(c.gif());
        assert_eq!(g.version, b"GIF89a", "{kind:?}");
        assert_eq!((g.width, g.height), (240, 240));
        assert!(g.trailer);
        assert_eq!(g.images, frames, "{kind:?} frame count");
        assert_eq!(
            g.delays_cs,
            vec![(delay / 10) as u16; frames],
            "{kind:?} delays"
        );
        assert_eq!(
            g.disposals,
            vec![2; frames],
            "{kind:?}: each frame is cleared before the next"
        );
        assert_eq!(g.comments + g.plain_text, 0, "no comment or text extension");
        assert_eq!(
            g.apps.len(),
            1,
            "the loop extension is the only application extension"
        );
        assert_eq!(g.apps[0].0, b"NETSCAPE2.0");
        // Loop count 3 after the first pass: four plays in total.
        assert_eq!(
            g.apps[0].1,
            vec![vec![1, 3, 0]],
            "{kind:?} plays 3 + 1 times"
        );
        // Through a decoder.
        let decoded = frames_of(c.gif());
        assert_eq!(decoded.len(), frames);
        assert!(decoded
            .iter()
            .all(|(f, d)| f.dimensions() == (240, 240) && *d == delay));
        // The facts the card and the pin use.
        assert_eq!(
            (c.frames() as usize, c.duration_ms()),
            (frames, frames as u32 * delay)
        );
        assert_eq!(c.bytes(), c.gif().len());
        assert!(c.bytes() <= MIB);
        assert_eq!(c.sha256(), hex::encode(Sha256::digest(c.gif())));
        // D3 renditions: small GIF <=128 and <=256 KiB, static PNG thumb.
        let small = &c.media.small;
        assert_eq!(small.info.mime, "image/gif");
        assert!(small.info.width.max(small.info.height) <= 128 && small.data.len() <= 256 * 1024);
        assert_eq!(small.info.frame_count as usize, frames);
        assert_eq!(c.media.thumb.info.mime, "image/png");
        assert!(c.media.thumb.info.width.max(c.media.thumb.info.height) <= 128);
        assert_eq!(c.media.large.info.mime, "image/gif");
    }

    // ---- positions, measured on the frames a player shows (size 240: 8% = 19.2 px)
    let at = |i: usize, k: usize| blob(&frames_of(made[i].gif())[k].0);
    let rest = at(2, 0); // pulse frame 0 is the identity pose
    near(rest.cx, 120.0, 0.1, "rest x");
    near(rest.cy, 120.0, 0.1, "rest y");
    near(rest.width(), 132.0, 0.5, "bar width");
    near(rest.height(), 20.0, 0.5, "bar height");
    // bounce t=0.5 (frame 8): up by 0.08 * size, nothing else.
    let top = at(0, 8);
    near(top.cy, 120.0 - 0.08 * 240.0, 0.5, "bounce lift");
    near(top.cx, 120.0, 0.2, "bounce x");
    near(top.width(), 132.0, 0.6, "no squash in the air");
    // bounce t=0: squash +6% / -6%, resting on the picture's bottom edge (y = 24 + 192 = 216).
    let floor = at(0, 0);
    near(floor.width(), 132.0 * 1.06, 0.8, "squash width");
    near(floor.height(), 20.0 * 0.94, 0.6, "squash height");
    near(
        floor.cy,
        216.0 - 0.94 * (192.0 - 96.0),
        0.6,
        "squash rests on the bottom edge",
    );
    // wobble t=0.25: +8 degrees about the centre.
    let tilted = at(1, 4);
    near(tilted.degrees(), 8.0, 0.6, "wobble 8 degrees");
    near(at(1, 12).degrees(), -8.0, 0.6, "wobble -8 degrees");
    near(at(1, 0).degrees(), 0.0, 0.2, "wobble rests at t=0");
    near(tilted.cx, 120.0, 0.3, "wobble about the centre");
    near(tilted.cy, 120.0, 0.3, "wobble about the centre");
    // pulse t=0.25 and t=0.75: x1.12, between them back to 1.
    for (k, scale) in [(0, 1.0), (3, 1.12), (6, 1.0), (9, 1.12)] {
        near(at(2, k).width(), 132.0 * scale, 1.0, "pulse width");
    }

    // ---- sparkle: the picture never moves; star k is on exactly in frames 5k..5k+4.
    let sparkle: Vec<RgbaImage> = frames_of(made[3].gif())
        .into_iter()
        .map(|(f, _)| f)
        .collect();
    let corner = |k: usize| -> (u32, u32, u32, u32) {
        let m = 24; // the 10% band of a 240 canvas
        let (x, y) = [(0, 0), (240 - m, 0), (240 - m, 240 - m), (0, 240 - m)][k];
        (x, y, x + m, y + m)
    };
    let differing = |a: &RgbaImage, b: &RgbaImage| -> Vec<(u32, u32)> {
        a.enumerate_pixels()
            .filter(|(x, y, p)| *p != b.get_pixel(*x, *y))
            .map(|(x, y, _)| (x, y))
            .collect()
    };
    for i in 0..20 {
        let (k, base_k) = (i / 5, 0);
        let diff = differing(&sparkle[i], &sparkle[0]);
        if k == base_k {
            assert!(
                diff.is_empty(),
                "frames 0..4 are the same picture and the same star: {i}"
            );
            continue;
        }
        assert!(!diff.is_empty(), "frame {i} lights star {k}");
        let (c0, ck) = (corner(base_k), corner(k));
        for (x, y) in diff {
            let within = |c: (u32, u32, u32, u32)| x >= c.0 && x < c.2 && y >= c.1 && y < c.3;
            assert!(
                within(c0) || within(ck),
                "frame {i}: pixel {x},{y} changed outside the two stars"
            );
        }
    }
    for k in 0..4 {
        for i in 5 * k..5 * k + 5 {
            assert!(
                differing(&sparkle[i], &sparkle[5 * k]).is_empty(),
                "frame {i} is in star {k}'s run"
            );
        }
        // The star itself is visible on the margin colour inside its own corner.
        let c = corner(k);
        let lit = (c.0..c.2)
            .flat_map(|x| (c.1..c.3).map(move |y| (x, y)))
            .filter(|(x, y)| sparkle[5 * k].get_pixel(*x, *y).0[..3] != BG)
            .count();
        assert!(lit > 30, "star {k} shows: {lit} px");
    }
    // The red bar is where it was in every frame.
    for f in &sparkle {
        near(blob(f).cy, 120.0, 0.1, "sparkle keeps the picture still");
    }
}

// ---- sprite ---------------------------------------------------------------------------------
#[tokio::test]
async fn a_sprite_sheet_is_cut_on_the_fixed_grid_and_played_in_sequence_order() {
    let cell = [[220, 40, 40], [40, 200, 60], [50, 60, 220], [230, 200, 30]];
    let pink = [255, 0, 255];
    // (frames, sheet w x h, cell w x h, sequence). The leftover pink strip must stay a minority
    // of the sheet's outer ring, or the margin colour would turn pink: so one case leaves a
    // column over and another a row.
    for (frames, sheet, cell_wh, sequence) in [
        (2u32, (41u32, 30u32), (20u32, 30u32), vec![1u32, 0, 0, 1]),
        (3, (62, 20), (20, 20), vec![2, 0, 1, 1, 2]),
        (4, (41, 30), (20, 15), vec![3, 2, 1, 0, 0, 3]),
        (4, (40, 31), (20, 15), vec![0, 1, 2, 3]),
    ] {
        let (cols, rows) = if frames == 4 { (2, 2) } else { (frames, 1) };
        let mut img = solid(sheet.0, sheet.1, pink); // whatever is left over is pink
        for index in 0..frames {
            // A one-pixel rim in the margin colour keeps the margin (the median of the sheet's
            // outer ring) apart from every cell colour.
            let (x, y) = ((index % cols) * cell_wh.0, (index / cols) * cell_wh.1);
            fill_rect(&mut img, (x, y, cell_wh.0, cell_wh.1), BG);
            fill_rect(
                &mut img,
                (x + 1, y + 1, cell_wh.0 - 2, cell_wh.1 - 2),
                cell[index as usize],
            );
        }
        assert_eq!(
            (cols * cell_wh.0 <= sheet.0, rows * cell_wh.1 <= sheet.1),
            (true, true)
        );
        let made = candidates(&sprite(frames, &sequence, 120, 240), png(&img)).await;
        assert_eq!(made.len(), 1, "a sprite is one candidate");
        let c = &made[0];
        assert_eq!(c.motion, MotionKind::Sprite);
        let decoded = frames_of(c.gif());
        assert_eq!(decoded.len(), sequence.len(), "{frames}-cell sheet");
        assert_eq!(
            (c.frames() as usize, c.duration_ms()),
            (sequence.len(), sequence.len() as u32 * 120)
        );
        let g = walk(c.gif());
        assert_eq!(g.delays_cs, vec![12; sequence.len()]);
        assert_eq!(g.apps[0].1, vec![vec![1, 3, 0]]);
        for ((frame, delay), index) in decoded.iter().zip(&sequence) {
            assert_eq!(*delay, 120);
            let want = cell[*index as usize];
            assert_eq!(
                frame.get_pixel(120, 120).0[..3],
                want,
                "cell {index} of the {frames}-cell sheet"
            );
            // The cell is placed unscaled and whole: its colour covers exactly the cell's inside.
            let count = frame.pixels().filter(|p| p.0[..3] == want).count() as u32;
            assert_eq!(
                count,
                (cell_wh.0 - 2) * (cell_wh.1 - 2),
                "cell {index} is cut whole"
            );
            assert!(
                frame.pixels().all(|p| p.0[..3] != pink),
                "the remainder pixels are dropped, not shown"
            );
        }
    }
}

// ---- fitting, margin, transparency ------------------------------------------------------------
/// A picture whose one-pixel rim is the margin colour and whose inside is red: the red box is
/// the picture minus its rim.
fn framed(w: u32, h: u32) -> RgbaImage {
    let mut img = solid(w, h, BG);
    fill_rect(&mut img, (1, 1, w - 2, h - 2), FG);
    img
}
fn red_box(img: &RgbaImage) -> (u32, u32, u32, u32) {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p.0[1] < 135 {
            (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
        }
    }
    (x0, y0, x1, y1)
}
#[tokio::test]
async fn the_picture_fits_eighty_percent_square_centred_and_is_never_enlarged() {
    // Pulse frame 0 is the identity pose: the picture as placed. Canvas 360 -> box 288.
    let small = candidates(&presets(&[Preset::Pulse], 360), png(&framed(100, 50))).await;
    let placed = red_box(&frames_of(small[0].gif())[0].0);
    assert_eq!(
        placed,
        (131, 156, 228, 203),
        "100x50 stays 100x50, centred at (180,180)"
    );
    let big = candidates(&presets(&[Preset::Pulse], 360), png(&framed(1000, 500))).await;
    let placed = red_box(&frames_of(big[0].gif())[0].0);
    // 288 x 144 centred: x 36..323, y 108..251, give or take the soft rim of the downscale.
    for (got, want) in [
        (placed.0, 36),
        (placed.1, 108),
        (placed.2, 323),
        (placed.3, 251),
    ] {
        assert!(got.abs_diff(want) <= 2, "{placed:?}");
    }
    let tall = candidates(&presets(&[Preset::Pulse], 240), png(&framed(300, 900))).await;
    let placed = red_box(&frames_of(tall[0].gif())[0].0);
    // 192 box: 64 x 192, centred in 240 -> x 88..151, y 24..215.
    for (got, want) in [
        (placed.0, 88),
        (placed.1, 24),
        (placed.2, 151),
        (placed.3, 215),
    ] {
        assert!(got.abs_diff(want) <= 2, "{placed:?}");
    }
}

#[tokio::test]
async fn a_transparent_picture_stays_transparent_and_leaves_no_ghosts() {
    // A soft-edged green disk on transparent WHITE: the see-through pixels carry a colour that must
    // never bleed into the rim, and the rim has every alpha between 0 and 255.
    let mut img = RgbaImage::from_pixel(120, 120, Rgba([255, 255, 255, 0]));
    for y in 0..120 {
        for x in 0..120 {
            let (dx, dy) = (f64::from(x) - 59.5, f64::from(y) - 59.5);
            let alpha = ((40.0 - (dx * dx + dy * dy).sqrt()) / 3.0 + 0.5).clamp(0.0, 1.0);
            if alpha > 0.0 {
                img.put_pixel(x, y, Rgba([20, 160, 40, (alpha * 255.0).round() as u8]));
            }
        }
    }
    let made = candidates(&presets(&[Preset::Pulse, Preset::Bounce], 240), png(&img)).await;
    let mut per_frame = Vec::new();
    for c in &made {
        for (frame, _) in frames_of(c.gif()) {
            let opaque: Vec<_> = frame
                .enumerate_pixels()
                .filter(|(_, _, p)| p.0[3] != 0)
                .collect();
            assert!(
                frame.pixels().all(|p| p.0[3] == 0 || p.0[3] == 255),
                "a GIF mask is one bit"
            );
            // Every visible pixel is the picture's own green, edges of a resampled frame included:
            // resampling a transparent picture without premultiplying would darken the rim.
            assert!(
                opaque.iter().all(|(_, _, p)| p.0[..3]
                    .iter()
                    .zip([20u8, 160, 40])
                    .all(|(g, w)| g.abs_diff(w) <= 2)),
                "no dark fringe"
            );
            assert_eq!(frame.get_pixel(0, 0).0[3], 0, "the margin is transparent");
            assert_eq!(frame.get_pixel(239, 239).0[3], 0);
            per_frame.push(opaque.len() as f64);
        }
    }
    let disk = std::f64::consts::PI * 40.0 * 40.0;
    // No frame has more picture than the largest pose (x1.12, bounce squash): a ghost of an
    // earlier frame left behind by a wrong disposal would pile up.
    for n in per_frame {
        assert!(
            n > 0.85 * disk && n < 1.12 * 1.12 * disk * 1.02,
            "opaque pixels: {n}"
        );
    }
    // The picture itself keeps its colour.
    assert_eq!(
        frames_of(made[0].gif())[0].0.get_pixel(120, 120).0,
        [20, 160, 40, 255]
    );
}

#[tokio::test]
async fn every_still_format_of_d3_is_accepted() {
    let img = bar_source();
    let single_gif = {
        let mut out = Vec::new();
        {
            let mut e = GifEncoder::new(&mut out);
            e.set_repeat(Repeat::Infinite).unwrap();
            e.encode_frame(Frame::from_parts(
                img.clone(),
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            ))
            .unwrap();
        }
        out
    };
    for (name, bytes) in [
        ("png", png(&img)),
        ("jpeg", encode(&img, ImageFormat::Jpeg)),
        ("webp", encode(&img, ImageFormat::WebP)),
        ("single-frame gif", single_gif),
    ] {
        let made = candidates(&presets(&[Preset::Pulse], 240), bytes).await;
        assert_eq!(made[0].frames(), 12, "{name}");
        near(
            blob(&frames_of(made[0].gif())[0].0).width(),
            132.0,
            1.5,
            name,
        );
    }
}

// ---- EXIF orientation (#4820 C1b, planner decision 5) --------------------------------------
/// `jpeg` with an EXIF APP1 segment that says `orientation` (tag 0x0112), right after SOI. A real
/// camera segment is bigger, but this is the whole of what an orientation reader needs: the
/// `Exif\0\0` marker, a TIFF header in either byte order, and one IFD0 entry.
fn with_exif_orientation(jpeg: &[u8], orientation: u16, little_endian: bool) -> Vec<u8> {
    let mut tiff = Vec::new();
    let put16 = |tiff: &mut Vec<u8>, value: u16| {
        tiff.extend_from_slice(&if little_endian {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        })
    };
    let put32 = |tiff: &mut Vec<u8>, value: u32| {
        tiff.extend_from_slice(&if little_endian {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        })
    };
    tiff.extend_from_slice(if little_endian { b"II*\0" } else { b"MM\0*" });
    put32(&mut tiff, 8); // IFD0 follows the 8-byte header
    put16(&mut tiff, 1); // one entry
    put16(&mut tiff, 0x0112); // Orientation
    put16(&mut tiff, 3); // SHORT
    put32(&mut tiff, 1); // one value
    put16(&mut tiff, orientation);
    tiff.extend_from_slice(&[0, 0]); // the value field is 4 bytes wide
    put32(&mut tiff, 0); // no next IFD
    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn colour_of(p: &Rgba<u8>) -> &'static str {
    if p[0] > 170 && p[2] < 100 {
        "red"
    } else if p[2] > 170 && p[0] < 100 {
        "blue"
    } else {
        "margin"
    }
}

/// How far the picture reaches (red or blue, not margin) along the middle column and the middle row
/// of the canvas: `(height, width)` of the picture as it was laid down.
fn reach(frame: &RgbaImage) -> (u32, u32) {
    let (w, h) = frame.dimensions();
    let column = (0..h)
        .filter(|y| colour_of(frame.get_pixel(w / 2, *y)) != "margin")
        .count() as u32;
    let row = (0..w)
        .filter(|x| colour_of(frame.get_pixel(*x, h / 2)) != "margin")
        .count() as u32;
    (column, row)
}

#[tokio::test]
async fn a_phone_photos_exif_orientation_is_applied_so_it_does_not_lie_down() {
    // 240 x 120 (bigger than the 192 fit box, so it is scaled down to 192 x 96 and never
    // enlarged): the left half red, the right half blue.
    let mut wide = solid(240, 120, [30, 30, 220]);
    fill_rect(&mut wide, (0, 0, 120, 120), [220, 30, 30]);
    let jpeg = encode(&wide, ImageFormat::Jpeg);
    // `sparkle` keeps the picture still, so frame 0 is how it was laid on the canvas (240: the
    // fit box is 192).
    let frame_zero = |made: &[Candidate]| frames_of(made[0].gif())[0].0.clone();
    let (centre, quarter) = (120u32, 60u32);

    // No orientation segment: lying as stored: wide, red to the left, blue to the right.
    let made = candidates(&presets(&[Preset::Sparkle], 240), jpeg.clone()).await;
    let frame = frame_zero(&made);
    let (height, width) = reach(&frame);
    assert!(
        (186..=194).contains(&width) && (90..=100).contains(&height),
        "{width}x{height}"
    );
    assert_eq!(colour_of(frame.get_pixel(centre - quarter, centre)), "red");
    assert_eq!(colour_of(frame.get_pixel(centre + quarter, centre)), "blue");
    // An explicit "normal" is the same picture.
    let made = candidates(
        &presets(&[Preset::Sparkle], 240),
        with_exif_orientation(&jpeg, 1, false),
    )
    .await;
    assert_eq!(
        frame_zero(&made).as_raw(),
        frame.as_raw(),
        "orientation 1 changes nothing"
    );

    // Orientation 6: turn 90 degrees clockwise to display. The left half (red) goes to the top
    // and the picture stands: 96 wide, 192 tall. Orientation 8 (little-endian segment): the other
    // way, red at the bottom.
    for (orientation, little_endian, upper, lower) in
        [(6u16, false, "red", "blue"), (8, true, "blue", "red")]
    {
        let bytes = with_exif_orientation(&jpeg, orientation, little_endian);
        let made = candidates(&presets(&[Preset::Sparkle], 240), bytes).await;
        let frame = frame_zero(&made);
        let (height, width) = reach(&frame);
        assert!(
            (186..=194).contains(&height) && (90..=100).contains(&width),
            "orientation {orientation}: the picture must stand up, got {width}x{height}"
        );
        assert_eq!(
            colour_of(frame.get_pixel(centre, centre - quarter)),
            upper,
            "orientation {orientation}: top"
        );
        assert_eq!(
            colour_of(frame.get_pixel(centre, centre + quarter)),
            lower,
            "orientation {orientation}: bottom"
        );
        // Every frame of the animation is of the turned picture, and the result is still the
        // ADR table's `sparkle`.
        assert_eq!(made[0].frames(), 20);
    }
}

#[tokio::test]
async fn an_unreadable_orientation_is_an_upright_picture_not_a_refusal() {
    let mut wide = solid(240, 120, [30, 30, 220]);
    fill_rect(&mut wide, (0, 0, 120, 120), [220, 30, 30]);
    let jpeg = encode(&wide, ImageFormat::Jpeg);
    // Orientation 9 does not exist; a segment that stops short is not a segment at all.
    let broken = [with_exif_orientation(&jpeg, 9, false), {
        let mut cut = with_exif_orientation(&jpeg, 6, false);
        // Keep the segment's length field but lose its tail: the reader gets half a TIFF.
        let app1_end = 4 + 2 + 6 + 12;
        cut.splice(app1_end..app1_end + 14, std::iter::empty());
        cut
    }];
    for bytes in broken {
        let result = run(&presets(&[Preset::Sparkle], 240), bytes).await;
        // Either the picture is taken as stored or it is `assembly_source_invalid`: what it must
        // never be is a turned guess.
        match result {
            Ok(outcomes) => {
                let made = outcomes.into_iter().next().unwrap().unwrap();
                let (height, width) = reach(&frames_of(made.gif())[0].0);
                assert!(
                    width > height,
                    "an unreadable orientation lays the picture as stored"
                );
            }
            Err(error) => assert_eq!(error, AssembleError::SourceInvalid),
        }
    }
}

// ---- determinism ------------------------------------------------------------------------------
#[tokio::test]
async fn the_same_input_is_the_same_bytes_and_one_changed_bit_is_not() {
    let request = presets(&[Preset::Pulse, Preset::Sparkle], 240);
    let source = bar_source();
    let (a, b) = (
        candidates(&request, png(&source)).await,
        candidates(&request, png(&source)).await,
    );
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(x.sha256(), y.sha256());
        assert_eq!(x.media.large.data, y.media.large.data);
        assert_eq!(x.media.small.data, y.media.small.data);
        assert_eq!(x.media.thumb.data, y.media.thumb.data);
    }
    // One bit of one channel of one pixel inside the red bar.
    let mut flipped = source.clone();
    flipped.get_pixel_mut(96, 96).0[2] ^= 1;
    assert_ne!(flipped, source);
    let c = candidates(&request, png(&flipped)).await;
    for (x, y) in a.iter().zip(&c) {
        assert_ne!(x.sha256(), y.sha256(), "{:?}", x.motion);
    }
    // A different size or preset order is a different, but equally stable, result.
    let d = candidates(
        &presets(&[Preset::Sparkle, Preset::Pulse], 240),
        png(&source),
    )
    .await;
    assert_eq!(d[0].sha256(), a[1].sha256());
    assert_eq!(d[1].sha256(), a[0].sha256());
}

// ---- failure codes from real inputs --------------------------------------------------------------
#[tokio::test]
async fn bad_parameters_are_refused_by_name_before_any_child_starts() {
    let nowhere = Path::new("/nonexistent/assembler");
    let r = try_assemble_with_program(
        nowhere,
        PATIENT,
        &sprite(5, &[0, 9], 10, 100),
        png(&bar_source()),
        SourceFrom::Request,
        &slots(),
    )
    .await;
    match r {
        Err(AssembleError::ParamsInvalid { params }) => {
            let names: Vec<_> = params.iter().map(|p| p.name()).collect();
            assert_eq!(names, ["frames", "sequence", "frameMs", "size"]);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_strict_entry_also_checks_parameters_and_bytes_before_it_starts_a_child() {
    // `assemble` is the entry that is handed a slot: it must not rely on its callers' checks.
    let nowhere = Path::new("/nonexistent/assembler");
    let slot = || async { slots().acquire_owned().await.unwrap() };
    let r = assemble_with_program(
        nowhere,
        PATIENT,
        &sprite(5, &[0, 9], 10, 100),
        png(&bar_source()),
        SourceFrom::Request,
        slot().await,
    )
    .await;
    assert!(
        matches!(r, Err(AssembleError::ParamsInvalid { .. })),
        "{r:?}"
    );
    let r = assemble_with_program(
        nowhere,
        PATIENT,
        &presets(&[Preset::Pulse], 240),
        vec![0; 4 * MIB + 1],
        SourceFrom::Request,
        slot().await,
    )
    .await;
    assert_eq!(r.unwrap_err(), AssembleError::SourceTooLarge);
    // Both are answered without a child: with a program that cannot start, this one fails to start.
    let r = assemble_with_program(
        nowhere,
        PATIENT,
        &presets(&[Preset::Pulse], 240),
        png(&bar_source()),
        SourceFrom::Request,
        slot().await,
    )
    .await;
    assert_eq!(r.unwrap_err(), AssembleError::Unavailable);
}

#[tokio::test]
async fn pictures_that_cannot_be_animated_are_source_invalid() {
    use base64::Engine;
    let apng = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAABAAAAALQt6aAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYII=").unwrap();
    let animated_gif = {
        let mut out = Vec::new();
        {
            let mut e = GifEncoder::new(&mut out);
            for _ in 0..2 {
                e.encode_frame(Frame::from_parts(
                    solid(8, 8, FG),
                    0,
                    0,
                    Delay::from_numer_denom_ms(100, 1),
                ))
                .unwrap();
            }
        }
        out
    };
    let good = png(&bar_source());
    let wide = png(&solid(4097, 1, BG)); // one side over 4096
    let tall = png(&solid(1, 4097, BG));
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("text", b"not an image".to_vec()),
        ("svg", b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec()),
        ("apng", apng),
        ("animated gif", animated_gif),
        ("animated webp", b"RIFF0000WEBPANIM".to_vec()),
        (
            "mp4",
            vec![0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
        ),
        ("truncated png", good[..good.len() / 2].to_vec()),
        // (a JPEG cut off after its header is decoded by the codec, with the rest grey: that is
        // the codec's leniency and the same as for every other still of D3.)
        ("4097 wide", wide),
        ("4097 tall", tall),
    ];
    for (name, bytes) in cases {
        let r = run(&presets(&[Preset::Pulse], 240), bytes).await;
        assert_eq!(failure(r, name), AssembleError::SourceInvalid, "{name}");
    }
    // A sheet too small for its grid has no cells to show.
    let r = run(&sprite(4, &[0, 3], 100, 240), png(&solid(1, 1, BG))).await;
    assert_eq!(r.unwrap_err(), AssembleError::SourceInvalid);
}

#[tokio::test]
async fn the_byte_limit_is_4_mib_in_a_request_and_5_mib_inside_the_server() {
    let mut padded = png(&bar_source());
    let pad = |bytes: &mut Vec<u8>, to: usize| bytes.resize(to, 0);
    let nowhere = Path::new("/nonexistent/assembler");
    let go = |from, bytes: Vec<u8>, program: &'static Path| async move {
        try_assemble_with_program(
            program,
            PATIENT,
            &presets(&[Preset::Pulse], 240),
            bytes,
            from,
            &slots(),
        )
        .await
    };
    // Over the limit: refused before a child is started (the program does not even exist).
    pad(&mut padded, 4 * MIB + 1);
    assert_eq!(
        go(SourceFrom::Request, padded.clone(), nowhere)
            .await
            .unwrap_err(),
        AssembleError::SourceTooLarge
    );
    pad(&mut padded, 5 * MIB + 1);
    assert_eq!(
        go(SourceFrom::Server, padded.clone(), nowhere)
            .await
            .unwrap_err(),
        AssembleError::SourceTooLarge
    );
    // At the limit: assembled. 4 MiB + 1 is fine when it was moved inside the server.
    pad(&mut padded, 4 * MIB);
    assert!(
        go(SourceFrom::Request, padded.clone(), program())
            .await
            .is_ok(),
        "exactly 4 MiB"
    );
    pad(&mut padded, 4 * MIB + 1);
    assert!(
        go(SourceFrom::Server, padded.clone(), program())
            .await
            .is_ok(),
        "4 MiB + 1 inside"
    );
    pad(&mut padded, 5 * MIB);
    assert!(
        go(SourceFrom::Server, padded, program()).await.is_ok(),
        "exactly 5 MiB"
    );
}

#[tokio::test]
async fn a_result_over_1_mib_is_reported_with_its_measured_size_never_shrunk() {
    // Two noisy cells of 384 px at size 480: identical frames of ~200 KB each. The picture is the
    // same on every frame, so the GIF grows by exactly one frame's bytes per step: the reported
    // number is a measurement, not a constant.
    let sheet = noise(768, 384, 200);
    let bytes_for = |n: usize| {
        let sheet = sheet.clone();
        async move {
            let r = run(&sprite(2, &vec![0; n], 40, 480), png(&sheet))
                .await
                .unwrap();
            assert_eq!(r.len(), 1);
            match r.into_iter().next().unwrap() {
                Err(AssembleError::OutputTooLarge { bytes }) => bytes,
                other => panic!("{n} frames: {other:?}"),
            }
        }
    };
    let (b8, b12, b16) = (bytes_for(8).await, bytes_for(12).await, bytes_for(16).await);
    assert!(b8 > MIB as u64, "{b8}");
    assert_eq!(
        b12 - b8,
        b16 - b12,
        "bytes grow by whole frames: {b8} {b12} {b16}"
    );
    assert!(
        b16 < 16 * MIB as u64,
        "a measurement below the sink ceiling"
    );
}

#[tokio::test]
async fn a_noisy_picture_is_a_valid_source_even_when_its_own_png_rendition_would_not_fit() {
    // 512 x 512 RGBA noise is over 1 MiB as a PNG: the static rendition path of D3 refuses it,
    // but animating it is a different question and a source follows only the input rules.
    let mut seed = 0x719d_2901u32;
    let sheet = RgbaImage::from_fn(512, 512, |_, _| {
        let mut px = [0u8; 4];
        for c in &mut px {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *c = seed as u8;
        }
        Rgba(px)
    });
    let bytes = png(&sheet);
    assert!(
        bytes.len() > MIB && bytes.len() < 4 * MIB,
        "{}",
        bytes.len()
    );
    assert!(
        momo_expressions::media::decode(&bytes, Instant::now() + PATIENT).is_err(),
        "the premise: the still renditions of this picture do not fit"
    );
    let r = run(&presets(&[Preset::Pulse], 240), bytes).await;
    // Whatever becomes of the frames, the picture itself was accepted.
    assert!(r.is_ok(), "{r:?}");
}

#[tokio::test]
async fn a_gif_under_1_mib_that_breaks_the_small_rendition_cap_is_too_large_with_its_own_size() {
    // 192 px of per-pixel noise (64 colours) on a 240 canvas: each frame of the assembled GIF is
    // about 40 KB and each frame of its 128 px GIF about 14.5 KB. 22 frames are about 875 KB, under
    // 1 MiB, yet about 320 KB as the small GIF, over the 256 KiB the D3 path allows it, and that is
    // what fails. The code is the same and `bytes` is the assembled size, below the limit it names.
    let sheet = png(&noise(384, 192, 64));
    let over = run(&sprite(2, &[0; 22], 40, 240), sheet.clone())
        .await
        .unwrap();
    match &over[0] {
        Err(AssembleError::OutputTooLarge { bytes }) => {
            assert!(*bytes < MIB as u64 && *bytes > 600_000, "{bytes}");
        }
        other => panic!("{other:?}"),
    }
    // The same sheet with fewer frames is fine: the cap on the small GIF, not the picture, said no.
    let fits = candidates(&sprite(2, &[0; 12], 40, 240), sheet).await;
    assert!(fits[0].media.small.data.len() <= 256 * 1024 && fits[0].bytes() <= MIB);
}

#[tokio::test]
async fn the_largest_flat_result_still_fits_and_stays_within_1_mib() {
    // 20 frames x 500 ms is the longest allowed play (10,000 ms) and must pass D3 untouched.
    let made = candidates(
        &sprite(
            2,
            &[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
            500,
            240,
        ),
        {
            let mut sheet = solid(40, 20, FG);
            fill_rect(&mut sheet, (20, 0, 20, 20), [20, 160, 40]);
            png(&sheet)
        },
    )
    .await;
    assert_eq!((made[0].frames(), made[0].duration_ms()), (20, 10_000));
    // frameMs is stored in GIF's 10 ms units: 45 plays as 40.
    let made = candidates(&sprite(2, &[0, 1, 0], 45, 240), png(&solid(40, 20, FG))).await;
    assert_eq!(made[0].duration_ms(), 120);
    assert_eq!(walk(made[0].gif()).delays_cs, [4, 4, 4]);
}

// ---- isolation, slots and limits (fixture scripts stand in for the child) ----------------------------
#[cfg(unix)]
mod supervised {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        dir: PathBuf,
        program: PathBuf,
    }
    impl Fixture {
        fn new(script: &str) -> Fixture {
            let dir = std::env::temp_dir().join(format!("oort-assemble-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let program = dir.join("assembler");
            let script = script.replace("DIR", &dir.display().to_string());
            std::fs::write(&program, script).unwrap();
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
            Fixture { dir, program }
        }
        fn pids(&self) -> Vec<String> {
            std::fs::read_dir(&self.dir)
                .unwrap()
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    name.strip_prefix("pid-").map(str::to_owned)
                })
                .collect()
        }
        fn alive(pid: &str) -> bool {
            std::process::Command::new("/bin/kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for entry in std::fs::read_dir(&self.dir).unwrap().filter_map(Result::ok) {
                let _ = std::fs::remove_file(entry.path());
            }
            let _ = std::fs::remove_dir(&self.dir);
        }
    }
    const SLEEPER: &str = "#!/bin/sh\necho $$ > 'DIR'/pid-$$\nexec /bin/sleep 30\n";
    fn req() -> AssembleRequest {
        presets(&[Preset::Pulse], 240)
    }
    fn tiny() -> Vec<u8> {
        png(&solid(8, 8, FG))
    }
    async fn with(
        fixture: &Fixture,
        deadline: Duration,
        slots: &Arc<Semaphore>,
    ) -> Result<Vec<Outcome>, AssembleError> {
        try_assemble_with_program(
            &fixture.program,
            deadline,
            &req(),
            tiny(),
            SourceFrom::Request,
            slots,
        )
        .await
    }

    #[tokio::test]
    async fn without_a_free_slot_nothing_starts_and_nothing_queues() {
        let fixture = Fixture::new(SLEEPER);
        let sem = slots();
        let held = sem.clone().acquire_many_owned(2).await.unwrap();
        for _ in 0..6 {
            let r = tokio::time::timeout(Duration::from_millis(500), with(&fixture, PATIENT, &sem))
                .await;
            assert_eq!(
                r.expect("answered at once, not queued").unwrap_err(),
                AssembleError::Busy
            );
        }
        assert!(
            fixture.pids().is_empty(),
            "no child was started for a refused call"
        );
        assert_eq!(sem.available_permits(), 0, "the refused calls took no slot");
        // One slot back: now the call does try to start (this program is not the sleeper).
        drop(held);
        let r = try_assemble_with_program(
            Path::new("/nonexistent/assembler"),
            PATIENT,
            &req(),
            tiny(),
            SourceFrom::Request,
            &sem,
        )
        .await;
        assert_eq!(
            r.unwrap_err(),
            AssembleError::Unavailable,
            "a free slot is all it needs to start"
        );
        assert_eq!(sem.available_permits(), 2, "and the slot is returned");
    }

    #[tokio::test]
    async fn a_cancelled_call_keeps_its_slot_until_the_child_is_killed_and_reaped() {
        let fixture = Fixture::new(SLEEPER);
        let sem = slots();
        let mut jobs = Vec::new();
        for _ in 0..2 {
            let (program, sem) = (fixture.program.clone(), sem.clone());
            jobs.push(tokio::spawn(async move {
                let permit = sem.acquire_owned().await.unwrap();
                assemble_with_program(
                    &program,
                    Duration::from_secs(3),
                    &req(),
                    tiny(),
                    SourceFrom::Request,
                    permit,
                )
                .await
            }));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while fixture.pids().len() != 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("both children started");
        assert_eq!(sem.available_permits(), 0);
        for job in jobs {
            job.abort();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), sem.clone().acquire_owned())
                .await
                .is_err(),
            "abandoning the call does not free the slot while the child lives"
        );
        let both = tokio::time::timeout(Duration::from_secs(10), sem.clone().acquire_many_owned(2))
            .await
            .expect("the slots come back when the deadline kills the children")
            .unwrap();
        for pid in fixture.pids() {
            assert!(
                !Fixture::alive(&pid),
                "slot released before the child {pid} was reaped"
            );
        }
        drop(both);
    }

    #[tokio::test]
    async fn a_child_past_the_deadline_is_killed_and_the_call_ends_in_assembly_timeout() {
        let fixture = Fixture::new(SLEEPER);
        let sem = slots();
        let started = Instant::now();
        // Long enough for a shell to start even when the other tests keep every core busy.
        let r = with(&fixture, Duration::from_secs(2), &sem).await;
        assert_eq!(r.unwrap_err(), AssembleError::Timeout);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it does not hang for the child's 30 s"
        );
        assert_eq!(fixture.pids().len(), 1);
        for pid in fixture.pids() {
            assert!(!Fixture::alive(&pid), "the child {pid} was killed");
        }
        assert_eq!(
            sem.available_permits(),
            2,
            "the slot is back once the child is reaped"
        );
    }

    #[tokio::test]
    async fn a_child_that_dies_is_told_apart_by_why() {
        let sem = slots();
        let run_script = |script: &'static str| {
            let sem = sem.clone();
            async move {
                let fixture = Fixture::new(script);
                with(&fixture, PATIENT, &sem).await
            }
        };
        // Killed by a signal: the CPU limit or the allocation limit at work.
        assert_eq!(
            run_script("#!/bin/sh\nkill -9 $$\n").await.unwrap_err(),
            AssembleError::Timeout
        );
        // A plain failure, an empty answer, garbage and a wrong shape are the assembler's fault.
        for script in [
            "#!/bin/sh\nexit 3\n",
            "#!/bin/sh\nexit 0\n",
            "#!/bin/sh\necho not json\n",
            "#!/bin/sh\necho '{\"Ok\":[{\"Err\":{\"code\":\"generation_failed\"}}]}'\n",
        ] {
            assert_eq!(
                run_script(script).await.unwrap_err(),
                AssembleError::Unavailable,
                "{script}"
            );
        }
        // A missing program too.
        let r = try_assemble_with_program(
            Path::new("/nonexistent/assembler"),
            PATIENT,
            &req(),
            tiny(),
            SourceFrom::Request,
            &sem,
        )
        .await;
        assert_eq!(r.unwrap_err(), AssembleError::Unavailable);
        assert_eq!(sem.available_permits(), 2);
    }

    #[tokio::test]
    async fn the_child_gets_an_empty_environment_and_a_closed_stdin_after_its_input() {
        // Anything of ours in the environment (a token, a database URL) must not reach it.
        std::env::set_var("OORT_TEST_SECRET_FOR_CHILD", "leak");
        let fixture = Fixture::new(
            "#!/bin/sh\n/usr/bin/env > 'DIR'/env.txt\n/bin/cat > 'DIR'/stdin.bin\nexit 3\n",
        );
        let _ = with(&fixture, PATIENT, &slots()).await;
        std::env::remove_var("OORT_TEST_SECRET_FOR_CHILD");
        let env = std::fs::read_to_string(fixture.dir.join("env.txt")).unwrap();
        assert!(
            !env.contains("OORT_TEST_SECRET_FOR_CHILD") && !env.contains("HOME="),
            "{env}"
        );
        // The framed input arrived whole and then ended (cat returned), so the child can read it all.
        let stdin = std::fs::read(fixture.dir.join("stdin.bin")).unwrap();
        let header_len = u32::from_be_bytes([stdin[0], stdin[1], stdin[2], stdin[3]]) as usize;
        let header: serde_json::Value = serde_json::from_slice(&stdin[4..4 + header_len]).unwrap();
        assert_eq!(header["from"], "request");
        assert_eq!(header["request"]["size"], 240);
        assert_eq!(
            &stdin[4 + header_len..],
            tiny().as_slice(),
            "the picture follows the header untouched"
        );
    }

    #[tokio::test]
    async fn the_childs_answer_is_bounded_and_never_read_without_limit() {
        let fixture = Fixture::new("#!/bin/sh\nexec /usr/bin/head -c 16777217 /dev/zero\n");
        let r = with(&fixture, PATIENT, &slots()).await;
        assert_eq!(r.unwrap_err(), AssembleError::Unavailable);
        // A child that never stops talking is cut off at the bound, long before its deadline.
        let endless = Fixture::new("#!/bin/sh\nexec /usr/bin/yes\n");
        let started = Instant::now();
        let sem = slots();
        let r = with(&endless, Duration::from_secs(3), &sem).await;
        assert_eq!(
            r.unwrap_err(),
            AssembleError::Unavailable,
            "cut off at the bound, not by the deadline"
        );
        assert!(
            started.elapsed() < Duration::from_millis(2500),
            "stopped at the bound, long before the deadline"
        );
        assert_eq!(sem.available_permits(), 2);
        // A relayed answer is read whole: a child's real result round-trips through the pipe.
        let answer = Fixture::new("#!/bin/sh\ncat > /dev/null\nprintf '{\"Ok\":[{\"Err\":{\"code\":\"assembly_output_too_large\",\"bytes\":1234567}}]}'\n");
        let r = with(&answer, PATIENT, &slots()).await.unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(
            r[0].as_ref().unwrap_err(),
            &AssembleError::OutputTooLarge { bytes: 1_234_567 }
        );
    }

    #[tokio::test]
    async fn the_real_child_stops_at_its_own_deadline_with_a_clean_timeout() {
        // 300 ms budget: the child's cooperative deadline (90%) or the parent's kill ends it.
        let sheet = png(&noise(768, 384, 200));
        let started = Instant::now();
        let r = try_assemble_with_program(
            program(),
            Duration::from_millis(300),
            &sprite(2, &[0; 24], 40, 480),
            sheet,
            SourceFrom::Request,
            &slots(),
        )
        .await;
        assert_eq!(r.unwrap_err(), AssembleError::Timeout);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}

// ---- the child, spoken to directly ------------------------------------------------------------------
/// Run the real child with `input` on stdin; its exit status and the JSON it answered.
fn child(input: Vec<u8>) -> (std::process::ExitStatus, serde_json::Value) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut process = Command::new(program())
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = process.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = process.wait_with_output().unwrap();
    writer.join().unwrap();
    let answer = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::Value::Null);
    (out.status, answer)
}
fn frame(header: &[u8], source: &[u8]) -> Vec<u8> {
    let mut input = (header.len() as u32).to_be_bytes().to_vec();
    input.extend_from_slice(header);
    input.extend_from_slice(source);
    input
}
fn job(request: &str, from: &str, budget_ms: u64) -> Vec<u8> {
    format!(r#"{{"request":{request},"from":"{from}","budgetMs":{budget_ms}}}"#).into_bytes()
}
const PULSE_240: &str = r#"{"motion":{"kind":"preset","presets":["pulse"]},"size":240}"#;

#[test]
fn the_child_trusts_nothing_it_is_sent_and_always_answers_in_json() {
    let good = png(&bar_source());
    let unavailable = serde_json::json!({"Err": {"code": "assembly_unavailable"}});
    for (name, input) in [
        ("empty stdin", vec![]),
        ("three bytes", vec![0, 0, 0]),
        (
            "header longer than the input",
            frame(b"x", b"")[..4].to_vec(),
        ),
        (
            "absurd header length",
            [&u32::MAX.to_be_bytes()[..], b"{}"].concat(),
        ),
        ("header is not json", frame(b"not json", &good)),
        (
            "unknown field in the request",
            frame(
                &job(
                    r#"{"motion":{"kind":"preset","presets":["pulse"]},"size":240,"x":1}"#,
                    "request",
                    10_000,
                ),
                &good,
            ),
        ),
        (
            "unknown source kind",
            frame(&job(PULSE_240, "internet", 10_000), &good),
        ),
    ] {
        let (status, answer) = child(input);
        assert!(status.success(), "{name}: the child exits normally");
        assert_eq!(answer, unavailable, "{name}");
    }
    // A well-formed job is checked again by the child itself.
    let bad_size = r#"{"motion":{"kind":"preset","presets":["pulse"]},"size":100}"#;
    let (status, answer) = child(frame(&job(bad_size, "request", 10_000), &good));
    assert!(status.success());
    assert_eq!(
        answer,
        serde_json::json!({"Err": {"code": "assembly_params_invalid", "params": ["size"]}})
    );
    let (_, answer) = child(frame(
        &job(PULSE_240, "request", 10_000),
        &vec![0; 4 * MIB + 1],
    ));
    assert_eq!(
        answer,
        serde_json::json!({"Err": {"code": "assembly_source_too_large"}})
    );
    let (_, answer) = child(frame(&job(PULSE_240, "request", 10_000), b"not a picture"));
    assert_eq!(
        answer,
        serde_json::json!({"Err": {"code": "assembly_source_invalid"}})
    );
    let (_, answer) = child(frame(&job(PULSE_240, "request", 0), &good));
    assert_eq!(
        answer,
        serde_json::json!({"Err": {"code": "assembly_timeout"}}),
        "no budget, no work"
    );
    // And a good one answers with the candidate: hex bytes of a GIF and their facts.
    let (status, answer) = child(frame(&job(PULSE_240, "request", 10_000), &good));
    assert!(status.success());
    let made = &answer["Ok"][0]["Ok"];
    assert_eq!(made["motion"], "pulse");
    assert_eq!(made["large"]["info"]["frameCount"], 12);
    let gif = hex::decode(made["large"]["data"].as_str().unwrap()).unwrap();
    assert_eq!(&gif[..6], b"GIF89a");
    assert_eq!(
        made["large"]["info"]["bytes"].as_u64().unwrap() as usize,
        gif.len()
    );
}

#[tokio::test]
async fn the_default_entry_finds_the_assembler_beside_this_binary_and_honours_the_override() {
    // The only test that touches the environment, and the only one that calls the default entry.
    std::env::set_var("OORT_EXPRESSION_ASSEMBLER", "/somewhere/else/assembler");
    assert_eq!(
        assembler_path().unwrap(),
        PathBuf::from("/somewhere/else/assembler")
    );
    std::env::remove_var("OORT_EXPRESSION_ASSEMBLER");
    let found = assembler_path().unwrap();
    assert_eq!(
        found,
        program(),
        "target/debug/deps/<test> -> target/debug/momo-expression-assembler"
    );
    let r = try_assemble(
        &presets(&[Preset::Pulse], 240),
        png(&bar_source()),
        SourceFrom::Request,
        &slots(),
    )
    .await
    .unwrap();
    assert_eq!(r.len(), 1);
    assert!(r[0].is_ok());
}

#[tokio::test]
async fn a_preset_over_1_mib_at_the_largest_canvas_reports_the_measured_size() {
    // The planner's case: a noise picture at 480. Frames that move are resampled (no exact
    // palette), so this takes the slow path of the encoder: kept to one preset.
    let mut seed = 0x1357_9bdfu32;
    let noisy = RgbaImage::from_fn(512, 512, |_, _| {
        let mut px = [255u8; 4];
        for c in &mut px[..3] {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            *c = seed as u8;
        }
        Rgba(px)
    });
    let started = Instant::now();
    let r = run(&presets(&[Preset::Bounce], 480), png(&noisy))
        .await
        .unwrap();
    assert!(started.elapsed() < Duration::from_secs(30));
    match &r[0] {
        Err(AssembleError::OutputTooLarge { bytes }) => assert!(*bytes > MIB as u64, "{bytes}"),
        other => panic!("{other:?}"),
    }
}
