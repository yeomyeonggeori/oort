import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// #1490 — 한 폼의 두 갈래가 진행을 같은 문법으로 말한다.
//
// `CleanupArtifactRow` 는 한 자리에서 두 갈래로 갈린다. 관측만 기록하는 갈래는
// 곧장 저장하고 버튼이 「저장하는 중」으로 바뀌었지만, 처분을 확정하는 갈래는
// `ConfirmButton` 이라 진행을 말할 낱말 자체가 없었다 — 폼의 `aria-busy` 뿐이고,
// 그것은 낭독되기만 할 뿐 눈에는 아무것도 아니다. 같은 폼, 같은 저장, 다른 대답.
//
// 도는 곳은 DOM 없는 node 라 렌더를 볼 수 없다(옆 `hostedDisconnectScope.test.ts`
// 가 같은 사정을 적어 두었다). 그래서 이 스위트가 재는 것은 컴포넌트 소스의
// **구조적 불변식**이다. 실제 렌더·초점·낭독은 Playwright 실측이 따로 봤다.
//
// RED PROOF 셋:
//
//   ① 진행 낱말이 존재하고, `SaveButton` 과 같은 기본 낱말을 쓴다. busy 를 도로
//      들어내면 이 단정이 먼저 빨개진다.
//   ② 진행은 잠금으로 그려지지 않는다. `busy` 가 `aria-disabled` 나 흐림
//      (`opacity-50`) 식에 끼어들면 화면에 하나뿐인 진행 낱말이 「당신은 이걸 못
//      한다」로 읽히며 죽는다 (#1403 리뷰 H-1 이 관측 갈래에서 이미 겪은 일).
//   ③ 그럼에도 두 번째 Enter 는 삼켜진다. 그림만 바꾸고 가드가 없으면 날고 있는
//      쓰기 위에 또 한 번 쓰기가 나간다.
// =============================================================================

const SOURCE = readFileSync(
  fileURLToPath(new URL("./SettingsFields.tsx", import.meta.url)),
  "utf8"
);

/**
 * 한 `export function` 의 몸통만 떼어낸다.
 *
 * 파일 전체를 상대로 세면 `SaveButton` 의 busy 문법이 `ConfirmButton` 의 것으로
 * 잘못 세어져, 이식을 통째로 되돌려도 스위트가 초록으로 남는다. 경계는 다음
 * 최상위 `export function` 이다.
 */
function region(name: string): string {
  const start = SOURCE.indexOf(`export function ${name}(`);
  expect(start, `${name} 가 SettingsFields.tsx 에 없다`).toBeGreaterThan(-1);
  const rest = SOURCE.slice(start + 1);
  const end = rest.indexOf("\nexport function ");
  return end === -1 ? rest : rest.slice(0, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const CONFIRM = region("ConfirmButton");
const SAVE = region("SaveButton");

/** `attr={...}` 한 줄짜리 식들. 잠금이 무엇을 근거로 켜지는지 여기서 읽는다. */
function expressions(source: string, attr: string): string[] {
  return source.match(new RegExp(`${attr}=\\{[^}]*\\}`, "g")) ?? [];
}

describe("RED PROOF ① 처분 확정에도 진행 낱말이 있다", () => {
  it("ConfirmButton 이 busy·busyLabel 을 받는다", () => {
    expect(CONFIRM).toContain("busy,");
    expect(CONFIRM).toContain("busy?: boolean;");
    expect(CONFIRM).toContain("busyLabel?: string;");
  });

  it("기본 낱말이 SaveButton 의 것과 글자까지 같다", () => {
    // 두 컨트롤이 한 패널에 함께 서므로 기본값이 갈리면 같은 저장이 두 낱말로
    // 보인다. 상수를 따로 두는 대신 서로를 근거로 맞춘다.
    const confirmDefault = CONFIRM.match(/busyLabel = "([^"]+)"/)?.[1];
    const saveDefault = SAVE.match(/busyLabel = "([^"]+)"/)?.[1];
    expect(saveDefault).toBe("저장 중");
    expect(confirmDefault).toBe(saveDefault);
  });

  it("두 갈래 모두 낱말을 갈아 끼운다 — 트리거와 확정 버튼", () => {
    // 확정을 누르면 질문이 먼저 닫히므로(close() 가 onConfirm() 앞이다) 쓰기가
    // 나가는 순간 사람 앞에 남는 것은 트리거다. 거기가 진행이 보여야 할 자리다.
    expect(CONFIRM).toContain("const triggerText = busy ? busyLabel : label;");
    expect(CONFIRM).toContain(
      "const confirmText = busy ? busyLabel : confirmLabel;"
    );
    expect(CONFIRM).toContain("{triggerText}");
    expect(CONFIRM).toContain("{confirmText}");
  });

  it("낭독되는 이름이 보이는 낱말을 따라 움직인다", () => {
    // 보이는 글자가 「저장 중」인데 접근 가능한 이름이 「삭제」로 남으면
    // label-in-name(WCAG 2.5.3)이 깨진다. 그래서 이름은 `label`·`confirmLabel`
    // 이 아니라 **진행을 아는 두 낱말**에서 지어진다 — 손으로 맞춰야 하는 두
    // 번째 문자열이 없으므로 어긋날 자리 자체가 없다.
    expect(CONFIRM).toContain("${subject} ${triggerText}");
    expect(CONFIRM).toContain("${subject} ${confirmText}");
    expect(CONFIRM).not.toContain("${subject} ${label}");
    expect(CONFIRM).not.toContain("${subject} ${confirmLabel}`");
    // 행 정체가 없는 호출자(ariaLabel)는 진행 중 이름을 내려놓고 버튼의 글자
    // 자신이 이름이 된다.
    expect(CONFIRM).toContain(
      "const triggerName = busy ? rowName : (ariaLabel ?? rowName);"
    );
    // 진행은 실제로 낭독된다 — 트리거와 확정 버튼 둘 다.
    expect(count(CONFIRM, "aria-busy={busy || undefined}")).toBe(2);
  });
});

