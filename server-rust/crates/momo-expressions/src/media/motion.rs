//! The GIF half of the D3 re-encode (#5455). What a viewer sees does not change: the same frames,
//! the same delays, four plays, and the same rule that any visible pixel is opaque. What changes is
//! how the bytes carry it.
//!
//! The old encoder trained a palette for every frame and wrote every frame as the whole canvas. This
//! one writes each frame as **the box around its visible pixels**, cleared before the next frame, and
//! picks the palette per animation:
//!
//! 1. the animation's colours all fit one table: **one global table with exactly those colours**
//!    (nothing is quantised; a GIF made with one shared palette lands here);
//! 2. they do not, but a frame fits a table by itself: **that frame keeps its own exact table**, as
//!    the old encoder also did (a GIF from a site with per-frame palettes lands here);
//! 3. a frame has more colours than a table holds (a large picture shrunk to 128 px blends colours):
//!    those frames share **one table trained on all of them**, instead of one rough table each.
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use color_quant::NeuQuant;
use gif::{DisposalMethod, Encoder, Frame, Repeat};
use image::RgbaImage;

use super::{Output, Rejected};

/// How many visible pixels train a palette. The network's work grows with this and its result
/// stops improving well before it.
const SAMPLE_PIXELS: usize = 1 << 16;
/// NeuQuant's quality knob: 1 is best and slowest, 30 fastest. The old encoder used 30.
const TRAINING_SPEED: i32 = 3;
/// Colours remembered between pixels and palette entries. Bounded so a noisy picture cannot grow it.
const MEMO_MAX: usize = 1 << 17;
/// A GIF palette holds 256 entries.
const ENTRIES: usize = 256;

fn pack([r, g, b]: [u8; 3]) -> u32 {
    u32::from(r) << 16 | u32::from(g) << 8 | u32::from(b)
}

/// What one frame uses: its distinct visible colours (counting stops past a table's worth), and
/// whether any pixel of it is see-through.
fn colours_of(frame: &RgbaImage) -> (HashSet<u32>, bool, bool) {
    let (mut colors, mut wide, mut clear) = (HashSet::new(), false, false);
    for p in frame.as_raw().chunks_exact(4) {
        if p[3] == 0 {
            clear = true;
        } else if !wide {
            colors.insert(pack([p[0], p[1], p[2]]));
            if colors.len() > ENTRIES {
                wide = true;
                colors = HashSet::new();
            }
        }
    }
    (colors, wide, clear)
}

/// First pass over the frames of one output size: which colours each frame and the animation use,
/// and a fair sample of the colours of the frames that do not fit a table, to train one on.
pub(super) struct Census {
    union: HashSet<u32>,
    /// More colours than a table holds have been seen over the whole animation.
    union_wide: bool,
    /// Some pixel somewhere is see-through, so a table needs one entry that means "nothing".
    clear: bool,
    /// Per frame: its colours (and its entry for "nothing") fit a table by themselves.
    fits: Vec<bool>,
    stride: usize,
    seen: usize,
    sample: Vec<u8>,
    size: (u16, u16),
}

impl Census {
    pub(super) fn new() -> Self {
        Self {
            union: HashSet::new(),
            union_wide: false,
            clear: false,
            fits: Vec::new(),
            stride: 1,
            seen: 0,
            sample: Vec::new(),
            size: (0, 0),
        }
    }

    pub(super) fn add(&mut self, frame: &RgbaImage) {
        self.size = (frame.width() as u16, frame.height() as u16);
        let (colors, wide, clear) = colours_of(frame);
        self.clear |= clear;
        let fits = !wide && colors.len() + usize::from(clear) <= ENTRIES;
        self.fits.push(fits);
        if wide {
            self.union_wide = true;
            self.union = HashSet::new();
        } else if !self.union_wide {
            self.union.extend(colors);
            if self.union.len() > ENTRIES {
                self.union_wide = true;
                self.union = HashSet::new();
            }
        }
        if !fits {
            for p in frame.as_raw().chunks_exact(4).filter(|p| p[3] != 0) {
                self.take(p);
            }
        }
    }

