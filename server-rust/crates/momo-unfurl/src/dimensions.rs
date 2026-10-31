//! Read a picture's size from its header (ADR-0170 amendment D12).
//!
//! The image proxy already holds the bytes when a card has no declared size. Reading two integers
//! out of the first bytes is all that is needed, so there is no image decoder here: nothing in
//! this file ever decodes pixels, allocates by a size the file claims, or reads past the slice
//! (`get` everywhere; an input that is too short or malformed is simply "not measured").
//! PNG, GIF, JPEG and WebP are read. AVIF and the rest are not.

use crate::parse::IMAGE_DIMENSION_MAX;

/// `(width, height)` in pixels, each 1..=[`IMAGE_DIMENSION_MAX`], or `None`.
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let (width, height) = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        png(bytes)?
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        gif(bytes)?
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        jpeg(bytes)?
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12).is_some_and(|tag| tag == b"WEBP") {
        webp(bytes)?
    } else {
        return None;
    };
    let range = 1..=IMAGE_DIMENSION_MAX;
    (range.contains(&width) && range.contains(&height)).then_some((width, height))
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    let pair = bytes.get(at..at + 2)?;
    Some(u32::from(pair[0]) << 8 | u32::from(pair[1]))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    let quad = bytes.get(at..at + 4)?;
    Some(u32::from_be_bytes([quad[0], quad[1], quad[2], quad[3]]))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    let pair = bytes.get(at..at + 2)?;
    Some(u32::from(pair[1]) << 8 | u32::from(pair[0]))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    let triple = bytes.get(at..at + 3)?;
    Some(u32::from(triple[2]) << 16 | u32::from(triple[1]) << 8 | u32::from(triple[0]))
}

/// The first chunk is IHDR: length(4) "IHDR" width(4) height(4).
fn png(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be32(bytes, 16)?, be32(bytes, 20)?))
}

/// Logical screen descriptor right after the six signature bytes.
fn gif(bytes: &[u8]) -> Option<(u32, u32)> {
    Some((le16(bytes, 6)?, le16(bytes, 8)?))
}

/// Walk the marker segments until a start-of-frame (SOF0..SOF15 except DHT/JPG/DAC).
fn jpeg(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    loop {
        // Skip to the next marker; any number of 0xFF fill bytes may precede its code.
        while *bytes.get(at)? != 0xFF {
            at += 1;
        }
        while *bytes.get(at)? == 0xFF {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        match marker {
            // Standalone markers carry no length.
            0x00 | 0x01 | 0xD0..=0xD8 => continue,
            // End of image, or the start of scan data before any frame header: give up.
            0xD9 | 0xDA => return None,
            0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                // length(2) precision(1) height(2) width(2)
                return Some((be16(bytes, at + 5)?, be16(bytes, at + 3)?));
            }
            _ => {
                let length = be16(bytes, at)? as usize;
                if length < 2 {
                    return None;
                }
                at += length;
            }
        }
    }
}

