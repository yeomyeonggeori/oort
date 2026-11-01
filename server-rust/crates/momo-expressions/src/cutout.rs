//! 배경 지우기 (ADR-0218 §8 H5/H9, #4941): take the background off a picture, deterministically.
//!
//! Two ways a cut-out arrives here, and the same function settles both:
//!
//! 1. The model drew it with a transparent background (a model the provider's documentation
//!    names for that). The picture already has an alpha channel with a real share of fully
//!    transparent pixels: it is kept as the model drew it ([`Outcome::Model`]).
//! 2. The model was told to draw the subject on one flat colour (a model with no documented
//!    transparency). The edge-connected part of that colour is erased ([`Outcome::Erased`]).
//!
//! Anything else is left exactly as it is ([`Outcome::Untouched`]): 「지우지 못한 경우는 지우지 않은
//! 그림이 그대로 후보가 된다」. The function never guesses: it erases only when the picture
//! proves it is drawn on one flat colour, and it says which of the three happened.
//!
//! Everything is integer arithmetic over an explicit queue (no recursion, no floats, no
//! randomness), so the same picture gives the same bytes. It runs inside the isolated decoder
//! child, whose limits (192 MiB, 10 s) are the budget; [`MAX_PIXELS`] keeps it far below them.
//!
//! The numbers are the §8 H5 draft, confirmed against the synthetic table in the tests below
//! (never against a person's photograph):
//!
//! | name | value | meaning |
//! |---|---|---|
//! | [`BAND`] | 3 px | width of the edge band the background colour is read from |
//! | [`NEAR`] | 16 | most a channel may differ and still count as the background colour |
//! | [`UNIFORM_MIN_PERCENT`] | 98 % | share of the band that must be that colour, else nothing is erased |
//! | [`ERASED_MIN_PERCENT`]..[`ERASED_MAX_PERCENT`] | 20 %..95 % | erasing less or more than this is not a cut-out |
//! | [`SOFT`] | 48 | channel distance from which a boundary pixel is fully opaque |

use std::collections::VecDeque;

use image::{Rgba, RgbaImage};

pub const BAND: u32 = 3;
pub const NEAR: i32 = 16;
pub const UNIFORM_MIN_PERCENT: u64 = 98;
pub const ERASED_MIN_PERCENT: u64 = 20;
pub const ERASED_MAX_PERCENT: u64 = 95;
pub const SOFT: i32 = 48;
/// A picture is only worked on up to 2048 x 2048. A model returns 1024 or 1536 px; anything
/// larger is not one, and is left alone.
pub const MAX_PIXELS: u64 = 4_194_304;
/// A picture smaller than this has no band to read a colour from.
pub const MIN_EDGE: u32 = 8;
/// The share of fully transparent pixels from which a picture counts as already cut out.
pub const MODEL_TRANSPARENT_MIN_PERCENT: u64 = 2;
/// Alpha from which a pixel is part of the subject when the crop is measured.
const SUBJECT_ALPHA: u8 = 16;
/// Room kept around the subject, as a percentage of its longer side.
const MARGIN_PERCENT: u32 = 4;

/// What happened to the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Outcome {
    /// It already had a transparent background; only the crop was applied.
    Model,
    /// The flat background was erased from its edges inward.
    Erased,
    /// Nothing was erased. The picture is exactly the input.
    Untouched,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Outcome::Model => "model",
            Outcome::Erased => "erased",
            Outcome::Untouched => "unchanged",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Cut {
    pub image: RgbaImage,
    pub outcome: Outcome,
}

fn untouched(image: &RgbaImage) -> Cut {
    Cut {
        image: image.clone(),
        outcome: Outcome::Untouched,
    }
}

/// Largest channel difference between `pixel` and the colour `c`.
fn distance(pixel: &Rgba<u8>, c: [u8; 3]) -> i32 {
    (0..3)
        .map(|i| (i32::from(pixel.0[i]) - i32::from(c[i])).abs())
        .max()
        .unwrap_or(0)
}

/// Is this pixel part of the background: nearly transparent, or the background colour.
fn background_like(pixel: &Rgba<u8>, c: [u8; 3]) -> bool {
    pixel.0[3] < 128 || distance(pixel, c) <= NEAR
}

/// Every pixel of the outermost [`BAND`] pixels, once.
fn band(width: u32, height: u32) -> impl Iterator<Item = (u32, u32)> {
    (0..height).flat_map(move |y| {
        (0..width).filter_map(move |x| {
            let edge = x < BAND || y < BAND || x >= width - BAND || y >= height - BAND;
            edge.then_some((x, y))
        })
    })
}

/// Per-channel median of the band (the same definition as the motion assembler's margin colour,
/// over a wider ring). `None` when the band is mostly transparent.
fn band_colour(image: &RgbaImage) -> Option<[u8; 3]> {
    let (w, h) = image.dimensions();
    let mut channels: [Vec<u8>; 4] = Default::default();
    for (x, y) in band(w, h) {
        let pixel = image.get_pixel(x, y).0;
        for (channel, value) in channels.iter_mut().zip(pixel) {
            channel.push(value);
        }
    }
    let mut median = [0u8; 4];
    for (m, channel) in median.iter_mut().zip(channels.iter_mut()) {
        channel.sort_unstable();
        *m = channel[channel.len() / 2];
    }
    (median[3] >= 128).then_some([median[0], median[1], median[2]])
}

