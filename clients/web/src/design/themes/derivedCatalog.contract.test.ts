import { describe, expect, it } from "vitest";
import { THEME_CATALOG } from "@momo/core/design/themeCatalog.generated";
import { deriveCatalogMode } from "@momo/core/design/deriveCatalog";
import { THEMES, THEME_IDS, type Mode } from "@momo/core/design/themes";
import { CONTROL_SURFACES, FOREGROUNDS, SURFACES, contrast, foregroundHosts } from "../tokens.contrast.test";

// =============================================================================
// 카탈로그 57 테마-모드가 **첫 파티의 닫힌 표**(`tokens.contrast.test.ts`: `SURFACES` 17면 · `FOREGROUNDS` · `CONTROL_SURFACES` ·
// `foregroundHosts`)로 같은 계약을 지키는가 (AP-1b #4188, 설계 리뷰 2차 H-B). 이 파일은 표를 **복사하지 않고 가져온다**:
// core의 자(`derive.test.ts`의 `bandViolations`)가 자기 목록을 쓰면 첫 파티 표가 늘어도 카탈로그가 따라오지 않는다(README §5.5 ②).
//
// 첫 파티는 손으로 맞춘 여유로 이 계약의 일부를 못 지킨다(예: 흑연 라이트의 에이전트가 가리킨 행 위 4.43). 그래서 대조군은
// 「첫 파티가 지키는 만큼」이 아니라 「카탈로그 57행이 **전부** 지킨다」를 단정하고, 첫 파티의 잔량은 아래 표로 적는다.
// =============================================================================

const surfaceMap = (c: Record<string, string>, d: Record<string, string>, canvas: readonly string[], pane: string): Record<string, string> => ({
  surface: c.surface,
  "surface-muted": c["surface-muted"],
  sheet: c.sheet,
  pane,
  "canvas-top": canvas[0],
  "canvas-mid": canvas[1],
  "canvas-bottom": canvas[2],
  // 이행 별칭(tokens.css): `surface-raised` = `surface`, `surface-sidebar` = `sheet`, `accent-soft` = `signal-soft`.
  "surface-raised": c.surface,
  "surface-sidebar": c.sheet,
  "surface-hover": d["surface-hover"],
  "surface-pressed": d["surface-pressed"],
  "accent-soft": c["signal-soft"],
  "agent-soft": c["agent-soft"],
  "muted-soft": d["muted-soft"],
  "ok-soft": c["ok-soft"],
  "warn-soft": c["warn-soft"],
  "danger-soft": c["danger-soft"],
});

interface Row {
  name: string;
  color: Record<string, string>;
  surfaces: Record<string, string>;
}

const CATALOG_ROWS: Row[] = THEME_CATALOG.flatMap((entry) =>
  (["light", "dark"] as const).flatMap((mode: Mode) => {
    if (!entry[mode]) return [];
    const derived = deriveCatalogMode(entry.id, mode, null)!;
    const color = derived.tokens.color as unknown as Record<string, string>;
    const d = derived.tokens.derived as unknown as Record<string, string>;
    return [{ name: `${entry.id} ${mode}`, color, surfaces: surfaceMap(color, d, derived.tokens.canvas, derived.pane) }];
  })
);

const FIRST_PARTY_ROWS: Row[] = THEME_IDS.flatMap((id) =>
  (["light", "dark"] as const).map((mode: Mode) => {
    const t = THEMES[id][mode];
    const color = t.color as unknown as Record<string, string>;
    // 본문 판은 웹 셸의 값이다: 라이트 surface, 다크 canvas-mid.
    return {
      name: `${id} ${mode}`,
      color,
      surfaces: surfaceMap(color, t.derived as unknown as Record<string, string>, t.canvas, mode === "light" ? color.surface : t.canvas[1]),
    };
  })
);

/** 한 행이 닫힌 표를 어긴 곳(읽을 수 있는 줄). 비어 있으면 모두 지킨다. */
function misses(row: Row): string[] {
  const out: string[] = [];
  for (const fg of FOREGROUNDS) {
    for (const bg of foregroundHosts(fg)) {
      const ratio = Number(contrast(row.color[fg], row.surfaces[bg]).toFixed(2));
      if (ratio < 4.5) out.push(`${fg} on ${bg} ${ratio} < 4.5`);
    }
  }
  for (const bg of CONTROL_SURFACES) {
    const ratio = Number(contrast(row.color["line-strong"], row.surfaces[bg]).toFixed(2));
    if (ratio < 3) out.push(`line-strong on ${bg} ${ratio} < 3`);
  }
  return out;
}

describe("카탈로그는 첫 파티의 닫힌 표를 전수로 지킨다 (17면 · 전경 일곱 · 테두리 컨트롤 면)", () => {
  it("표가 카탈로그의 면 이름을 다 덮는다: 표에 있는데 카탈로그에 매핑이 없는 면은 없다", () => {
    for (const name of SURFACES) expect(CATALOG_ROWS[0].surfaces[name], name).toBeTruthy();
    expect(Object.keys(CATALOG_ROWS[0].surfaces).sort()).toEqual([...SURFACES].sort());
  });

  it("57행이 그대로다 (쌍 16 × 2 + 라이트 단독 1 + 다크 단독 24)", () => {
    expect(CATALOG_ROWS).toHaveLength(57);
  });

  it.each(CATALOG_ROWS.map((row) => [row.name, row] as const))("%s: 글자·톤 글자 4.5, 테두리 3을 첫 파티와 같은 면 위에서 지킨다", (_name, row) => {
    expect(misses(row)).toEqual([]);
  });

  it("ink·ink-muted는 17면 전부에서, 톤 글자는 첫 파티가 제외한 면(눌린 행·칩 그릇)에서도 지킨다: 첫 파티보다 강한 보장이다", () => {
    for (const row of CATALOG_ROWS) {
      for (const bg of SURFACES) {
        for (const fg of ["ink", "ink-muted"] as const) {
          expect(contrast(row.color[fg], row.surfaces[bg]), `${row.name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5 - 1e-9);
        }
      }
      for (const fg of ["signal-text", "agent", "ok", "warn", "danger"] as const) {
        for (const bg of ["surface-pressed", "muted-soft"]) {
          expect(contrast(row.color[fg], row.surfaces[bg]), `${row.name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5 - 1e-9);
        }
      }
    }
  });
});

describe("대조군: 첫 파티 6행의 잔량 (카탈로그가 더 강하게 지킨다는 말이 근거를 갖게 한다)", () => {
  it("첫 파티는 이 표를 일부 못 지킨다(손으로 맞춘 값): 잔량 13줄, 모두 2.5 초과다 (천장은 줄어들기만 한다)", () => {
    const all = FIRST_PARTY_ROWS.flatMap((row) => misses(row).map((line) => `${row.name}: ${line}`));
    // 이 잔량은 이 PR이 만든 것이 아니고(첫 파티 값은 그대로), 카탈로그가 같은 표에서 0이라는 비교의 기준이다.
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(13);
    for (const line of all) {
      const ratio = Number(/(\d+\.\d+) < /.exec(line)![1]);
      expect(ratio, line).toBeGreaterThan(2.5);
    }
  });
});