/// `VP8X` (extended), `VP8L` (lossless) or `VP8 ` (lossy) first chunk.
fn webp(bytes: &[u8]) -> Option<(u32, u32)> {
    let payload = 20;
    match bytes.get(12..16)? {
        // flags(4) width-1 (24 bit LE) height-1 (24 bit LE)
        b"VP8X" => Some((le24(bytes, 24)? + 1, le24(bytes, 27)? + 1)),
        // signature 0x2F, then 14 bits width-1, 14 bits height-1 (little endian bit packing)
        b"VP8L" => {
            if *bytes.get(payload)? != 0x2F {
                return None;
            }
            let packed = u32::from_le_bytes(bytes.get(payload + 1..payload + 5)?.try_into().ok()?);
            Some(((packed & 0x3FFF) + 1, ((packed >> 14) & 0x3FFF) + 1))
        }
        // 3-byte frame tag, start code 9D 01 2A, then 14 bits width and 14 bits height (+2 scale bits each)
        b"VP8 " => {
            if bytes.get(payload + 3..payload + 6)? != [0x9D, 0x01, 0x2A] {
                return None;
            }
            Some((
                le16(bytes, payload + 6)? & 0x3FFF,
                le16(bytes, payload + 8)? & 0x3FFF,
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(b"IHDR");
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&[8, 6, 0, 0, 0]);
        out
    }

    fn gif_of(width: u16, height: u16) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.extend_from_slice(&[0xF7, 0, 0]);
        out
    }

    fn jpeg_of(marker: u8, width: u16, height: u16, padding: usize) -> Vec<u8> {
        let mut out = vec![0xFF, 0xD8];
        // APP0 (JFIF), 16 bytes of segment, then a comment, then fill bytes, then the frame header.
        out.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        out.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
        out.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x05, b'h', b'i', b'!']);
        out.extend(vec![0xFFu8; padding]);
        out.extend_from_slice(&[0xFF, marker, 0x00, 0x11, 0x08]);
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[0x03, 0x01, 0x22, 0x00]);
        out
    }

    fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        out.extend_from_slice(&10u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        out.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        out
    }

    fn webp_vp8l(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8L".to_vec();
        out.extend_from_slice(&5u32.to_le_bytes());
        out.push(0x2F);
        let packed = (width - 1) | ((height - 1) << 14);
        out.extend_from_slice(&packed.to_le_bytes());
        out
    }

    fn webp_vp8(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        out.extend_from_slice(&10u32.to_le_bytes());
        out.extend_from_slice(&[0x10, 0x00, 0x00, 0x9D, 0x01, 0x2A]);
        out.extend_from_slice(&(width as u16).to_le_bytes());
        out.extend_from_slice(&(height as u16).to_le_bytes());
        out
    }

    #[test]
    fn each_supported_format_reports_its_size() {
        assert_eq!(image_dimensions(&png_of(1200, 630)), Some((1200, 630)));
        assert_eq!(image_dimensions(&gif_of(480, 270)), Some((480, 270)));
        for marker in [0xC0, 0xC1, 0xC2] {
            assert_eq!(
                image_dimensions(&jpeg_of(marker, 800, 600, 0)),
                Some((800, 600)),
                "SOF {marker:#x}"
            );
        }
        assert_eq!(
            image_dimensions(&jpeg_of(0xC0, 320, 240, 7)),
            Some((320, 240)),
            "fill bytes before a marker"
        );
        assert_eq!(image_dimensions(&webp_vp8x(1024, 512)), Some((1024, 512)));
        assert_eq!(image_dimensions(&webp_vp8l(640, 360)), Some((640, 360)));
        // The lossy frame keeps two scale bits above the 14 size bits; they are not size.
        assert_eq!(image_dimensions(&webp_vp8(300, 200)), Some((300, 200)));
    }

    #[test]
    fn what_cannot_be_measured_is_none_and_never_a_panic() {
        // Out of range: zero and past the card's limit.
        assert_eq!(image_dimensions(&png_of(0, 10)), None);
        assert_eq!(image_dimensions(&png_of(10, 0)), None);
        assert_eq!(image_dimensions(&png_of(16385, 10)), None);
        assert_eq!(
            image_dimensions(&png_of(16384, 16384)),
            Some((16384, 16384))
        );
        assert_eq!(image_dimensions(&gif_of(0, 0)), None);
        // Unknown, empty, truncated at every length, and lying segment lengths.
        assert_eq!(image_dimensions(b""), None);
        assert_eq!(image_dimensions(b"<html>not a picture</html>"), None);
        assert_eq!(
            image_dimensions(b"RIFF\0\0\0\0WEBPJUNKJUNKJUNKJUNKJUNK"),
            None
        );
        for full in [
            png_of(10, 10),
            gif_of(10, 10),
            jpeg_of(0xC0, 10, 10, 3),
            webp_vp8x(10, 10),
            webp_vp8l(10, 10),
            webp_vp8(10, 10),
        ] {
            for cut in 0..full.len() {
                let _ = image_dimensions(&full[..cut]);
            }
        }
        // A JPEG whose first segment claims a length past the end, or less than its own header.
        assert_eq!(
            image_dimensions(&[0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xFF, 0, 0]),
            None
        );
        assert_eq!(
            image_dimensions(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01, 0, 0]),
            None
        );
        // Scan data before any frame header ends the walk.
        assert_eq!(
            image_dimensions(&[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02]),
            None
        );
        // A PNG whose first chunk is not IHDR.
        let mut odd = png_of(10, 10);
        odd[12..16].copy_from_slice(b"IDAT");
        assert_eq!(image_dimensions(&odd), None);
    }
}
