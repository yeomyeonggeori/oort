//! Answering a read of an attachment's bytes: `200`, `206`, `416`, `HEAD`
//! (ADR-0151 증보 5 D3, #4671).
//!
//! **This module never decides who may read.** Its caller has already passed the
//! four checks that do — authentication, active channel membership,
//! `load_readable_attachment_in_tx`, `status = complete` — and only then hands it
//! the `Range` header. That order is the contract: a request that fails any of the
//! four gets the same status and body whether or not it carries `Range`, so a
//! `Range` header can never be a question about whether a file exists (a 416 is
//! only ever sent for a file the reader may read). Nothing here touches
//! PostgreSQL.
//!
//! ## What the headers say, and where it comes from
//!
//! * **Size and mime are the database row's** — `complete` recorded the measured
//!   size and refused a mime the archive disagreed with, so the row is the
//!   archive's fact. `GET`, `HEAD`, `206` and `416` therefore all read one place.
//!   The archive's own idea of the length is compared with it, and a disagreement
//!   is a 502 before a byte is sent.
//! * **`Range` is read with checked arithmetic.** Digits only, at most twenty of
//!   them, `first <= last`; a number that does not fit a `u64` is a syntax error,
//!   and a syntax error is *ignored* (RFC 9110 allows it): the answer is the
//!   whole file.
//! * **What is ignored (answered `200`, whole file):** a list of ranges (a
//!   multipart answer built from overlapping ranges can be far larger than the
//!   file), a unit other than `bytes`, a malformed spec, a second `Range` header,
//!   `If-Range` (this server sends no validator, so it can never match), and an
//!   empty file.
//! * **What is refused (`416`):** a start at or past the end, and `-0`. The
//!   answer carries `Content-Range: bytes */<size>` and the usual JSON error body.
//!
//! Every answer — 200, 206, 416 and `HEAD` — carries `Content-Disposition:
//! attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private,
//! no-store, no-transform` and `Accept-Ranges: bytes`. A `206` is a download like
//! any other: **nothing here lets a browser render these bytes inline.**
//! `no-transform` asks an edge not to compress or otherwise rewrite them, which
//! would break the byte offsets a `Content-Range` promises.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use momo_drive::{ByteRange, DriveArchive, DriveError, MAX_ATTACHMENT_BYTES};
use momo_messaging::Attachment;

use crate::error::ApiError;
use crate::routes::attachments::drive_error;

/// What a request's `Range` asks of a file of a known size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadPlan {
    /// No usable `Range`: `200`, the whole file.
    Whole,
    /// One satisfiable range, already clamped to the file: `206`.
    Partial(ByteRange),
    /// A single range the file cannot satisfy: `416`.
    Unsatisfiable,
}

/// One `bytes=` range spec, as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeSpec {
    /// `first-last` or `first-`.
    Span { first: u64, last: Option<u64> },
    /// `-length`: the last `length` bytes.
    Suffix(u64),
}

/// Decide what to send for `headers` over a file of `size` bytes.
///
/// Call this **only** after the reader has been authorized and the attachment is
/// known to be complete.
pub(crate) fn plan(headers: &HeaderMap, size: u64) -> ReadPlan {
    // An empty file has no byte to ask for and none to refuse.
    if size == 0 {
        return ReadPlan::Whole;
    }
    // This server sends no validator (no ETag, no Last-Modified), so an
    // `If-Range` can never match: the request is for the whole file.
    if headers.contains_key(header::IF_RANGE) {
        return ReadPlan::Whole;
    }
    let mut values = headers.get_all(header::RANGE).iter();
    let (Some(value), None) = (values.next(), values.next()) else {
        // No `Range`, or more than one: not a single range to honour.
        return ReadPlan::Whole;
    };
    match value.to_str().ok().and_then(parse_single_range) {
        Some(spec) => resolve(spec, size),
        None => ReadPlan::Whole,
    }
}

