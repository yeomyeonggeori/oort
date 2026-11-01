//! The synthetic table of ADR-0218 §8 H9: flat backgrounds are erased from the edge inward,
//! everything that is not provably one flat colour comes back byte for byte, and the same
//! picture gives the same bytes. Every number here is measured on a drawn picture; no photograph
//! of a person is used.

use super::*;

const WHITE: [u8; 3] = [255, 255, 255];
const GREEN: [u8; 3] = [0, 200, 0];
const MAGENTA: [u8; 3] = [255, 0, 255];
const RED: [u8; 3] = [255, 0, 0];

fn canvas(w: u32, h: u32, bg: [u8; 3]) -> RgbaImage {
    RgbaImage::from_pixel(w, h, Rgba([bg[0], bg[1], bg[2], 255]))
}

fn disc(image: &mut RgbaImage, cx: i64, cy: i64, r: i64, colour: [u8; 3]) {
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (dx, dy) = (i64::from(x) - cx, i64::from(y) - cy);
        if dx * dx + dy * dy <= r * r {
            *pixel = Rgba([colour[0], colour[1], colour[2], 255]);
        }
    }
}

fn rect(image: &mut RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32, colour: [u8; 3]) {
    for y in y0..=y1 {
        for x in x0..=x1 {
            image.put_pixel(x, y, Rgba([colour[0], colour[1], colour[2], 255]));
        }
    }
}

/// A deterministic noise source, so a failure reproduces.
struct Noise(u64);
impl Noise {
    fn next(&mut self, spread: i32) -> i32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) as i32 % (2 * spread + 1)) - spread
    }
}

fn same(a: &RgbaImage, b: &RgbaImage) -> bool {
    a.dimensions() == b.dimensions() && a.as_raw() == b.as_raw()
}

#[test]
fn flat_backgrounds_of_three_colours_are_erased_from_the_edges_in_and_nothing_else_is() {
    for bg in [WHITE, GREEN, MAGENTA] {
        let mut picture = canvas(400, 400, bg);
        disc(&mut picture, 200, 200, 120, RED);
        // A hole in the subject that is the background's colour but is not reached from the edge.
        disc(&mut picture, 200, 200, 30, bg);
        let cut = cut_out(&picture);
        assert_eq!(cut.outcome, Outcome::Erased, "bg {bg:?}");
        // The subject is 241 px wide; 4 % of it (9 px) is kept around it: 259 px, from x = 71.
        assert_eq!(cut.image.dimensions(), (259, 259), "bg {bg:?}");
        let offset = 71i64;
        let mut erased = 0u32;
        for (x, y, pixel) in cut.image.enumerate_pixels() {
            let (dx, dy) = (i64::from(x) + offset - 200, i64::from(y) + offset - 200);
            let inside = dx * dx + dy * dy <= 120 * 120;
            if inside {
                // Subject and hole both stay fully opaque, in their own colour.
                let want = if dx * dx + dy * dy <= 30 * 30 {
                    bg
                } else {
                    RED
                };
                assert_eq!(
                    pixel.0,
                    [want[0], want[1], want[2], 255],
                    "({x},{y}) bg {bg:?}"
                );
            } else {
                assert_eq!(
                    pixel.0[3], 0,
                    "({x},{y}) outside the subject must be transparent"
                );
                erased += 1;
            }
        }
        assert!(erased > 0);
        // The crop keeps the subject whole: its widest row and column are inside the picture.
        assert_eq!(
            cut.image.get_pixel(129, 129).0,
            [bg[0], bg[1], bg[2], 255],
            "the hole's centre"
        );
    }
}

#[test]
fn a_subject_that_touches_the_edge_keeps_those_pixels_while_the_background_around_it_goes() {
    let mut picture = canvas(400, 400, WHITE);
    // A disc with a 30-row arm reaching the left edge: 90 of the band's 4764 pixels (1.9 %) are
    // subject, under the 2 % allowance, and the whole subject is about a fifth of the picture.
    disc(&mut picture, 240, 200, 100, RED);
    rect(&mut picture, 0, 185, 160, 214, RED);
    let cut = cut_out(&picture);
    assert_eq!(cut.outcome, Outcome::Erased);
    // The crop is the subject plus its margin, so the touched edge is still the picture's edge.
    let (w, h) = cut.image.dimensions();
    assert!(w < 400 && h < 400, "{w}x{h}");
    assert_eq!(
        cut.image.get_pixel(0, h / 2).0,
        [255, 0, 0, 255],
        "the arm's edge pixels stay opaque"
    );
    assert_eq!(
        cut.image.get_pixel(w - 1, h - 1).0[3],
        0,
        "the far corner is background"
    );
    assert_eq!(
        cut.image.get_pixel(0, 0).0[3],
        0,
        "and so is the corner beside the arm"
    );

    // A third of the edge is subject: that is not a flat edge, and nothing is erased.
    let mut busy = canvas(400, 400, WHITE);
    rect(&mut busy, 0, 100, 160, 300, RED);
    let cut = cut_out(&busy);
    assert_eq!(
        cut.outcome,
        Outcome::Untouched,
        "6 % of the band is subject"
    );
    assert!(same(&cut.image, &busy));
}

