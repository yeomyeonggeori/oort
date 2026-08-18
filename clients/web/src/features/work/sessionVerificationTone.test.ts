import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_CHECK_OUTCOME_LABEL,
  COMPLETION_CHECK_TONE,
  type CompletionCheckOutcome,
} from "@momo/core/features/timeline/completionReportCard";
import { SESSION_STATUS_CLASS } from "@momo/core/features/work/workSessionFormat";
import { COMPLETION_TONE_CLASS, COMPLETION_TONE_TOKEN } from "@/features/timeline/completionTone";

// =============================================================================
// 세션 검증 칩이 **카드와 같은 다리**로 칠해지는가 (UXC-C).
//
// `completionTone.test.ts` 의 짝이다. 그 파일이 완료 리포트 카드에 대해 하는 일을
// 이 파일이 세션 표면의 칩에 대해 한다: 색이 컴포넌트 안의 리터럴이 아니라 코어의
// 역할표(`COMPLETION_CHECK_TONE`)를 지나 이 팔레트의 토큰에 닿는지, 그리고 그
// 토큰이 `tokens.css` 에 실제로 있는지.
//
// 세션 표면에 이 파일이 따로 필요한 이유는 사각지대가 표면마다 새로 열리기
// 때문이다: 카드가 다리를 지나도 세션 칩이 `text-danger` 를 직접 적으면, 안 돌린
// 게이트가 세션 목록에서만 붉어진다. 그 오타는 사람이 다시 스크린샷을 뜰 때만
// 잡히고, 그때는 이미 「이 세션은 실패했다」를 읽은 뒤다.
// =============================================================================

const css = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const chip = readFileSync(
  new URL("./SessionVerificationChip.tsx", import.meta.url),
  "utf8"
);
const panel = readFileSync(new URL("./WorkPanel.tsx", import.meta.url), "utf8");
const detail = readFileSync(
  new URL("./WorkSessionDetail.tsx", import.meta.url),
  "utf8"
);
/** 수명주기 칩을 세우는 네 자리 전부 (#1491). 위 두 곳 + 콘솔 + 워크스트림. */
const STATUS_SURFACES = [
  ["WorkPanel", panel],
  ["WorkSessionDetail", detail],
  [
    "WorkConsoleRoute",
    readFileSync(
      new URL("../workConsole/WorkConsoleRoute.tsx", import.meta.url),
      "utf8"
    ),
  ],
  [
    "WorkstreamDetailRoute",
    readFileSync(
      new URL("../workstreams/WorkstreamDetailRoute.tsx", import.meta.url),
      "utf8"
    ),
  ],
] as const;

const OUTCOMES: readonly CompletionCheckOutcome[] = [
  "pass",
  "fail",
  "skip",
  "pending",
  "unknown",
];

describe("칩의 색이 코어 역할표를 지난다", () => {
  it("톤 클래스를 인라인으로 다시 적지 않는다", () => {
    expect(chip).toContain(
      "COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE["
    );
    // 다리를 지나면서 자기 리터럴도 함께 적으면 위 단정이 무의미해진다.
    expect(chip).not.toMatch(/className=\{?"[^"]*text-danger/);
    expect(chip).not.toMatch(/className=\{?"[^"]*text-ok/);
  });

  it("어휘도 코어 표 그대로다 — 세션 표면 전용 낱말이 없다", () => {
    expect(chip).toContain("COMPLETION_CHECK_OUTCOME_LABEL[");
    for (const outcome of OUTCOMES) {
      expect(COMPLETION_CHECK_OUTCOME_LABEL[outcome]).toBeTruthy();
      expect(COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE[outcome]]).toBeTruthy();
    }
  });

  it("다섯 어휘가 전부 tokens.css 에 있는 토큰에 닿는다", () => {
    for (const outcome of OUTCOMES) {
      const token = COMPLETION_TONE_TOKEN[COMPLETION_CHECK_TONE[outcome]];
      expect(
        css.includes(`${token}:`),
        `${outcome} 이 tokens.css 에 없는 ${token} 을 든다`
      ).toBe(true);
    }
  });
});

