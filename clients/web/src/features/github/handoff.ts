import { safeHttpsUrl, type GithubManifestStart } from "@momo/core/features/github/model";

// =============================================================================
// GitHub 앱 만들기의 브라우저 핸드오프 (ADR-0205 D2, #4220). 순수 모듈: window 를 읽지 않는다.
//
// 데스크탑 셸에는 GitHub 로 POST 하는 폼을 열 길이 없다(`target="_blank"` 가 죽은 컨트롤). 그래서
// 셸은 이 인스턴스 자신의 웹 SPA 주소 하나를 시스템 브라우저로 열고, 그 SPA 의 공개 경로
// (`GITHUB_HANDOFF_PATH`)가 받은 매니페스트를 GitHub 로 POST 한다. 서버는 바꾸지 않는다: 콜백은
// 이미 인증 없이 1회용 state 가 권한이고(`routes/github_app.rs` 머리 주석), 그래서 브라우저에는
// oort 로그인이 필요 없다.
//
// ## 비밀은 URL 조각(fragment)에만 있다
//
// 등록 주소의 `?state=` 와 매니페스트는 `#<payload>` 에만 실린다. 조각은 HTTP 요청에도 Referer 에도
// 실리지 않으므로 서버·프록시·접근 로그에 닿지 않는다. 쿼리스트링은 비어 있다(`search === ""`).
// 받는 쪽(`GithubHandoffPage`)은 착지 즉시 조각을 주소창에서 지운다. 시스템 브라우저의 방문 기록에
// 첫 방문 주소가 남는 것은 막을 수 없고 이슈가 허용한 범위다. state 는 한 번 쓰고 한 시간이면
// 끝난다.
//
// ## 받는 쪽은 남의 링크를 믿지 않는다
//
// 이 경로는 공개라서 누구나 조각을 지어 보낼 수 있다. 그래서 읽는 쪽이 (1) 등록 주소를 github.com 의
// 앱 만들기 경로 둘로, (2) 매니페스트의 콜백·수신 주소를 **이 페이지와 같은 오리진**으로 좁힌다.
// 낯선 서버로 GitHub 의 변환 코드가 돌아가게 짜인 매니페스트는 폼을 만들기 전에 거절된다.
// =============================================================================

/** 시스템 브라우저가 여는 공개 경로. 실제 pathname 이라 HashRouter 보다 먼저 App 이 가른다(claim·consent 와 같다). */
export const GITHUB_HANDOFF_PATH = "/github/handoff";

/** 서버가 매니페스트의 `redirect_url` 로 싣는 콜백 경로(`routes/github_app.rs`). GitHub 의 변환 코드가 여기로 온다. */
export const GITHUB_APP_CALLBACK_PATH = "/v1/integrations/github/app/callback";

/**
 * 데스크탑 opener(`clients/desktop/src-tauri/src/opener.rs` 의 `MAX_URL_LEN`)가 받는 가장 긴 주소.
 * 넘기면 셸이 거절하므로 보내는 쪽이 먼저 재고 직접 말한다(`buildGithubHandoffUrl`).
 */
export const GITHUB_HANDOFF_MAX_URL_LENGTH = 2048;

const PAYLOAD_VERSION = 1;
const MAX_PAYLOAD_CHARS = 4096;
const MAX_STATE_CHARS = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 서버 `is_valid_org_login` 과 같은 모양: 1~39자, 영문·숫자·하이픈, 양끝 하이픈 없음. */
const ORG_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const USER_PATH = "/settings/apps/new";
const ORG_PATH = /^\/organizations\/([^/]+)\/settings\/apps\/new$/;
const EXPIRES_MIN_SECONDS = 60;
const EXPIRES_MAX_SECONDS = 86_400;
const EXPIRES_DEFAULT_SECONDS = 3_600;

/** 핸드오프 경로에 서 있는가. 끝의 슬래시는 허용한다. */
export function isGithubHandoffPath(pathname: string): boolean {
  return pathname === GITHUB_HANDOFF_PATH || pathname === `${GITHUB_HANDOFF_PATH}/`;
}