#[test]
fn the_pixels_beside_the_background_keep_part_of_their_opacity_and_lose_its_colour() {
    let mut picture = canvas(200, 200, WHITE);
    rect(&mut picture, 50, 50, 149, 149, RED);
    // A column that is mostly the background colour: an antialiased edge.
    for y in 50..=149 {
        picture.put_pixel(49, y, Rgba([255, 230, 230, 255]));
    }
    let cut = cut_out(&picture);
    assert_eq!(cut.outcome, Outcome::Erased);
    // Margin = 4 % of 101 = 4 px, so the crop starts at x = 49 - 4 = 45, y = 50 - 4 = 46.
    let soft = cut.image.get_pixel(49 - 45, 100 - 46).0;
    assert!(
        soft[3] > 0 && soft[3] < 255,
        "partly opaque, got alpha {}",
        soft[3]
    );
    assert!(
        soft[1] < 230 && soft[2] < 230,
        "the white taken back out of it: {soft:?}"
    );
    assert_eq!(soft[0], 255);
}

#[test]
fn gradients_noise_and_checkerboards_are_not_erased_and_come_back_byte_identical() {
    // A gradient across the whole width.
    let mut gradient = RgbaImage::new(300, 300);
    for (x, _, pixel) in gradient.enumerate_pixels_mut() {
        let v = (x * 255 / 299) as u8;
        *pixel = Rgba([v, v, v, 255]);
    }
    disc(&mut gradient, 150, 150, 60, RED);
    // Noise of ±40 per channel around a grey.
    let mut noise = Noise(7);
    let mut noisy = canvas(300, 300, [200, 200, 200]);
    for pixel in noisy.pixels_mut() {
        for channel in pixel.0.iter_mut().take(3) {
            *channel = (200 + noise.next(40)).clamp(0, 255) as u8;
        }
    }
    disc(&mut noisy, 150, 150, 60, RED);
    // Black and white 8 px cells.
    let mut checker = canvas(304, 304, WHITE);
    for (x, y, pixel) in checker.enumerate_pixels_mut() {
        if (x / 8 + y / 8) % 2 == 0 {
            *pixel = Rgba([0, 0, 0, 255]);
        }
    }
    disc(&mut checker, 152, 152, 60, RED);
    for (name, picture) in [
        ("gradient", gradient),
        ("noise", noisy),
        ("checkerboard", checker),
    ] {
        let cut = cut_out(&picture);
        assert_eq!(cut.outcome, Outcome::Untouched, "{name}");
        assert!(
            same(&cut.image, &picture),
            "{name}: byte identical to the input"
        );
    }
}

#[test]
fn an_edge_that_is_not_flat_stops_the_erase_even_when_the_inside_is() {
    // A flat white inside, and every seventh pixel of the 3 px band dark: the edge is 86 % one colour,
    // under the 98 % it must be, so the white inside is not erased from it. (Only this check stands
    // between this picture and an erase: from the white pixels of the band the fill would reach the
    // whole inside, and the erased share, 70 %, is inside the allowed range.)
    let mut picture = canvas(400, 400, WHITE);
    disc(&mut picture, 200, 200, 90, RED);
    let mut speckled = 0u32;
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
        let in_band = x < BAND || y < BAND || x >= 400 - BAND || y >= 400 - BAND;
        if in_band && (x + y) % 7 == 0 {
            *pixel = Rgba([60, 60, 60, 255]);
            speckled += 1;
        }
    }
    assert!(speckled > 500, "the picture really is speckled: {speckled}");
    let cut = cut_out(&picture);
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert!(same(&cut.image, &picture));
}

