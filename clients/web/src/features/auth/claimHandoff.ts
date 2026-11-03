import {
  parseServerBeforeClaim,
  serializeServerBeforeClaim,
  type ServerBeforeClaim,
} from "@momo/core/features/auth/claimServerMemo";
import { normalizeServerUrl } from "@/lib/serverBase";
import { CLAIM_PATH_PREFIX } from "./claimPath";

// =============================================================================
// D0에 붙여 넣은 claim 링크를 #2811(OB2-5)의 claim 화면으로 넘긴다 (#2808).
//
// claim 화면은 HashRouter 밖의 실경로 `/claim/<token>`이고(claimPath.ts, 이 묶음은
// 그 파일을 건드리지 않는다), App이 첫 그림에서 경로를 보고 가른다. 그래서 넘기는
// 방법은 페이지 이동 하나다. `ClaimPage.openConnectScreen`이 반대 방향으로 이미
// 쓰는 방식이다.
//
//   브라우저, 같은 출처   이 페이지의 `/claim/<token>`
//   브라우저, 다른 출처   그 링크 자체(그 서버가 자기 웹 클라를 낸다)
//   데스크탑(Tauri)       서버를 링크의 출처로 저장하고, 앱 번들의 `/claim/<token>`
//
// 토큰은 로그·저장소에 남기지 않는다. 주소창에 잠깐 서는 것은 링크를 연 것과 같다.
// =============================================================================

export type ClaimHandoff = {
  /**
   * 이 기기의 서버 선택을 무엇으로 바꿀까. `undefined`면 건드리지 않는다(다른
   * 출처로 떠나는 페이지). `null`이면 같은 출처로 되돌린다: claim은 이 페이지의
   * 서버에 해야 하는데, 전에 다른 서버를 골라 둔 기기라면 그쪽으로 갈 것이다.
   */
  serverBase: string | null | undefined;
  /** 이동할 주소. */
  href: string;
};

export function claimHandoff(input: {
  origin: string;
  token: string;
  pageOrigin: string;
  isTauri: boolean;
}): ClaimHandoff {
  const path = `${CLAIM_PATH_PREFIX}${input.token}`;
  if (input.isTauri) {
    const checked = normalizeServerUrl(input.origin);
    return { serverBase: checked.ok ? checked.base : undefined, href: path };
  }
  if (input.origin === input.pageOrigin) {
    return { serverBase: null, href: path };
  }
  return { serverBase: undefined, href: `${input.origin}${path}` };
}

// -----------------------------------------------------------------------------
// 링크가 바꾸기 전의 서버 선택 (ADR-0215 D8, #4601).
//
// 데스크탑은 링크의 출처를 **먼저 저장하고** 나서 claim 화면으로 간다(그 화면이 그 서버로 비밀번호를
// 보내므로). 그런데 claim 화면은 사용자가 서버를 확인한 뒤에야 비밀번호 칸을 연다: 「아니에요」를
// 누르면 링크가 저장해 둔 서버가 그대로 남아 로그인 화면이 공격자 서버를 가리키게 된다. 그래서
// 바꾸기 전의 선택을 이 탭의 세션에 한 번 적어 두고, 거절하면 그것으로 되돌린다. 값은 서버 주소
// 하나이고 토큰이 아니다. 세션 저장소가 막힌 환경에서는 적지 못하고, 그때 거절은 선택을 비운다.
// -----------------------------------------------------------------------------

const BEFORE_CLAIM_KEY = "momo.claim.serverBeforeLink.v1";

/** 링크가 서버를 바꾸기 직전, 그때의 선택(없으면 null)을 적어 둔다. */
export function rememberServerBeforeClaim(previous: string | null): void {
  try {
    sessionStorage.setItem(BEFORE_CLAIM_KEY, serializeServerBeforeClaim(previous));
  } catch {
    // 적지 못하면 거절이 선택을 비우는 쪽으로 안전하게 떨어진다.
  }
}

/** 적어 둔 선택을 꺼내며 지운다. 적어 둔 것이 없거나 읽을 수 없으면 `found: false`. */
export function takeServerBeforeClaim(): ServerBeforeClaim {
  try {
    const raw = sessionStorage.getItem(BEFORE_CLAIM_KEY);
    sessionStorage.removeItem(BEFORE_CLAIM_KEY);
    return parseServerBeforeClaim(raw);
  } catch {
    return { found: false };
  }
}

/** 페이지 이동. 시험이 갈아 끼우는 자리다(jsdom에는 `location.assign`이 없다). */
export function navigateTo(href: string): void {
  window.location.assign(href);
}
