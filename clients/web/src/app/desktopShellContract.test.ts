import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { titlebarDragProps } from "./sidebarPane";

// =============================================================================
// 데스크탑 셸이 이 번들에 해 줘야 하는 것들 (#2671, #2676).
//
// 같은 번들이 브라우저와 Tauri 셸에서 돈다. 아래 동작은 번들만으로는 서지 않고
// 셸 설정(`clients/desktop/src-tauri`)이 받쳐 줘야 한다. 셸 설정이 빠져도 번들
// 시험은 초록이고 앱 안에서만 조용히 죽는다. 그래서 이 시험이 셸 설정을 읽는다.
//
// 1. 창 끌기. `titlebarDragProps(true)`가 붙이는 `data-tauri-drag-region`을
//    누르면 Tauri의 drag.js가 `plugin:window|start_dragging`을 부른다. 이
//    명령은 `core:default`(→ `core:window:default`)에 없다. capability가
//    `core:window:allow-start-dragging`을 따로 주지 않으면 거부되고
//    (「window.start_dragging not allowed」) 창은 움직이지 않는다.
// 2. 파일 끌어 놓기. 컴포저(`useComposerDropZone`)와 사이드바 재배치
//    (`sidebarDnd.ts`)는 HTML5 `dragover`/`drop`을 쓴다. Tauri의 기본값
//    `dragDropEnabled: true`에서는 셸의 네이티브 처리기가 모든 끌기를 먼저
//    받아(`tauri://drag-drop`) WKWebView가 HTML5 이벤트를 하나도 쏘지 않는다.
// 3. 알림 플러그인의 부팅 확인(#2676). `tauri-plugin-notification`은 모든
//    페이지에 스크립트를 심어 `window.Notification`을 바꾸고, 문서가 열릴 때
//    `plugin:notification|is_permission_granted`를 한 번 부른다. capability에
//    권한이 없으면 거부되고, 실행할 때마다 처리되지 않은 거부가 하나 남는다.
//    배너 자체는 앱 명령(`src/lib/tauri.ts`의 `notification_*`)으로 나가서
//    이 권한과 무관하다. 그래서 읽기 전용 확인 하나만 준다.
// 4. 신호등과 사이드바 토글의 세로 중심선(#2700). 신호등은 셸이 네이티브로
//    그리고(`trafficLightPosition`), 토글은 이 번들의 `app-titlebar` 줄 가운데
//    선다. 둘은 서로를 모른다. 한쪽만 바뀌면 어긋나고, 번들 시험도 셸 시험도
//    각각은 초록이다. 그래서 여기서 두 값을 한 식으로 묶는다.
// =============================================================================

const desktopDir = new URL("../../../desktop/src-tauri/", import.meta.url);
const tokensCss = readFileSync(
  fileURLToPath(new URL("../design/tokens.css", import.meta.url)),
  "utf8"
);

function readShellJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, desktopDir)), "utf8"));
}

interface Capability {
  windows?: string[];
  permissions?: Array<string | { identifier: string }>;
}

interface TauriWindow {
  label?: string;
  dragDropEnabled?: boolean;
  titleBarStyle?: string;
  hiddenTitle?: boolean;
  trafficLightPosition?: { x: number; y: number };
}

interface TauriConf {
  app?: { windows?: TauriWindow[] };
}

const capability = readShellJson("capabilities/default.json") as Capability;
const conf = readShellJson("tauri.conf.json") as TauriConf;

function permissionIds(cap: Capability): string[] {
  return (cap.permissions ?? []).map((p) => (typeof p === "string" ? p : p.identifier));
}

describe("데스크탑 셸 계약 (#2671, #2676)", () => {
  it("상단 줄의 드래그 영역은 셸의 start_dragging 권한이 받쳐 준다", () => {
    expect(titlebarDragProps(true)).toEqual({ "data-tauri-drag-region": "" });
    expect(capability.windows).toContain("main");
    expect(permissionIds(capability)).toContain("core:window:allow-start-dragging");
  });

  it("main 창은 파일 끌어 놓기를 HTML5 이벤트로 페이지에 넘긴다", () => {
    const main = conf.app?.windows?.find((w) => (w.label ?? "main") === "main");
    expect(main).toBeDefined();
    // 키가 없으면 Tauri 기본값(true)이다. false여야 컴포저의 onDrop이 불린다.
    expect(main?.dragDropEnabled).toBe(false);
  });

  it("알림 플러그인에는 부팅 때 묻는 읽기 전용 확인 하나만 허용한다 (#2676)", () => {
    const notification = permissionIds(capability).filter((p) =>
      p.startsWith("notification:")
    );
    // `notification:default`나 `allow-notify`는 페이지 스크립트가 배너를 띄우거나
    // 권한을 묻게 연다. 앱의 알림은 앱 명령으로 나가므로 그 권한은 필요 없다.
    expect(notification).toEqual(["notification:allow-is-permission-granted"]);
  });
});