describe("RED PROOF ② 진행은 잠금으로 그려지지 않는다", () => {
  it("busy 가 aria-disabled 식에 없다", () => {
    // #1403 리뷰 H-1 의 규율: 진행 중은 aria-busy 와 바뀐 낱말로만 말한다.
    const locks = expressions(CONFIRM, "aria-disabled");
    expect(locks.length).toBeGreaterThan(0);
    expect(locks.filter((lock) => /\bbusy\b/.test(lock))).toEqual([]);
  });

  it("busy 가 흐림(opacity-50) 식에 없다", () => {
    const dims = CONFIRM.match(/className=\{cn\([^)]*\)\}/g) ?? [];
    expect(dims.length).toBeGreaterThan(0);
    expect(dims.filter((dim) => /\bbusy\b/.test(dim))).toEqual([]);
    // 흐림을 켜는 것은 `disabled` 하나뿐이다.
    for (const dim of dims) expect(dim).toContain("disabled &&");
  });

  it("잠긴 이유는 여전히 disabled 만 가리킨다", () => {
    // 진행 중에 「왜 못 하는지」를 읽어 주면 하지 못하는 중이라는 뜻이 된다.
    for (const described of expressions(CONFIRM, "aria-describedby")) {
      expect(described).not.toMatch(/\bbusy\b/);
    }
  });
});

describe("RED PROOF ③ 두 번째 Enter 는 삼켜진다", () => {
  it("두 onClick 이 모두 조기 반환 가드를 갖는다", () => {
    // 그림만 바꾸고 가드가 없으면 죽지 않은 버튼이 된다. native `disabled` 로
    // 막지 않는 이유는 그 순간 초점이 <body> 로 떨어지기 때문이고, 그래서
    // 막는 일은 핸들러가 진다.
    expect(count(CONFIRM, "if (disabled || busy) return;")).toBe(2);
  });

  it("취소는 막히지 않는다", () => {
    // 질문을 닫는 일은 날고 있는 쓰기와 무관하다. 취소 버튼에 가드가 붙으면
    // 저장을 기다리는 사람이 질문 위에 갇힌다.
    const cancel = CONFIRM.slice(CONFIRM.lastIndexOf('variant="ghost"'));
    expect(cancel).toContain("onClick={close}");
    expect(cancel).not.toMatch(/\bbusy\b/);
  });
});