    /// One visible pixel for the training sample: every `stride`-th, and when the sample is full
    /// every second kept one is dropped and the stride doubles, so the sample stays an even slice
    /// of every frame however many there are.
    fn take(&mut self, p: &[u8]) {
        if self.seen.is_multiple_of(self.stride) {
            if self.sample.len() == SAMPLE_PIXELS * 4 {
                self.sample = self
                    .sample
                    .chunks_exact(4)
                    .step_by(2)
                    .flatten()
                    .copied()
                    .collect();
                self.stride *= 2;
            }
            if self.seen.is_multiple_of(self.stride) {
                self.sample.extend_from_slice(&[p[0], p[1], p[2], 255]);
            }
        }
        self.seen += 1;
    }

    pub(super) fn finish(self) -> Palette {
        let room = ENTRIES - usize::from(self.clear);
        let everyone = !self.union_wide && self.union.len() <= room;
        let local: Vec<bool> = if everyone {
            vec![false; self.fits.len()]
        } else {
            self.fits.clone()
        };
        let global = if everyone {
            let mut colors: Vec<u32> = self.union.into_iter().collect();
            colors.sort_unstable();
            Some(Table::exact(&colors, self.clear))
        } else if local.iter().any(|own| !own) {
            Some(Table::trained(room, &self.sample, self.clear))
        } else {
            None
        };
        Palette {
            global,
            local,
            size: self.size,
        }
    }
}

/// A table of colours, the entry that means "nothing", and the way a pixel finds its entry.
struct Table {
    /// `r,g,b` per entry; the entry for "nothing" (when there is one) is last and never shown.
    rgb: Vec<u8>,
    transparent: Option<u8>,
    /// None when the table is exactly the colours counted: every pixel is then a hit in `memo`.
    quantizer: Option<NeuQuant>,
    memo: HashMap<u32, u8>,
}

impl Table {
    fn exact(colors: &[u32], clear: bool) -> Self {
        let mut rgb = Vec::with_capacity(colors.len() * 3 + 3);
        let mut memo = HashMap::new();
        for (i, c) in colors.iter().enumerate() {
            rgb.extend_from_slice(&[(c >> 16) as u8, (c >> 8) as u8, *c as u8]);
            memo.insert(*c, i as u8);
        }
        Self::with_nothing(rgb, None, memo, clear)
    }

    fn trained(room: usize, sample: &[u8], clear: bool) -> Self {
        let net = NeuQuant::new(TRAINING_SPEED, room, sample);
        let rgb = net.color_map_rgb();
        Self::with_nothing(rgb, Some(net), HashMap::new(), clear)
    }

    fn with_nothing(
        mut rgb: Vec<u8>,
        quantizer: Option<NeuQuant>,
        memo: HashMap<u32, u8>,
        clear: bool,
    ) -> Self {
        let transparent = clear.then(|| {
            rgb.extend_from_slice(&[0, 0, 0]);
            (rgb.len() / 3 - 1) as u8
        });
        Self {
            rgb,
            transparent,
            quantizer,
            memo,
        }
    }

    fn index(&mut self, rgb: [u8; 3]) -> u8 {
        let key = pack(rgb);
        if let Some(i) = self.memo.get(&key) {
            return *i;
        }
        let i = match &self.quantizer {
            Some(net) => net.index_of(&[rgb[0], rgb[1], rgb[2], 255]) as u8,
            // Not a colour the first pass saw: the nearest entry, never a panic.
            None => self.nearest(rgb),
        };
        if self.memo.len() < MEMO_MAX {
            self.memo.insert(key, i);
        }
        i
    }

    fn nearest(&self, rgb: [u8; 3]) -> u8 {
        let visible = self.rgb.len() / 3 - usize::from(self.transparent.is_some());
        let distance = |entry: &[u8]| -> i32 {
            (0..3)
                .map(|c| (i32::from(entry[c]) - i32::from(rgb[c])).pow(2))
                .sum()
        };
        self.rgb
            .chunks_exact(3)
            .take(visible)
            .enumerate()
            .min_by_key(|(_, entry)| distance(entry))
            .map_or(0, |(i, _)| i as u8)
    }
}