// -----------------------------------------------------------------------------
// #2700 — 신호등 중심선 = 토글 중심선
//
// 실측(2026-09-25, macOS 27.0 26A428, tauri-runtime-wry 2.11.4 / tao 0.35.3,
// Retina 2x, `screencapture -l` 창 캡처의 픽셀 경계 ÷ 2):
//   trafficLightPosition.y = 14   → 신호등 원 5.0–19.0pt, 중심 12.0pt
//   trafficLightPosition.y = 21.5 → 신호등 원 12.5–26.5pt, 중심 19.5pt
// 두 점이 기울기 1로 이어진다: 신호등 중심 = y − 2. tao는 버튼 컨테이너의 높이를
// 「버튼 높이 + y」로 늘릴 뿐 버튼의 y를 직접 두지 않으므로, 이 2pt는 설정이
// 아니라 AppKit 배치에서 나온 값이다. OS가 신호등을 다시 그리면 다시 잰다.
//
// 토글: `app-titlebar`는 border-box 높이 `--spacing-control-lg`(40)에 아래
// 테두리 1px이다. 내용 상자는 39px이고 `align-items: center`라 토글 중심은
// 19.5px. 같은 캡처에서 토글 아이콘 경계 12.5–26.5pt, 중심 19.5pt로 확인했다.
// 수정 전(y=14)에는 7.5pt 어긋나 있었다(성재 스크린샷과 같은 모양).
// -----------------------------------------------------------------------------

/** 신호등 중심 − `trafficLightPosition.y` (pt). 음수 = 중심이 y보다 위. 위 실측. */
const LIGHT_CENTER_MINUS_Y = -2;

function pxToken(name: string): number {
  const match = tokensCss.match(new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px;`));
  if (!match) throw new Error(`${name} not found in tokens.css`);
  return Number(match[1]);
}

function utilityBlock(name: string): string {
  const start = tokensCss.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`@utility ${name} not found`);
  const end = tokensCss.indexOf("\n}", start);
  return tokensCss.slice(start, end);
}

describe("타이틀바 신호등과 사이드바 토글의 세로 정렬 (#2700)", () => {
  const main = conf.app?.windows?.find((w) => (w.label ?? "main") === "main");
  const titlebar = utilityBlock("app-titlebar");

  it("신호등이 웹 콘텐츠 위에 떠 있는 Overlay 타이틀바다", () => {
    // Overlay가 아니면 신호등은 네이티브 제목줄 안에 있고 웹 줄은 그 아래에서
    // 시작한다. 아래 정렬 계산이 성립하는 전제다.
    expect(main?.titleBarStyle).toBe("Overlay");
    expect(main?.hiddenTitle).toBe(true);
  });

  it("app-titlebar 줄은 control-lg 높이에 아래 테두리 1px, 토글은 세로 가운데", () => {
    expect(titlebar).toMatch(/block-size:\s*var\(--spacing-control-lg\);/);
    expect(titlebar).toMatch(/border-block-end:\s*1px solid/);
    expect(titlebar).toMatch(/align-items:\s*center;/);
  });

  it("신호등 중심과 토글 중심이 1pt 안에서 맞는다", () => {
    const rowHeight = pxToken("--spacing-control-lg");
    const borderBottom = 1;
    const toggleCenter = (rowHeight - borderBottom) / 2;
    const y = main?.trafficLightPosition?.y;
    expect(typeof y).toBe("number");
    const lightsCenter = (y as number) + LIGHT_CENTER_MINUS_Y;
    expect(Math.abs(lightsCenter - toggleCenter)).toBeLessThanOrEqual(1);
  });
});
