import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// =============================================================================
// 칩의 그릇 규칙을 **전수로** 잰다 (#1515 회전 1 / design-review H-1).
//
// ## 왜 이 파일이 따로 있나
//
// 앞 판의 강제는 두 곳이었다: 코어 역할표 두 개를 이름으로 막는 단정
// (`sessionStatusClass.test.ts`)과, 그릇 토큰이 행 바탕과 다른 값인지 재는 팔레트
// 단정(`tokens.contrast.test.ts`). 둘 다 **자기가 아는 표만** 본다. 그런데 팔레트와
// 정본 문서가 선언한 것은 훨씬 넓은 규칙이다 — 「상호작용 상태를 그리는 토큰은
// 정적인 그릇이 될 수 없다」. 규칙이 팔레트 전체인데 가드가 허용목록이면, 그 목록
// 밖에서 같은 결함이 조용히 산다. 실제로 그랬다: 리뷰가 이 레포에서 **대비 1.000짜리
// 산 결함 둘**을 더 찾아냈고(워크스트림 목록 행·ADE 서랍 카드), 그때 위 두 파일은
// 전부 초록이었다.
//
// design-system README §6·§5.5②가 요구하는 모양이 그것이다: **전수로 재고 잔량을
// 세라, 허용목록을 만들지 마라.** 그리고 §3.3이 컨트롤/컨테이너 프리미티브에 대해
// 한 그대로다 — 분류를 한 자리에 적고, 그 분류가 **총체**임을 단정하고, 남은 위반은
// 이름을 대어 적는다.
//
// ## 무엇을 「칩의 그릇」으로 세나 — 이름이 아니라 **쓰임**
//
// 칩인지 아닌지를 변수 이름(`*_CHIP_CLASS`)으로 가르면 그것이야말로 허용목록이다.
// 대신 이 레포에 이미 있는 사실 하나를 쓴다: **칩의 기하는 `CHIP_CLASS` 하나뿐이고**
// (`features/common/chip.ts` — 네 번 복붙되던 것을 한 줄로 모은 그 상수), 화면에 선
// 칩은 예외 없이 그것을 통과한다. 그래서 `cn(CHIP_CLASS, …)` 호출의 인자에서
// 출발한다:
//
//   ① 그 안에 직접 적힌 문자열의 `bg-*`            (인라인 삼항·리터럴)
//   ② 그 안에서 참조된 상수 표의 `키: "bg-…"` 항목  (역할표 — 코어·웹 어디에 있든)
//
// 이 둘이 「칩이 그릇을 얻는 길」의 전부다. 그래서 `button.tsx` 의 변형 표나
// `SettingsFields` 의 `accent` 변형처럼 **칩이 아닌** 표는 자동으로 빠진다 — 그것들은
// 컨트롤이고, 컨트롤이 `--accent-soft` 를 선택 상태로 입는 것은 이 규칙의 대상이
// 아니다(그 토큰이 하는 일 그 자체다).
//
// ## 잔량은 줄어들기만 한다
//
// 아래 표는 아직 옛 그릇에 선 칩 전부다. 이 표가 **정확히** 맞아야 하므로, 새 위반은
// 적지 않으면 빨갛고 수리는 표를 줄이지 않으면 빨갛다. 그리고 천장은 내려가기만
// 한다 — 올리는 커밋은 이 주석을 지나야 한다.
// =============================================================================

const WEB_SRC = fileURLToPath(new URL("..", import.meta.url));
const CORE_SRC = fileURLToPath(
  new URL("../../../../packages/momo-core/src", import.meta.url)
);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

interface Source {
  rel: string;
  src: string;
}

const SOURCES: Source[] = [
  ...walk(WEB_SRC).map((f) => ({
    rel: `clients/web/src/${relative(WEB_SRC, f)}`,
    src: readFileSync(f, "utf8"),
  })),
  ...walk(CORE_SRC).map((f) => ({
    rel: `packages/momo-core/src/${relative(CORE_SRC, f)}`,
    src: readFileSync(f, "utf8"),
  })),
];

