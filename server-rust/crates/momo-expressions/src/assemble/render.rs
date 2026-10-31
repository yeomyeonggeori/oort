//! Pixel math of the motion assembly (ADR-0218 G3.2/G3.3). Pure and synchronous: no clock, no
//! randomness and no hash-map iteration, so one input is one byte string. Frames are produced one
//! at a time by [`Canvas`]; nothing here collects an animation.
use std::f64::consts::PI;

use image::imageops::{self, FilterType};
use image::RgbaImage;

use super::Preset;

/// G3.2: the picture is fitted into a square of 80% of the canvas side.
pub(super) fn box_px(size: u32) -> u32 {
    size * 4 / 5
}

// ---- G3.3 table -------------------------------------------------------------------------
const BOUNCE_LIFT: f64 = 0.08;
const BOUNCE_SQUASH_X: f64 = 1.06;
const BOUNCE_SQUASH_Y: f64 = 0.94;
const WOBBLE_DEGREES: f64 = 8.0;
const PULSE_GAIN: f64 = 0.12;
/// Sparkle: star k is lit in frames `5k..5k+4` only.
pub(super) const STAR_FRAMES: u32 = 5;
/// Centres of the four stars as fractions of the canvas side: the middle of each corner square of
/// the 10% margin band, so a star never overlaps the 80% picture box.
pub(super) const STAR_CENTERS: [(f64, f64); 4] =
    [(0.05, 0.05), (0.95, 0.05), (0.95, 0.95), (0.05, 0.95)];
/// Star radii as fractions of the canvas side. The halo stays inside the 10% band (0.05 +- 0.048).
const STAR_HALO_RADIUS: f64 = 0.048;
const STAR_CORE_RADIUS: f64 = 0.034;
const STAR_INNER_RATIO: f64 = 0.36;
const STAR_HALO: [u8; 3] = [255, 255, 255];
const STAR_CORE: [u8; 3] = [255, 196, 0];

/// One frame's placement of the picture. Rotation is clockwise-positive on screen (CSS
/// convention), about the centre of the picture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Pose {
    /// Vertical shift in canvas pixels; negative is up.
    pub dy: f64,
    pub sx: f64,
    pub sy: f64,
    pub rot_deg: f64,
    /// Scale about the bottom edge instead of the centre: a squash rests on the ground line.
    pub on_floor: bool,
    pub star: Option<usize>,
}

impl Pose {
    pub(super) const REST: Pose = Pose {
        dy: 0.0,
        sx: 1.0,
        sy: 1.0,
        rot_deg: 0.0,
        on_floor: false,
        star: None,
    };
}

/// `sin`/`cos` come from the platform libm and may differ in the last ulp between platforms. Every
/// pose value is rounded to 1e-9 once, so the pixel arithmetic that follows is the same on every
/// IEEE-754 target (an ulp flip needs a value within 1e-16 of a rounding edge).
fn q(x: f64) -> f64 {
    (x * 1e9).round() / 1e9
}

/// Phase `t = i / frames` (G3.3). `i` counts from 0.
pub(super) fn pose(preset: Preset, i: u32, size: u32) -> Pose {
    let t = f64::from(i) / f64::from(preset.frames());
    match preset {
        Preset::Bounce => Pose {
            dy: q(-BOUNCE_LIFT * f64::from(size) * (PI * t).sin().abs()),
            sx: if i == 0 { BOUNCE_SQUASH_X } else { 1.0 },
            sy: if i == 0 { BOUNCE_SQUASH_Y } else { 1.0 },
            on_floor: i == 0,
            ..Pose::REST
        },
        Preset::Wobble => Pose {
            rot_deg: q(WOBBLE_DEGREES * (2.0 * PI * t).sin()),
            ..Pose::REST
        },
        Preset::Pulse => {
            let s = (2.0 * PI * t).sin();
            let k = q(1.0 + PULSE_GAIN * s * s);
            Pose {
                sx: k,
                sy: k,
                ..Pose::REST
            }
        }
        Preset::Sparkle => Pose {
            star: Some((i / STAR_FRAMES) as usize),
            ..Pose::REST
        },
    }
}

// ---- sprite sheet -----------------------------------------------------------------------
/// G3.2: 2 -> 2x1, 3 -> 3x1, 4 -> 2x2 (columns, rows).
pub(super) fn grid(frames: u32) -> (u32, u32) {
    match frames {
        2 => (2, 1),
        3 => (3, 1),
        _ => (2, 2),
    }
}

/// Cell `index` (left to right, top to bottom from 0) as `(x, y, w, h)`. Pixels that do not divide
/// evenly are dropped from the right and bottom; a sheet too small for the grid has no cell.
pub(super) fn cell_rect(w: u32, h: u32, frames: u32, index: u32) -> Option<(u32, u32, u32, u32)> {
    let (cols, rows) = grid(frames);
    let (cw, ch) = (w / cols, h / rows);
    if cw == 0 || ch == 0 || index >= cols * rows {
        return None;
    }
    Some(((index % cols) * cw, (index / cols) * ch, cw, ch))
}