/// Crop to the pixels that belong to the subject, with a small margin.
fn crop_to_subject(image: &RgbaImage) -> Option<RgbaImage> {
    let (w, h) = image.dimensions();
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0u32, 0u32);
    for (x, y, pixel) in image.enumerate_pixels() {
        if pixel.0[3] >= SUBJECT_ALPHA {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if x0 > x1 || y0 > y1 {
        return None;
    }
    let margin = ((x1 - x0 + 1).max(y1 - y0 + 1) * MARGIN_PERCENT / 100).max(1);
    let left = x0.saturating_sub(margin);
    let top = y0.saturating_sub(margin);
    let right = (x1 + margin).min(w - 1);
    let bottom = (y1 + margin).min(h - 1);
    Some(image::imageops::crop_imm(image, left, top, right - left + 1, bottom - top + 1).to_image())
}

/// Take the background off `image`. See the module docs for the three outcomes.
pub fn cut_out(image: &RgbaImage) -> Cut {
    let (w, h) = image.dimensions();
    if w < MIN_EDGE || h < MIN_EDGE || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return untouched(image);
    }
    let total = u64::from(w) * u64::from(h);

    // 1. The model already cut it out.
    let transparent = image.pixels().filter(|pixel| pixel.0[3] == 0).count() as u64;
    if transparent * 100 >= total * MODEL_TRANSPARENT_MIN_PERCENT {
        return match crop_to_subject(image) {
            Some(image) => Cut {
                image,
                outcome: Outcome::Model,
            },
            None => untouched(image),
        };
    }

    // 2. One flat colour all around the edge, or nothing is erased.
    let Some(c) = band_colour(image) else {
        return untouched(image);
    };
    let (mut near, mut count) = (0u64, 0u64);
    for (x, y) in band(w, h) {
        count += 1;
        if background_like(image.get_pixel(x, y), c) {
            near += 1;
        }
    }
    if near * 100 < count * UNIFORM_MIN_PERCENT {
        return untouched(image);
    }

    // 3. The background is what the edge's colour reaches through 4-connected neighbours.
    let width = w as usize;
    let index = |x: u32, y: u32| y as usize * width + x as usize;
    let mut background = vec![false; width * h as usize];
    let mut queue: VecDeque<(u32, u32)> = VecDeque::new();
    let take = |x: u32, y: u32, background: &mut Vec<bool>, queue: &mut VecDeque<(u32, u32)>| {
        let i = index(x, y);
        if !background[i] && background_like(image.get_pixel(x, y), c) {
            background[i] = true;
            queue.push_back((x, y));
        }
    };
    for x in 0..w {
        take(x, 0, &mut background, &mut queue);
        take(x, h - 1, &mut background, &mut queue);
    }
    for y in 0..h {
        take(0, y, &mut background, &mut queue);
        take(w - 1, y, &mut background, &mut queue);
    }
    while let Some((x, y)) = queue.pop_front() {
        if x > 0 {
            take(x - 1, y, &mut background, &mut queue);
        }
        if x + 1 < w {
            take(x + 1, y, &mut background, &mut queue);
        }
        if y > 0 {
            take(x, y - 1, &mut background, &mut queue);
        }
        if y + 1 < h {
            take(x, y + 1, &mut background, &mut queue);
        }
    }
    let erased = background.iter().filter(|b| **b).count() as u64;
    if erased * 100 < total * ERASED_MIN_PERCENT || erased * 100 > total * ERASED_MAX_PERCENT {
        return untouched(image);
    }

    // 4. Erase it. The one layer of subject pixels beside the background keeps part of its
    //    opacity, and its colour has the background taken back out of it (less halo).
    let mut out = image.clone();
    for y in 0..h {
        for x in 0..w {
            let i = index(x, y);
            if background[i] {
                out.put_pixel(x, y, Rgba([0, 0, 0, 0]));
                continue;
            }
            let beside = (x > 0 && background[index(x - 1, y)])
                || (x + 1 < w && background[index(x + 1, y)])
                || (y > 0 && background[index(x, y - 1)])
                || (y + 1 < h && background[index(x, y + 1)]);
            if !beside {
                continue;
            }
            let pixel = image.get_pixel(x, y).0;
            let d = distance(image.get_pixel(x, y), c);
            let alpha = (((d - NEAR).clamp(0, SOFT - NEAR) * 255) / (SOFT - NEAR)) as u32;
            if alpha == 0 || alpha >= 255 {
                continue;
            }
            let rgb: [u8; 3] = std::array::from_fn(|k| {
                let value = (i32::from(pixel[k]) * 255 - i32::from(c[k]) * (255 - alpha as i32))
                    / alpha as i32;
                value.clamp(0, 255) as u8
            });
            let opacity = (u32::from(pixel[3]) * alpha / 255) as u8;
            out.put_pixel(x, y, Rgba([rgb[0], rgb[1], rgb[2], opacity]));
        }
    }
    match crop_to_subject(&out) {
        Some(cropped) => Cut {
            image: cropped,
            outcome: Outcome::Erased,
        },
        None => untouched(image),
    }
}

#[cfg(test)]
mod tests;
