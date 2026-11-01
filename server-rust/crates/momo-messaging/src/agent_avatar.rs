//! Agent avatar images — the one place an image **an agent proposed** is turned
//! into bytes this server will serve (ADR-0186 증보 2026-10-13 v3, V3-2a, #3786).
//!
//! The rule that makes the rest of the design safe: **only decoded pixels, freshly
//! encoded, are ever stored or served.** The input is sniffed, size- and
//! dimension-gated *before* any decoder runs, decoded under allocation limits,
//! shrunk to at most 512×512, rotated by its EXIF orientation (the tag itself is
//! then gone) and **re-encoded from the decoded pixels** as a fresh PNG (or, when
//! that is too big, JPEG). EXIF/ICC/XMP/text chunks/comments/trailing bytes cannot
//! survive a re-encode because they are not pixels, and a polyglot (a PNG with a
//! ZIP or a script appended, a JPEG whose comment is HTML) loses its other half
//! the same way.
//!
//! What it does **not** claim: the *pixel values* are the proposer's, and a
//! deliberately crafted image can spell bytes in them (a stored deflate block in
//! the PNG data can contain a literal `<script>`). That is neutralised by what is
//! served, not by the encoder: the response carries the stored image mime only,
//! `nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
//!
//! Storage is Postgres (migration 131, `agent_avatar_image`): `momo-drive` has no
//! way for the server to write bytes and external URLs are forbidden, so the
//! re-encoded result lives in the row. Rows are `staged` (a proposal: the card's
//! preview and the sha256 pin) and then `applied` (approved), and are **immutable
//! except for that status** — a trigger enforces it, so the bytes an approver
//! pinned are the bytes that get served.
//!
//! The decode is CPU/memory work on attacker-chosen input: callers run
//! [`process_avatar_image`] inside `spawn_blocking` under a timeout **and bound how
//! many run at once** (a decode peaks at tens of MiB even for a tiny file; this
//! crate has no runtime to hold a semaphore, so the caller owns that).

use std::io::Cursor;

use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use momo_db::{DbError, PgConnection};
use sha2::{Digest, Sha256};
use sqlx::Row;
use uuid::Uuid;

use crate::member_avatar::{image_dimensions, sniff_image_mime, IMAGE_SNIFF_PREFIX_BYTES};

/// The longest side of a stored avatar. The image is drawn in 24–64 px tiles.
pub const AGENT_AVATAR_OUT_MAX_DIM: u32 = 512;
/// The largest stored avatar (matches `agent_avatar_size_ck`).
pub const AGENT_AVATAR_OUT_MAX_BYTES: usize = 512 * 1024;
/// An image an agent generated and sent **inside the tool call** (V3-2a).
///
/// The ADR planned 1 MiB; the Agent Port reads at most
/// `momo_mcp::MAX_BODY_BYTES` = 64 KiB of request
/// body *before* it authenticates (a deliberate pre-auth buffer bound), and a
/// base64 image has to fit in that body together with the call's own JSON. So the
/// decoded image is capped at 44 000 bytes (≈ 58.7 k base64 characters): a 256×256
/// PNG or a 512×512 JPEG fits; a 1 MiB render has to be downscaled by the agent
/// first. A larger image can still arrive as a workspace file (source (a), ≤5 MiB).
pub const AGENT_AVATAR_IN_MAX_BYTES_GENERATED: usize = 44_000;
/// An image already uploaded to the workspace (V3-2a: ≤5 MiB, like member avatars).
pub const AGENT_AVATAR_IN_MAX_BYTES_ATTACHMENT: usize = 5 * 1024 * 1024;
/// The longest side of an **input** image (ADR-0186 증보 v4 V4-10 2: 2048 → 4096, so a
/// phone photo of 4032×3024 is accepted). The stored result is at most 512, so the
/// extra pixels only cost memory; they are bounded by [`AGENT_AVATAR_IN_MAX_PIXELS`]
/// and the caller's decode concurrency, and the shrink happens before the rotation.
pub const AGENT_AVATAR_IN_MAX_DIM: u32 = 4096;
/// The most pixels (width × height) an **input** may claim, read from the header before
/// any decoder allocates. 16 000 000 keeps a 12 MP phone photo (and 4096×3906) and
/// refuses a 4096×4096 frame; an 8-bit RGB decode of the maximum is 48 MB.
pub const AGENT_AVATAR_IN_MAX_PIXELS: u64 = 16_000_000;
/// The decoder's allocation ceiling. What it actually bounds is the decoder's
/// **scratch** — the PNG `iCCP`/`zTXt` inflation and similar — not the decoded frame
/// (a 2048² 16-bit frame is 32 MiB and decodes fine with this set far lower; the
/// frame is bounded by the dimension gate above). A security review measured the
/// 4 MB `iCCP` bomb at 109 MB with a 96 MiB limit, 42 MB at 32 MiB and 25 MB at
/// 16 MiB, with no valid input refused at 8 MiB. 24 MiB leaves room and keeps the
/// worst case near 35 MB. Not every decoder honours it (zune-jpeg checks dimensions
/// only), which is why the dimension gate exists and why the **caller** bounds
/// concurrency.
pub const AGENT_AVATAR_DECODE_ALLOC_LIMIT: u64 = 24 * 1024 * 1024;
/// A staged row older than this is swept by the next avatar proposal.
pub const AGENT_AVATAR_STAGED_TTL_HOURS: i64 = 24;
/// Where a stored avatar came from (`agent_avatar_source_ck`).
pub const AGENT_AVATAR_SOURCES: [&str; 2] = ["attachment", "generated"];

/// Why an input image was refused. The proposal path folds every variant into one
/// `InvalidArguments`; the variants exist for tests and for the audit reason code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AvatarImageRejected {
    #[error("image is empty")]
    Empty,
    #[error("image is larger than the limit for this source")]
    TooLarge,
    #[error("image type is not allowed (PNG, JPEG or still WebP only)")]
    UnsupportedType,
    #[error(
        "HEIC/HEIF photos are not supported: 사진을 JPEG로 보내 주세요 (send the photo as JPEG)"
    )]
    Heic,
    #[error("animated images are not allowed")]
    Animated,
    #[error("image dimensions could not be read")]
    DimensionsUnreadable,
    #[error("image dimensions are out of range")]
    DimensionsOutOfRange,
    #[error("image could not be decoded")]
    DecodeFailed,
    #[error("image cannot be made small enough")]
    OutputTooLarge,
}