/// What one output size paints with: the table shared by the frames that have none of their own,
/// and which frames bring their own exact table.
pub(super) struct Palette {
    global: Option<Table>,
    local: Vec<bool>,
    pub(super) size: (u16, u16),
}

/// One output GIF being written: the header and global table up front, then a box per frame.
pub(super) struct Strip {
    encoder: Encoder<Output>,
    palette: Palette,
    indices: Vec<u8>,
    next: usize,
}

impl Strip {
    pub(super) fn new(out: Output, palette: Palette) -> Result<Self, Rejected> {
        let (width, height) = palette.size;
        let header = palette.global.as_ref().map_or(&[][..], |t| &t.rgb[..]);
        let mut encoder =
            Encoder::new(out, width, height, header).map_err(|_| Rejected::Invalid)?;
        // NETSCAPE repeat count is repetitions AFTER the initial pass: 3+1=4.
        encoder
            .set_repeat(Repeat::Finite(3))
            .map_err(|_| Rejected::Invalid)?;
        Ok(Self {
            encoder,
            palette,
            indices: Vec::new(),
            next: 0,
        })
    }

    pub(super) fn size(&self) -> (u32, u32) {
        (
            u32::from(self.palette.size.0),
            u32::from(self.palette.size.1),
        )
    }

    /// The frame as the box around its visible pixels. `delay` is in hundredths of a second.
    pub(super) fn push(&mut self, image: &RgbaImage, delay: u16) -> Result<(), Rejected> {
        let (w, h) = (image.width() as usize, image.height() as usize);
        if (w, h) != (self.palette.size.0.into(), self.palette.size.1.into()) {
            return Err(Rejected::Invalid);
        }
        let own = self.palette.local.get(self.next).copied().unwrap_or(false);
        self.next += 1;
        let mut own_table;
        let table = if own {
            let (colors, _, clear) = colours_of(image);
            let mut colors: Vec<u32> = colors.into_iter().collect();
            colors.sort_unstable();
            own_table = Table::exact(&colors, clear);
            &mut own_table
        } else {
            self.palette.global.as_mut().ok_or(Rejected::Invalid)?
        };
        let nothing = table.transparent;
        self.indices.clear();
        // (left, top, right, bottom) of the visible pixels, inclusive.
        let mut visible: Option<(usize, usize, usize, usize)> = None;
        for (y, row) in image.as_raw().chunks_exact(w * 4).enumerate() {
            for (x, p) in row.chunks_exact(4).enumerate() {
                if p[3] == 0 {
                    self.indices.push(nothing.ok_or(Rejected::Invalid)?);
                    continue;
                }
                self.indices.push(table.index([p[0], p[1], p[2]]));
                visible = Some(match visible {
                    None => (x, y, x, y),
                    Some((l, t, r, b)) => (l.min(x), t.min(y), r.max(x), b.max(y)),
                });
            }
        }
        let (left, top, width, height, buffer) = match (visible, nothing) {
            (Some((l, t, r, b)), _) => {
                let (bw, bh) = (r - l + 1, b - t + 1);
                let mut buffer = Vec::with_capacity(bw * bh);
                for y in t..=b {
                    buffer.extend_from_slice(&self.indices[y * w + l..=y * w + r]);
                }
                (l, t, bw, bh, buffer)
            }
            // Nothing to see in this frame: one see-through pixel keeps the frame and its delay.
            (None, Some(nothing)) => (0, 0, 1, 1, vec![nothing]),
            (None, None) => return Err(Rejected::Invalid),
        };
        let frame = Frame {
            delay,
            dispose: DisposalMethod::Background,
            transparent: nothing,
            left: left as u16,
            top: top as u16,
            width: width as u16,
            height: height as u16,
            palette: own.then(|| table.rgb.clone()),
            buffer: Cow::Owned(buffer),
            ..Frame::default()
        };
        self.encoder
            .write_frame(&frame)
            .map_err(|_| Rejected::Invalid)
    }

