import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FORMAT_TRAY_EDGE_GUTTER,
  FORMAT_TRAY_MIN_SPACE_ABOVE,
  FORMAT_TRAY_SELECTION_OFFSET,
  clampFormatTrayPosition,
} from "./composerFormatPosition";

const traySource = readFileSync(
  fileURLToPath(new URL("./ComposerFormatTray.tsx", import.meta.url)),
  "utf8"
);

const tokens = readFileSync(
  fileURLToPath(new URL("../../design/tokens.css", import.meta.url)),
  "utf8"
);

function tokenPx(name: string): number {
  const match = tokens.match(new RegExp(`--${name}:\\s*([\\d.]+)px;`));
  if (!match) throw new Error(`tokens.css에 --${name} 이 없다`);
  return Number(match[1]);
}

describe("선택 서식 트레이 좌표 (#1902)", () => {
  it("여백 상수는 Dawn 토큰과 같다", () => {
    expect(FORMAT_TRAY_EDGE_GUTTER).toBe(tokenPx("spacing-3"));
    expect(FORMAT_TRAY_SELECTION_OFFSET).toBe(tokenPx("spacing-2"));
    expect(FORMAT_TRAY_MIN_SPACE_ABOVE).toBe(tokenPx("tap-target"));
  });

  it("위 공간이 있으면 선택 위에 두고 좌우를 뷰포트 안으로 가둔다", () => {
    const position = clampFormatTrayPosition(
      { left: 100, top: 80, width: 40, height: 18 },
      120,
      { width: 1280, height: 720 }
    );
    expect(position.placement).toBe("top");
    expect(position.top).toBe(80 - FORMAT_TRAY_SELECTION_OFFSET);
    expect(position.left).toBe(120);
  });

  it("위 공간이 없으면 선택 아래로 내린다", () => {
    const position = clampFormatTrayPosition(
      { left: 20, top: 10, width: 30, height: 16 },
      80,
      { width: 390, height: 844 }
    );
    expect(position.placement).toBe("bottom");
    expect(position.top).toBe(10 + 16 + FORMAT_TRAY_SELECTION_OFFSET);
  });

  it("트레이 클래스는 max-w-full 을 두지 않아 유틸리티 클램프가 산다", () => {
    expect(tokens).toContain("max-inline-size: calc(100vw - var(--spacing-6))");
    expect(traySource).not.toMatch(/composer-format-tray[^\n]*max-w-full/);
  });

  it("오른쪽 끝 선택은 트레이 반폭이 뷰포트를 넘지 않게 민다", () => {
    const position = clampFormatTrayPosition(
      { left: 1240, top: 200, width: 20, height: 16 },
      120,
      { width: 1280, height: 720 }
    );
    expect(position.left).toBe(1280 - FORMAT_TRAY_EDGE_GUTTER - 60);
  });
});
