//! Input checks for the still source picture (ADR-0218 G3.2: D3 "정지 입력").
//!
//! The functions between the markers are a verbatim mirror of the private input checks of
//! [`crate::media`] (`gif_spec`, `no_apng`, `dimensions`, `preflight`), with the error type
//! renamed. They run before any codec constructor because some constructors allocate by the
//! picture's own claim (an inner WebP size, a huge GIF sub-rectangle). `media::decode` cannot
//! be used as the gate instead: besides the input rules it also refuses a picture whose
//! 512 px PNG rendition would exceed 1 MiB, and a noisy picture is a valid source. The
//! `mirrors_the_input_rules_of_media_decode` test compares both on a corpus so a drift shows.
use image::ImageFormat;

/// The input is refused (format, structure, size or animation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Bad;

// ---- mirror of media.rs: begin ------------------------------------------------------------
/// Container preflight for GIF: count ALL images and delays without allocating
/// frames. Reject oversized subrects before the decoder allocates its buffer.
pub(super) fn gif_spec(b: &[u8]) -> Result<(u32, u32, u32, u32), Bad> {
    let bad = || Bad;
    if b.len() < 13 {
        return Err(bad());
    }
    let u16at = |p| u16::from_le_bytes([b[p], b[p + 1]]) as u32;
    let (w, h) = (u16at(6), u16at(8));
    if w == 0 || h == 0 || w > 4096 || h > 4096 || u64::from(w) * u64::from(h) > 16_000_000 {
        return Err(bad());
    }
    let mut p = 13
        + if b[10] & 128 != 0 {
            3 * (1usize << ((b[10] & 7) + 1))
        } else {
            0
        };
    let (mut frames, mut ms, mut delay) = (0u32, 0u32, 20u32);
    fn blocks(b: &[u8], p: &mut usize) -> Result<(), Bad> {
        loop {
            let n = *b.get(*p).ok_or(Bad)? as usize;
            *p += 1;
            if n == 0 {
                return Ok(());
            }
            *p = p.checked_add(n).filter(|p| *p <= b.len()).ok_or(Bad)?;
        }
    }
    loop {
        let marker = *b.get(p).ok_or_else(bad)?;
        p += 1;
        match marker {
            0x3b => break,
            0x21 => {
                let label = *b.get(p).ok_or_else(bad)?;
                p += 1;
                if label == 0xf9 {
                    if b.get(p) != Some(&4) || b.get(p + 5) != Some(&0) {
                        return Err(bad());
                    }
                    delay = u16at(p + 2).saturating_mul(10).max(20);
                }
                blocks(b, &mut p)?;
            }
            0x2c => {
                if p + 9 > b.len() {
                    return Err(bad());
                }
                let (x, y, fw, fh) = (u16at(p), u16at(p + 2), u16at(p + 4), u16at(p + 6));
                if fw == 0 || fh == 0 || x + fw > w || y + fh > h {
                    return Err(bad());
                }
                let flags = b[p + 8];
                p += 9;
                if flags & 128 != 0 {
                    p += 3 * (1usize << ((flags & 7) + 1));
                }
                p += 1; // LZW code width; decoder validates it.
                blocks(b, &mut p)?;
                frames += 1;
                ms = ms.checked_add(delay).ok_or_else(bad)?;
                delay = 20;
                if frames > 100
                    || (frames > 1 && (w > 512 || h > 512 || ms > 10000))
                    || u64::from(w) * u64::from(h) * u64::from(frames) > 32_000_000
                {
                    return Err(bad());
                }
            }
            _ => return Err(bad()),
        }
    }
    if frames == 0 || (frames > 1 && ms > 10000) {
        return Err(bad());
    }
    Ok((w, h, frames, ms))
}

pub(super) fn no_apng(b: &[u8]) -> Result<(), Bad> {
    let mut p = 8usize;
    while p + 12 <= b.len() {
        let n = u32::from_be_bytes(b[p..p + 4].try_into().map_err(|_| Bad)?) as usize;
        if &b[p + 4..p + 8] == b"acTL" {
            return Err(Bad);
        }
        let end = p
            .checked_add(n)
            .and_then(|p| p.checked_add(12))
            .filter(|p| *p <= b.len())
            .ok_or(Bad)?;
        if &b[p + 4..p + 8] == b"IEND" {
            break;
        }
        p = end;
    }
    Ok(())
}

pub(super) fn dimensions(w: u32, h: u32) -> Result<(u32, u32), Bad> {
    if w == 0 || h == 0 || w > 4096 || h > 4096 || u64::from(w) * u64::from(h) > 16_000_000 {
        Err(Bad)
    } else {
        Ok((w, h))
    }
}