    /// The finished file: the trailer is written and the bytes handed back.
    pub(super) fn finish(self) -> Result<Vec<u8>, Rejected> {
        self.encoder
            .into_inner()
            .map(|out| out.data)
            .map_err(|_| Rejected::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(side: u32, color: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(side, side, image::Rgba(color))
    }

    /// A frame of `n` distinct colours, `offset` apart from the next frame's.
    fn many(n: u32, offset: u32) -> RgbaImage {
        RgbaImage::from_fn(n, 1, |x, _| {
            let v = x + offset;
            image::Rgba([(v >> 8) as u8, v as u8, 9, 255])
        })
    }

    /// 200 frames of 4,096 pixels that do not fit a table is 12 times the sample cap. The sample
    /// stays at the cap and still holds pixels of the very last frame: it is an even slice of the
    /// whole animation, not its first seconds.
    #[test]
    fn the_sample_stays_capped_and_still_reaches_the_last_frame() {
        let mut census = Census::new();
        for f in 0..199u32 {
            census.add(&RgbaImage::from_fn(64, 64, |x, y| {
                image::Rgba([(f % 256) as u8, x as u8 * 4, y as u8 * 4, 255])
            }));
        }
        // The last frame has a red no earlier frame has (they run 0..199).
        census.add(&RgbaImage::from_fn(64, 64, |x, y| {
            image::Rgba([250, x as u8 * 4, y as u8 * 4, 255])
        }));
        assert!(census.sample.len() <= SAMPLE_PIXELS * 4);
        assert!(census.stride > 1, "the stride doubled as the sample filled");
        let last = census
            .sample
            .chunks_exact(4)
            .filter(|p| p[0] == 250)
            .count();
        assert!(last > 0, "no sample came from the last frame");
    }

    /// An exact table answers for the colours it was counted from. A colour it never saw (it
    /// cannot happen between two passes over the same frames) gets the nearest entry, not a panic.
    #[test]
    fn an_exact_table_is_exact_and_a_stranger_gets_the_nearest_entry() {
        let mut census = Census::new();
        let mut frame = flat(2, [0, 0, 0, 0]);
        frame.put_pixel(0, 0, image::Rgba([10, 20, 30, 255]));
        frame.put_pixel(1, 0, image::Rgba([200, 100, 50, 255]));
        census.add(&frame);
        let palette = census.finish();
        assert_eq!(palette.local, vec![false]);
        let mut table = palette.global.unwrap();
        assert_eq!(table.rgb.len() / 3, 3, "two colours and the nothing entry");
        assert_eq!(table.transparent, Some(2));
        let (a, b) = (table.index([10, 20, 30]), table.index([200, 100, 50]));
        assert_ne!(a, b);
        assert_eq!(&table.rgb[usize::from(a) * 3..][..3], &[10, 20, 30]);
        assert_eq!(&table.rgb[usize::from(b) * 3..][..3], &[200, 100, 50]);
        assert_eq!(table.index([14, 22, 31]), a, "the nearest entry");
        assert_eq!(table.index([190, 110, 60]), b, "the nearest entry");
    }

    /// Which of the three ways each animation is written, from its colours alone.
    #[test]
    fn the_palette_is_chosen_from_the_colours_of_the_whole_and_of_each_frame() {
        // One table for everything: 120 + 120 colours, 20 of them shared, no see-through pixel.
        let mut together = Census::new();
        together.add(&many(120, 0));
        together.add(&many(120, 100));
        let palette = together.finish();
        assert_eq!(palette.local, vec![false, false]);
        assert_eq!(palette.global.as_ref().unwrap().rgb.len() / 3, 220);
        // Together too many, each by itself fine: every frame keeps its own exact table.
        let mut apart = Census::new();
        apart.add(&many(200, 0));
        apart.add(&many(200, 1000));
        let palette = apart.finish();
        assert_eq!(palette.local, vec![true, true]);
        assert!(palette.global.is_none(), "nobody needs a shared table");
        // A frame past a table's worth is trained on; the frame that fits keeps its own.
        let mut mixed = Census::new();
        mixed.add(&many(200, 0));
        mixed.add(&many(300, 2000));
        let palette = mixed.finish();
        assert_eq!(palette.local, vec![true, false]);
        assert!(palette.global.unwrap().quantizer.is_some());
    }
}