// ---- colour -----------------------------------------------------------------------------
/// Per-channel median of the outermost ring of pixels. `None` (transparent margin) when the
/// median alpha is below 128: an image that is transparent at its edge stays transparent.
pub(super) fn edge_fill(img: &RgbaImage) -> Option<[u8; 3]> {
    let (w, h) = img.dimensions();
    let mut ring: [Vec<u8>; 4] = Default::default();
    let mut push = |x: u32, y: u32| {
        let p = img.get_pixel(x, y).0;
        for (channel, value) in ring.iter_mut().zip(p) {
            channel.push(value);
        }
    };
    for x in 0..w {
        push(x, 0);
        if h > 1 {
            push(x, h - 1);
        }
    }
    for y in 1..h.saturating_sub(1) {
        push(0, y);
        if w > 1 {
            push(w - 1, y);
        }
    }
    let mut median = [0u8; 4];
    for (m, channel) in median.iter_mut().zip(ring.iter_mut()) {
        channel.sort_unstable();
        *m = channel[channel.len() / 2];
    }
    (median[3] >= 128).then_some([median[0], median[1], median[2]])
}

pub(super) fn premultiply(img: &mut RgbaImage) {
    for p in img.pixels_mut() {
        let a = u32::from(p.0[3]);
        if a != 255 {
            for c in &mut p.0[..3] {
                *c = ((u32::from(*c) * a + 127) / 255) as u8;
            }
        }
    }
}

fn unpremultiply(px: [u8; 4]) -> [u8; 4] {
    let a = u32::from(px[3]);
    match a {
        0 => [0, 0, 0, 0],
        255 => px,
        _ => {
            let f = |c: u8| ((u32::from(c) * 255 + a / 2) / a).min(255) as u8;
            [f(px[0]), f(px[1]), f(px[2]), px[3]]
        }
    }
}

// ---- fitting ----------------------------------------------------------------------------
/// Premultiplied RGBA8 picture, already fitted: no enlargement, aspect ratio kept.
pub(super) struct Tile {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

/// Longest side to `box_px` when larger, otherwise unchanged (G3.2: never enlarge).
pub(super) fn fit_dims(w: u32, h: u32, box_px: u32) -> (u32, u32) {
    if w.max(h) <= box_px {
        return (w, h);
    }
    let scale = |short: u32, long: u32| {
        ((u64::from(short) * u64::from(box_px) + u64::from(long) / 2) / u64::from(long)).max(1)
            as u32
    };
    if w >= h {
        (box_px, scale(h, w))
    } else {
        (scale(w, h), box_px)
    }
}

/// `src` is premultiplied. A box average first brings a large source to twice the target (each
/// source pixel is visited once), then Lanczos finishes: the resize filters assume premultiplied
/// alpha, which is what keeps a transparent picture free of dark fringes.
pub(super) fn fit_tile(src: &RgbaImage, x: u32, y: u32, w: u32, h: u32, box_px: u32) -> Tile {
    let (nw, nh) = fit_dims(w, h, box_px);
    let view = imageops::crop_imm(src, x, y, w, h);
    let mut fitted = if (nw, nh) == (w, h) {
        view.to_image()
    } else if w >= nw * 2 && h >= nh * 2 {
        let mid = imageops::thumbnail(&*view, nw * 2, nh * 2);
        imageops::resize(&mid, nw, nh, FilterType::Lanczos3)
    } else {
        imageops::resize(&*view, nw, nh, FilterType::Lanczos3)
    };
    // The filters can overshoot; premultiplied colour never exceeds alpha.
    for p in fitted.pixels_mut() {
        let a = p.0[3];
        for c in &mut p.0[..3] {
            *c = (*c).min(a);
        }
    }
    Tile {
        w: nw,
        h: nh,
        px: fitted.into_raw(),
    }
}

// ---- canvas -----------------------------------------------------------------------------
/// Square premultiplied RGBA8 canvas. The margin and every empty spot are the edge-median colour,
/// or transparent when the source is.
pub(super) struct Canvas {
    size: u32,
    px: Vec<u8>,
}

impl Canvas {
    pub(super) fn new(size: u32, fill: Option<[u8; 3]>) -> Canvas {
        let pixel = fill.map_or([0, 0, 0, 0], |c| [c[0], c[1], c[2], 255]);
        let px = pixel
            .iter()
            .copied()
            .cycle()
            .take(size as usize * size as usize * 4)
            .collect();
        Canvas { size, px }
    }

    /// `src` over the pixel at `(x, y)`, both premultiplied.
    fn over(&mut self, x: u32, y: u32, src: [u8; 4]) {
        if src[3] == 0 {
            return;
        }
        let at = (y as usize * self.size as usize + x as usize) * 4;
        let keep = 255 - u32::from(src[3]);
        for (k, channel) in src.iter().enumerate() {
            let dst = u32::from(self.px[at + k]);
            self.px[at + k] = (u32::from(*channel) + (dst * keep + 127) / 255).min(255) as u8;
        }
    }