impl AvatarImageRejected {
    /// The audit `reason` — a code, never input bytes.
    pub fn code(self) -> &'static str {
        match self {
            AvatarImageRejected::Empty => "empty",
            AvatarImageRejected::TooLarge => "too_large",
            AvatarImageRejected::UnsupportedType => "unsupported_type",
            AvatarImageRejected::Heic => "heic_unsupported",
            AvatarImageRejected::Animated => "animated",
            AvatarImageRejected::DimensionsUnreadable => "dimensions_unreadable",
            AvatarImageRejected::DimensionsOutOfRange => "dimensions_out_of_range",
            AvatarImageRejected::DecodeFailed => "decode_failed",
            AvatarImageRejected::OutputTooLarge => "output_too_large",
        }
    }
}

/// A freshly encoded avatar. Every field describes **the output**, never the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedAvatar {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub sha256: [u8; 32],
}

/// Whether the bytes are an ISO-BMFF `ftyp` box with a HEIC/HEIF brand (an iPhone's
/// default photo format). Refused by name so the person is told what to do.
fn is_heif(prefix: &[u8]) -> bool {
    prefix.len() >= 12
        && &prefix[4..8] == b"ftyp"
        && matches!(
            &prefix[8..12],
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"mif1" | b"msf1" | b"heif"
        )
}

/// Whether a WebP is animated: the `VP8X` extended header's animation flag
/// (bit 1 of the flags byte, offset 20). A still WebP has no `VP8X` or a clear bit.
fn webp_is_animated(bytes: &[u8]) -> bool {
    bytes.len() >= 21 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0
}

/// Decode `input` and re-encode it as a fresh avatar. See the module doc.
pub fn process_avatar_image(
    input: &[u8],
    max_input_bytes: usize,
) -> Result<ProcessedAvatar, AvatarImageRejected> {
    process_with_limits(input, max_input_bytes, AGENT_AVATAR_OUT_MAX_BYTES)
}

/// [`process_avatar_image`] with the output ceiling explicit, so the branch that
/// refuses an image that cannot be made small enough can be exercised.
pub fn process_with_limits(
    input: &[u8],
    max_input_bytes: usize,
    max_output_bytes: usize,
) -> Result<ProcessedAvatar, AvatarImageRejected> {
    process_with_all_limits(
        input,
        max_input_bytes,
        max_output_bytes,
        AGENT_AVATAR_DECODE_ALLOC_LIMIT,
    )
}

/// [`process_with_limits`] with the decoder's allocation ceiling explicit too.
pub fn process_with_all_limits(
    input: &[u8],
    max_input_bytes: usize,
    max_output_bytes: usize,
    decode_alloc_limit: u64,
) -> Result<ProcessedAvatar, AvatarImageRejected> {
    if input.is_empty() {
        return Err(AvatarImageRejected::Empty);
    }
    if input.len() > max_input_bytes {
        return Err(AvatarImageRejected::TooLarge);
    }

    // 1. The type is the one the **bytes** say. GIF and everything else (SVG, ICO,
    //    BMP, text…) is refused; a declared mime never gets a vote.
    let prefix = &input[..input.len().min(IMAGE_SNIFF_PREFIX_BYTES)];
    let format = match sniff_image_mime(prefix) {
        Some("image/png") => ImageFormat::Png,
        Some("image/jpeg") => ImageFormat::Jpeg,
        Some("image/webp") => {
            if webp_is_animated(input) {
                return Err(AvatarImageRejected::Animated);
            }
            ImageFormat::WebP
        }
        _ if is_heif(prefix) => return Err(AvatarImageRejected::Heic),
        _ => return Err(AvatarImageRejected::UnsupportedType),
    };
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        _ => "image/webp",
    };

    // 2. The header's own dimensions, before any decoder allocates: a 5 MiB file
    //    that claims 60000×60000 never reaches the decoder.
    let (width, height) =
        image_dimensions(mime, input).ok_or(AvatarImageRejected::DimensionsUnreadable)?;
    if width == 0
        || height == 0
        || width > AGENT_AVATAR_IN_MAX_DIM
        || height > AGENT_AVATAR_IN_MAX_DIM
        || u64::from(width) * u64::from(height) > AGENT_AVATAR_IN_MAX_PIXELS
    {
        return Err(AvatarImageRejected::DimensionsOutOfRange);
    }

    // 3. Decode under the decoder's own limits as well (the header may lie about
    //    what the stream then does).
    let mut reader = ImageReader::with_format(Cursor::new(input), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(AGENT_AVATAR_IN_MAX_DIM);
    limits.max_image_height = Some(AGENT_AVATAR_IN_MAX_DIM);
    limits.max_alloc = Some(decode_alloc_limit);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| AvatarImageRejected::DecodeFailed)?;
    // The EXIF orientation is **read** here, but applied only after the shrink: a
    // rotation copies the whole frame, and doing it on the full-size decode doubled
    // the peak (security review of #3799, measured 178 → 312 MB).
    let orientation = decoder.orientation().ok();
    let decoded =
        DynamicImage::from_decoder(decoder).map_err(|_| AvatarImageRejected::DecodeFailed)?;
    if decoded.width() == 0 || decoded.height() == 0 {
        return Err(AvatarImageRejected::DecodeFailed);
    }

    // 4. Shrink to fit 512×512 (never enlarge), keeping the aspect ratio, **then**
    //    turn it upright (the box is square, so rotating a shrunk image keeps it
    //    inside it). The tag is not carried into the output.
    let mut shrunk = if decoded.width() > AGENT_AVATAR_OUT_MAX_DIM
        || decoded.height() > AGENT_AVATAR_OUT_MAX_DIM
    {
        decoded.resize(
            AGENT_AVATAR_OUT_MAX_DIM,
            AGENT_AVATAR_OUT_MAX_DIM,
            FilterType::Lanczos3,
        )
    } else {
        decoded
    };
    if let Some(orientation) = orientation {
        shrunk.apply_orientation(orientation);
    }

    // 5. Encode from pixels. PNG keeps transparency; when it is too big the picture
    //    is flattened onto white and written as JPEG.
    let (out_width, out_height) = (shrunk.width(), shrunk.height());
    let png = encode_png(&shrunk)?;
    let (bytes, out_mime) = if png.len() <= max_output_bytes {
        (png, "image/png")
    } else {
        let jpeg = encode_flattened_jpeg(&shrunk)?;
        if jpeg.len() > max_output_bytes {
            return Err(AvatarImageRejected::OutputTooLarge);
        }
        (jpeg, "image/jpeg")
    };
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Ok(ProcessedAvatar {
        bytes,
        mime: out_mime,
        width: out_width,
        height: out_height,
        sha256: digest,
    })
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, AvatarImageRejected> {
    let normalised = if image.has_alpha() {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(image.to_rgb8())
    };
    let mut out = Cursor::new(Vec::new());
    normalised
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|_| AvatarImageRejected::DecodeFailed)?;
    Ok(out.into_inner())
}

