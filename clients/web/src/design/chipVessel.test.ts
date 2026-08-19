import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// =============================================================================
// 칩의 그릇 규칙을 **전수로** 잰다 (#1515 / design-review H-1).
//
// ## 회전 1 의 가드는 허용목록을 다른 허용목록으로 바꾼 것이었다 (회전 2)
//
// 앞 판은 칩을 `cn(CHIP_CLASS, …)` 호출에서 찾았고 그 전제를 이렇게 적었다:
// 「칩의 기하는 `CHIP_CLASS` 하나뿐이고 화면에 선 칩은 예외 없이 그것을 통과한다」.
// **이 레포에서 거짓이다.** 여덟 자리가 기하를 손으로 다시 적고 있었고 그중 하나는
// 살아 있었다 — `WorkSessionIdleCard` 의 「대기 전환」 칩은 `CHIP_CLASS` 와 바이트
// 동일한 클래스 목록에 `bg-surface-hover` 를 얹었고, 그 칩을 인 <button> 이
// `hover:bg-surface-hover` 다. 카드를 가리키면 그릇이 사라졌다(두 스킴 실측 대비
// 1.000 · OKLab 거리 0.0000 — 이 티켓 전체를 정당화한 바로 그 측정).
//
// 총체성 주장도 근거가 없었다. `chipCalls >= 15` 는 `CHIP_CLASS` 가 **개명**되는
// 것만 막는다. 아예 import 하지 않는 칩은 그 수를 그대로 두고 가드는 초록이다.
//
// ## 그래서 발견을 import 가 아니라 **기하**로 키잉한다
//
// 칩을 칩으로 만드는 것은 상수의 이름이 아니라 모양이다: `rounded-sm px-2 py-px
// text-timestamp`. 이 파일은 이제 그 시그니처를 지닌 **모든 클래스 목록**을 훑는다.
// `CHIP_CLASS` 를 import 하든 안 하든 걸린다 — 즉 발견이 더 이상 「모두가 그 상수를
// 쓴다」는 미검증 전제 위에 서지 않는다. 전제를 참으로 만드는 대신 **전제를 필요
// 없게** 만든 것이다.
//
// 그 위에 기하 자체의 잔량도 함께 센다(아래 `HAND_ROLLED`): 손으로 적은 기하는
// 목록에 적혀야 하고 그 수는 줄어들기만 한다. 새로 손으로 적으면 빨갛다.
//
// ## 무엇을 칩의 그릇으로 세나
//
//   ① 기하 시그니처를 지닌 클래스 목록 안의 `bg-*`      (손 기하·정본 칩 공통)
//   ② 그 목록을 감싼 `cn(…)` 호출에서 참조된 상수 표의 `키: "bg-…"` 항목
//
// 그래서 `button.tsx` 의 변형표처럼 **칩이 아닌** 표는 자동으로 빠진다 — 컨트롤이
// `--accent-soft` 를 선택 상태로 입는 것은 이 규칙의 대상이 아니라 그 토큰이 하는 일
// 그 자체다.
//
// ## 이 파일이 재지 **않는** 것
//
// `bg-*` 만 읽는다. 칩의 **테두리**는 기계가 아무것도 재지 않는다 —
// `SettingsFields` 의 `StatusChip` 이 `border-ok`/`border-warn`/`border-danger` 톤
// 셀로 일곱 설정 표면에 살아 있고, #1516 이 검증 칩에서 「컨트롤 문법」이라 판정해
// 걷어낸 것이 바로 그 모양이다. 그 공백은 design-system README §5.3(아무것도 재지
// 않는 축)에 기재돼 있다.
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

/** 칩의 기하 — 이 넷을 한 목록에 지니면 그것은 칩이다. */
const GEOMETRY = ["rounded-sm", "px-2", "py-px", "text-timestamp"] as const;
/** 그 기하가 **살아도 되는** 유일한 자리. */
const CHIP_GEOMETRY_HOME = "clients/web/src/features/common/chip.ts";

const FILL = /\bbg-[a-z][a-z0-9-]*/g;

function hasGeometry(classList: string): boolean {
  return GEOMETRY.every((c) =>
    new RegExp(`(^|[\\s:])${c}($|\\s)`).test(classList)
  );
}

/** 균형 잡힌 괄호로 잘라낸 `cn(` 호출 전체. 칩의 인자 목록이 한 문자열이 된다. */
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

interface Fill {
  rel: string;
  line: number;
  fill: string;
  via: string;
}

/** `키: "…bg-… …"` — 역할표 한 칸. 삼항의 가지(`? "bg-…"`)는 걸리지 않는다. */
const MAP_ENTRY =
  /^\s*(?:"[^"]+"|'[^']+'|\[[^\]]+\]|[A-Za-z_$][\w$]*)\s*:\s*"([^"]*\bbg-[^"]*)"/;

