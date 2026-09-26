import { parseJoinDeepLink, parseJoinFromPageUrl } from "@momo/core/features/auth/deepLink";
import { normalizeServerUrl } from "@/lib/serverBase";
import { CLAIM_PATH_PREFIX, readClaimToken } from "./claimPath";

// =============================================================================
// D0 한 칸 판별 (ADR-0193 D7, #2808 OB2-2).
//
// 첫 화면의 입력 칸 하나가 팀 주소·초대 링크·claim 링크를 가른다. 사람은 메신저
// 창에서 통째로 복사해 온 문단, 따옴표, 줄바꿈, 앞뒤 공백을 그대로 붙여 넣는다.
// 그래서 순서는 (1) 잡음을 걷고 (2) 링크 모양 낱말을 먼저 찾고 (3) 그 낱말 하나를
// 판정한다. DOM이 없는 순수 함수다(표 시험이 node에서 돈다).
//
// 갈래:
//   invite  `oort://join?server=…&code=…`, `https://host/?code=…`, `?join=…`,
//           초대 코드만(서버 없음). → D1′
//   claim   `https://host/claim/<token>` → #2811의 claim 화면(D1″)
//   server  `team.example.com`, `http://10.0.0.5:8080/`, `https://Team.Example.com`
//           → D1 로그인
//   invalid 그 밖. 무엇을 넣으면 되는지 합니다체로 말한다.
//
// `oort://claim/…`의 모양은 #2812(OB2-6)의 계약이라 여기서 새로 정하지 않는다.
// 알아보되 이 칸에서는 받지 않는다고 말한다.
// =============================================================================

export type EntryDecision =
  | { kind: "empty" }
  | { kind: "invite"; serverUrl: string; inviteCode: string }
  | { kind: "claim"; origin: string; token: string }
  | { kind: "server"; base: string }
  | { kind: "invalid"; message: string };

/** 서버가 만드는 초대 코드: base64url, 16~64바이트 → 22~86자(migration 003). */
const INVITE_CODE_SHAPE = /^[A-Za-z0-9_-]{22,86}$/;

/** 붙여 넣기에 딸려 오는 보이지 않는 글자: 폭 없는 공백·BOM·방향 표시. */
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF]/g;