fn encode_flattened_jpeg(image: &DynamicImage) -> Result<Vec<u8>, AvatarImageRejected> {
    let rgba = image.to_rgba8();
    let mut flat = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        let blend = |channel: u8| -> u8 {
            // over white: c·a + 255·(1−a)
            ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8
        };
        flat.put_pixel(
            x,
            y,
            image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    let mut out = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80);
    flat.write_with_encoder(encoder)
        .map_err(|_| AvatarImageRejected::DecodeFailed)?;
    Ok(out.into_inner())
}

// ---------------------------------------------------------------------------
// storage (migration 131)
// ---------------------------------------------------------------------------

/// One stored avatar row **without** its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAvatarImage {
    pub id: Uuid,
    pub member_id: Uuid,
    pub proposed_by: Uuid,
    pub source: String,
    pub mime: String,
    pub width: i32,
    pub height: i32,
    pub size_bytes: i32,
    pub sha256: Vec<u8>,
    pub status: String,
    /// The approval this staged image was proposed under, once bound
    /// ([`bind_staged_image_to_approval_in_tx`]); `None` before that.
    pub approval_id: Option<Uuid>,
}

/// A stored avatar with the bytes to serve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAvatarBytes {
    pub image: AgentAvatarImage,
    pub bytes: Vec<u8>,
}

const META_COLS: &str = "id, member_id, proposed_by, source, mime, width, height, size_bytes, \
                         sha256, status, approval_id";

fn decode_meta(row: &sqlx::postgres::PgRow) -> Result<AgentAvatarImage, sqlx::Error> {
    Ok(AgentAvatarImage {
        id: row.try_get("id")?,
        member_id: row.try_get("member_id")?,
        proposed_by: row.try_get("proposed_by")?,
        source: row.try_get("source")?,
        mime: row.try_get("mime")?,
        width: row.try_get("width")?,
        height: row.try_get("height")?,
        size_bytes: row.try_get("size_bytes")?,
        sha256: row.try_get("sha256")?,
        status: row.try_get("status")?,
        approval_id: row.try_get("approval_id")?,
    })
}

/// Insert a `staged` row for `member_id` (the agent that would wear the avatar).
/// `source` must be one of [`AGENT_AVATAR_SOURCES`]; the table's CHECKs refuse
/// anything else.
pub async fn stage_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    proposed_by: Uuid,
    source: &str,
    image: &ProcessedAvatar,
) -> Result<Uuid, DbError> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO agent_avatar_image \
           (workspace_id, member_id, proposed_by, source, mime, width, height, size_bytes, \
            sha256, bytes, status) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staged') RETURNING id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(proposed_by)
    .bind(source)
    .bind(image.mime)
    .bind(image.width as i32)
    .bind(image.height as i32)
    .bind(image.bytes.len() as i32)
    .bind(&image.sha256[..])
    .bind(&image.bytes)
    .fetch_one(&mut *conn)
    .await?;
    Ok(id)
}

/// A row by id, bytes excluded. `None` when RLS or the id hides it.
pub async fn read_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    image_id: Uuid,
) -> Result<Option<AgentAvatarImage>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {META_COLS} FROM agent_avatar_image WHERE workspace_id = $1 AND id = $2"
    ))
    .bind(workspace_id)
    .bind(image_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.as_ref().map(decode_meta).transpose()?)
}

async fn read_bytes_where(
    conn: &mut PgConnection,
    sql: &str,
    workspace_id: Uuid,
    key: Uuid,
) -> Result<Option<AgentAvatarBytes>, DbError> {
    let row = sqlx::query(sql)
        .bind(workspace_id)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(AgentAvatarBytes {
        image: decode_meta(&row)?,
        bytes: row.try_get("bytes")?,
    }))
}

/// A staged or applied row **with** its bytes (the approval card's preview).
pub async fn read_avatar_image_bytes_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    image_id: Uuid,
) -> Result<Option<AgentAvatarBytes>, DbError> {
    read_bytes_where(
        conn,
        &format!(
            "SELECT {META_COLS}, bytes FROM agent_avatar_image WHERE workspace_id = $1 AND id = $2"
        ),
        workspace_id,
        image_id,
    )
    .await
}

/// The member's **current, approved** image through `member.avatar_image_id` —
/// what the content proxy serves. A `staged` row is never reachable this way:
/// the pointer is only ever set to an `applied` one ([`apply_avatar_image_in_tx`]).
pub async fn read_current_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<Option<AgentAvatarBytes>, DbError> {
    read_bytes_where(
        conn,
        "SELECT i.id, i.member_id, i.proposed_by, i.source, i.mime, i.width, i.height, \
                i.size_bytes, i.sha256, i.status, i.approval_id, i.bytes \
           FROM agent_avatar_image i \
           JOIN member m ON m.avatar_image_id = i.id AND m.id = i.member_id \
                        AND m.workspace_id = i.workspace_id \
          WHERE m.workspace_id = $1 AND m.id = $2 AND i.status = 'applied'",
        workspace_id,
        member_id,
    )
    .await
}

/// Whether the stored bytes of `image_id` are **still** the ones `expected_sha256`
/// pinned: the row exists, is `staged`, belongs to `member_id`, **is bound to
/// `approval_id`** (the approval being decided — an unbound row, or one bound to
/// another approval, never satisfies a pin), and both its
/// recorded hash **and a hash recomputed from the stored bytes by the database**
/// equal the pin. The recomputation is the point — a column that was edited
/// around the immutability trigger is caught here too.
pub async fn staged_image_matches_pin_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    image_id: Uuid,
    member_id: Uuid,
    approval_id: Uuid,
    expected_sha256: &[u8],
) -> Result<bool, DbError> {
    let ok: Option<bool> = sqlx::query_scalar(
        "SELECT sha256 = $5 AND public.digest(bytes, 'sha256') = $5 \
           FROM agent_avatar_image \
          WHERE workspace_id = $1 AND id = $2 AND member_id = $3 AND status = 'staged' \
            AND approval_id = $4",
    )
    .bind(workspace_id)
    .bind(image_id)
    .bind(member_id)
    .bind(approval_id)
    .bind(expected_sha256)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(ok.unwrap_or(false))
}