/** Balanced-paren body of every `cn(` call, so a chip's whole argument list is one string. */
function cnCalls(src: string): { body: string; at: number }[] {
  const out: { body: string; at: number }[] = [];
  for (let i = src.indexOf("cn("); i !== -1; i = src.indexOf("cn(", i + 1)) {
    if (/[\w$]/.test(src[i - 1] ?? "")) continue;
    let depth = 0;
    for (let j = i + 2; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) {
          out.push({ body: src.slice(i, j + 1), at: i });
          break;
        }
      }
    }
  }
  return out;
}

const FILL = /\bbg-[a-z][a-z0-9-]*/g;
/** `키: "…bg-… …"` — 역할표 한 칸. 삼항의 가지(`? "bg-…"`)는 여기 걸리지 않는다. */
const MAP_ENTRY =
  /^\s*(?:"[^"]+"|'[^']+'|\[[^\]]+\]|[A-Za-z_$][\w$]*)\s*:\s*"([^"]*\bbg-[^"]*)"/;

interface Fill {
  rel: string;
  line: number;
  fill: string;
  via: string;
}

/** 이름이 가리키는 상수 표의 `bg-*` 칸 전부. 코어에 있든 웹에 있든 찾는다. */
function mapFills(name: string): Fill[] {
  const hits: Fill[] = [];
  for (const { rel, src } of SOURCES) {
    const decl = src.indexOf(`const ${name}`);
    if (decl === -1) continue;
    const open = src.indexOf("{", decl);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    const base = src.slice(0, open).split("\n").length - 1;
    src.slice(open, end).split("\n").forEach((line, k) => {
      const m = line.match(MAP_ENTRY);
      if (m)
        for (const f of m[1].match(FILL) ?? [])
          hits.push({ rel, line: base + k + 1, fill: f, via: `map ${name}` });
    });
  }
  return hits;
}