/** 링크를 감싸는 따옴표·괄호·꺾쇠, 문장 끝 구두점. */
const WRAPPERS = /^[\s"'`“”‘’<(（「『[]+|[\s"'`“”‘’>)）」』\].,;:!?。、]+$/g;

const LINK_TOKEN = /(?:oort|momo|https?):\/?\/?[^\s"'`“”‘’<>）」』]+/gi;

const MSG_UNKNOWN =
  "팀 주소나 초대 링크로 읽을 수 없습니다. 받은 주소를 그대로 붙여 넣으세요. 예: https://team.example.com";
const MSG_CLAIM_BROKEN =
  "claim 링크가 잘렸습니다. 설치가 끝날 때 나온 주소를 끝까지 복사해 붙여 넣으세요.";
const MSG_CLAIM_SCHEME =
  "이 칸은 oort://claim 링크를 아직 받지 않습니다. 설치가 끝날 때 나온 https 주소를 붙여 넣으세요.";
const MSG_DEVICE_LINK =
  "기기 연결 링크입니다. 폰의 oort 앱에서 여세요. 이 칸에는 팀 주소나 초대 링크를 넣습니다.";

function strip(value: string): string {
  return value.replace(INVISIBLE, "").replace(WRAPPERS, "");
}

/** 붙여 넣은 덩어리에서 판정할 낱말 하나를 고른다. 링크가 있으면 첫 링크. */
export function pickEntryToken(raw: string): string {
  const cleaned = raw.replace(INVISIBLE, "").trim();
  if (cleaned === "") return "";
  const links = cleaned.match(LINK_TOKEN);
  if (links && links.length > 0) {
    // 초대 카드처럼 링크 여럿이 든 글이면 초대·claim 링크를 앞세운다.
    const preferred =
      links.find((link) => /^(?:oort|momo):/i.test(link)) ??
      links.find((link) => /\/claim\//i.test(link)) ??
      links[0];
    return strip(preferred);
  }
  const words = cleaned.split(/\s+/).map(strip).filter(Boolean);
  return words.length === 1 ? words[0] : strip(cleaned);
}

function looksLikeHost(token: string): boolean {
  if (/\s/.test(token)) return false;
  const host = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  if (host === "") return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  if (name === "localhost") return true;
  if (/^\[[0-9a-f:]+\]$/i.test(name)) return true;
  return name.includes(".") && !name.startsWith(".") && !name.endsWith(".");
}

function fromCustomScheme(token: string): EntryDecision | null {
  if (!/^(?:oort|momo):/i.test(token)) return null;
  const join = parseJoinDeepLink(token);
  if (join) {
    if (join.inviteCode !== "") {
      return { kind: "invite", serverUrl: join.serverUrl, inviteCode: join.inviteCode };
    }
    if (join.serverUrl !== "") return { kind: "server", base: join.serverUrl };
  }
  const action = token.replace(/^(?:oort|momo):\/*/i, "").split(/[/?#]/)[0]?.toLowerCase();
  if (action === "claim") return { kind: "invalid", message: MSG_CLAIM_SCHEME };
  if (action === "link") return { kind: "invalid", message: MSG_DEVICE_LINK };
  return { kind: "invalid", message: MSG_UNKNOWN };
}

function fromWebUrl(token: string): EntryDecision | null {
  if (!/^https?:\/\//i.test(token)) return null;
  let url: URL;
  try {
    url = new URL(token);
  } catch {
    return { kind: "invalid", message: MSG_UNKNOWN };
  }
  if (url.hostname === "") return { kind: "invalid", message: MSG_UNKNOWN };
  const path = url.pathname;
  const lower = path.toLowerCase();
  if (lower === "/claim" || lower.startsWith(CLAIM_PATH_PREFIX)) {
    // 경로 머리의 대소문자만 접는다. 토큰은 대소문자를 가리므로 그대로 둔다.
    const claimToken = readClaimToken(
      `${CLAIM_PATH_PREFIX}${path.slice(CLAIM_PATH_PREFIX.length)}`
    );
    return claimToken === null
      ? { kind: "invalid", message: MSG_CLAIM_BROKEN }
      : { kind: "claim", origin: url.origin, token: claimToken };
  }
  const join = parseJoinFromPageUrl(url.toString());
  if (join && join.inviteCode !== "") {
    // 웹 초대 링크(`https://team/?code=…`)는 서버를 따로 싣지 않는다. 그 페이지를
    // 낸 곳이 서버다.
    const origin = normalizeServerUrl(url.origin);
    return {
      kind: "invite",
      serverUrl: join.serverUrl !== "" ? join.serverUrl : origin.ok ? origin.base : "",
      inviteCode: join.inviteCode,
    };
  }
  const checked = normalizeServerUrl(`${url.origin}${url.pathname}`);
  return checked.ok
    ? { kind: "server", base: checked.base }
    : { kind: "invalid", message: checked.message };
}

/** D0 입력 칸의 판정. 같은 입력에 늘 같은 답을 낸다. */
export function classifyEntry(raw: string): EntryDecision {
  const token = pickEntryToken(raw);
  if (token === "") return { kind: "empty" };

  const custom = fromCustomScheme(token);
  if (custom) return custom;

  const web = fromWebUrl(token);
  if (web) return web;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
    return {
      kind: "invalid",
      message: "주소는 http:// 또는 https:// 로 시작해야 합니다.",
    };
  }

  if (looksLikeHost(token)) {
    // 스킴 없는 `host:port`를 먼저 https로 읽는다. 그대로 넘기면 `normalizeServerUrl`의
    // 스킴 판별이 `team.example.com:`을 스킴으로 읽어 거절한다.
    const checked = normalizeServerUrl(`https://${token}`);
    if (checked.ok) return { kind: "server", base: checked.base };
    return { kind: "invalid", message: checked.message };
  }

  if (INVITE_CODE_SHAPE.test(token)) {
    return { kind: "invite", serverUrl: "", inviteCode: token };
  }

  return { kind: "invalid", message: MSG_UNKNOWN };
}

/** 서버 주소에서 사람에게 보일 부분(스킴 없이 호스트·포트·경로). */
export function serverLabel(base: string): string {
  return base.replace(/^https?:\/\//i, "");
}