/// `bytes=<spec>` with exactly one spec. `None` — "ignore this header" — for
/// everything else: another unit, a list, a spec that is not digits and one dash,
/// a number too long for a `u64`, an inverted span.
fn parse_single_range(value: &str) -> Option<RangeSpec> {
    let (unit, set) = value.split_once('=')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    // A list is ignored whole; it is never expanded into a multipart answer.
    if set.contains(',') {
        return None;
    }
    let (first, last) = set.split_once('-')?;
    match (first.is_empty(), last.is_empty()) {
        (true, true) => None,
        (true, false) => Some(RangeSpec::Suffix(decimal(last)?)),
        (false, true) => Some(RangeSpec::Span {
            first: decimal(first)?,
            last: None,
        }),
        (false, false) => {
            let (first, last) = (decimal(first)?, decimal(last)?);
            (last >= first).then_some(RangeSpec::Span {
                first,
                last: Some(last),
            })
        }
    }
}

/// ASCII digits only, at most twenty of them, and a value that fits a `u64`.
/// (`str::parse` alone would accept a leading `+`.)
fn decimal(text: &str) -> Option<u64> {
    if text.is_empty() || text.len() > 20 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Resolve `spec` against a file of `size` bytes (`size > 0`).
fn resolve(spec: RangeSpec, size: u64) -> ReadPlan {
    let last_index = size - 1;
    let (start, end) = match spec {
        RangeSpec::Span { first, last } => {
            if first >= size {
                return ReadPlan::Unsatisfiable;
            }
            (first, last.map_or(last_index, |last| last.min(last_index)))
        }
        RangeSpec::Suffix(0) => return ReadPlan::Unsatisfiable,
        // A suffix at least as long as the file is the whole file.
        RangeSpec::Suffix(length) => (size.saturating_sub(length), last_index),
    };
    ByteRange::new(start, end).map_or(ReadPlan::Unsatisfiable, ReadPlan::Partial)
}

/// The headers every read answer carries, whatever its status.
fn apply_read_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, no-transform"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
}

fn read_response(
    status: StatusCode,
    mime: &str,
    content_range: Option<String>,
    length: u64,
    body: Body,
) -> Result<Response, ApiError> {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime)
            .map_err(|error| ApiError::internal("attachments.content.mime", error))?,
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if let Some(content_range) = content_range {
        headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&content_range)
                .map_err(|error| ApiError::internal("attachments.content.range", error))?,
        );
    }
    apply_read_headers(headers);
    Ok(response)
}

/// `416` for a file of `size` bytes: the usual JSON error body, the read headers,
/// and `Content-Range: bytes */<size>`.
fn unsatisfiable(size: u64) -> Result<Response, ApiError> {
    let mut response = ApiError::new(
        StatusCode::RANGE_NOT_SATISFIABLE,
        "requested range not satisfiable",
    )
    .into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_RANGE,
        HeaderValue::from_str(&format!("bytes */{size}"))
            .map_err(|error| ApiError::internal("attachments.content.range", error))?,
    );
    apply_read_headers(headers);
    Ok(response)
}