/// Bind a freshly staged image to the approval created for it (once: the column is
/// `UNIQUE` and the immutability trigger lets it go from `NULL` to a value only). The
/// decision then accepts the image only under **that** approval, so a pin that names
/// another approval's staged row is refused by the database's own record.
pub async fn bind_staged_image_to_approval_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    image_id: Uuid,
    approval_id: Uuid,
) -> Result<bool, DbError> {
    let bound = sqlx::query(
        "UPDATE agent_avatar_image SET approval_id = $3 \
          WHERE workspace_id = $1 AND id = $2 AND status = 'staged' AND approval_id IS NULL",
    )
    .bind(workspace_id)
    .bind(image_id)
    .bind(approval_id)
    .execute(&mut *conn)
    .await?;
    Ok(bound.rows_affected() == 1)
}

/// Make a `staged` image the member's current avatar. Returns the **previous**
/// image id (deleted in the same transaction) — `Some(None)` when there was none —
/// or `None` when the image is not a `staged` row of this member.
pub async fn apply_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    image_id: Uuid,
    approval_id: Uuid,
) -> Result<Option<Option<Uuid>>, DbError> {
    apply_avatar_image_for_kind_in_tx(
        conn,
        workspace_id,
        member_id,
        image_id,
        approval_id,
        "agent",
    )
    .await
}

/// [`apply_avatar_image_in_tx`] for a **person** (ADR-0186 증보 v4 `member.avatar.set`):
/// the same staged → applied move, but the target must be a live human member. The two
/// wrappers differ in exactly one word, so an agent's profile card can never apply an
/// image onto a person and a person's card can never apply one onto an agent.
pub async fn apply_human_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    image_id: Uuid,
    approval_id: Uuid,
) -> Result<Option<Option<Uuid>>, DbError> {
    apply_avatar_image_for_kind_in_tx(
        conn,
        workspace_id,
        member_id,
        image_id,
        approval_id,
        "human",
    )
    .await
}

async fn apply_avatar_image_for_kind_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
    image_id: Uuid,
    approval_id: Uuid,
    kind: &str,
) -> Result<Option<Option<Uuid>>, DbError> {
    let member = sqlx::query(
        "SELECT avatar_image_id FROM member \
          WHERE workspace_id = $1 AND id = $2 AND kind = $3::member_kind AND status = 'active' \
            AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(kind)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(member) = member else {
        return Ok(None);
    };
    let previous: Option<Uuid> = member.try_get("avatar_image_id")?;
    let applied = sqlx::query(
        "UPDATE agent_avatar_image SET status = 'applied' \
          WHERE workspace_id = $1 AND id = $2 AND member_id = $3 AND status = 'staged' \
            AND approval_id = $4",
    )
    .bind(workspace_id)
    .bind(image_id)
    .bind(member_id)
    .bind(approval_id)
    .execute(&mut *conn)
    .await?;
    if applied.rows_affected() != 1 {
        return Ok(None);
    }
    sqlx::query(
        // An image avatar and an uploaded one never coexist
        // (`member_avatar_exclusive_ck`): the uploaded pointer is cleared with it.
        "UPDATE member SET avatar_image_id = $3, avatar_media_id = NULL, updated_at = now() \
          WHERE workspace_id = $1 AND id = $2",
    )
    .bind(workspace_id)
    .bind(member_id)
    .bind(image_id)
    .execute(&mut *conn)
    .await?;
    if let Some(previous) = previous {
        if previous != image_id {
            sqlx::query("DELETE FROM agent_avatar_image WHERE workspace_id = $1 AND id = $2")
                .bind(workspace_id)
                .bind(previous)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(Some(previous))
}

/// Remove the member's current image (a preset replaces it). Returns whether one
/// was removed.
pub async fn clear_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    member_id: Uuid,
) -> Result<bool, DbError> {
    // The member row first, exactly like `apply_avatar_image_in_tx`: without it a
    // concurrent apply could move the pointer between this read and the delete and
    // leave the new image winning over a preset the caller believed it had set.
    sqlx::query("SELECT id FROM member WHERE workspace_id = $1 AND id = $2 FOR UPDATE")
        .bind(workspace_id)
        .bind(member_id)
        .fetch_optional(&mut *conn)
        .await?;
    let deleted = sqlx::query(
        "DELETE FROM agent_avatar_image i USING member m \
          WHERE m.workspace_id = $1 AND m.id = $2 AND i.id = m.avatar_image_id \
            AND i.workspace_id = m.workspace_id",
    )
    .bind(workspace_id)
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    Ok(deleted.rows_affected() > 0)
}

/// Delete one `staged` row (a rejected, expired or cancelled proposal). An
/// `applied` row is never deleted here.
pub async fn delete_staged_avatar_image_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    image_id: Uuid,
) -> Result<bool, DbError> {
    let deleted = sqlx::query(
        "DELETE FROM agent_avatar_image \
          WHERE workspace_id = $1 AND id = $2 AND status = 'staged'",
    )
    .bind(workspace_id)
    .bind(image_id)
    .execute(&mut *conn)
    .await?;
    Ok(deleted.rows_affected() > 0)
}

/// Delete this workspace's `staged` rows older than [`AGENT_AVATAR_STAGED_TTL_HOURS`].
/// The next avatar proposal calls it in its own transaction: there is no sweeper.
pub async fn purge_stale_staged_avatar_images_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
) -> Result<u64, DbError> {
    let deleted = sqlx::query(
        "DELETE FROM agent_avatar_image \
          WHERE workspace_id = $1 AND status = 'staged' \
            AND created_at < now() - make_interval(hours => $2::int)",
    )
    .bind(workspace_id)
    .bind(AGENT_AVATAR_STAGED_TTL_HOURS as i32)
    .execute(&mut *conn)
    .await?;
    Ok(deleted.rows_affected())
}

// ---------------------------------------------------------------------------
// presets and attachment sources (ADR-0186 증보 v3 V3-2a, A1)
// ---------------------------------------------------------------------------

/// The server-side avatar presets (an id the clients draw: a colour tile with the
/// agent's initial, or one of the mascots). A preset is only an id — no bytes, no
/// URL, nothing to parse. The art and the picker belong to the UXUI.
pub const AGENT_AVATAR_PRESETS: [&str; 8] = [
    "sky", "mint", "sun", "rose", "violet", "slate", "comet", "omu",
];

/// Whether `id` is one of [`AGENT_AVATAR_PRESETS`].
pub fn is_avatar_preset(id: &str) -> bool {
    AGENT_AVATAR_PRESETS.contains(&id)
}

