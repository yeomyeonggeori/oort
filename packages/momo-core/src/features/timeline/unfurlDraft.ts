// =============================================================================
// 보내기 전 입력칸의 링크 미리보기가 따르는 규칙 (#5005, ADR-0170 증보 2026-11-01 D22).
//
// 이 모듈은 React도 전송도 모른다. 웹 입력칸이 지금 쓰고, 폰 입력칸(후속 이슈)이 그대로 읽는다.
// 화면 쪽에 규칙이 갈라져 있으면 「미리보기에는 보이는데 보낸 뒤에는 카드가 안 생기는」 어긋남이
// 난다(D22). 그래서 아래 추출은 서버(`server-rust/crates/momo-unfurl/src/extract.rs`·`normalize.rs`)를
// **단계마다 그대로** 옮겼고, `unfurlDraft.test.ts`가 서버 시험 네 개를 같은 입력으로 다시 돈다.
//
//   코드 블록·인라인 코드는 먼저 걷어낸다 (그 안의 주소는 카드가 되지 않는다)
//   → `http://`·`https://`를 대소문자 가리지 않고 찾는다 (이메일은 이 글자가 없어 걸리지 않는다)
//   → 공백이나 `<>"'[]{}|\` 앞까지 한 덩어리로 떼고, 끝의 `.,;:!?)]`를 걷는다
//   → 주소 모양을 맞춘다 (조각 제거, 호스트 소문자, 기본 포트 제거, 경로 끝 `/` 제거)
//   → 서로 다른 주소만, 앞에서 3개까지.
//
// 같은 글은 같은 주소 목록을 낸다. 그 목록이 화면의 「같은 주소는 다시 묻지 않음」 열쇠이자,
// 「링크를 바꾸면 다시 뜬다」를 가르는 기준이다.
// =============================================================================

import { UNFURL_MAX_CARDS, type UnfurlPreview, type UnfurlPreviewFailed } from "./unfurl";

/** 입력을 멈추고 이만큼 지나야 묻는다. 한 글자마다 묻지 않으려는 기다림이다(D22 권고). */
export const UNFURL_PREVIEW_DEBOUNCE_MS = 350;

/**
 * 받아 둔 카드를 이만큼 쓴다. 서버는 `ok`를 30분 기억하고 미리보기 열쇠(그림·아이콘 경로)도 그 항목과
 * 함께 사라진다(D18·D19). 그보다 조금 짧게 잡아, 죽은 열쇠로 그림을 부르는 일이 드물게 한다.
 */
export const UNFURL_PREVIEW_OK_MEMORY_MS = 25 * 60 * 1000;

/** `failed`는 서버도 2분만 기억한다. 일시적 실패가 이 화면에서 영영 남지 않게 같은 길이로 맞춘다. */
export const UNFURL_PREVIEW_FAILED_MEMORY_MS = 2 * 60 * 1000;

/** 429가 말한 기다림의 상한(초). 서버의 예산 창(60초)보다 길게 기다릴 이유가 없다. */
export const UNFURL_PREVIEW_RETRY_CEILING_SECONDS = 60;

/** 받아 둔 답을 얼마나 오래 쓰는가. `ok`는 길게, `failed`는 짧게다. */
export function unfurlPreviewMemoryMs(preview: UnfurlPreview): number {
  return preview.status === "ok" ? UNFURL_PREVIEW_OK_MEMORY_MS : UNFURL_PREVIEW_FAILED_MEMORY_MS;
}

/** 서버가 이 주소는 안 된다고 거절했을 때(4xx) 기억해 둘 답. 서버의 `failed`와 같은 모양이다. */
export function failedPreviewFor(url: string): UnfurlPreviewFailed {
  return { status: "failed", url };
}

/** 서버가 받는 주소의 상한(바이트, UTF-8). 넘으면 서버 추출도 이 주소를 버린다. */
export const UNFURL_PREVIEW_URL_MAX_BYTES = 2_048;

// ---- 코드 걷어내기 ------------------------------------------------------------

/**
 * 서버 `strip_fences`와 같다. 닫히지 않은 펜스는 **여는 표시만** 걷고 그 뒤 글은 남긴다(서버가
 * `None => break` 뒤에 나머지를 붙인다). 글을 쓰는 중에는 코드 블록이 아직 안 닫힌 때가 흔하고,
 * 그 상태에서 서버가 카드를 만드는 주소와 어긋나지 않게 하려는 것이다.
 */
function stripFences(body: string): string {
  let out = "";
  let rest = body;
  for (;;) {
    const start = rest.indexOf("```");
    if (start < 0) break;
    out += rest.slice(0, start);
    rest = rest.slice(start + 3);
    const end = rest.indexOf("```");
    if (end < 0) break;
    rest = rest.slice(end + 3);
  }
  return out + rest;
}

/** 서버 `strip_inline`과 같다. 닫히지 않은 백틱은 그 뒤 글을 끝까지 먹는다. */
function stripInlineCode(body: string): string {
  let out = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body.charAt(index);
    if (char !== "`") {
      out += char;
      continue;
    }
    const close = body.indexOf("`", index + 1);
    if (close < 0) break;
    index = close;
  }
  return out;
}