/// This runs BEFORE any codec constructor (some constructors allocate). In
/// particular, image-webp checks VP8X/VP8 agreement only AFTER VP8 allocation.
pub(super) fn preflight(format: ImageFormat, b: &[u8]) -> Result<(u32, u32), Bad> {
    match format {
        ImageFormat::Png => {
            if b.len() < 33 || &b[12..16] != b"IHDR" {
                return Err(Bad);
            }
            dimensions(
                u32::from_be_bytes(b[16..20].try_into().map_err(|_| Bad)?),
                u32::from_be_bytes(b[20..24].try_into().map_err(|_| Bad)?),
            )
        }
        ImageFormat::Jpeg => {
            let mut p = 2;
            while p < b.len() {
                if b[p] != 0xff {
                    return Err(Bad);
                }
                while b.get(p) == Some(&0xff) {
                    p += 1;
                }
                let marker = *b.get(p).ok_or(Bad)?;
                p += 1;
                if marker == 0xda || marker == 0xd9 {
                    return Err(Bad);
                }
                if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
                    continue;
                }
                if p + 2 > b.len() {
                    return Err(Bad);
                }
                let len = u16::from_be_bytes([b[p], b[p + 1]]) as usize;
                if len < 2 || p + len > b.len() {
                    return Err(Bad);
                }
                if [
                    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
                ]
                .contains(&marker)
                {
                    if len < 8 {
                        return Err(Bad);
                    }
                    return dimensions(
                        u16::from_be_bytes([b[p + 5], b[p + 6]]) as u32,
                        u16::from_be_bytes([b[p + 3], b[p + 4]]) as u32,
                    );
                }
                p += len;
            }
            Err(Bad)
        }
        ImageFormat::WebP => {
            if b.len() < 12 {
                return Err(Bad);
            }
            let riff = u32::from_le_bytes(b[4..8].try_into().map_err(|_| Bad)?) as usize;
            let end = riff.checked_add(8).filter(|p| *p <= b.len()).ok_or(Bad)?;
            let mut p = 12;
            let (mut outer, mut inner) = (None, None);
            while p + 8 <= end {
                let kind = &b[p..p + 4];
                let len = u32::from_le_bytes(b[p + 4..p + 8].try_into().map_err(|_| Bad)?) as usize;
                let next = p
                    .checked_add(8)
                    .and_then(|p| p.checked_add(len))
                    .filter(|p| *p <= end)
                    .ok_or(Bad)?;
                let data = &b[p + 8..next];
                match kind {
                    b"ANIM" | b"ANMF" => return Err(Bad),
                    b"VP8X" => {
                        if len != 10 || data[0] & 2 != 0 || outer.is_some() {
                            return Err(Bad);
                        }
                        let u24 =
                            |p| u32::from_le_bytes([data[p], data[p + 1], data[p + 2], 0]) + 1;
                        outer = Some(dimensions(u24(4), u24(7))?);
                    }
                    b"VP8 " => {
                        if len < 10
                            || inner.is_some()
                            || &data[3..6] != b"\x9d\x01\x2a"
                            || data[0] & 1 != 0
                        {
                            return Err(Bad);
                        }
                        inner = Some(dimensions(
                            u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                            u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                        )?);
                    }
                    b"VP8L" => {
                        if len < 5 || inner.is_some() || data[0] != 0x2f {
                            return Err(Bad);
                        }
                        let bits = u32::from_le_bytes(data[1..5].try_into().map_err(|_| Bad)?);
                        if bits >> 29 != 0 {
                            return Err(Bad);
                        }
                        inner = Some(dimensions(
                            (bits & 0x3fff) + 1,
                            ((bits >> 14) & 0x3fff) + 1,
                        )?);
                    }
                    _ => {}
                }
                p = next.checked_add(len & 1).ok_or(Bad)?;
            }
            let inner = inner.ok_or(Bad)?;
            if p != end || outer.is_some_and(|outer| outer != inner) {
                return Err(Bad);
            }
            Ok(inner)
        }
        ImageFormat::Gif => {
            let (w, h, _, _) = gif_spec(b)?;
            Ok((w, h))
        }
        _ => Err(Bad),
    }
}

// ---- mirror of media.rs: end --------------------------------------------------------------