function discover(): { fills: Fill[]; chipCalls: number } {
  const found: Fill[] = [];
  let chipCalls = 0;
  for (const { rel, src } of SOURCES) {
    for (const { body, at } of cnCalls(src)) {
      if (!body.includes("CHIP_CLASS")) continue;
      chipCalls++;
      const line = src.slice(0, at).split("\n").length;
      for (const lit of body.match(/"[^"]*"/g) ?? [])
        for (const f of lit.match(FILL) ?? [])
          found.push({ rel, line, fill: f, via: "inline" });
      for (const id of new Set(body.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [])) {
        if (id === "CHIP_CLASS") continue;
        found.push(...mapFills(id));
      }
    }
  }
  // 한 표가 여러 화면에서 쓰이면 같은 선언이 여러 번 잡힌다. 세는 단위는 **선언**이다
  // — 그래야 렌더 자리 하나가 늘었다고 잔량 수가 흔들리지 않는다.
  const seen = new Set<string>();
  const fills = found.filter((f) => {
    const key = `${f.rel}:${f.line}:${f.fill}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { fills, chipCalls };
}

/**
 * 칩이 그릇으로 들 수 있는 값 전부 (`tokens.css` 의 `-soft` 가족 중 그릇 쪽).
 *
 * `--accent-soft`·`--agent-soft` 는 같은 이름 가족이지만 여기 없다: 그 둘은 칩의
 * 그릇이 아니라 **선택된 행**의 채움이고(사이드바·관제 줄·⌘K), 칩이 그것을 그릇으로
 * 들면 그게 바로 이 파일이 막는 결함이다.
 */
const VESSELS = new Set([
  "bg-muted-soft",
  "bg-ok-soft",
  "bg-warn-soft",
  "bg-danger-soft",
]);

/**
 * 아직 옛 그릇에 선 칩 — 좌표와 수 (#1515 회전 1).
 *
 * **live** 는 그 칩을 인 행이 실제로 상호작용 바탕을 입어 대비 1.000 이 나는 자리이고,
 * **rule-only** 는 규칙 위반이되 호스트가 그 바탕을 입지 않아 지금 화면에서는 그릇이
 * 살아 있는 자리다. 회전 1 은 live 를 전부 닫았다(워크스트림 역할표 4칸 · ADE 서랍
 * 3칸). 남은 것은 rule-only 뿐이고, 후속 goal 후보다.
 *
 *   StatusChip.tsx        20  턴·승인·로그인 핸드오프 세 역할표 + 완료 리포트 칩의
 *                             인라인 바탕. 타임라인 행은 hover 바탕을 입지 않는다.
 *   WorkSessionDetail.tsx  2  제어 창 칩. `--surface-raised` 카드 안에 산다.
 *   DisplayController.tsx  2  제어 등급 칩. 같은 카드 문맥.
 *
 * 이 표에서 한 줄을 지우려면 그 자리를 실제로 고쳐야 하고, 새 위반을 들이려면 여기
 * 적어야 한다. 둘 다 리뷰를 지나간다.
 *
 * #1516 이 `SessionVerificationChip.tsx` 한 줄을 지웠다(검증 칩의 `--surface-raised`
 * + 테두리가 톤 그릇으로 바뀌었다) — 천장이 25 에서 24 로 내려온 것이 그 기록이다.
 */
const RESIDUE: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/timeline/StatusChip.tsx", 20],
  ["clients/web/src/features/work/DisplayController.tsx", 2],
  ["clients/web/src/features/work/WorkSessionDetail.tsx", 2],
];

/** 잔량 천장. **내려가기만 한다** — 올리는 변경은 위 문단을 지나야 한다. */
const RESIDUE_CEILING = 24;

describe("칩의 그릇 규칙은 팔레트 전체에 걸린다 (#1515 회전 1)", () => {
  const { fills, chipCalls } = discover();

  it("스윕이 실제로 칩을 보고 있다 — 눈먼 가드는 언제나 초록이다", () => {
    // `CHIP_CLASS` 가 이름을 바꾸거나 칩이 그 상수를 안 쓰기 시작하면 위 discover 가
    // 조용히 빈 배열을 내고, 그러면 아래 단정이 전부 무의미해진다. 이 레포가 실제로
    // 세우는 칩 자리는 열여덟이다.
    expect(chipCalls).toBeGreaterThanOrEqual(15);
    expect(fills.length).toBeGreaterThanOrEqual(30);
  });

  it("칩이 그릇을 얻는 모든 자리가 분류된다 — 미분류가 없다", () => {
    const residueFiles = new Set(RESIDUE.map(([rel]) => rel));
    const unclassified = fills.filter(
      (f) => !VESSELS.has(f.fill) && !residueFiles.has(f.rel)
    );
    expect(
      unclassified.map((f) => `${f.rel}:${f.line} ${f.fill} (${f.via})`),
      "칩 그릇이 vessel 도 아니고 잔량 표에도 없다 — 규칙을 새로 어겼거나, 어긴 것을 안 적었다"
    ).toEqual([]);
  });

  it("잔량이 좌표와 수까지 표와 정확히 맞는다", () => {
    const counted = new Map<string, number>();
    for (const f of fills)
      if (!VESSELS.has(f.fill))
        counted.set(f.rel, (counted.get(f.rel) ?? 0) + 1);
    const actual = [...counted].sort(([a], [b]) => a.localeCompare(b));
    expect(
      actual,
      "잔량 표가 낡았다 — 고쳤으면 줄이고, 늘었으면 적어라"
    ).toEqual(RESIDUE.map(([rel, n]) => [rel, n]));
  });

  it("잔량은 줄어들기만 한다", () => {
    const total = fills.filter((f) => !VESSELS.has(f.fill)).length;
    expect(total).toBeLessThanOrEqual(RESIDUE_CEILING);
    expect(
      RESIDUE.reduce((sum, [, n]) => sum + n, 0),
      "천장과 표가 어긋난다"
    ).toBeLessThanOrEqual(RESIDUE_CEILING);
  });

  it("옛 그릇의 정체를 이름으로 적어 둔다 — 상호작용 상태이거나, 그릇이 아닌 표면", () => {
    // 잔량이 무엇 때문에 잔량인지가 표에서 사라지면, 다음 사람은 이 목록을 그냥
    // 「예외」로 읽는다. 실제로는 두 종류뿐이다: 행이 입는 상태 토큰(그래서 그 행이
    // hover 하는 순간 사라진다)과, 그릇 가족이 아닌 중립 표면.
    const kinds = new Set(
      fills.filter((f) => !VESSELS.has(f.fill)).map((f) => f.fill)
    );
    expect([...kinds].sort()).toEqual(["bg-accent-soft", "bg-surface-hover"]);
  });
});
