import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEW_PASSWORD_MAX_BYTES,
  NEW_PASSWORD_MAX_HANGUL,
  NEW_PASSWORD_MIN_CHARS,
  PASSWORD_TOO_LONG_CODE,
  PASSWORD_TOO_SHORT_CODE,
  passwordRuleCopy,
} from "@momo/core/features/auth/passwordRuleCopy";

// =============================================================================
// 드리프트 가드: 새 비밀번호 규칙의 숫자와 오류 코드 (ADR-0215 D2, #4593).
//
// 서버 `momo-auth` `password_rules.rs`의 `NEW_PASSWORD_MIN_CHARS`·
// `NEW_PASSWORD_MAX_BYTES`·`PASSWORD_TOO_SHORT_CODE`·`PASSWORD_TOO_LONG_CODE`와
// 코어 `passwordRuleCopy.ts`의 같은 이름 상수는 두 언어에 따로 선언된 사본이다.
// 둘을 잇는 것이 없으면, 서버 숫자를 바꾸고 Rust 핀 시험을 고쳐 초록으로 만든
// 뒤에도 화면은 옛 숫자를 계속 말한다(독립 디자인 검수 r2-L1).
//
// 이 시험이 웹에 사는 이유: 코어의 `tsc`에는 Node 타입 선언이 없어서 코어 시험이
// `node:fs`를 import하면 TS2307로 빨개지고(실측), `scripts/purity.mjs`는
// `import.meta`·`process`·`__dirname`·`require`를 막는다. 그래서 코어 시험은
// 저장소의 다른 파일을 읽을 수 없다. 웹 시험은 `node:fs`를 쓰고 선례도 있다
// (`app/commandRegistry.test.ts`). 기대값을 베껴 적지 않고 서버 파일을 매번 읽는다.
// 읽지 못하면(상수 이름이나 모양이 바뀌면) 조용히 통과하지 않고 빨개진다.
//
// 닿는 범위(과장하지 않기): 이 시험은 `password_rules.rs`를 읽는 웹 시험이다.
// PR CI의 node 레인은 경로 필터(`.github/workflows/pr-ci.yml`)가
// `clients/web/`·`packages/` 등만 켜므로, `server-rust/`만 바꾼 PR에서는 CI에서
// 돌지 않는다. 이 시험은 로컬 `npm --prefix clients/web run test`,
// `scripts/verify_merge_tree.sh`의 웹 스위트, 웹·코어를 건드리는 PR의 node
// 레인에서 돈다.
//
// 서버의 세 번째 코드 `PASSWORD_INVALID_CHAR_CODE`(NUL)는 화면이 따로 말하지
// 않고 코어에 상수도 없어서 대조 대상이 아니다(`passwordRuleCopy.test.ts`가 그
// 코드에 문장을 붙이지 않는다는 것을 고정한다).
// =============================================================================

const RULES_SOURCE = readFileSync(
  new URL(
    "../../../../../server-rust/crates/momo-auth/src/password_rules.rs",
    import.meta.url,
  ),
  "utf8",
);

/** `pub const NAME: <type> = <value>;`의 `<value>` 원문. 못 찾으면 이유를 말하고 실패한다. */
function serverConst(name: string, type: "usize" | "&str"): string {
  const match = new RegExp(`^pub const ${name}: ${type} = ([^;]+);`, "m").exec(
    RULES_SOURCE,
  );
  if (match === null) {
    throw new Error(
      `password_rules.rs에서 \`pub const ${name}: ${type} = …;\` 한 줄을 찾지 못했다. ` +
        "상수 이름이나 모양이 바뀌었다면 이 시험의 읽기도 같이 고쳐야 한다.",
    );
  }
  return match[1].trim();
}

function serverNumber(name: string): number {
  const text = serverConst(name, "usize");
  const value = Number(text.replace(/_/g, ""));
  expect(
    Number.isInteger(value) && value > 0,
    `${name} = ${text}은 양의 정수 리터럴이어야 한다`,
  ).toBe(true);
  return value;
}

function serverCode(name: string): string {
  const text = serverConst(name, "&str");
  const match = /^"([a-z][a-z_]*)"$/.exec(text);
  expect(
    match,
    `${name} = ${text}은 snake_case 문자열 리터럴이어야 한다`,
  ).not.toBeNull();
  return match === null ? "" : match[1];
}

function serverRule() {
  return {
    minChars: serverNumber("NEW_PASSWORD_MIN_CHARS"),
    maxBytes: serverNumber("NEW_PASSWORD_MAX_BYTES"),
    tooShortCode: serverCode("PASSWORD_TOO_SHORT_CODE"),
    tooLongCode: serverCode("PASSWORD_TOO_LONG_CODE"),
  };
}

/** 문장에 아라비아 숫자로 찍힌 정수들(말투가 바뀌어도 숫자는 남는다). */
function numbersIn(sentence: string | null): number[] {
  return (sentence ?? "").match(/\d+/g)?.map(Number) ?? [];
}

/** 한글 음절 하나가 UTF-8로 차지하는 바이트(문장의 「한 자에 3바이트」가 말하는 그것). */
const HANGUL_BYTES = new TextEncoder().encode("한").length;

describe("새 비밀번호 규칙: 서버 password_rules.rs와 화면 문구 (ADR-0215 D2)", () => {
  it("서버 파일에서 숫자 둘과 오류 코드 둘을 실제로 읽어 낸다", () => {
    expect(RULES_SOURCE.length).toBeGreaterThan(0);
    const server = serverRule();
    expect(server.maxBytes).toBeGreaterThan(server.minChars);
    expect(server.tooShortCode).not.toBe(server.tooLongCode);
  });

  it("화면이 말하는 최소 글자 수는 서버가 거는 값이다", () => {
    expect(NEW_PASSWORD_MIN_CHARS).toBe(serverRule().minChars);
  });

  it("화면이 말하는 바이트 상한은 서버가 거는 값이고, 한글 환산은 그 상한에서 나온다", () => {
    const server = serverRule();
    expect(NEW_PASSWORD_MAX_BYTES).toBe(server.maxBytes);
    expect(NEW_PASSWORD_MAX_HANGUL).toBe(
      Math.floor(server.maxBytes / HANGUL_BYTES),
    );
  });

  it("문구가 매인 오류 코드는 서버가 보내는 이름이다", () => {
    const server = serverRule();
    expect(PASSWORD_TOO_SHORT_CODE).toBe(server.tooShortCode);
    expect(PASSWORD_TOO_LONG_CODE).toBe(server.tooLongCode);
    // 서버의 이름으로 물어도 문장이 나온다(상수만 같고 분기가 다른 이름이면 빨개진다).
    expect(passwordRuleCopy(server.tooShortCode)).not.toBeNull();
    expect(passwordRuleCopy(server.tooLongCode)).not.toBeNull();
    expect(passwordRuleCopy(server.tooShortCode)).not.toBe(
      passwordRuleCopy(server.tooLongCode),
    );
  });

  it("사람이 읽는 문장에 서버의 숫자가 그대로 찍힌다", () => {
    const server = serverRule();
    expect(numbersIn(passwordRuleCopy(server.tooShortCode))).toContain(
      server.minChars,
    );
    const long = numbersIn(passwordRuleCopy(server.tooLongCode));
    expect(long).toContain(server.maxBytes);
    expect(long).toContain(HANGUL_BYTES);
    expect(long).toContain(Math.floor(server.maxBytes / HANGUL_BYTES));
  });
});
