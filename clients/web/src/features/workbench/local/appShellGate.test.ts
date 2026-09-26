import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AppShell은 소켓·라우터·다이얼로그 제공자를 한꺼번에 세우는 셸이라 렌더 시험이
// 무겁다. 도크의 문지기 두 줄만 소스로 잰다: 브라우저 탭에는 로컬 PTY가 없으므로
// 도크(와 ⌃` 전역 키)가 붙지 않아야 한다(#2774). 헤더 버튼 쪽은
// workSurfaceEntryPoints.test.tsx가 렌더로 잰다.
const src = readFileSync(
  fileURLToPath(new URL("../../../app/AppShell.tsx", import.meta.url)),
  "utf8"
);

describe("AppShell 로컬 도크 문지기", () => {
  it("도크는 데스크탑 셸에서만, 스트레스 측정이 아닐 때만 붙는다", () => {
    expect(src).toMatch(/const localTerminal = isDesktop\(\) && !stress;/);
    const mounts = src.match(/<LocalTerminalDock\b/g) ?? [];
    expect(mounts.length).toBe(1);
    expect(src).toMatch(/\{localTerminal && <LocalTerminalDock \/>\}/);
  });

  it("전체 화면은 라우트 상자를 지우지 않고 숨긴다", () => {
    expect(src).toMatch(/localDockFullscreen && "hidden"/);
  });
});