/// What `media::decode` decides about the input before it builds a codec: video containers,
/// formats other than PNG/JPEG/WebP/GIF, APNG, the per-format structure and size bounds, and a
/// GIF with more than one image. Returns the format and the picture's own claimed size.
pub(super) fn check(bytes: &[u8]) -> Result<(ImageFormat, (u32, u32)), Bad> {
    if bytes.get(4..8) == Some(b"ftyp") || bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Err(Bad); // a video is not a picture to animate
    }
    let format = image::guess_format(bytes).map_err(|_| Bad)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(Bad);
    }
    if format == ImageFormat::Png {
        no_apng(bytes)?;
    }
    let size = preflight(format, bytes)?;
    if format == ImageFormat::Gif && gif_spec(bytes)?.2 > 1 {
        return Err(Bad); // an animated GIF is not a still picture
    }
    Ok((format, size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media;
    use image::{DynamicImage, Rgba, RgbaImage};
    use std::io::Cursor;
    use std::time::{Duration, Instant};

    fn encoded(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }
    fn picture(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(x * 7) as u8, (y * 5) as u8, 90, 255]))
    }
    fn png(w: u32, h: u32) -> Vec<u8> {
        encoded(DynamicImage::ImageRgba8(picture(w, h)), ImageFormat::Png)
    }
    /// A PNG whose header claims a size it does not have.
    fn claiming(w: u32, h: u32) -> Vec<u8> {
        let mut bytes = png(8, 8);
        bytes[16..20].copy_from_slice(&w.to_be_bytes());
        bytes[20..24].copy_from_slice(&h.to_be_bytes());
        bytes
    }

    #[test]
    fn mirrors_the_input_rules_of_media_decode() {
        use base64::Engine;
        let apng = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAABAAAAALQt6aAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYII=").unwrap();
        let animated_gif = {
            let mut out = Vec::new();
            {
                let mut e = image::codecs::gif::GifEncoder::new(&mut out);
                for _ in 0..2 {
                    e.encode_frame(image::Frame::from_parts(
                        picture(8, 8),
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(100, 1),
                    ))
                    .unwrap();
                }
            }
            out
        };
        let single_gif = encoded(DynamicImage::ImageRgba8(picture(8, 8)), ImageFormat::Gif);
        let jpeg = encoded(
            DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(picture(32, 16)).to_rgb8()),
            ImageFormat::Jpeg,
        );
        let webp = encoded(DynamicImage::ImageRgba8(picture(20, 10)), ImageFormat::WebP);
        let webp_bomb = hex::decode("524946462800000057454250565038580a00000000000000000000000000565038200a0000001000009d012aff3fff3f").unwrap();
        let good = png(40, 30);
        // (name, bytes, accepted as a still picture). Only what is decided from the container before
        // a codec exists: a JPEG cut off after its header passes here and fails in the decode
        // (see `assemble::tests` / tests/assemble.rs for that case).
        let corpus: Vec<(&str, Vec<u8>, bool)> = vec![
            ("png", png(40, 30), true),
            ("png 4096 wide", png(4096, 1), true),
            ("png 4096 tall", png(1, 4096), true),
            ("jpeg", jpeg.clone(), true),
            ("webp", webp, true),
            ("single-frame gif", single_gif, true),
            ("empty", vec![], false),
            ("text", b"not an image".to_vec(), false),
            ("svg", b"<svg/>".to_vec(), false),
            ("apng", apng, false),
            ("animated gif", animated_gif, false),
            ("animated webp", b"RIFF0000WEBPANIM".to_vec(), false),
            ("webp inner-size bomb", webp_bomb, false),
            (
                "mp4",
                vec![0, 0, 0, 12, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm'],
                false,
            ),
            ("matroska", vec![0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0], false),
            ("png 4097 wide", claiming(4097, 1), false),
            ("png 4097 tall", claiming(1, 4097), false),
            ("png over 16 MP", claiming(4001, 4001), false),
            ("png 0 wide", claiming(0, 5), false),
            ("truncated png", good[..good.len() / 2].to_vec(), false),
        ];
        let end = || Instant::now() + Duration::from_secs(10);
        for (name, bytes, accepted) in corpus {
            let mine = check(&bytes).is_ok();
            // `decode` accepts an animated GIF as an animation; as a source it is not a still.
            let theirs = media::decode(&bytes, end()).is_ok_and(|p| p.large.info.frame_count == 1);
            assert_eq!(mine, accepted, "{name}: the assembly input check");
            assert_eq!(
                theirs, accepted,
                "{name}: media::decode, the rule being mirrored"
            );
        }
    }

    #[test]
    fn a_noisy_picture_passes_the_input_check_though_media_decode_refuses_its_renditions() {
        let mut seed = 0x719d_2901u32;
        let noise = RgbaImage::from_fn(512, 512, |_, _| {
            let mut px = [0u8; 4];
            for c in &mut px {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *c = seed as u8;
            }
            Rgba(px)
        });
        let bytes = encoded(DynamicImage::ImageRgba8(noise), ImageFormat::Png);
        assert!(bytes.len() > 1024 * 1024, "{}", bytes.len());
        assert!(check(&bytes).is_ok());
        assert!(media::decode(&bytes, Instant::now() + Duration::from_secs(10)).is_err());
    }
}