/**
 * 이름 -> 그 상수 표의 `bg-*` 칸 전부. **한 번만** 훑어 색인해 둔다.
 *
 * 앞 판은 `src.indexOf("const " + name)` 으로 찾아 두 가지가 틀렸다: 같은 파일에 그
 * 이름을 **접두로 갖는** 앞선 선언이 있으면 엉뚱한 표를 잡았고, 이름을 부를 때마다 전
 * 파일을 다시 훑었다. 정확한 이름 경계로 한 번 색인하면 둘 다 사라지고, 이름 규칙
 * (대문자 다섯 자 이상)으로 거를 이유도 없어진다 — 표가 아니면 색인에 없다.
 */
const MAP_INDEX = new Map<string, Fill[]>();
for (const { rel, src } of SOURCES) {
  for (const m of src.matchAll(/(?:^|[^\w$])const\s+([A-Za-z_$][\w$]*)/g)) {
    const name = m[1];
    const eq = src.indexOf("=", (m.index ?? 0) + m[0].length);
    if (eq === -1) continue;
    let k = eq + 1;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== "{") continue; // `= {` 인 것만 표로 본다
    let depth = 0;
    let end = k;
    for (let j = k; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    const base = src.slice(0, k).split("\n").length - 1;
    const hits: Fill[] = [];
    src.slice(k, end).split("\n").forEach((line, i) => {
      const e = line.match(MAP_ENTRY);
      if (e)
        for (const f of e[1].match(FILL) ?? [])
          hits.push({ rel, line: base + i + 1, fill: f, via: `map ${name}` });
    });
    if (hits.length > 0 && !MAP_INDEX.has(name)) MAP_INDEX.set(name, hits);
  }
}

interface Site {
  rel: string;
  line: number;
  handRolled: boolean;
}