/// A workspace image file an agent may use as an avatar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvatarAttachmentSource {
    pub id: Uuid,
    pub channel_id: Uuid,
    pub drive_file_id: String,
    pub size_bytes: i64,
    /// The recorded (lower-cased) media type — the first narrowing of what a caller does with the
    /// bytes. Never the bytes' own say: those are sniffed again ([`crate::self_media::bytes_match_mime`]).
    pub mime: String,
}

/// The attachment, **if and only if the proposing agent could read it**: it is
/// complete, bound to a message that still exists, a PNG/JPEG/WebP within
/// `max_bytes`, in a live non-DM channel that is in the agent's approved set
/// (`approved_channels`, from its hosted identity) and that the agent is a live
/// member of. Everything else — somebody else's private channel, a DM, an archived
/// channel, a deleted message, a pending or failed upload, a missing id — is the
/// same `None`, so a refusal cannot be used to learn that a file exists.
pub async fn find_visible_image_attachment_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    proposer_member_id: Uuid,
    approved_channels: &[Uuid],
    attachment_id: Uuid,
    max_bytes: i64,
) -> Result<Option<AvatarAttachmentSource>, DbError> {
    let row = sqlx::query(
        "SELECT a.id, a.channel_id, a.drive_file_id, a.size_bytes, a.mime \
           FROM attachment a \
           JOIN channel c ON c.workspace_id = a.workspace_id AND c.id = a.channel_id \
           JOIN message m ON m.workspace_id = a.workspace_id AND m.id = a.message_id \
          WHERE a.workspace_id = $1 AND a.id = $2 AND a.status = 'complete' \
            AND a.drive_file_id IS NOT NULL \
            AND a.mime IN ('image/png', 'image/jpeg', 'image/webp') \
            AND a.size_bytes BETWEEN 1 AND $5 \
            AND m.state <> 'deleted' AND m.deleted_at IS NULL \
            AND c.kind IN ('public', 'private') AND c.archived_at IS NULL \
            AND a.channel_id = ANY($3) \
            AND EXISTS (SELECT 1 FROM membership p \
                         WHERE p.workspace_id = c.workspace_id AND p.channel_id = c.id \
                           AND p.member_id = $4 AND p.left_at IS NULL)",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .bind(approved_channels)
    .bind(proposer_member_id)
    .bind(max_bytes)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(AvatarAttachmentSource {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        drive_file_id: row.try_get("drive_file_id")?,
        size_bytes: row.try_get("size_bytes")?,
        mime: row.try_get("mime")?,
    }))
}

/// The person an agent run was **raised by**, and the conversation the run is in: the author
/// of the run's trigger message, when that author is a live human member (ADR-0186 증보 v4
/// `member.avatar.set`), with the run's channel.
///
/// The run must belong to `agent_member_id` — the proposer — so one agent's proposal
/// can never be attributed to a run of another. Everything else (a run nobody
/// addressed, a trigger written by an agent, a departed or deleted author, a missing
/// run) is the same `None`: the caller answers one `InvalidArguments`.
pub async fn requester_of_run_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    run_id: Uuid,
    agent_member_id: Uuid,
) -> Result<Option<(Uuid, Uuid)>, DbError> {
    Ok(sqlx::query_as(
        "SELECT h.id, r.channel_id \
           FROM agent_run r \
           JOIN message t ON t.workspace_id = r.workspace_id AND t.id = r.trigger_message_id \
           JOIN member h ON h.workspace_id = t.workspace_id AND h.id = t.author_member_id \
          WHERE r.workspace_id = $1 AND r.id = $2 AND r.agent_member_id = $3 \
            AND h.kind = 'human' AND h.status = 'active' AND h.deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(run_id)
    .bind(agent_member_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// What a requester's attachment is wanted **for**. The media type the database recorded is a
/// first narrowing (the bytes still decide, later, in the decoder); the two uses differ in
/// which types are worth fetching at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequesterAttachmentUse {
    /// A person's or an agent's avatar: PNG, JPEG, WebP. Never an animation, never a video
    /// (ADR-0186 P7-2: "GIF·SVG·애니메이션·HEIC는 열지 않는다").
    Avatar,
    /// The source of an expression (ADR-0186 X8-1/X8-2, ADR-0218 D3/D4): the avatar types plus
    /// **GIF**, which goes through the decoder's full-frame check, and the **video** types,
    /// which end as the `video_processing_unavailable` card (D4 is on hold). Nothing here
    /// widens what the decoder accepts: it decides on the bytes.
    ExpressionSource,
    /// A person's own attachment **read for them** by the team's helper (ADR-0201 증보 v3 B6-1,
    /// #4970; ADR-0151 증보 4): the avatar's three picture types plus the text and PDF types the
    /// worker can pull letters out of ([`crate::self_media::READ_MIMES`]). The recorded type is
    /// the first narrowing; the bytes are sniffed again at the route and in the worker, and the
    /// extractor decides last.
    Read,
    /// The **lookup** half of [`Read`](Self::Read) (#4970): whose file is it, **whatever its type** — so a
    /// person's own file of a type the helper does not read is told 「그 종류는 못 읽어요」 instead of
    /// 「못 찾아요」 (it is their own file: nothing leaks), while somebody else's file of any type is `None`
    /// as always. It is the only use with no type narrowing (an empty [`mimes`](Self::mimes) means "any"),
    /// and it is **never** what a token is minted or redeemed under.
    ReadAnyType,
}

impl RequesterAttachmentUse {
    /// The recorded (lower-cased) media types this use accepts. **Empty means any type**, which only
    /// [`ReadAnyType`](Self::ReadAnyType) says; a test pins that no other use is empty.
    pub const fn mimes(self) -> &'static [&'static str] {
        match self {
            RequesterAttachmentUse::ReadAnyType => &[],
            RequesterAttachmentUse::Read => &crate::self_media::READ_MIMES,
            RequesterAttachmentUse::Avatar => &["image/png", "image/jpeg", "image/webp"],
            RequesterAttachmentUse::ExpressionSource => &[
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
                "video/mp4",
                "video/quicktime",
                "video/webm",
            ],
        }
    }
}

/// The attachment a person may turn into **their own** avatar through an agent: complete,
/// a PNG/JPEG/WebP within `max_bytes`, on a live message **written by `requester`** in
/// **`channel_id`** — the conversation the agent was called in. Anything else (a file
/// somebody else attached, one from another channel or a DM the run is not in, a deleted
/// message, a pending upload, a missing id) is the same `None`, so a refusal cannot be
/// used to learn that a file exists.
///
/// Unlike [`find_visible_image_attachment_in_tx`] this does not exclude DMs: the person
/// talks to their agent in a DM as often as in a channel, and the conversation **is** the
/// boundary here (the run's own channel), not the agent's approved-channel set.
///
/// This is [`find_requester_attachment_for_in_tx`] for [`RequesterAttachmentUse::Avatar`]; the
/// avatar rules are exactly what they were before the expression source existed.
pub async fn find_requester_attachment_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    requester: Uuid,
    channel_id: Uuid,
    attachment_id: Uuid,
    max_bytes: i64,
) -> Result<Option<AvatarAttachmentSource>, DbError> {
    find_requester_attachment_for_in_tx(
        conn,
        workspace_id,
        requester,
        channel_id,
        attachment_id,
        max_bytes,
        RequesterAttachmentUse::Avatar,
    )
    .await
}

/// [`find_requester_attachment_in_tx`] for one **use**: the same author, conversation,
/// completeness, deletion and size judgement, with the media types of `usage` as the only
/// difference. One statement, so the two uses cannot drift apart in anything but the types.
#[allow(clippy::too_many_arguments)]
pub async fn find_requester_attachment_for_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    requester: Uuid,
    channel_id: Uuid,
    attachment_id: Uuid,
    max_bytes: i64,
    usage: RequesterAttachmentUse,
) -> Result<Option<AvatarAttachmentSource>, DbError> {
    let row = sqlx::query(
        "SELECT a.id, a.channel_id, a.drive_file_id, a.size_bytes, a.mime \
           FROM attachment a \
           JOIN channel c ON c.workspace_id = a.workspace_id AND c.id = a.channel_id \
           JOIN message m ON m.workspace_id = a.workspace_id AND m.id = a.message_id \
          WHERE a.workspace_id = $1 AND a.id = $2 AND a.status = 'complete' \
            AND a.drive_file_id IS NOT NULL \
            AND (cardinality($6::text[]) = 0 OR a.mime = ANY($6)) \
            AND a.size_bytes BETWEEN 1 AND $5 \
            AND m.state <> 'deleted' AND m.deleted_at IS NULL \
            AND m.author_member_id = $4 \
            AND a.channel_id = $3 AND c.archived_at IS NULL",
    )
    .bind(workspace_id)
    .bind(attachment_id)
    .bind(channel_id)
    .bind(requester)
    .bind(max_bytes)
    .bind(usage.mimes())
    .fetch_optional(&mut *conn)
    .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(AvatarAttachmentSource {
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        drive_file_id: row.try_get("drive_file_id")?,
        size_bytes: row.try_get("size_bytes")?,
        mime: row.try_get("mime")?,
    }))
}