    /// Inverse-mapped bilinear draw of `tile` placed at the middle of the canvas and moved by
    /// `pose`. Taps outside the picture are transparent, so a rotated or scaled edge falls off
    /// over one pixel. With the identity pose every tap lands on a pixel centre: an exact copy.
    pub(super) fn draw_tile(&mut self, tile: &Tile, pose: &Pose) {
        let (tw, th) = (f64::from(tile.w), f64::from(tile.h));
        let left = (self.size.saturating_sub(tile.w) / 2) as f64;
        let top = (self.size.saturating_sub(tile.h) / 2) as f64;
        let rad = pose.rot_deg.to_radians();
        let (sin, cos) = (q(rad.sin()), q(rad.cos()));
        let floor_shift = if pose.on_floor {
            (1.0 - pose.sy) * th / 2.0
        } else {
            0.0
        };
        let (tx, ty) = (left + tw / 2.0, top + th / 2.0 + pose.dy + floor_shift);
        // Bounding box of the transformed picture.
        let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for (cx, cy) in [(-tw, -th), (tw, -th), (-tw, th), (tw, th)] {
            let (px, py) = (cx * pose.sx / 2.0, cy * pose.sy / 2.0);
            let (x, y) = (tx + px * cos - py * sin, ty + px * sin + py * cos);
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
        }
        let clamp = |v: f64| v.clamp(0.0, f64::from(self.size)) as u32;
        let (x0, x1, y0, y1) = (
            clamp(min_x.floor()),
            clamp(max_x.ceil()),
            clamp(min_y.floor()),
            clamp(max_y.ceil()),
        );
        for y in y0..y1 {
            for x in x0..x1 {
                let (dx, dy) = (f64::from(x) + 0.5 - tx, f64::from(y) + 0.5 - ty);
                let u = (cos * dx + sin * dy) / pose.sx + tw / 2.0 - 0.5;
                let v = (-sin * dx + cos * dy) / pose.sy + th / 2.0 - 0.5;
                let (iu, iv) = (u.floor(), v.floor());
                let (wu, wv) = ((u - iu) as f32, (v - iv) as f32);
                let (i0, j0) = (iu as i64, iv as i64);
                let taps = [
                    (i0, j0, (1.0 - wu) * (1.0 - wv)),
                    (i0 + 1, j0, wu * (1.0 - wv)),
                    (i0, j0 + 1, (1.0 - wu) * wv),
                    (i0 + 1, j0 + 1, wu * wv),
                ];
                let mut acc = [0f32; 4];
                for (i, j, weight) in taps {
                    if i < 0 || j < 0 || i >= i64::from(tile.w) || j >= i64::from(tile.h) {
                        continue;
                    }
                    let at = (j as usize * tile.w as usize + i as usize) * 4;
                    for (a, c) in acc.iter_mut().zip(&tile.px[at..at + 4]) {
                        *a += f32::from(*c) * weight;
                    }
                }
                let src = acc.map(|c| (c + 0.5).clamp(0.0, 255.0) as u8);
                self.over(
                    x,
                    y,
                    [
                        src[0].min(src[3]),
                        src[1].min(src[3]),
                        src[2].min(src[3]),
                        src[3],
                    ],
                );
            }
        }
    }

    /// Star `k` of G3.3, drawn from code: a white halo under a gold four-point core, each
    /// anti-aliased by 3x3 sampling. No external asset.
    pub(super) fn draw_star(&mut self, k: usize) {
        let size = f64::from(self.size);
        let (fx, fy) = STAR_CENTERS[k % STAR_CENTERS.len()];
        let (cx, cy) = (fx * size, fy * size);
        for (radius, color) in [(STAR_HALO_RADIUS, STAR_HALO), (STAR_CORE_RADIUS, STAR_CORE)] {
            let r = radius * size;
            let poly = star_polygon(cx, cy, r, r * STAR_INNER_RATIO);
            let (x0, x1) = (
                (cx - r).floor().max(0.0) as u32,
                (cx + r).ceil().min(size) as u32,
            );
            let (y0, y1) = (
                (cy - r).floor().max(0.0) as u32,
                (cy + r).ceil().min(size) as u32,
            );
            for y in y0..y1 {
                for x in x0..x1 {
                    let mut inside = 0u32;
                    for sy in 0..3 {
                        for sx in 0..3 {
                            let (px, py) = (
                                f64::from(x) + (f64::from(sx) + 0.5) / 3.0,
                                f64::from(y) + (f64::from(sy) + 0.5) / 3.0,
                            );
                            inside += u32::from(contains(&poly, px, py));
                        }
                    }
                    if inside > 0 {
                        let a = (inside * 255 + 4) / 9;
                        let c = |v: u8| ((u32::from(v) * a + 127) / 255) as u8;
                        self.over(x, y, [c(color[0]), c(color[1]), c(color[2]), a as u8]);
                    }
                }
            }
        }
    }

