import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { titlebarDragProps } from "./sidebarPane";

// =============================================================================
// 데스크탑 셸이 이 번들에 해 줘야 하는 두 가지 (#2671).
//
// 같은 번들이 브라우저와 Tauri 셸에서 돈다. 두 동작은 번들만으로는 서지 않고
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
// =============================================================================

const desktopDir = new URL("../../../desktop/src-tauri/", import.meta.url);

function readShellJson(path: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(path, desktopDir)), "utf8"));
}

interface Capability {
  windows?: string[];
  permissions?: Array<string | { identifier: string }>;
}

interface TauriConf {
  app?: { windows?: Array<{ label?: string; dragDropEnabled?: boolean }> };
}

const capability = readShellJson("capabilities/default.json") as Capability;
const conf = readShellJson("tauri.conf.json") as TauriConf;

function permissionIds(cap: Capability): string[] {
  return (cap.permissions ?? []).map((p) => (typeof p === "string" ? p : p.identifier));
}

describe("데스크탑 셸 계약 (#2671)", () => {
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
});