describe("세션 표면이 칩을 우회하지 않는다", () => {
  it("두 표면 모두 공용 칩 컴포넌트를 쓴다", () => {
    // 표면마다 자기 <span> 을 세우기 시작하면 다리는 그대로인데 화면만 갈라진다.
    for (const [name, source] of [
      ["WorkPanel", panel],
      ["WorkSessionDetail", detail],
    ] as const) {
      expect(source, name).toContain('from "./SessionVerificationChip"');
      expect(source, name).toContain("<SessionVerificationChip");
    }
  });

  it("검증 칩이 세션 상태 칩을 대체하지 않는다 — 둘은 다른 사실이다", () => {
    // 원장이 이 세션을 무엇이라 부르는가(실행 중·종료됨·호스트 연결 끊김)와
    // 이 세션이 스스로 보고한 게이트 결과는 서로를 함의하지 않는다.
    expect(detail).toContain("SESSION_STATUS_CLASS[status.key]");
    expect(panel).toContain("SESSION_STATUS_CLASS[status.key]");
  });
});

// -----------------------------------------------------------------------------
// 그리고 나란히 선 두 칩 중 초록은 하나뿐이다 (#1491).
//
// 위 절이 「둘은 다른 사실이다」를 지켰더니 다음 물음이 왔다: 그러면 통과한 세션의
// 행에서 왜 둘 다 초록인가. 검증 칩의 초록은 게이트 표가 번 것이고(「통과 12」),
// 수명주기 칩의 초록은 「멈췄다」 위에 얹힌 것이었다 — 그 행에서 가장 정보가 없는
// 사실. 그래서 코어 역할표가 종료됨을 muted 로 내렸고, 이 절은 그 결정이 **이
// 팔레트의 실제 값에서** 성립하는지 잰다. 클래스 문자열만 재는 가드는 두 유틸리티가
// 같은 색을 가리키도록 토큰이 바뀐 날에 조용하다.
// -----------------------------------------------------------------------------