    /// Straight RGBA8 for the GIF encoder. A GIF has a one-bit mask: a pixel is opaque (alpha >=
    /// 128, colour un-premultiplied) or fully transparent black. On an opaque margin every pixel
    /// is opaque, so this is the identity there.
    pub(super) fn into_frame(self) -> RgbaImage {
        let mut px = self.px;
        for p in px.chunks_exact_mut(4) {
            let straight = if p[3] >= 128 {
                let s = unpremultiply([p[0], p[1], p[2], p[3]]);
                [s[0], s[1], s[2], 255]
            } else {
                [0, 0, 0, 0]
            };
            p.copy_from_slice(&straight);
        }
        RgbaImage::from_raw(self.size, self.size, px).expect("canvas length is size*size*4")
    }
}

fn star_polygon(cx: f64, cy: f64, outer: f64, inner: f64) -> [(f64, f64); 8] {
    let mut poly = [(0.0, 0.0); 8];
    for (i, vertex) in poly.iter_mut().enumerate() {
        let radius = if i % 2 == 0 { outer } else { inner };
        let angle = f64::from(i as u32) * PI / 4.0;
        *vertex = (cx + radius * q(angle.cos()), cy + radius * q(angle.sin()));
    }
    poly
}

/// Even-odd ray cast.
fn contains(poly: &[(f64, f64); 8], x: f64, y: f64) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let ((xi, yi), (xj, yj)) = (poly[i], poly[j]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    const BG: [u8; 3] = [240, 240, 240];
    const FG: [u8; 3] = [200, 30, 30];

    fn solid(w: u32, h: u32, c: [u8; 3]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([c[0], c[1], c[2], 255]))
    }
    /// A light picture with one red rectangle: its moments say where the picture went.
    fn marker(w: u32, h: u32, rect: (u32, u32, u32, u32)) -> RgbaImage {
        let mut img = solid(w, h, BG);
        for y in rect.1..rect.1 + rect.3 {
            for x in rect.0..rect.0 + rect.2 {
                img.put_pixel(x, y, Rgba([FG[0], FG[1], FG[2], 255]));
            }
        }
        img
    }
    fn tile_of(img: &RgbaImage, box_px: u32) -> Tile {
        let mut premultiplied = img.clone();
        premultiply(&mut premultiplied);
        fit_tile(&premultiplied, 0, 0, img.width(), img.height(), box_px)
    }
    fn frame(tile: &Tile, size: u32, pose: &Pose) -> RgbaImage {
        let mut canvas = Canvas::new(size, Some(BG));
        canvas.draw_tile(tile, pose);
        canvas.into_frame()
    }

