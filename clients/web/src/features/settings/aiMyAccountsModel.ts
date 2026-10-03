import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  HIDDEN_DEFAULTS_STORAGE_KEY,
  parseHiddenDefaults,
  serializeHiddenDefaults,
  type HarnessProfileRef,
  type UnlinkFailure,
  type UnlinkPhase,
} from "@momo/core/features/settings/harnessProfiles";
import type { SubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";

// =============================================================================
// 「내 계정 · 이 맥」 절의 문장과 판정 (#2944 GC-3).
//
// AI의 이 절(`AiMyAccountsSection`)과 채팅의 로컬 연결 카드
// (`features/chat/AiConnectCard`)가 **같은 줄**을 그린다. 두 곳이 서로 다른 문장이나
// 다른 「브라우저 탭」 판정을 갖지 않게 여기 한 번만 둔다. 알약 판정은 코어
// `aiLinkPill.ts`(#2941)다.
// =============================================================================

export const MY_ACCOUNTS_EMPTY_LINE = "아직 연결한 구독이 없어요.";
export const MY_ACCOUNTS_EMPTY_DETAIL =
  "Claude나 ChatGPT 구독이 있으면 이 맥의 공식 CLI로 붙일 수 있어요.";
export const MY_ACCOUNTS_BROWSER_LINE =
  "구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요. 이 브라우저 탭에는 이 맥의 CLI가 없어요.";
export const MY_ACCOUNTS_DENIED_DETAIL =
  "구독으로 쓰는 에이전트는 워크스페이스 소유자·관리자가 만들 수 있어요.";

/**
 * 이 화면이 브라우저 탭인가. design 캡처의 `?aiEntry=desktop-only`는 브라우저
 * 탭을 흉내 낸다. 그 밖에는 셸 종류가 답한다. 빌드가 구독 표면을 걷었어도
 * 브라우저 탭 사실은 그대로다.
 */
export function myAccountsBrowserTab(state: SubscriptionEntryState, isTauri: boolean): boolean {
  return state === "desktop-only" || (!isTauri && state !== "rows" && state !== "server-off");
}

/**
 * design 모드 캡처 전용: `?aiProbe=claude-ready` · `?aiProbe=login`. 브라우저에는
 * 이 맥의 CLI가 없어 감지 결과를 셸 없이 세울 수 없다. 제품 빌드에서는 늘 null이다.
 */
export function readProbeFixture(): LocalHarnessProbe[] | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  const pose = new URLSearchParams(query).get("aiProbe");
  if (pose === "claude-ready") {
    return [
      { id: "claude", installed: true, auth: "logged_in" },
      { id: "codex", installed: true, auth: "needs_login" },
    ];
  }
  if (pose === "login") {
    return [
      { id: "claude", installed: true, auth: "needs_login" },
      { id: "codex", installed: true, auth: "needs_login" },
    ];
  }
  return null;
}

// ---- #2878: 프로필 줄·해제·추가의 design 캡처 픽스처와 이 기기 설정 ------------------

/** design 모드 캡처 전용 쿼리 값. 제품 빌드에서는 늘 null. */
export function readDesignParam(name: string): string | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  return new URLSearchParams(query).get(name);
}

/**
 * `?aiProfiles=demo`: 프로필 두 줄(개인 로그인됨 · 회사 로그인 필요). 셸 없이 프로필
 * 줄을 그리려는 캡처용이다.
 */
export function readProfilesFixture(): {
  profiles: HarnessProfileRef[];
  status: Record<string, LocalHarnessProbe>;
} | null {
  if (readDesignParam("aiProfiles") !== "demo") return null;
  return {
    profiles: [
      { harness: "claude", label: "개인" },
      { harness: "claude", label: "회사" },
      // 32자 한도 가까운 한글+라틴 라벨: 좁은 폭에서 줄이 잘리지 않는지 본다.
      { harness: "codex", label: "회사 메인 Pro 계정 (팀 공용 아님, 개인 결제)" },
    ],
    status: {
      "claude/개인": { id: "claude", installed: true, auth: "logged_in" },
      "claude/회사": { id: "claude", installed: true, auth: "needs_login" },
      "codex/회사 메인 Pro 계정 (팀 공용 아님, 개인 결제)": { id: "codex", installed: true, auth: "logged_in" },
    },
  };
}

/** `?aiUnlink=<phase>[:<reason>]` → 회사 줄의 해제 창을 그 상태로. */
export function readUnlinkFixture(): UnlinkPhase | null {
  const raw = readDesignParam("aiUnlink");
  if (raw === null) return null;
  const [phase, reason] = raw.split(":");
  if (phase === "failed") {
    return { phase: "failed", reason: (reason as UnlinkFailure) || "logout-failed" };
  }
  if (phase === "confirm" || phase === "signing-out" || phase === "removing") return { phase };
  return null;
}

export function readHiddenDefaults(): LocalHarnessId[] {
  try {
    return parseHiddenDefaults(window.localStorage.getItem(HIDDEN_DEFAULTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeHiddenDefaults(ids: readonly LocalHarnessId[]): void {
  try {
    window.localStorage.setItem(HIDDEN_DEFAULTS_STORAGE_KEY, serializeHiddenDefaults(ids));
  } catch {
    // 저장할 수 없는 창(사생활 보호 모드 등): 이번 화면에서만 빠진다.
  }
}
