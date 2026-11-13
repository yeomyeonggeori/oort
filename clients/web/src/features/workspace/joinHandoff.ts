import { JOIN_URL_PARAMS } from "@momo/core/features/auth/deepLink";
import type { EntryDecision } from "@/features/auth/entryInput";

// =============================================================================
// 「이미 있는 곳에 참여」가 로그인 화면으로 링크를 넘기는 길 (#5785, QA 14 1단).
//
// 앱은 로그인을 하나만 든다(세션 묶음과 전환은 ADR-0161 4b-3, 아직 없음). 그래서 로그인한 채로는
// 다른 워크스페이스에 들어갈 수 없고, 참여는 「로그아웃 → 로그인 화면」이다. 이 파일은 그 넘김의
// 두 조각을 DOM 없이 진다:
//
//   1. 무엇을 넘길 수 있나 — 로그인 화면의 첫 칸과 **같은 판정**(`classifyEntry`)을 쓴다. 다르게
//      판정하면 이 창이 받은 링크를 로그인 화면이 거절하는 막다른 길이 생긴다. 넘기는 것은 팀 주소와
//      초대 링크뿐이다. claim 링크(첫 소유자·재설정)는 로그인 화면이 자기 길(`openClaimLink`)로
//      다루는 것이라 여기서 받지 않는다고 말한다.
//   2. 어떻게 넘기나 — 로그인 화면은 마운트될 때 페이지 주소에서 `server`·`code`를 읽는다
//      (`useJoinPrefill` → `parseJoinFromPageUrl`, 다 읽으면 주소창에서 지운다). 그래서 로그아웃
//      **전에** 지금 주소에 그 두 값을 얹는다. 로그아웃은 같은 틱에 세션을 비우고 로그인 화면을
//      새로 마운트한다(`app/session.tsx` signOut).
//
// 해시는 `#/`로 돌린다: 다른 워크스페이스에 로그인한 뒤 앞 워크스페이스의 채널 주소로 떨어지지 않게.
// =============================================================================

export type JoinTarget =
  | { kind: "server"; serverUrl: string }
  | { kind: "invite"; serverUrl: string; inviteCode: string };

export type JoinEntryResult =
  | { ok: true; target: JoinTarget }
  | { ok: false; reason: "empty" | "claim" }
  | { ok: false; reason: "invalid"; message: string };

/** 로그인 화면의 첫 칸이 내린 판정을, 이 창이 넘길 수 있는 것과 없는 것으로 가른다. */
export function joinTargetFromEntry(decision: EntryDecision): JoinEntryResult {
  switch (decision.kind) {
    case "server":
      return { ok: true, target: { kind: "server", serverUrl: decision.base } };
    case "invite":
      return {
        ok: true,
        target: {
          kind: "invite",
          serverUrl: decision.serverUrl,
          inviteCode: decision.inviteCode,
        },
      };
    case "empty":
      return { ok: false, reason: "empty" };
    case "claim":
      return { ok: false, reason: "claim" };
    case "invalid":
      return { ok: false, reason: "invalid", message: decision.message };
  }
}

/**
 * 로그아웃 직전에 쓸 주소: 지금 주소에서 옛 참여 값을 걷고 넘길 값만 얹고, 해시는 첫 화면.
 * 초대 코드는 bearer 비밀이지만 로그인 화면이 읽는 순간 주소창에서 지운다(`urlWithoutJoinParams`).
 */
export function joinHandoffHref(href: string, target: JoinTarget): string {
  const url = new URL(href);
  for (const name of JOIN_URL_PARAMS) url.searchParams.delete(name);
  if (target.serverUrl !== "") url.searchParams.set("server", target.serverUrl);
  if (target.kind === "invite") url.searchParams.set("code", target.inviteCode);
  url.hash = "#/";
  return url.toString();
}