    /// Coverage-weighted moments of the red marker (coverage from the green channel).
    struct Blob {
        area: f64,
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
        /// Orientation of the long axis, degrees, clockwise-positive on screen (y down).
        fn degrees(&self) -> f64 {
            (0.5 * (2.0 * self.vxy).atan2(self.vxx - self.vyy)).to_degrees()
        }
    }
    fn blob(img: &RgbaImage) -> Blob {
        let coverage = |p: &Rgba<u8>| {
            ((f64::from(BG[1]) - f64::from(p.0[1])) / f64::from(BG[1] - FG[1])).clamp(0.0, 1.0)
        };
        let (mut area, mut sx, mut sy) = (0.0, 0.0, 0.0);
        for (x, y, p) in img.enumerate_pixels() {
            let c = coverage(p);
            area += c;
            sx += c * (f64::from(x) + 0.5);
            sy += c * (f64::from(y) + 0.5);
        }
        let (cx, cy) = (sx / area, sy / area);
        let (mut vxx, mut vyy, mut vxy) = (0.0, 0.0, 0.0);
        for (x, y, p) in img.enumerate_pixels() {
            let c = coverage(p);
            let (dx, dy) = (f64::from(x) + 0.5 - cx, f64::from(y) + 0.5 - cy);
            vxx += c * dx * dx;
            vyy += c * dy * dy;
            vxy += c * dx * dy;
        }
        Blob {
            area,
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

    #[test]
    fn the_picture_box_is_eighty_percent_of_every_canvas_side() {
        assert_eq!(
            [240, 360, 480].map(box_px),
            [192, 288, 384],
            "G3.2: 80% of the side"
        );
    }

    #[test]
    fn fitting_keeps_the_ratio_and_never_enlarges() {
        assert_eq!(
            fit_dims(100, 50, 288),
            (100, 50),
            "smaller than the box: untouched"
        );
        assert_eq!(fit_dims(288, 288, 288), (288, 288));
        assert_eq!(fit_dims(1000, 500, 288), (288, 144));
        assert_eq!(fit_dims(500, 1000, 288), (144, 288));
        // The short side is rounded to the nearest pixel, not cut.
        assert_eq!(fit_dims(1000, 333, 288), (288, 96), "95.9 -> 96");
        assert_eq!(fit_dims(333, 1000, 288), (96, 288));
        assert_eq!(fit_dims(1000, 331, 288), (288, 95), "95.3 -> 95");
        assert_eq!(
            fit_dims(4000, 1, 288),
            (288, 1),
            "a side never reaches zero"
        );
        let src = marker(40, 20, (10, 5, 10, 10));
        let tile = tile_of(&src, 288);
        assert_eq!((tile.w, tile.h), (40, 20), "the tile is the picture itself");
        let big = tile_of(&solid(1000, 500, BG), 288);
        assert_eq!((big.w, big.h), (288, 144));
    }

    #[test]
    fn the_sheet_grid_numbers_cells_left_to_right_then_top_to_bottom() {
        assert_eq!([2, 3, 4].map(grid), [(2, 1), (3, 1), (2, 2)]);
        // 10 wide, 7 tall, three cells: 3 px each, the 10th column is dropped.
        let cells: Vec<_> = (0..3).map(|i| cell_rect(10, 7, 3, i)).collect();
        assert_eq!(
            cells,
            [Some((0, 0, 3, 7)), Some((3, 0, 3, 7)), Some((6, 0, 3, 7))]
        );
        // 9 x 5, 2x2: cells 4x2, the right column and bottom row are dropped.
        let cells: Vec<_> = (0..4).map(|i| cell_rect(9, 5, 4, i)).collect();
        assert_eq!(
            cells,
            [
                Some((0, 0, 4, 2)),
                Some((4, 0, 4, 2)),
                Some((0, 2, 4, 2)),
                Some((4, 2, 4, 2))
            ]
        );
        assert_eq!(cell_rect(9, 5, 4, 4), None, "no cell 4 in a 2x2 sheet");
        assert_eq!(
            cell_rect(1, 9, 2, 0),
            None,
            "a sheet narrower than its grid has no cell"
        );
        assert_eq!(cell_rect(9, 1, 4, 0), None, "...or shorter");
    }

    #[test]
    fn the_margin_colour_is_the_median_of_the_outer_ring_only() {
        let mut img = solid(5, 5, [10, 20, 30]);
        for y in 1..4 {
            for x in 1..4 {
                img.put_pixel(x, y, Rgba([200, 200, 200, 255])); // interior never counts
            }
        }
        // 16 ring pixels: 5 outliers stay a minority.
        for x in 0..5 {
            img.put_pixel(x, 0, Rgba([255, 0, 0, 255]));
        }
        assert_eq!(edge_fill(&img), Some([10, 20, 30]));
        // Make the outliers the majority and the median follows them.
        for x in 0..5 {
            img.put_pixel(x, 4, Rgba([255, 0, 0, 255]));
        }
        img.put_pixel(0, 2, Rgba([255, 0, 0, 255]));
        assert_eq!(edge_fill(&img), Some([255, 0, 0]));
        // Channels are medians on their own: the result need not be any pixel of the ring.
        let mut mixed = solid(3, 3, [0, 0, 0]);
        let ring = [
            (0, 0),
            (1, 0),
            (2, 0),
            (0, 1),
            (2, 1),
            (0, 2),
            (1, 2),
            (2, 2),
        ];
        let (r, g, b) = (
            [10, 20, 30, 40, 50, 60, 70, 80],
            [80, 70, 60, 50, 40, 30, 20, 10],
            [5, 5, 5, 5, 200, 200, 200, 200],
        );
        for (i, (x, y)) in ring.into_iter().enumerate() {
            mixed.put_pixel(x, y, Rgba([r[i], g[i], b[i], 255]));
        }
        assert_eq!(edge_fill(&mixed), Some([50, 50, 200]));
    }

    #[test]
    fn the_ring_of_a_one_pixel_wide_picture_is_the_whole_picture() {
        let mut column = RgbaImage::new(1, 3);
        for (y, c) in [[10u8, 90, 7], [20, 80, 8], [30, 70, 9]]
            .into_iter()
            .enumerate()
        {
            column.put_pixel(0, y as u32, Rgba([c[0], c[1], c[2], 255]));
        }
        assert_eq!(
            edge_fill(&column),
            Some([20, 80, 8]),
            "each pixel counted once"
        );
        let row = RgbaImage::from_fn(3, 1, |x, _| Rgba([[1u8, 5, 9][x as usize], 0, 0, 255]));
        assert_eq!(edge_fill(&row), Some([5, 0, 0]));
        assert_eq!(edge_fill(&solid(1, 1, [4, 5, 6])), Some([4, 5, 6]));
    }

    #[test]
    fn a_picture_that_is_transparent_at_its_edge_keeps_a_transparent_margin() {
        let mut img = RgbaImage::from_pixel(6, 6, Rgba([9, 9, 9, 0]));
        img.put_pixel(3, 3, Rgba([200, 0, 0, 255]));
        assert_eq!(edge_fill(&img), None);
        let half = RgbaImage::from_pixel(6, 6, Rgba([9, 9, 9, 128]));
        assert_eq!(
            edge_fill(&half),
            Some([9, 9, 9]),
            "alpha 128 is opaque enough"
        );
        let faint = RgbaImage::from_pixel(6, 6, Rgba([9, 9, 9, 127]));
        assert_eq!(edge_fill(&faint), None);
        // An opaque edge around a see-through middle is an opaque margin.
        let mut ring = solid(6, 6, [7, 8, 9]);
        ring.put_pixel(3, 3, Rgba([0, 0, 0, 0]));
        assert_eq!(edge_fill(&ring), Some([7, 8, 9]));
    }

    #[test]
    fn poses_follow_the_adr_table() {
        // Independent of the implementation: the formulas of G3.3 written out again.
        for size in [240u32, 360, 480] {
            for i in 0..16u32 {
                let t = f64::from(i) / 16.0;
                let p = pose(Preset::Bounce, i, size);
                near(
                    p.dy,
                    -0.08 * f64::from(size) * (PI * t).sin().abs(),
                    1e-6,
                    "bounce dy",
                );
                let squash = i == 0;
                assert_eq!((p.sx, p.sy), if squash { (1.06, 0.94) } else { (1.0, 1.0) });
                assert_eq!(p.on_floor, squash, "the squash is frame 0 only");
                assert_eq!((p.rot_deg, p.star), (0.0, None));
                let w = pose(Preset::Wobble, i, size);
                near(
                    w.rot_deg,
                    8.0 * (2.0 * PI * t).sin(),
                    1e-6,
                    "wobble degrees",
                );
                assert_eq!((w.dy, w.sx, w.sy), (0.0, 1.0, 1.0));
            }
            for i in 0..12u32 {
                let t = f64::from(i) / 12.0;
                let p = pose(Preset::Pulse, i, size);
                let want = 1.0 + 0.12 * (2.0 * PI * t).sin().powi(2);
                near(p.sx, want, 1e-6, "pulse scale x");
                near(p.sy, want, 1e-6, "pulse scale y");
            }
            for i in 0..20u32 {
                let p = pose(Preset::Sparkle, i, size);
                assert_eq!(
                    p.star,
                    Some((i / 5) as usize),
                    "star k is lit in frames 5k..5k+4"
                );
                assert_eq!(
                    (p.dy, p.sx, p.sy, p.rot_deg),
                    (0.0, 1.0, 1.0, 0.0),
                    "the picture is fixed"
                );
            }
        }
        // Peak values quoted by the ADR text.
        near(
            pose(Preset::Bounce, 8, 360).dy,
            -28.8,
            1e-9,
            "bounce lifts 8% of 360",
        );
        near(
            pose(Preset::Wobble, 4, 360).rot_deg,
            8.0,
            1e-9,
            "wobble peaks at 8 degrees",
        );
        near(
            pose(Preset::Pulse, 3, 360).sx,
            1.12,
            1e-9,
            "pulse peaks at x1.12",
        );
        assert_eq!(
            pose(Preset::Pulse, 6, 360).sx,
            1.0,
            "...and rests between beats"
        );
    }

    #[test]
    fn the_preset_table_has_the_adr_frame_counts_delays_and_play_times() {
        let table =
            Preset::ALL.map(|p| (p.id(), p.frames(), p.delay_ms(), p.frames() * p.delay_ms()));
        assert_eq!(
            table,
            [
                ("bounce", 16, 40, 640),
                ("wobble", 16, 40, 640),
                ("pulse", 12, 50, 600),
                ("sparkle", 20, 50, 1000)
            ]
        );
    }

    #[test]
    fn identity_pose_copies_the_picture_exactly() {
        // Odd tile on an even canvas: still pixel-aligned, so no tap is blended.
        let src = marker(101, 61, (30, 20, 11, 9));
        let tile = tile_of(&src, 288);
        let out = frame(&tile, 360, &Pose::REST);
        let (left, top) = ((360 - 101) / 2, (360 - 61) / 2);
        for y in 0..360 {
            for x in 0..360 {
                let inside = x >= left && x < left + 101 && y >= top && y < top + 61;
                let want = if inside {
                    *src.get_pixel(x - left, y - top)
                } else {
                    Rgba([BG[0], BG[1], BG[2], 255])
                };
                assert_eq!(*out.get_pixel(x, y), want, "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn bounce_lifts_eight_percent_at_half_phase_and_nothing_sideways() {
        let tile = tile_of(&marker(200, 200, (60, 60, 80, 80)), 288);
        let rest = blob(&frame(&tile, 360, &Pose::REST));
        near(rest.cx, 180.0, 0.05, "rest x");
        near(rest.cy, 180.0, 0.05, "rest y");
        let top = blob(&frame(&tile, 360, &pose(Preset::Bounce, 8, 360)));
        near(top.cy, 180.0 - 0.08 * 360.0, 0.1, "t=0.5 lifts -0.08*size");
        near(top.cx, 180.0, 0.05, "no sideways drift");
        near(top.width(), 80.0, 0.3, "no squash in the air");
        near(top.height(), 80.0, 0.3, "no squash in the air");
        // |sin| is symmetric: frames 4 and 12 sit at the same height.
        let (a, b) = (
            blob(&frame(&tile, 360, &pose(Preset::Bounce, 4, 360))),
            blob(&frame(&tile, 360, &pose(Preset::Bounce, 12, 360))),
        );
        near(a.cy, 180.0 - 0.08 * 360.0 * (PI / 4.0).sin(), 0.1, "t=0.25");
        near(a.cy, b.cy, 1e-6, "t=0.25 and t=0.75");
    }

    #[test]
    fn bounce_squashes_six_percent_at_the_floor_and_rests_on_it() {
        let tile = tile_of(&marker(200, 200, (60, 60, 80, 80)), 288);
        let floor = blob(&frame(&tile, 360, &pose(Preset::Bounce, 0, 360)));
        near(floor.width(), 80.0 * 1.06, 0.3, "wider by 6%");
        near(floor.height(), 80.0 * 0.94, 0.3, "lower by 6%");
        // The picture's bottom edge stays on the ground line (y = 280), so the marker, 100 px
        // above it, ends 94 px above it.
        near(
            floor.cy,
            280.0 - 94.0,
            0.1,
            "squash is anchored at the bottom edge",
        );
        near(floor.cx, 180.0, 0.05, "centred sideways");
    }

    #[test]
    fn wobble_turns_eight_degrees_clockwise_at_quarter_phase() {
        let tile = tile_of(&marker(200, 200, (40, 90, 120, 20)), 288);
        let at = |i| blob(&frame(&tile, 360, &pose(Preset::Wobble, i, 360)));
        near(at(0).degrees(), 0.0, 0.05, "t=0");
        near(
            at(4).degrees(),
            8.0,
            0.3,
            "t=0.25 turns +8 degrees (clockwise, y down)",
        );
        near(at(8).degrees(), 0.0, 0.05, "t=0.5");
        near(at(12).degrees(), -8.0, 0.3, "t=0.75 turns -8 degrees");
        let turned = at(4);
        near(turned.cx, 180.0, 0.1, "about the centre");
        near(turned.cy, 180.0, 0.1, "about the centre");
        near(turned.area, 120.0 * 20.0, 6.0, "a turn keeps the area");
    }

    #[test]
    fn pulse_swells_twelve_percent_twice_per_play() {
        let tile = tile_of(&marker(200, 200, (60, 60, 80, 80)), 288);
        let at = |i| blob(&frame(&tile, 360, &pose(Preset::Pulse, i, 360)));
        for (i, scale) in [(0, 1.0), (3, 1.12), (6, 1.0), (9, 1.12)] {
            let b = at(i);
            near(b.width(), 80.0 * scale, 0.3, "pulse width");
            near(b.height(), 80.0 * scale, 0.3, "pulse height");
            near(b.cx, 180.0, 0.1, "about the centre");
            near(b.cy, 180.0, 0.1, "about the centre");
        }
    }

    #[test]
    fn the_largest_motions_stay_inside_the_canvas() {
        // A solid red picture filling the 80% box on a grey margin: if any motion pushed an edge
        // out of the canvas the red area would drop, and red would touch the outer ring.
        let tile = tile_of(&solid(288, 288, FG), 288);
        let area = |f: &RgbaImage| {
            f.pixels()
                .map(|p| ((f64::from(BG[1]) - f64::from(p.0[1])) / 210.0).clamp(0.0, 1.0))
                .sum::<f64>()
        };
        for (preset, i, scale) in [
            (Preset::Bounce, 8, 1.0),
            (Preset::Bounce, 0, 1.06 * 0.94),
            (Preset::Wobble, 4, 1.0),
            (Preset::Wobble, 12, 1.0),
            (Preset::Pulse, 3, 1.12 * 1.12),
        ] {
            let f = frame(&tile, 360, &pose(preset, i, 360));
            let expected = 288.0 * 288.0 * scale;
            near(area(&f), expected, expected * 0.002, "nothing is clipped");
            for k in 0..360 {
                for (x, y) in [(k, 0), (k, 359), (0, k), (359, k)] {
                    assert_eq!(
                        f.get_pixel(x, y).0[1],
                        BG[1],
                        "{preset:?} frame {i} touches the edge"
                    );
                }
            }
        }
    }

    #[test]
    fn a_transparent_picture_becomes_a_one_bit_mask() {
        let mut img = RgbaImage::from_pixel(60, 60, Rgba([0, 0, 0, 0]));
        for y in 10..50 {
            for x in 10..50 {
                img.put_pixel(x, y, Rgba([20, 160, 40, 255]));
            }
        }
        let tile = tile_of(&img, 192);
        let mut canvas = Canvas::new(240, None);
        canvas.draw_tile(&tile, &pose(Preset::Wobble, 4, 240));
        let out = canvas.into_frame();
        let mut opaque = 0;
        for p in out.pixels() {
            match p.0[3] {
                0 => assert_eq!(
                    p.0,
                    [0, 0, 0, 0],
                    "transparent pixels are plain transparent black"
                ),
                255 => {
                    opaque += 1;
                    assert!(p.0[1] > 100 && p.0[0] < 100, "no dark fringe: {:?}", p.0);
                }
                other => panic!("alpha {other} is not allowed in a GIF mask"),
            }
        }
        assert!(opaque > 40 * 40 - 200, "the picture stays: {opaque}");
        assert_eq!(
            out.get_pixel(0, 0).0,
            [0, 0, 0, 0],
            "the margin is transparent"
        );
        assert_eq!(out.get_pixel(120, 120).0, [20, 160, 40, 255]);
    }

    #[test]
    fn the_gif_mask_switches_at_alpha_128_and_keeps_the_straight_colour() {
        // One row of three pixels of one colour with alpha 127 / 128 / 255, placed unmoved.
        let mut row = RgbaImage::new(3, 1);
        for (x, a) in [127u8, 128, 255].into_iter().enumerate() {
            row.put_pixel(x as u32, 0, Rgba([200, 100, 50, a]));
        }
        let tile = tile_of(&row, 192);
        let mut canvas = Canvas::new(240, None);
        canvas.draw_tile(&tile, &Pose::REST);
        let out = canvas.into_frame();
        let (left, top) = ((240 - 3) / 2, (240 - 1) / 2);
        let at = |dx: u32| out.get_pixel(left + dx, top).0;
        assert_eq!(at(0), [0, 0, 0, 0], "alpha 127 is transparent");
        assert_eq!(at(1)[3], 255, "alpha 128 is opaque");
        assert_eq!(at(2), [200, 100, 50, 255]);
        // Un-premultiplied: the colour of the half-transparent pixel is its own, not darkened.
        assert!(
            at(1)[..3]
                .iter()
                .zip([200u8, 100, 50])
                .all(|(g, w)| g.abs_diff(w) <= 1),
            "{:?}",
            at(1)
        );
    }

    #[test]
    fn a_downscaled_transparent_picture_has_no_dark_fringe() {
        // White square on transparent *black*: non-premultiplied resampling would grey the rim.
        let mut img = RgbaImage::from_pixel(600, 600, Rgba([0, 0, 0, 0]));
        for y in 100..500 {
            for x in 100..500 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let tile = tile_of(&img, 288);
        assert_eq!((tile.w, tile.h), (288, 288));
        let mut rim = 0;
        for p in tile.px.chunks_exact(4) {
            let straight = unpremultiply([p[0], p[1], p[2], p[3]]);
            if straight[3] > 0 {
                rim += 1;
                assert!(
                    straight[..3].iter().all(|c| *c >= 253),
                    "grey rim: {straight:?}"
                );
            }
        }
        assert!(rim > 190 * 190, "the square is there");
    }

    #[test]
    fn stars_sit_in_the_corner_margins_and_never_touch_the_picture_box() {
        let size = 360u32;
        let plain = Canvas::new(size, Some(BG)).into_frame();
        let band = (0.1 * f64::from(size)) as u32; // 36 px
        let mut regions = Vec::new();
        for k in 0..4 {
            let mut canvas = Canvas::new(size, Some(BG));
            canvas.draw_star(k);
            let lit = canvas.into_frame();
            let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0, 0);
            let mut gold = 0;
            for (x, y, p) in lit.enumerate_pixels() {
                if p != plain.get_pixel(x, y) {
                    min_x = min_x.min(x);
                    min_y = min_y.min(y);
                    max_x = max_x.max(x);
                    max_y = max_y.max(y);
                    gold += u32::from(p.0 == [255, 196, 0, 255]);
                }
            }
            assert!(gold > 20, "star {k} has a gold core");
            // Inside the 10% band on both axes (it is a corner square), clear of the 80% box.
            let in_band = |lo: u32, hi: u32| hi < band || lo >= size - band;
            assert!(
                in_band(min_x, max_x) && in_band(min_y, max_y),
                "star {k}: {min_x}..{max_x} x {min_y}..{max_y}"
            );
            regions.push((min_x, min_y, max_x, max_y));
            // The star is drawn on the margin colour only: it is clearly visible there.
            assert_ne!(
                lit.get_pixel((min_x + max_x) / 2, (min_y + max_y) / 2).0,
                [BG[0], BG[1], BG[2], 255]
            );
        }
        for a in 0..4 {
            for b in a + 1..4 {
                let (p, q) = (regions[a], regions[b]);
                let overlap = p.0 <= q.2 && q.0 <= p.2 && p.1 <= q.3 && q.1 <= p.3;
                assert!(!overlap, "stars {a} and {b} are at four distinct places");
            }
        }
    }
}