// ---- 읽는 쪽 ---------------------------------------------------------------------

export type GithubHandoffTarget = { kind: "user" } | { kind: "organization"; login: string };

export interface GithubHandoff {
  /** POST 할 주소. github.com 의 앱 만들기 경로 + `?state=` 하나. */
  registrationUrl: string;
  /** 폼의 `manifest` 칸 값. */
  manifestJson: string;
  expiresInSeconds: number;
  /** 앱이 만들어질 곳. 사람이 눈으로 확인하는 줄에 쓴다. */
  target: GithubHandoffTarget;
  /** 이 페이지의 호스트(= GitHub 가 알림을 보낼 서버). */
  host: string;
  appName: string | null;
}

/**
 * 거절 사유는 닫힌 집합이다. 화면은 사유로 문장을 고를 뿐 조각의 어떤 조각도 되풀이하지 않는다.
 *   empty         조각이 없다(주소창에서 이미 지웠거나 그냥 열었다)
 *   unreadable    base64url·JSON·버전이 맞지 않는다
 *   registration  등록 주소가 github.com 의 앱 만들기 경로가 아니다
 *   manifest      매니페스트 모양이 아니다
 *   foreign       매니페스트가 이 서버의 것이 아니다(콜백·수신 주소가 다른 오리진)
 */
export type GithubHandoffRefusal = "empty" | "unreadable" | "registration" | "manifest" | "foreign";

export type GithubHandoffRead =
  | { ok: true; handoff: GithubHandoff }
  | { ok: false; refusal: GithubHandoffRefusal };

