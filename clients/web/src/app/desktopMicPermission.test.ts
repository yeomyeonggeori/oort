import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 허들 마이크가 서명된 데스크탑 앱에서 열리려면 셸이 해 줘야 하는 것(#2761,
// ADR-0122 D-H3).
//
// 허들은 이 번들의 LiveKit 경로가 `getUserMedia`로 마이크를 연다. 브라우저와
// dev 빌드에서는 아래 셋이 없어도 동작한다. 서명된 DMG에서만 조용히 막힌다.
//
// 1. `Info.plist`의 `NSMicrophoneUsageDescription`. macOS 권한 창에 나오는
//    문장이다. 없으면 TCC가 마이크를 요청한 앱을 거부한다.
// 2. `com.apple.security.device.audio-input` 엔타이틀먼트. 번들러는 hardened
//    runtime으로 서명하고, 그 아래에서 이 값이 없으면 TCC가 창도 띄우지 않고
//    마이크를 거부한다.
// 3. `tauri.conf.json > bundle > macOS > entitlements`. 번들러가 2의 파일로
//    서명하게 하는 연결이다. 이것이 빠지면 파일이 있어도 서명에 들어가지 않는다.
//
// 셸 crate의 같은 시험(`clients/desktop/src-tauri/tests/mic_permission.rs`)은
// 로컬에서만 돈다. CI가 도는 이쪽에서도 같은 계약을 잡는다.
// =============================================================================

const desktopDir = new URL("../../../desktop/src-tauri/", import.meta.url);
const AUDIO_INPUT = "com.apple.security.device.audio-input";

function readShell(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, desktopDir)), "utf8");
}

interface TauriConf {
  bundle?: { macOS?: { entitlements?: string; hardenedRuntime?: boolean } };
}

/** `<key>{key}</key>` 바로 뒤의 값 요소. 주석은 건너뛴다. 키가 없으면 null. */
function valueAfterKey(plist: string, key: string): string | null {
  const marker = `<key>${key}</key>`;
  const at = plist.indexOf(marker);
  if (at < 0) return null;
  const rest = plist.slice(at + marker.length).replace(/^(\s|<!--[\s\S]*?-->)*/, "");
  const match = /^(<string>[\s\S]*?<\/string>|<[^>]*>)/.exec(rest);
  return match ? match[1] : null;
}

describe("데스크탑 셸의 허들 마이크 권한", () => {
  const conf = JSON.parse(readShell("tauri.conf.json")) as TauriConf;
  const entitlementsPath = conf.bundle?.macOS?.entitlements;

  it("Info.plist가 마이크 권한 창의 문장을 준다", () => {
    const value = valueAfterKey(readShell("Info.plist"), "NSMicrophoneUsageDescription");
    expect(value, "NSMicrophoneUsageDescription 없음").toMatch(/^<string>[\s\S]+<\/string>$/);
    const text = value!.replace(/^<string>|<\/string>$/g, "").trim();
    expect(text).toContain("허들");
    expect(text).toContain("마이크");
    expect(text).not.toMatch(/[—–]/);
  });

  it("번들러가 엔타이틀먼트 파일로 서명한다", () => {
    expect(entitlementsPath, "bundle.macOS.entitlements 없음").toBeTruthy();
    expect(existsSync(fileURLToPath(new URL(entitlementsPath!, desktopDir)))).toBe(true);
  });

  it("엔타이틀먼트가 audio-input을 켠다", () => {
    expect(entitlementsPath).toBeTruthy();
    expect(valueAfterKey(readShell(entitlementsPath!), AUDIO_INPUT)).toBe("<true/>");
  });

  it("hardened runtime을 끄지 않는다", () => {
    expect(conf.bundle?.macOS?.hardenedRuntime).not.toBe(false);
  });

  it("값 읽기가 주석을 건너뛰고 없는 키는 null이다", () => {
    const plist = "<key>a</key><!-- x --><true/><key>b</key>\n<string>y</string>";
    expect(valueAfterKey(plist, "a")).toBe("<true/>");
    expect(valueAfterKey(plist, "b")).toBe("<string>y</string>");
    expect(valueAfterKey(plist, "c")).toBeNull();
  });
});