/// The answer to a read of `attachment`, whose bytes live under `drive_file_id`.
///
/// `head_only` answers the same status and headers a `GET` would and **opens
/// nothing**: the archive is not asked for a byte, and its failures are not
/// visible (a `HEAD` that is `200` can be followed by a `GET` the archive fails).
pub(crate) async fn respond(
    drive: &dyn DriveArchive,
    attachment: &Attachment,
    drive_file_id: &str,
    headers: &HeaderMap,
    head_only: bool,
) -> Result<Response, ApiError> {
    // The row's size is checked non-negative by the `attachment_size_ck`
    // constraint; a value that is not is read as an empty file, never as a range
    // over bytes nobody measured.
    let size = u64::try_from(attachment.size_bytes).unwrap_or(0);
    let planned = plan(headers, size);
    if planned == ReadPlan::Unsatisfiable {
        return unsatisfiable(size);
    }
    // An empty file has no range to read: nothing to ask the archive, `GET` or
    // `HEAD`. (`plan` answers `Whole` for it whatever `Range` said.)
    if size == 0 {
        return read_response(StatusCode::OK, &attachment.mime, None, 0, Body::empty());
    }
    let (status, range) = match planned {
        ReadPlan::Partial(range) => (StatusCode::PARTIAL_CONTENT, range),
        // The whole file is the range `0..=size-1`, so a `GET` has one archive path
        // whatever the request said. `size` fits an `i64`, so this cannot be `None`.
        _ => (
            StatusCode::OK,
            ByteRange::new(0, size - 1).ok_or_else(|| drive_error(DriveError::UpstreamFailure))?,
        ),
    };
    let content_range = (status == StatusCode::PARTIAL_CONTENT)
        .then(|| format!("bytes {}-{}/{size}", range.start(), range.end()));
    let body = if head_only {
        Body::empty()
    } else {
        // The ceiling, not any effective limit: a file that is already complete
        // stays readable if an operator lowers what may be uploaded (D1).
        let archived = drive
            .file_range(drive_file_id, range, MAX_ATTACHMENT_BYTES)
            .await
            .map_err(drive_error)?;
        if archived.total_size_bytes != attachment.size_bytes {
            tracing::warn!(
                row_bytes = attachment.size_bytes,
                archive_bytes = archived.total_size_bytes,
                "attachment content refused: the archive's length disagrees with the row"
            );
            return Err(drive_error(DriveError::UpstreamFailure));
        }
        Body::from_stream(archived.body)
    };
    read_response(
        status,
        &attachment.mime,
        content_range,
        range.length(),
        body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                header::HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
                HeaderValue::from_str(value).expect("a header value"),
            );
        }
        map
    }

    fn planned(range: &str, size: u64) -> ReadPlan {
        plan(&headers(&[("range", range)]), size)
    }

    fn partial(start: u64, end: u64) -> ReadPlan {
        ReadPlan::Partial(ByteRange::new(start, end).expect("a range"))
    }

    /// **Red proof (D3 응답표, the grammar and the arithmetic).** Every line of the
    /// table for a ten-byte file, including the edges: `a-`, `-n`, `n` at and past
    /// the size, `b` past the end, the last byte, a start at the size, `-0`.
    #[test]
    fn the_range_table_for_a_ten_byte_file() {
        for (value, expected) in [
            ("bytes=0-0", partial(0, 0)),
            ("bytes=0-4", partial(0, 4)),
            ("bytes=5-", partial(5, 9)),
            ("bytes=9-", partial(9, 9)),
            ("bytes=9-9", partial(9, 9)),
            ("bytes=-3", partial(7, 9)),
            ("bytes=-1", partial(9, 9)),
            ("bytes=-10", partial(0, 9)),
            ("bytes=-11", partial(0, 9)),
            ("bytes=5-99", partial(5, 9)),
            ("bytes=0-9", partial(0, 9)),
            ("BYTES=2-3", partial(2, 3)),
            ("bytes=10-", ReadPlan::Unsatisfiable),
            ("bytes=10-12", ReadPlan::Unsatisfiable),
            ("bytes=99-", ReadPlan::Unsatisfiable),
            ("bytes=-0", ReadPlan::Unsatisfiable),
        ] {
            assert_eq!(planned(value, 10), expected, "{value}");
        }
    }

    /// **Red proof (D3 응답표).** What is *ignored* — answered with the whole file —
    /// rather than refused: lists, other units, malformed specs, inverted spans,
    /// signs, spaces, hex, and numbers too long for a `u64`.
    #[test]
    fn a_range_that_is_not_one_clean_bytes_spec_is_ignored() {
        for value in [
            "bytes=0-0,5-6",
            "bytes=0-1,",
            "bytes=,0-1",
            "items=0-1",
            "bytes",
            "bytes=",
            "bytes=-",
            "bytes=a-b",
            "bytes=1-0",
            "bytes=0-1-2",
            "bytes=+1-2",
            "bytes=1- 2",
            "bytes= 1-2",
            "bytes =1-2",
            "bytes=0x1-2",
            "bytes=1.5-2",
            "bytes=--1",
            "",
            "0-1",
            // u64::MAX + 1 (twenty digits that do not fit), and twenty-three digits.
            "bytes=18446744073709551616-",
            "bytes=0-18446744073709551616",
            "bytes=0-99999999999999999999999",
            "bytes=-99999999999999999999999",
            // Twenty-one digits is over the length limit even when the value is 0.
            "bytes=000000000000000000000-",
        ] {
            assert_eq!(planned(value, 10), ReadPlan::Whole, "{value:?}");
        }
    }

    /// **Red proof (D3 응답표, 검사된 산술).** The largest `u64` is read, not
    /// wrapped: as a start it is past the file (416); as an end it is clamped to the
    /// file's last byte; and a huge file's suffix and clamp do not overflow.
    #[test]
    fn the_edges_of_u64_do_not_wrap() {
        assert_eq!(
            planned("bytes=18446744073709551615-", 10),
            ReadPlan::Unsatisfiable
        );
        assert_eq!(planned("bytes=0-18446744073709551615", 10), partial(0, 9));
        assert_eq!(planned("bytes=-18446744073709551615", 10), partial(0, 9));
        let huge = i64::MAX as u64;
        assert_eq!(planned("bytes=-1", huge), partial(huge - 1, huge - 1));
        assert_eq!(
            planned("bytes=0-18446744073709551615", huge),
            partial(0, huge - 1)
        );
        // Twenty digits that all fit are a number like any other.
        assert_eq!(planned("bytes=00000000000000000003-", 10), partial(3, 9));
    }

    /// **Red proof (D3 응답표).** An empty file ignores `Range` altogether, `If-Range`
    /// (no validator is ever sent) and a second `Range` header ignore it too, and
    /// an unreadable header value does not panic.
    #[test]
    fn an_empty_file_if_range_and_repeated_headers_ignore_range() {
        assert_eq!(planned("bytes=0-0", 0), ReadPlan::Whole);
        assert_eq!(planned("bytes=5-", 0), ReadPlan::Whole);
        assert_eq!(
            plan(
                &headers(&[("range", "bytes=0-1"), ("if-range", "\"anything\"")]),
                10
            ),
            ReadPlan::Whole,
            "If-Range can never match: no validator was sent"
        );
        assert_eq!(
            plan(&headers(&[("range", "bytes=0-1"), ("if-range", "")]), 10),
            ReadPlan::Whole
        );
        assert_eq!(
            plan(
                &headers(&[("range", "bytes=0-1"), ("range", "bytes=2-3")]),
                10
            ),
            ReadPlan::Whole,
            "two Range headers are not one range"
        );
        let mut opaque = HeaderMap::new();
        opaque.insert(
            header::RANGE,
            HeaderValue::from_bytes(b"bytes=0-\xff").expect("opaque bytes"),
        );
        assert_eq!(plan(&opaque, 10), ReadPlan::Whole);
        assert_eq!(
            plan(&HeaderMap::new(), 10),
            ReadPlan::Whole,
            "no Range at all"
        );
    }

    #[test]
    fn every_read_answer_carries_the_four_headers() {
        let mut map = HeaderMap::new();
        apply_read_headers(&mut map);
        assert_eq!(map[header::CONTENT_DISPOSITION], "attachment");
        assert_eq!(map[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            map[header::CACHE_CONTROL],
            "private, no-store, no-transform"
        );
        assert_eq!(map[header::ACCEPT_RANGES], "bytes");
        let refused = unsatisfiable(10).expect("a 416");
        assert_eq!(refused.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(refused.headers()[header::CONTENT_RANGE], "bytes */10");
        assert_eq!(refused.headers()[header::CONTENT_DISPOSITION], "attachment");
        assert_eq!(refused.headers()[header::CONTENT_TYPE], "application/json");
    }
}