// ---- 한 덩어리 떼기 ------------------------------------------------------------

const SCHEME = /https?:\/\//gi;

// Rust `char::is_whitespace`(유니코드 White_Space)와 같은 집합이다. JS의 `\s`는 U+FEFF를 넣고 U+0085를
// 빼서 서버와 갈라진다. 정규식에 보이지 않는 글자를 적지 않으려고 숫자로 적는다.
function isWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** 공백 말고 서버가 주소의 끝으로 치는 문자들(`take_url`). */
const URL_DELIMITERS = "<>\"'[]{}|\\";

/** `from`에서 시작하는 한 덩어리의 끝 위치(서버 `take_url`). */
function urlEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (isWhitespace(text.charCodeAt(index)) || URL_DELIMITERS.includes(text.charAt(index))) {
      return index;
    }
  }
  return text.length;
}

/** 서버 `trim_trailing_punct`. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

// ---- 주소 모양 맞추기 -----------------------------------------------------------

function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** 서버 `split_authority`의 IPv6가 아닌 가지(`[`는 덩어리를 끊는 문자라 여기까지 오지 않는다). */
function splitAuthority(authority: string): { host: string; port: number | null } | null {
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return { host: asciiLowercase(authority), port: null };
  const rawPort = authority.slice(colon + 1);
  // Rust `u16::from_str`: 숫자(앞의 `+` 하나는 허용)이고 0..=65535.
  if (!/^\+?\d+$/.test(rawPort)) return null;
  const port = Number(rawPort);
  if (port > 65_535) return null;
  return { host: asciiLowercase(authority.slice(0, colon)), port };
}

/** 서버는 호스트를 ASCII 대문자만 내린다(`to_ascii_lowercase`). 다른 글자는 그대로 둔다. */
function asciiLowercase(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function trimTrailingSlash(pathAndQuery: string): string {
  const question = pathAndQuery.indexOf("?");
  if (question >= 0) {
    const path = pathAndQuery.slice(0, question);
    const query = pathAndQuery.slice(question + 1);
    return path !== "/" && path.endsWith("/")
      ? `${path.replace(/\/+$/, "")}?${query}`
      : pathAndQuery;
  }
  return pathAndQuery.endsWith("/") && pathAndQuery !== "/"
    ? pathAndQuery.replace(/\/+$/, "")
    : pathAndQuery;
}

/**
 * 서버 `normalize_url`(`parse_outbound_url`의 모양 검사까지). 조각(`#…`)은 먼저 버린다 — 조각은
 * 네트워크에 가지 않고, 서버로 보낼 이유도 없다. 모양이 아니면 `null`.
 */
function normalizeLikeServer(raw: string): string | null {
  const hash = raw.indexOf("#");
  const value = hash < 0 ? raw : raw.slice(0, hash);
  if (value === "" || utf8Length(value) > UNFURL_PREVIEW_URL_MAX_BYTES) return null;
  const split = value.indexOf("://");
  if (split < 0) return null;
  const scheme = asciiLowercase(value.slice(0, split));
  if (scheme !== "https" && scheme !== "http") return null;
  const rest = value.slice(split + 3);
  const boundary = rest.search(/[/?]/);
  const authority = boundary < 0 ? rest : rest.slice(0, boundary);
  const tail = boundary < 0 ? "" : rest.slice(boundary);
  // 주소 안의 계정 정보는 서버도 받지 않는다(조용히 걷지 않고 거절).
  if (authority === "" || authority.includes("@")) return null;
  const parts = splitAuthority(authority);
  if (parts === null || parts.host === "") return null;
  const pathAndQuery = trimTrailingSlash(tail === "" ? "/" : tail.startsWith("?") ? `/${tail}` : tail);
  const isDefaultPort =
    (scheme === "https" && parts.port === 443) || (scheme === "http" && parts.port === 80);
  return parts.port !== null && !isDefaultPort
    ? `${scheme}://${parts.host}:${parts.port}${pathAndQuery}`
    : `${scheme}://${parts.host}${pathAndQuery}`;
}

// ---- 공개 ------------------------------------------------------------------------

/**
 * 이 글이 보내지면 서버가 카드로 만들 주소들, 글에 나온 순서로 서로 다른 것 3개까지(서버
 * `extract_urls`). 모양은 서버가 정규화한 것과 같다(소문자 호스트, 조각 없음). 이 주소를 그대로
 * 미리보기 요청에 싣고, 같은 주소의 기억·「링크가 바뀌었는가」의 열쇠로도 쓴다.
 */
export function draftPreviewLinks(body: string): string[] {
  const scanned = stripInlineCode(stripFences(body));
  const found: string[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < scanned.length) {
    SCHEME.lastIndex = index;
    const hit = SCHEME.exec(scanned);
    if (!hit) break;
    const start = hit.index;
    const end = urlEnd(scanned, start);
    // 서버는 덩어리 길이만큼(최소 1) 나아간다. 같은 자리에서 멈추는 일이 없게 하는 줄이다.
    index = start + Math.max(end - start, 1);
    const key = normalizeLikeServer(trimTrailingPunctuation(scanned.slice(start, end)));
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    found.push(key);
    if (found.length >= UNFURL_MAX_CARDS) break;
  }
  return found;
}
