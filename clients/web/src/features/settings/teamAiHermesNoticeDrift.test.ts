import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 드리프트 가드: 설정 화면의 Hermes 고지와 서버 고지의 글자 (ADR-0201 증보 v4 P10, #5375 수리 1회차 · 검수 M6).
//
// 켤 때 서버는 「고지 판 2026-11-06.v2를 보였다」고 기록한다. 그 판의 글은 서버 `momo_agent::team_ai_roles::NOTICE_HERMES`
// 이고, 화면이 실제로 보이는 글은 사전 `teamAi.roles.noticeHermes`(ko-KR)다. 둘을 잇는 것이 없으면 한쪽만 고쳐도 시험이
// 초록이라, 기록이 가리키는 글과 화면 글이 조용히 갈라진다.
//
// 지금 두 글은 **끝 구절 하나만** 다르다: 서버 「운영자 설정이에요.」 ↔ 화면 「서버 운영자가 정해요.」. 화면 쪽 글자는 디자인
// 검사의 옛 용어 목록(`LEGACY_TERM_MAP`의 「운영자 설정」 → 「팀 AI 키」)이 막아 서버 글자를 그대로 쓸 수 없다(이 수리
// 회차에 실측: 사전을 서버 글자로 바꾸면 core `legacy_term` 1건으로 빨갛다). 그래서 이 시험은 그 차이를 **선언한 한 곳**으로
// 묶는다: 화면 글의 끝 구절을 서버 끝 구절로 바꾸면 서버 글과 글자까지 같아야 한다. 앞의 두 문장, 끝 구절, 어느 쪽이든
// 다른 글자가 바뀌면 빨갛다. 차이를 없애기로 정하면(서버 글을 바꾸거나 화면 예외를 두거나) 아래 두 상수를 같은 값으로 둔다.
//
// 서버 글은 매번 Rust 소스에서 읽는다(선례: `features/auth/passwordRuleDrift.test.ts` — 코어 시험은 `node:fs`를 쓸 수 없다).
// 닿는 범위: PR CI의 node 레인은 `clients/web/`·`packages/` 경로에서만 켜져, `server-rust/`만 바꾼 PR에서는 CI에서 돌지 않는다.
// 로컬 웹 시험·`scripts/verify_merge_tree.sh` 웹 스위트·웹/코어를 건드리는 PR에서 돈다.
// =============================================================================

/** 서버 고지의 끝 구절(ADR P10 글자 그대로). */
const SERVER_ENDING = "운영자 설정이에요.";
/** 화면 고지의 끝 구절(옛 용어 검사를 지나는 같은 뜻의 표기). */
const SCREEN_ENDING = "서버 운영자가 정해요.";

const ROLES_SOURCE = readFileSync(
  new URL("../../../../../server-rust/crates/momo-agent/src/team_ai_roles.rs", import.meta.url),
  "utf8"
);
const KO_TEAM_AI = JSON.parse(
  readFileSync(new URL("../../../../../packages/momo-core/src/i18n/catalogs/ko-KR/teamAi.json", import.meta.url), "utf8")
) as Record<string, string>;

/** `const NOTICE_HERMES: &str = "…";`의 문자열 값(줄 이음 `\` + 줄바꿈 + 앞 공백을 Rust처럼 지운다). 못 읽으면 실패한다. */
function serverNoticeHermes(): string {
  const match = /^const NOTICE_HERMES: &str = "((?:[^"\\]|\\[\s\S])*)";/m.exec(ROLES_SOURCE);
  if (match === null) {
    throw new Error(
      "team_ai_roles.rs에서 `const NOTICE_HERMES: &str = \"…\";`를 찾지 못했다. 상수 이름이나 모양이 바뀌었다면 이 시험의 읽기도 같이 고친다."
    );
  }
  const raw = match[1] ?? "";
  const text = raw.replace(/\\\n[ \t]*/g, "");
  if (text.includes("\\")) throw new Error(`NOTICE_HERMES에 이 시험이 풀지 않는 이스케이프가 있다: ${text}`);
  return text;
}

describe("설정 화면의 Hermes 고지는 서버 고지(NOTICE_HERMES)와 선언한 끝 구절만 다르다", () => {
  it("화면 글의 끝 구절을 서버 끝 구절로 바꾸면 서버 글과 글자까지 같다", () => {
    const server = serverNoticeHermes();
    const screen = KO_TEAM_AI["teamAi.roles.noticeHermes"] ?? "";
    expect(server.endsWith(SERVER_ENDING)).toBe(true);
    expect(screen.endsWith(SCREEN_ENDING)).toBe(true);
    expect(`${screen.slice(0, screen.length - SCREEN_ENDING.length)}${SERVER_ENDING}`).toBe(server);
  });
});