function refuse(refusal: GithubHandoffRefusal): GithubHandoffRead {
  return { ok: false, refusal };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsedUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function ownOrigin(value: unknown, origin: string): boolean {
  const url = parsedUrl(value);
  return url !== null && url.origin === origin && url.username === "" && url.password === "";
}

/**
 * 등록 주소가 GitHub 의 앱 만들기 경로 둘 중 하나이고 쿼리가 `state` 하나뿐이면, 행선지와 정규화한
 * 주소를 돌려준다. 폼은 원문이 아니라 이 정규화한 주소로 POST 한다.
 */
function registrationTarget(value: unknown): { target: GithubHandoffTarget; url: string } | null {
  const safe = typeof value === "string" ? safeHttpsUrl(value) : null;
  const url = safe === null ? null : parsedUrl(safe);
  if (url === null || url.hostname !== "github.com" || url.port !== "" || url.hash !== "") return null;
  const keys = [...url.searchParams.keys()];
  const state = url.searchParams.get("state");
  if (keys.length !== 1 || keys[0] !== "state" || state === null) return null;
  if (state.length === 0 || state.length > MAX_STATE_CHARS) return null;
  if (url.pathname === USER_PATH) return { target: { kind: "user" }, url: url.toString() };
  const org = ORG_PATH.exec(url.pathname)?.[1];
  if (org !== undefined && ORG_LOGIN.test(org)) {
    return { target: { kind: "organization", login: org }, url: url.toString() };
  }
  return null;
}

/** 이 페이지의 서버가 만든 매니페스트인가: 변환 코드가 오는 콜백과 수신 주소가 모두 이 오리진이다. */
function manifestIsOurs(manifest: Record<string, unknown>, origin: string): boolean {
  const redirect = parsedUrl(manifest.redirect_url);
  if (
    redirect === null ||
    redirect.origin !== origin ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.pathname !== GITHUB_APP_CALLBACK_PATH ||
    redirect.search !== "" ||
    redirect.hash !== ""
  ) {
    return false;
  }
  const hook = plainRecord(manifest.hook_attributes);
  for (const [value, present] of [
    [manifest.url, manifest.url !== undefined],
    [hook?.url, hook !== null && hook.url !== undefined],
    [manifest.setup_url, manifest.setup_url !== undefined],
  ] as const) {
    if (present && !ownOrigin(value, origin)) return false;
  }
  return true;
}

function decodePayload(text: string): unknown {
  if (text.length === 0 || text.length > MAX_PAYLOAD_CHARS || !BASE64URL.test(text)) return undefined;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * 주소의 조각(`window.location.hash`)을 읽어 폼을 만들어도 되는지 판정한다. `pageOrigin` 은 이 페이지의
 * `window.location.origin` 이다. 돌려주는 값 어디에도 조각의 원문을 되풀이하지 않는다.
 */
export function readGithubHandoff(hash: string, pageOrigin: string): GithubHandoffRead {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw === "") return refuse("empty");
  const payload = plainRecord(decodePayload(raw));
  if (payload === null || payload.v !== PAYLOAD_VERSION) return refuse("unreadable");

  const registration = registrationTarget(payload.u);
  if (registration === null) return refuse("registration");
  const manifest = plainRecord(payload.m);
  if (manifest === null) return refuse("manifest");
  if (!manifestIsOurs(manifest, pageOrigin)) return refuse("foreign");

  const expires = typeof payload.e === "number" && Number.isFinite(payload.e) ? payload.e : EXPIRES_DEFAULT_SECONDS;
  const name = typeof manifest.name === "string" && manifest.name.length <= 100 ? manifest.name : null;
  return {
    ok: true,
    handoff: {
      registrationUrl: registration.url,
      manifestJson: JSON.stringify(manifest),
      expiresInSeconds: Math.min(EXPIRES_MAX_SECONDS, Math.max(EXPIRES_MIN_SECONDS, Math.round(expires))),
      target: registration.target,
      host: new URL(pageOrigin).host,
      appName: name,
    },
  };
}

// ---- 보내는 쪽 ---------------------------------------------------------------------

/**
 * origin   매니페스트에 이 서버의 https 콜백이 없다(보낼 곳을 알 수 없다)
 * length   주소가 opener 의 한도를 넘는다(공개 주소가 아주 길 때만)
 * shape    받는 쪽이 거절할 모양이다(서버가 보낸 등록 정보가 계약과 다르다)
 */
export type GithubHandoffBuildFailure = "origin" | "length" | "shape";

export type GithubHandoffBuild =
  | { ok: true; url: string }
  | { ok: false; reason: GithubHandoffBuildFailure };

function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 시스템 브라우저가 열 주소: `<이 서버의 공개 오리진>/github/handoff#<payload>`.
 *
 * 오리진은 데스크탑이 접속한 주소가 아니라 **매니페스트의 콜백 오리진**(= `MOMO_PUBLIC_BASE_URL`)이다.
 * GitHub 가 돌려보내는 곳, 서버가 `?githubApp=` 로 303 하는 곳과 같은 곳이어야 브라우저가 한 서버
 * 안에서 끝난다. 쿼리스트링은 쓰지 않는다. 만든 주소는 받는 쪽 검사를 한 번 통과시켜 본다:
 * 받는 쪽이 거절할 주소는 열지 않는다.
 */
export function buildGithubHandoffUrl(start: GithubManifestStart): GithubHandoffBuild {
  const redirect = typeof start.manifest.redirect_url === "string" ? safeHttpsUrl(start.manifest.redirect_url) : null;
  const origin = redirect === null ? null : new URL(redirect).origin;
  if (origin === null) return { ok: false, reason: "origin" };

  const hash = encodePayload({
    v: PAYLOAD_VERSION,
    u: start.registrationUrl,
    m: start.manifest,
    e: start.expiresInSeconds,
  });
  const url = `${origin}${GITHUB_HANDOFF_PATH}#${hash}`;
  if (url.length > GITHUB_HANDOFF_MAX_URL_LENGTH) return { ok: false, reason: "length" };
  if (!readGithubHandoff(`#${hash}`, origin).ok) return { ok: false, reason: "shape" };
  return { ok: true, url };
}