/** 토큰 한 줄의 light-dark() 두 값을 [light, dark] 로 (`completionTone.test.ts` 의 잣대). */
function tokenValues(name: string): [string, string] {
  const match = css.match(
    new RegExp(
      `${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
      "i"
    )
  );
  if (match === null) {
    throw new Error(`${name} 이 tokens.css 에 light-dark() 한 쌍으로 없다`);
  }
  return [match[1].toLowerCase(), match[2].toLowerCase()];
}

const SCHEMES = ["라이트", "다크"] as const;

describe("통과한 세션의 행에서 초록은 검증 칩 하나다 (#1491)", () => {
  it("수명주기 칩의 잉크가 두 스킴 모두에서 --ok 값과 다르다", () => {
    const doneInk = SESSION_STATUS_CLASS.done
      .split(/\s+/)
      .find((c) => c.startsWith("text-"));
    expect(doneInk, "종료됨 칩에 잉크 유틸리티가 없다").toBeTruthy();
    const ok = tokenValues("--ok");
    const done = tokenValues(`--${doneInk!.slice("text-".length)}`);
    for (const [index, scheme] of SCHEMES.entries()) {
      expect(
        done[index],
        `${scheme}에서 종료됨의 잉크가 --ok 와 같은 값(${done[index]})이다`
      ).not.toBe(ok[index]);
    }
  });

  it("검증 칩은 초록을 그대로 진다 — 없앤 것이 아니라 옮긴 것이다", () => {
    // 이 대조가 결정의 전부다. 검증 쪽이 초록을 잃으면 근거도 함께 사라진다.
    expect(COMPLETION_TONE_CLASS[COMPLETION_CHECK_TONE.pass]).toBe("text-ok");
    expect(() => tokenValues("--ok")).not.toThrow();
  });

  it("네 표면 어디도 상태 칩에 자기 초록을 따로 적지 않는다", () => {
    // 역할표를 내려도 표면 하나가 상태 옆에 `text-ok` 를 직접 적으면 그 화면에서만
    // 초록이 살아남고, 그 어긋남은 사람이 두 화면을 나란히 놓을 때만 보인다.
    for (const [name, source] of STATUS_SURFACES) {
      expect(source, `${name} 이 역할표를 안 쓴다`).toContain(
        "SESSION_STATUS_CLASS[status.key]"
      );
      expect(source, name).not.toMatch(/status\.key[^\n]*text-ok/);
    }
  });
});

// -----------------------------------------------------------------------------
// 그리고 그 두 칩은 **그릇도** 달라야 한다 (#1463 리뷰 H1·M1).
//
// #1491 이 잉크를 갈랐지만 그릇은 같은 채였다: 같은 기하에 같은 바탕
// (`--surface-hover`). 두 결함이 거기서 나왔다.
//
//   1. 행의 hover·선택 바탕이 바로 그 토큰이다. 그래서 가리키고 있는 행에서 칩이
//      바탕과 같은 색이 되어 그릇이 사라졌다.
//   2. 잉크가 겹치는 조합이 실재한다: 수명주기 `running` 은 warn 이고 게이트 대표
//      `unknown`·`pending` 도 warn 이다. 그릇까지 같으면 한 행의 호박색 알약 둘을
//      구분할 방법이 없다.
//
// 그래서 검증 칩은 한 단 올라온 바탕에 테두리를 진다. 아래는 그 결정이 **이 팔레트의
// 실제 값에서** 성립하는지 재는 것이다 — 클래스 문자열만 보는 가드는 토큰이 같은
// 값으로 수렴한 날에 조용하다.
// -----------------------------------------------------------------------------

describe("칩의 그릇이 행의 상호작용 바탕에서 살아남는다", () => {
  it("검증 칩은 행이 hover·선택될 때 쓰는 바탕을 자기 바탕으로 쓰지 않는다", () => {
    expect(panel).toContain("hover:bg-surface-hover");
    expect(chip).not.toContain("bg-surface-hover");
    expect(chip).toContain("bg-surface-raised");
    expect(chip).toContain("border border-line");
  });

  it("그 바탕이 두 스킴 모두에서 행의 바탕 둘과 실제로 다른 값이다", () => {
    const raised = tokenValues("--surface-raised");
    const surface = tokenValues("--surface");
    const hover = tokenValues("--surface-hover");
    for (const [index, scheme] of SCHEMES.entries()) {
      expect(raised[index], `${scheme}: 칩 바탕이 기본 행 바탕과 같다`).not.toBe(
        surface[index]
      );
      expect(
        raised[index],
        `${scheme}: 칩 바탕이 hover·선택 행 바탕과 같다 — 가리키는 행에서 그릇이 사라진다`
      ).not.toBe(hover[index]);
    }
  });

  it("테두리도 두 바탕과 다른 값이다 — 바탕이 수렴해도 그릇이 남게", () => {
    const line = tokenValues("--line");
    const surface = tokenValues("--surface");
    const hover = tokenValues("--surface-hover");
    for (const [index, scheme] of SCHEMES.entries()) {
      expect(line[index], `${scheme}: 테두리가 기본 행 바탕과 같다`).not.toBe(
        surface[index]
      );
      expect(line[index], `${scheme}: 테두리가 hover 행 바탕과 같다`).not.toBe(
        hover[index]
      );
    }
  });

  it("수명주기 칩은 채움 그대로다 — 갈라진 것은 그릇이지 한쪽을 없앤 것이 아니다", () => {
    // 두 칩이 같은 그릇을 쓰지 않는다는 것이 이 절의 계약이다. 검증 칩이 테두리를
    // 지는 대신, 원장의 칩은 지금까지처럼 채움으로 남는다.
    for (const [key, value] of Object.entries(SESSION_STATUS_CLASS)) {
      expect(value, `${key}: 원장의 칩은 채움이다`).toMatch(/\bbg-[a-z-]/);
      expect(
        value,
        `${key}: 원장의 칩에 테두리가 생기면 두 그릇이 다시 같아진다`
      ).not.toContain("border");
    }
  });
});