// =============================================================================
// #1558 — 정본 컴포넌트 자신이 그 문법을 어겼다.
//
// 위 스위트(#1490)와 #1557 이 여섯 소비처를 SaveButton 을 **선례로 들며** 갈라내는
// 동안, SaveButton 자신은 `blocked = !canSave || busy` 한 식으로 저장 중에
// aria-busy 와 aria-disabled 와 흐림(opacity-50)을 동시에 걸고 있었다 — #1403
// 리뷰 H-1 과 같은 클래스가 정본 안에. 진행과 잠금은 다른 축이다: 잠금은
// `!canSave` 하나에서만 오고, 진행은 낱말과 aria-busy 로만 말한다.
//
// 단정이 부분 문자열이 아니라 **식 전체의 등치**인 이유: 결함은 `busy` 라는
// 글자가 아니라 `blocked` 라는 접힘 변수 뒤에 숨어 있었다. 부분 일치는 그 간접을
// 통과시키고, 등치는 어떤 별칭도 통과시키지 않는다.
// =============================================================================

describe("#1558 RED PROOF — SaveButton 의 진행은 잠금으로 그려지지 않는다", () => {
  it("잠금은 canSave 하나에서만 온다 — aria-disabled", () => {
    expect(expressions(SAVE, "aria-disabled")).toEqual([
      "aria-disabled={!canSave || undefined}",
    ]);
  });

  it("흐림도 canSave 하나에서만 온다 — opacity-50", () => {
    const dims = SAVE.match(/className=\{cn\([^)]*\)\}/g) ?? [];
    expect(dims).toEqual(['className={cn(!canSave && "opacity-50")}']);
  });

  it("진행은 낱말과 aria-busy 로만 말한다", () => {
    expect(SAVE).toContain("aria-busy={busy || undefined}");
    expect(SAVE).toContain("{busy ? busyLabel : label}");
  });

  it("그럼에도 두 번째 Enter 는 삼켜진다", () => {
    // 흐림을 걷어냈다고 가드까지 걷히면 날고 있는 쓰기 위에 또 쓰기가 나간다.
    // native disabled 로 막지 않는 이유는 파일 위 docstring 그대로다: 초점.
    expect(SAVE).toContain("if (!canSave || busy) return;");
  });
});

describe("#1558 소비처 — busy 가 canSave 로 접혀 들어오지 않는다", () => {
  // 컴포넌트를 갈라도 소비처가 `canSave={dirty && !save.isPending}` 을 넘기면
  // 같은 겹침이 prop 을 타고 되돌아온다. features/ 아래 모든 <SaveButton> 의
  // canSave 식을 기계로 훑는다 — 새 소비처도 자동으로 이 규율 아래 선다.
  const FEATURES_DIR = fileURLToPath(new URL("..", import.meta.url));

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(path);
      return entry.name.endsWith(".tsx") ? [path] : [];
    });
  }

  function saveButtonBlocks(): { file: string; canSave: string }[] {
    const blocks: { file: string; canSave: string }[] = [];
    for (const file of tsxFiles(FEATURES_DIR)) {
      const source = readFileSync(file, "utf8");
      let from = 0;
      for (;;) {
        const start = source.indexOf("<SaveButton", from);
        if (start === -1) break;
        const end = source.indexOf("/>", start);
        const block = source.slice(start, end === -1 ? undefined : end);
        const canSave = block.match(/canSave=\{([^}]*)\}/)?.[1];
        expect(canSave, `${file} 의 <SaveButton> 에 canSave 가 없다`).toBeTruthy();
        blocks.push({ file, canSave: canSave ?? "" });
        from = start + 1;
      }
    }
    return blocks;
  }

  it("모든 소비처의 canSave 식에 진행 어휘가 없다", () => {
    const blocks = saveButtonBlocks();
    // 소비처가 하나도 안 잡히면 이 단정은 공허하게 초록이다. 오늘의 실측은
    // 셋(AiLinkChain chain-save, WorkHostSection 엔진·티어)이고, 줄어들면
    // 스캔이 깨진 것이므로 여기서 같이 빨개진다.
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const { file, canSave } of blocks) {
      expect(
        /\b(busy|isPending|isLoading|isFetching|saving)\b/i.test(canSave),
        `${file}: canSave={${canSave}} 가 진행을 잠금으로 접는다`
      ).toBe(false);
    }
  });
});