function discover(): { fills: Fill[]; sites: Site[] } {
  const fills: Fill[] = [];
  const sites: Site[] = [];
  for (const { rel, src } of SOURCES) {
    const claimed: [number, number][] = [];
    for (const { body, at } of cnCalls(src)) {
      const literals = body.match(/"[^"]*"/g) ?? [];
      const geometric = literals.some((l) => hasGeometry(l.slice(1, -1)));
      if (!body.includes("CHIP_CLASS") && !geometric) continue;
      claimed.push([at, at + body.length]);
      const line = src.slice(0, at).split("\n").length;
      sites.push({
        rel,
        line,
        handRolled: geometric && rel !== CHIP_GEOMETRY_HOME,
      });
      for (const lit of literals)
        for (const f of lit.match(FILL) ?? [])
          fills.push({ rel, line, fill: f, via: "inline" });
      // 같은 호출에서 참조된 상수 표. 이름 규칙으로 거르지 않는다.
      for (const id of new Set(body.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []))
        for (const h of MAP_INDEX.get(id) ?? []) fills.push(h);
    }
    // `cn()` 을 통하지 않고 className 에 직접 적힌 기하 — 회전 2 가 연 구멍이 이것이다.
    for (const m of src.matchAll(/"([^"\n]{10,})"/g)) {
      const lit = m[1];
      const at = m.index ?? 0;
      if (!hasGeometry(lit)) continue;
      if (claimed.some(([s, e]) => at >= s && at < e)) continue;
      const line = src.slice(0, at).split("\n").length;
      sites.push({ rel, line, handRolled: rel !== CHIP_GEOMETRY_HOME });
      for (const f of lit.match(FILL) ?? [])
        fills.push({ rel, line, fill: f, via: "bare" });
    }
  }
  const seen = new Set<string>();
  return {
    fills: fills.filter((f) => {
      const key = `${f.rel}:${f.line}:${f.fill}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    sites,
  };
}

/**
 * 칩이 그릇으로 들 수 있는 값 전부 (`tokens.css` 의 `-soft` 가족 중 그릇 쪽).
 *
 * 같은 `-soft` 이름을 쓰지만 여기 **없는** 둘이 있고, 빠진 이유가 서로 다르다:
 *
 *   `--accent-soft`  선택된 행의 채움이다(사이드바·관제 줄·⌘K). 상호작용 상태이므로
 *                    칩이 그것을 그릇으로 들면 그게 바로 이 파일이 막는 결함이다.
 *   `--agent-soft`   **정체성**이다 — 에이전트임을 말하는 색이지 상태가 아니다
 *                    (`MessageRow.tsx:171` · `AgentTurnBadge.tsx:31` ·
 *                    `AgentHubRoute.tsx:180`,`:242` · `AgentWorkPanel.tsx:229` —
 *                    트리의 모든 용례가 그렇다). 상태가 아니므로 hover 로 사라지지
 *                    않고, 따라서 이 규칙이 다루는 결함을 애초에 낼 수 없다.
 *
 * 그 갈림을 적어 두는 이유: 앞 판이 `--agent-soft` 를 「선택된 행의 채움」으로 잘못
 * 적었다. 지금은 아무것도 빨갛지 않지만, 훗날 에이전트 정체성 칩이 생기면 위반으로
 * 찍히고 고치러 온 사람이 **존재하지 않는 규칙**을 가리키게 된다.
 */
const VESSELS = new Set([
  "bg-muted-soft",
  "bg-ok-soft",
  "bg-warn-soft",
  "bg-danger-soft",
]);

/**
 * 아직 옛 그릇에 선 칩 — 좌표와 수.
 *
 * **live** 는 그 칩을 인 행이 실제로 상호작용 바탕을 입어 대비 1.000 이 나는 자리이고,
 * **rule-only** 는 규칙 위반이되 지금 화면에서는 그릇이 살아 있는 자리다. live 는
 * 전부 닫혔다(회전 1: 워크스트림 4칸·ADE 3칸 / 회전 2: 대기 카드 1칸).
 *
 * **rule-only 가 살아 있는 진짜 이유는 「그 행이 hover 하지 않아서」가 아니다.**
 * 회전 1 이 그렇게 적었는데 거짓이었다 — `timeline/MessageRow.tsx:473` 은
 * `hover:bg-surface-hover` 를 **입는다**. 실제로 그 칩들을 지켜 주는 것은 사이에 낀
 * **불투명한 카드**다: `AgentCard.tsx:1034` 와 `ArtifactCard.tsx:711` 이
 * `bg-surface-raised` 로 행과 칩 사이를 가로막는다. 이 구분은 중요하다 — 틀린
 * 불변식을 적어 두면 그 카드를 평평하게 만드는 사람이 칩 스무 개를 한꺼번에 지운다.
 *
 *   StatusChip.tsx        20  턴·승인·로그인 핸드오프 세 역할표 + 완료 리포트 칩.
 *                             불투명 카드 안에 산다(위 문단).
 *   ObserverTerminal.tsx   4  관전 터미널 머리 칩 둘(손 기하) + **토글 버튼** 하나가
 *                             칩 기하를 빌려 쓴 것(:1246, `aria-pressed`).
 *   HostedAgentWizard.tsx  2  단계 표시기(:672). 이것도 칩이 아니라 **상태 표시**다.
 *   WorkSessionDetail.tsx  2  제어 창 칩. `--surface-raised` 카드 안.
 *   DisplayController.tsx  2  제어 등급 칩. 같은 카드 문맥.
 *   ArtifactCard.tsx       1  커밋/PR 칩. 손 기하 + 불투명 카드 안.
 *   DisplayObserver.tsx    1  관전 머리 칩. 손 기하.
 *   SettingsFields.tsx     1  설정 `StatusChip` 의 accent 톤 셀.
 *
 * #1516 이 `SessionVerificationChip` 한 줄을 지웠다(검증 칩의 `--surface-raised` +
 * 테두리가 톤 그릇으로 바뀌었다) — 천장이 34 에서 33 으로 내려온 것이 그 기록이다.
 *
 * **두 종류가 섞여 있고 고치는 법이 다르다.** 대부분은 「칩인데 그릇이 틀렸다」이고,
 * `ObserverTerminal:1246`·`HostedAgentWizard:672` 는 반대다 — **컨트롤·상태 표시가 칩
 * 기하를 빌려 쓴 것**이라 거기서는 `--accent-soft`(눌림·현재 단계)와
 * `--surface-hover`(hover)가 **옳게** 쓰이고 있다. 그 둘의 결함은 그릇이 아니라
 * 기하이고, 그래서 아래 `HAND_ROLLED` 에도 함께 서 있다. 스윕이 기하로 걸리는 이상
 * 둘 다 여기 보이는 것이 맞고, 「보이지만 사유가 다르다」를 적어 두지 않으면 다음
 * 사람이 눌림 상태를 그릇으로 오해해 지운다.
 *
 * 이 표에서 한 줄을 지우려면 그 자리를 실제로 고쳐야 하고, 새 위반을 들이려면 여기
 * 적어야 한다. 둘 다 리뷰를 지나간다. **후속 goal 후보**: 이 잔량 전부.
 */
const RESIDUE: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/hostedAgents/HostedAgentWizard.tsx", 2],
  ["clients/web/src/features/settings/SettingsFields.tsx", 1],
  ["clients/web/src/features/timeline/ArtifactCard.tsx", 1],
  ["clients/web/src/features/timeline/StatusChip.tsx", 20],
  ["clients/web/src/features/work/DisplayController.tsx", 2],
  ["clients/web/src/features/work/DisplayObserver.tsx", 1],
  ["clients/web/src/features/work/ObserverTerminal.tsx", 4],
  ["clients/web/src/features/work/WorkSessionDetail.tsx", 2],
];

/** 잔량 천장. **내려가기만 한다** — 올리는 변경은 위 문단을 지나야 한다. */
const RESIDUE_CEILING = 33;

/**
 * 기하를 손으로 다시 적은 자리 — 좌표와 수.
 *
 * 이것이 회전 1 의 가드를 눈멀게 한 축이다. 발견은 이제 기하로 키잉하므로 이 자리들도
 * 전부 보이지만, **기하가 하나여야 한다**는 규칙 자체는 따로 잰다: 여기 적히지 않은
 * 손 기하가 생기면 빨갛고, 이 수는 줄어들기만 한다.
 *
 * 전부 `CHIP_CLASS` 로 옮기지 않은 이유는 다섯이 `font-medium` 을 지니지 않아 옮기는
 * 순간 그 표면들의 글자 굵기가 바뀌기 때문이다 — 토큰 PR 이 실어 나를 시각 변경이
 * 아니다. **후속 goal 후보**이고, 그때까지 이 수가 새 손 기하를 막는다.
 */
const HAND_ROLLED: readonly (readonly [string, number])[] = [
  ["clients/web/src/features/hostedAgents/HostedAgentWizard.tsx", 1],
  ["clients/web/src/features/settings/SettingsFields.tsx", 1],
  ["clients/web/src/features/timeline/ArtifactCard.tsx", 1],
  ["clients/web/src/features/work/DisplayObserver.tsx", 1],
  ["clients/web/src/features/work/ObserverTerminal.tsx", 3],
];

/** 손 기하 천장. **내려가기만 한다.** */
const HAND_ROLLED_CEILING = 7;

describe("칩의 그릇 규칙은 팔레트 전체에 걸린다 (#1515)", () => {
  const { fills, sites } = discover();

  it("발견이 import 가 아니라 기하로 걸린다 — 손으로 적은 칩도 보인다", () => {
    // 회전 1 의 `chipCalls >= 15` 는 `CHIP_CLASS` 개명만 막았고 import 하지 않는
    // 칩에는 눈이 멀었다. 이 단정은 그 반대를 잰다: 손 기하가 실제로 발견에
    // 걸리는가. 걸리지 않으면 스윕이 다시 허용목록이 된 것이다.
    const handRolledFound = new Set(
      sites.filter((s) => s.handRolled).map((s) => s.rel)
    );
    for (const [rel] of HAND_ROLLED)
      expect(handRolledFound.has(rel), `${rel} 의 손 기하를 스윕이 못 봤다`).toBe(
        true
      );
    expect(sites.length).toBeGreaterThanOrEqual(20);
  });

  it("칩의 기하는 하나다 — 손으로 적은 자리가 표와 정확히 맞는다", () => {
    const counted = new Map<string, number>();
    for (const s of sites)
      if (s.handRolled) counted.set(s.rel, (counted.get(s.rel) ?? 0) + 1);
    expect(
      [...counted].sort(([a], [b]) => a.localeCompare(b)),
      "손 기하 표가 낡았다 — `CHIP_CLASS` 로 옮겼으면 줄이고, 새로 적었으면 적어라"
    ).toEqual(HAND_ROLLED.map(([rel, n]) => [rel, n]));
    expect(
      [...counted.values()].reduce((a, b) => a + b, 0)
    ).toBeLessThanOrEqual(HAND_ROLLED_CEILING);
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
    expect(
      [...counted].sort(([a], [b]) => a.localeCompare(b)),
      "잔량 표가 낡았다 — 고쳤으면 줄이고, 늘었으면 적어라"
    ).toEqual(RESIDUE.map(([rel, n]) => [rel, n]));
  });

  it("잔량은 줄어들기만 한다", () => {
    const total = fills.filter((f) => !VESSELS.has(f.fill)).length;
    expect(total).toBeLessThanOrEqual(RESIDUE_CEILING);
  });

  it("옛 그릇의 정체를 이름으로 적어 둔다 — 상호작용 상태이거나, 그릇이 아닌 표면", () => {
    // 잔량이 무엇 때문에 잔량인지가 표에서 사라지면 다음 사람은 그냥 「예외」로
    // 읽는다. 실제로는 두 종류뿐이다: 행이 입는 상태 토큰(그래서 그 행이 hover 하는
    // 순간 사라진다)과, 그릇 가족이 아닌 중립 표면.
    const kinds = new Set(
      fills.filter((f) => !VESSELS.has(f.fill)).map((f) => f.fill)
    );
    // `bg-surface-raised` 는 #1516 이 검증 칩을 톤 그릇으로 옮기며 사라졌다 —
    // 이제 잔량은 **전부 상호작용 상태 토큰**이다.
    expect([...kinds].sort()).toEqual(["bg-accent-soft", "bg-surface-hover"]);
  });
});
