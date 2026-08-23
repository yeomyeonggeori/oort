import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 컨트롤 경계는 `--line` 이 아니라 `--line-strong` 이다 (#1210 D1).
 *
 * ## 왜 grep 이 못 잡았나
 *
 * `tokens.css:33-34` 가 규칙을 선언한다 — `--line` 은 **나누고**, `--line-strong` 은
 * **컨트롤을 그린다**(WCAG 1.4.11 의 3:1). `tokens.contrast.test.ts` 는 그 **토큰
 * 쌍**을 두 스킴에서 재고 있었다. 없던 것은 그 사이다: 어느 컴포넌트가 어느 쪽을
 * 쓰는지 아무도 안 봤다. 실측 사용 빈도는 `border-line` 198회 · `border-line-strong`
 * 18회이고, 셸 프리플라이트도 이것을 분류할 수 없다 — 「이 테두리가 컨트롤 경계인가」
 * 는 문법 질문이 아니라 **의미 질문**이라 정규식이 답할 수 없기 때문이다.
 *
 * 그래서 감사(2026-08-09 §B-4 ①)가 특정한 위반은 사람이 픽셀을 샘플링해 찾았다:
 * `button.tsx` 의 `secondary` 가 경계 1.32/1.43:1 · 채움 1.07/1.10:1 로 **둘 다**
 * 3:1 미달이었고, 바로 아래 형제 `outline` 은 같은 모양으로 규칙을 지키고 있었다.
 *
 * ## 이 파일이 하는 일
 *
 * 의미 질문을 **한 번만** 사람이 답하고, 그 답을 표로 고정한다. `design/ui/` 는
 * 프리미티브 디렉터리라 파일 수가 적고 각각이 컨트롤인지 컨테이너인지가 분명하다.
 * 표에 없는 프리미티브가 생기면 통과할 수 없으므로, 다음 사람은 새 파일을 어느
 * 쪽에 넣을지 **판정하지 않고는** 초록을 얻지 못한다.
 *
 * 숫자는 여기서 다시 재지 않는다. `--line-strong` 이 컨트롤이 설 수 있는 모든
 * 표면에서 3:1 을 넘는다는 사실은 `tokens.contrast.test.ts` 의
 * "control borders meet the 3:1 non-text minimum" 이 이미 두 스킴에서 진다. 이
 * 파일이 지는 것은 **그 토큰이 실제로 컨트롤에 닿는가**이고, 둘이 합쳐져야 화면의
 * 단정이 된다.
 */

const UI_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 프리미티브의 역할. 사람이 한 판정이고, 근거를 값과 함께 둔다.
 *
 * `control`  누를 수 있거나 값을 받는 것. 자기 경계가 곧 어포던스라 3:1 을 진다.
 * `container` 내용을 담는 것. 경계는 안팎을 **나누는** 선이고, 그 안의 컨트롤이
 *            각자 자기 경계를 진다. `--line` 이 옳은 자리다.
 */
const ROLE: Record<string, "control" | "container"> = {
  // 다섯 변형 전부가 눌리는 것이다. 경계를 가진 둘(secondary·outline)이 이 규칙의
  // 대상이고, 채움을 가진 둘(default·destructive)은 채움이 어포던스를 진다.
  "button.tsx": "control",
  // 값을 받는 상자. 비어 있을 때 경계 말고는 자기가 있다고 말할 것이 없다.
  "input.tsx": "control",
  // 같음. 닫힌 상태의 `<select>` 는 경계와 글자뿐이다.
  "select.tsx": "control",
  // 담는 것. 카드 경계가 3:1 이면 목록이 격자로 읽히고, 그 안의 버튼이 카드보다
  // 조용해진다 — 위계가 뒤집힌다.
  "card.tsx": "container",
  // 담는 것. 다이얼로그를 앞으로 세우는 것은 경계가 아니라 스크림과 고도다.
  "dialog.tsx": "container",
  // 담는 것. 떠 있는 판이고, 그 안의 항목은 호버/포커스 채움으로 자기를 말한다.
  "dropdown-menu.tsx": "container",
  // 같은 판을 우클릭 좌표에서 여는 프리미티브. 경계 역할도 dropdown과 같다.
  "context-menu.tsx": "container",
};

/** 클래스 문자열 안의 `border-line` (뒤에 `-strong` 이 붙지 않은 것). */
const BARE_BORDER_LINE = /\bborder-line\b(?!-)/;

function primitives(): string[] {
  return readdirSync(UI_DIR)
    .filter((name) => name.endsWith(".tsx"))
    .sort();
}

describe("#1210 D1 — 프리미티브의 테두리 토큰", () => {
  it("design/ui 의 모든 프리미티브가 역할표에 있다", () => {
    // 표를 닫는다. 새 프리미티브를 추가하면서 여기를 안 채우면 통과하지 못한다 —
    // 그 판정이 바로 grep 이 못 하는 일이고, 이 파일이 존재하는 이유다.
    expect(primitives().sort()).toEqual(Object.keys(ROLE).sort());
  });

  it("컨트롤은 --line 을 경계로 쓰지 않는다", () => {
    for (const file of primitives()) {
      if (ROLE[file] !== "control") continue;
      const offenders = readFileSync(`${UI_DIR}/${file}`, "utf8")
        .split("\n")
        .map((line, index) => [index + 1, line] as const)
        // 주석은 이 규칙의 대상이 아니다: 이 수리의 근거가 주석에 `border-line` 을
        // 적고 있고, 그것을 위반으로 세면 설명을 지워야 초록이 된다.
        .filter(([, line]) => !line.trimStart().startsWith("//"))
        .filter(([, line]) => BARE_BORDER_LINE.test(line));
      expect(
        offenders.map(([index, line]) => `${file}:${index} ${line.trim()}`),
        `${file} — 컨트롤 경계는 border-line-strong 이다 (tokens.css:33-34)`
      ).toEqual([]);
    }
  });

  it("경계를 가진 컨트롤은 실제로 --line-strong 을 든다", () => {
    // 위 단정은 「없음」을 잰다. 이것은 「있음」을 잰다 — 누가 테두리를 통째로
    // 지워서 초록을 얻는 길을 닫는다.
    const bordered = ["button.tsx", "input.tsx", "select.tsx"];
    for (const file of bordered) {
      const source = readFileSync(`${UI_DIR}/${file}`, "utf8");
      expect(source, `${file}`).toContain("border-line-strong");
    }
  });
});