#[test]
fn a_nearly_flat_background_still_counts_as_flat() {
    // A slow ramp from 200 to 212 stays inside the 16-per-channel allowance of its own median.
    let mut picture = RgbaImage::new(300, 300);
    for (x, _, pixel) in picture.enumerate_pixels_mut() {
        let v = (200 + x * 12 / 299) as u8;
        *pixel = Rgba([v, v, v, 255]);
    }
    disc(&mut picture, 150, 150, 80, RED);
    assert_eq!(cut_out(&picture).outcome, Outcome::Erased);
}

#[test]
fn erasing_nothing_or_nearly_everything_is_not_a_cut_out() {
    // All one colour: 100 % would be erased.
    assert_eq!(
        cut_out(&canvas(100, 100, WHITE)).outcome,
        Outcome::Untouched
    );
    // A speck: 3 % subject, 97 % erased.
    let mut speck = canvas(200, 200, WHITE);
    rect(&mut speck, 80, 80, 114, 114, RED);
    let cut = cut_out(&speck);
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert!(same(&cut.image, &speck));
    // A subject that fills the frame: 10 % erased, under the 20 % floor.
    let mut full = canvas(200, 200, WHITE);
    rect(&mut full, 5, 5, 194, 194, RED);
    let cut = cut_out(&full);
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert!(same(&cut.image, &full));
}

#[test]
fn a_cut_out_the_model_already_made_keeps_its_transparency_and_is_only_cropped() {
    let mut picture = RgbaImage::from_pixel(400, 400, Rgba([0, 0, 0, 0]));
    disc(&mut picture, 200, 200, 100, RED);
    picture.put_pixel(200, 200, Rgba([10, 20, 30, 128]));
    let cut = cut_out(&picture);
    assert_eq!(cut.outcome, Outcome::Model);
    // 201 px of subject + 4 % margin (8 px): 217, from x = 100 - 8 = 92.
    assert_eq!(cut.image.dimensions(), (217, 217));
    assert_eq!(
        cut.image.get_pixel(200 - 92, 200 - 92).0,
        [10, 20, 30, 128],
        "its own pixels are untouched"
    );
    assert_eq!(cut.image.get_pixel(0, 0).0[3], 0);
    assert_eq!(cut.image.get_pixel(150 - 92, 200 - 92).0, [255, 0, 0, 255]);
}

#[test]
fn a_picture_with_an_alpha_channel_that_is_fully_opaque_is_judged_by_its_edge_like_any_other() {
    let mut picture = canvas(300, 300, GREEN);
    disc(&mut picture, 150, 150, 90, RED);
    assert!(picture.pixels().all(|p| p.0[3] == 255));
    assert_eq!(cut_out(&picture).outcome, Outcome::Erased);
}

#[test]
fn the_same_picture_gives_the_same_bytes() {
    let mut picture = canvas(320, 320, MAGENTA);
    disc(&mut picture, 160, 160, 100, RED);
    disc(&mut picture, 150, 140, 20, [20, 40, 200]);
    let (a, b) = (cut_out(&picture), cut_out(&picture));
    assert_eq!(a.outcome, Outcome::Erased);
    assert!(same(&a.image, &b.image));
}

#[test]
fn a_picture_that_is_too_big_or_too_small_is_left_alone() {
    let mut big = canvas(2100, 2100, WHITE);
    disc(&mut big, 1050, 1050, 500, RED);
    assert!(u64::from(big.width()) * u64::from(big.height()) > MAX_PIXELS);
    let cut = cut_out(&big);
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert!(same(&cut.image, &big));
    let tiny = canvas(MIN_EDGE - 1, MIN_EDGE - 1, WHITE);
    assert_eq!(cut_out(&tiny).outcome, Outcome::Untouched);
}

#[test]
fn a_see_through_band_has_no_background_colour_to_erase() {
    // The band is 60 % transparent (alpha 100 < 128 everywhere), but fewer than 2 % of the picture
    // is fully transparent, so it is not an already-cut-out picture either: nothing is done.
    let mut picture = canvas(300, 300, WHITE);
    disc(&mut picture, 150, 150, 80, RED);
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
        if x < 3 || y < 3 || x >= 297 || y >= 297 {
            *pixel = Rgba([255, 255, 255, 100]);
        }
    }
    let cut = cut_out(&picture);
    assert_eq!(cut.outcome, Outcome::Untouched);
    assert!(same(&cut.image, &picture));
}