/// Image attachments of a page of messages, for the Agent Port's conversation read:
/// `(message id, attachment id, name, mime, size)` for complete PNG/JPEG/WebP files
/// only. The agent learns an attachment's **id** here because that id is the only
/// way to name a file for [`find_visible_image_attachment_in_tx`]; the Drive file id
/// is never projected.
///
/// **A deleted message lists nothing** (ADR-0151 증보 2, #4443), in the statement
/// itself: the join requires the message alive, the same tombstone test every other
/// attachment projection uses. The conversation-read handler also drops a deleted
/// row's `imageAttachments` (`agent_port_tools.rs`, `gated_channel_page`) — a second
/// layer, kept, so this statement is the one that must be right on its own.
pub async fn image_attachments_for_messages_in_tx(
    conn: &mut PgConnection,
    workspace_id: Uuid,
    message_ids: &[Uuid],
) -> Result<Vec<(Uuid, Uuid, String, String, i64)>, DbError> {
    let rows = sqlx::query(
        "SELECT a.message_id, a.id, a.name, a.mime, a.size_bytes FROM attachment a \
           JOIN message m ON m.workspace_id = a.workspace_id AND m.id = a.message_id \
          WHERE a.workspace_id = $1 AND a.message_id = ANY($2) AND a.status = 'complete' \
            AND a.mime IN ('image/png', 'image/jpeg', 'image/webp') \
            AND m.state <> 'deleted' AND m.deleted_at IS NULL \
          ORDER BY a.created_at ASC, a.id ASC",
    )
    .bind(workspace_id)
    .bind(message_ids)
    .fetch_all(&mut *conn)
    .await?;
    rows.iter()
        .map(|row| {
            Ok((
                row.try_get("message_id")?,
                row.try_get("id")?,
                row.try_get("name")?,
                row.try_get("mime")?,
                row.try_get("size_bytes")?,
            ))
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn png_of(width: u32, height: u32, fill: [u8; 4]) -> Vec<u8> {
        let buffer = ImageBuffer::from_pixel(width, height, Rgba(fill));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(buffer)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn jpeg_of(width: u32, height: u32) -> Vec<u8> {
        let buffer = ImageBuffer::from_pixel(width, height, Rgb([200u8, 30, 30]));
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(buffer)
            .write_to(&mut out, ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    /// A JPEG with an EXIF APP1 (orientation + a GPS-shaped string), a COM segment
    /// carrying HTML, and a ZIP-ish tail after EOI, inserted after SOI.
    fn hostile_jpeg(width: u32, height: u32, orientation: u16) -> Vec<u8> {
        let base = jpeg_of(width, height);
        assert_eq!(&base[..2], &[0xFF, 0xD8]);
        // TIFF header (big endian) with one IFD0 entry: Orientation (0x0112).
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"MM\x00\x2A\x00\x00\x00\x08");
        tiff.extend_from_slice(&[0x00, 0x01]); // one entry
        tiff.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]);
        tiff.extend_from_slice(&orientation.to_be_bytes());
        tiff.extend_from_slice(&[0x00, 0x00]);
        tiff.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // next IFD
        tiff.extend_from_slice(b"GPSLatitude=37.5665,126.9780");
        let mut exif = b"Exif\0\0".to_vec();
        exif.extend_from_slice(&tiff);
        let mut app1 = vec![0xFF, 0xE1];
        app1.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        app1.extend_from_slice(&exif);
        let comment = b"<html><script>alert(1)</script></html>";
        let mut com = vec![0xFF, 0xFE];
        com.extend_from_slice(&((comment.len() + 2) as u16).to_be_bytes());
        com.extend_from_slice(comment);
        let mut out = vec![0xFF, 0xD8];
        out.extend_from_slice(&app1);
        out.extend_from_slice(&com);
        out.extend_from_slice(&base[2..]);
        out.extend_from_slice(b"PK\x03\x04polyglot-tail<script>alert(2)</script>");
        out
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn a_png_comes_out_as_a_fresh_png_within_the_ceilings() {
        let out = process_avatar_image(&png_of(1000, 600, [10, 120, 200, 255]), 1 << 20).unwrap();
        assert_eq!(out.mime, "image/png");
        assert_eq!(
            (out.width, out.height),
            (512, 307),
            "fit inside 512x512, aspect kept"
        );
        assert!(out.bytes.len() <= AGENT_AVATAR_OUT_MAX_BYTES);
        assert_eq!(out.sha256.to_vec(), Sha256::digest(&out.bytes).to_vec());
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (512, 307));
    }

    #[test]
    fn a_small_image_is_never_enlarged() {
        let out = process_avatar_image(&png_of(40, 30, [1, 2, 3, 255]), 1 << 20).unwrap();
        assert_eq!((out.width, out.height), (40, 30));
    }

    #[test]
    fn exif_comments_and_trailing_bytes_do_not_survive_a_re_encode() {
        let hostile = hostile_jpeg(64, 48, 1);
        assert!(contains(&hostile, b"GPSLatitude"));
        assert!(contains(&hostile, b"<script>"));
        assert!(contains(&hostile, b"PK\x03\x04"));
        let out = process_avatar_image(&hostile, 1 << 20).unwrap();
        for marker in [
            &b"GPSLatitude"[..],
            b"Exif",
            b"<script>",
            b"<html>",
            b"PK\x03\x04",
            b"polyglot",
        ] {
            assert!(
                !contains(&out.bytes, marker),
                "{:?} survived the re-encode",
                String::from_utf8_lossy(marker)
            );
        }
    }

    #[test]
    fn a_png_with_a_script_or_zip_appended_loses_the_appendix() {
        let mut polyglot = png_of(32, 32, [9, 9, 9, 255]);
        polyglot.extend_from_slice(b"<script>alert(1)</script>PK\x03\x04");
        let out = process_avatar_image(&polyglot, 1 << 20).unwrap();
        assert!(!contains(&out.bytes, b"<script>") && !contains(&out.bytes, b"PK\x03\x04"));
        assert_eq!(
            &out.bytes[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn an_exif_orientation_is_applied_to_the_pixels_and_the_tag_is_gone() {
        // Orientation 6 = rotate 90 CW: a 64x48 picture becomes 48x64.
        let out = process_avatar_image(&hostile_jpeg(64, 48, 6), 1 << 20).unwrap();
        assert_eq!((out.width, out.height), (48, 64));
        let upright = process_avatar_image(&hostile_jpeg(64, 48, 1), 1 << 20).unwrap();
        assert_eq!((upright.width, upright.height), (64, 48));
    }

    #[test]
    fn what_is_not_a_still_png_jpeg_or_webp_is_refused() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
        for (input, expected) in [
            (&svg[..], AvatarImageRejected::UnsupportedType),
            (
                b"GIF89a\x01\x00\x01\x00\x00\x00\x00;",
                AvatarImageRejected::UnsupportedType,
            ),
            (b"BM......", AvatarImageRejected::UnsupportedType),
            (b"<html></html>", AvatarImageRejected::UnsupportedType),
            (b"", AvatarImageRejected::Empty),
        ] {
            assert_eq!(process_avatar_image(input, 1 << 20).unwrap_err(), expected);
        }
    }

    #[test]
    fn an_animated_webp_is_refused_before_any_decoder_runs() {
        // RIFF....WEBPVP8X + flags(animation bit) + canvas 16x16.
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF\x1a\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00");
        webp.push(0x02); // animation flag
        webp.extend_from_slice(&[0, 0, 0]);
        webp.extend_from_slice(&[15, 0, 0, 15, 0, 0]);
        assert_eq!(
            process_avatar_image(&webp, 1 << 20).unwrap_err(),
            AvatarImageRejected::Animated
        );
    }

    #[test]
    fn the_input_ceilings_are_the_ones_documented() {
        assert_eq!(AGENT_AVATAR_IN_MAX_DIM, 4096);
        assert_eq!(AGENT_AVATAR_IN_MAX_PIXELS, 16_000_000);
    }

    #[test]
    fn a_phone_photo_size_is_accepted_and_shrunk() {
        // 4032x3024 (12 MP): the size that V4-4 (A) refused.
        let photo = jpeg_of(4032, 3024);
        let out = process_avatar_image(&photo, 5 << 20).expect("a phone-size photo");
        assert_eq!((out.width, out.height), (512, 384));
    }

    #[test]
    fn a_frame_over_the_pixel_budget_is_refused_from_the_header() {
        // 4096x4096 is inside the per-side limit but over 16 MP.
        let mut png = png_of(8, 8, [0, 0, 0, 255]);
        png[16..20].copy_from_slice(&4096u32.to_be_bytes());
        png[20..24].copy_from_slice(&4096u32.to_be_bytes());
        assert_eq!(
            process_avatar_image(&png, 1 << 20).unwrap_err(),
            AvatarImageRejected::DimensionsOutOfRange
        );
    }

    #[test]
    fn a_heic_photo_is_refused_by_name_with_the_instruction() {
        let mut heic = vec![0, 0, 0, 24];
        heic.extend_from_slice(b"ftypheic");
        heic.extend_from_slice(&[0; 32]);
        let rejected = process_avatar_image(&heic, 1 << 20).unwrap_err();
        assert_eq!(rejected, AvatarImageRejected::Heic);
        assert_eq!(rejected.code(), "heic_unsupported");
        assert!(rejected.to_string().contains("사진을 JPEG로 보내 주세요"));
        // Any other box is still the generic refusal.
        let mut other = vec![0, 0, 0, 24];
        other.extend_from_slice(b"ftypmp42");
        other.extend_from_slice(&[0; 32]);
        assert_eq!(
            process_avatar_image(&other, 1 << 20).unwrap_err(),
            AvatarImageRejected::UnsupportedType
        );
    }

    #[test]
    fn a_header_that_claims_a_huge_canvas_never_reaches_the_decoder() {
        // A real PNG header (IHDR) claiming 4097 and then 70000 wide, then nothing.
        for claimed in [4097u32, 70_000] {
            let mut png = png_of(8, 8, [0, 0, 0, 255]);
            png[16..20].copy_from_slice(&claimed.to_be_bytes());
            assert_eq!(
                process_avatar_image(&png, 1 << 20).unwrap_err(),
                AvatarImageRejected::DimensionsOutOfRange,
                "{claimed}"
            );
        }
        let mut zero = png_of(8, 8, [0, 0, 0, 255]);
        zero[16..20].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            process_avatar_image(&zero, 1 << 20).unwrap_err(),
            AvatarImageRejected::DimensionsUnreadable
        );
        let mut huge = png_of(8, 8, [0, 0, 0, 255]);
        huge[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        huge[20..24].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            process_avatar_image(&huge, 1 << 20).unwrap_err(),
            AvatarImageRejected::DimensionsOutOfRange
        );
    }

    #[test]
    fn a_truncated_or_corrupt_stream_is_a_clean_refusal() {
        let png = png_of(64, 64, [5, 5, 5, 255]);
        let truncated = &png[..png.len() / 2];
        assert_eq!(
            process_avatar_image(truncated, 1 << 20).unwrap_err(),
            AvatarImageRejected::DecodeFailed
        );
        let mut garbage = png.clone();
        let mid = garbage.len() / 2;
        for byte in &mut garbage[mid..mid + 12] {
            *byte ^= 0xFF;
        }
        assert!(process_avatar_image(&garbage, 1 << 20).is_err());
    }

    #[test]
    fn the_input_ceiling_is_per_source_and_inclusive() {
        let png = png_of(16, 16, [1, 1, 1, 255]);
        assert!(process_avatar_image(&png, png.len()).is_ok());
        assert_eq!(
            process_avatar_image(&png, png.len() - 1).unwrap_err(),
            AvatarImageRejected::TooLarge
        );
    }

    #[test]
    fn a_large_square_is_shrunk_and_a_noisy_one_falls_back_to_jpeg() {
        let big = process_avatar_image(&png_of(2048, 2048, [30, 60, 90, 255]), 5 << 20).unwrap();
        assert_eq!((big.width, big.height), (512, 512));

        // Deterministic noise: PNG cannot compress it under 512 KiB at 512x512.
        let mut state = 0x1234_5678u32;
        let noise = ImageBuffer::from_fn(512, 512, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let [a, b, c, _] = state.to_be_bytes();
            Rgba([a, b, c, 255])
        });
        let mut input = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(noise)
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let input = input.into_inner();
        assert!(
            input.len() > AGENT_AVATAR_OUT_MAX_BYTES,
            "fixture is not noisy enough"
        );
        let out = process_avatar_image(&input, 5 << 20).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert!(out.bytes.len() <= AGENT_AVATAR_OUT_MAX_BYTES);
        assert_eq!(&out.bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn an_image_that_cannot_be_made_small_enough_is_refused() {
        let png = png_of(300, 300, [10, 20, 30, 255]);
        assert_eq!(
            process_with_limits(&png, 1 << 20, 10).unwrap_err(),
            AvatarImageRejected::OutputTooLarge
        );
    }

    #[test]
    fn the_decoders_own_allocation_limit_is_applied() {
        // The header gate lets a 600×600 PNG through; only the decoder's `Limits`
        // can refuse it here, so removing `reader.limits(..)` fails this test.
        let png = png_of(600, 600, [10, 20, 30, 255]);
        assert!(
            process_with_all_limits(&png, 1 << 20, AGENT_AVATAR_OUT_MAX_BYTES, 1 << 28).is_ok()
        );
        assert_eq!(
            process_with_all_limits(&png, 1 << 20, AGENT_AVATAR_OUT_MAX_BYTES, 1_000).unwrap_err(),
            AvatarImageRejected::DecodeFailed
        );
    }

    #[test]
    fn a_transparent_picture_falls_back_to_white_not_black() {
        // Fully transparent noise: the PNG is large (noise), the flattened JPEG is
        // a white square. If the alpha blend were dropped the JPEG would be noise.
        let mut state = 7u32;
        let noise = ImageBuffer::from_fn(64, 64, |_, _| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let [a, b, c, _] = state.to_be_bytes();
            Rgba([a, b, c, 0])
        });
        let mut input = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(noise)
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let out = process_with_limits(&input.into_inner(), 1 << 20, 3_000).unwrap();
        assert_eq!(out.mime, "image/jpeg", "the PNG did not fit 3000 bytes");
        let pixels = image::load_from_memory(&out.bytes).unwrap().to_rgb8();
        assert!(
            pixels.pixels().all(|p| p.0.iter().all(|c| *c >= 245)),
            "a transparent pixel must flatten to white"
        );
    }

    #[test]
    fn a_big_rotated_photo_is_shrunk_then_turned_upright() {
        // 1000×600, orientation 6 (90° CW): upright it is 600×1000 → fits 512 as 307×512.
        let out = process_avatar_image(&hostile_jpeg(1000, 600, 6), 5 << 20).unwrap();
        assert_eq!((out.width, out.height), (307, 512));
    }

    #[test]
    fn the_declared_sources_are_the_two_the_table_allows() {
        assert_eq!(AGENT_AVATAR_SOURCES, ["attachment", "generated"]);
        for reason in [
            AvatarImageRejected::Empty,
            AvatarImageRejected::TooLarge,
            AvatarImageRejected::UnsupportedType,
            AvatarImageRejected::Animated,
            AvatarImageRejected::DimensionsUnreadable,
            AvatarImageRejected::DimensionsOutOfRange,
            AvatarImageRejected::DecodeFailed,
            AvatarImageRejected::OutputTooLarge,
        ] {
            assert!(reason
                .code()
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_'));
        }
    }
}

#[cfg(test)]
mod read_use_tests {
    use super::*;

    /// "Any type" is spelled by an empty list, and only [`RequesterAttachmentUse::ReadAnyType`] is allowed
    /// to say it: a use that became empty by accident would drop its type narrowing without a word.
    #[test]
    fn only_the_lookup_use_has_no_type_narrowing() {
        for usage in [
            RequesterAttachmentUse::Avatar,
            RequesterAttachmentUse::ExpressionSource,
            RequesterAttachmentUse::Read,
        ] {
            assert!(!usage.mimes().is_empty(), "{usage:?}");
        }
        assert!(RequesterAttachmentUse::ReadAnyType.mimes().is_empty());
        // Read is exactly the three pictures plus the text and PDF types, nothing the avatar flow
        // would be handed
        for mime in RequesterAttachmentUse::Avatar.mimes() {
            assert!(RequesterAttachmentUse::Read.mimes().contains(mime));
        }
        assert!(!RequesterAttachmentUse::Avatar
            .mimes()
            .contains(&"application/pdf"));
    }
}
