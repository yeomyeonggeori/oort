import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAPTURE_LOCALE, withCaptureLocale } from "../../scripts/capture-locale.mjs";

// #5260: 캡처 하네스가 컨텍스트에 언어를 넘기지 않으면 Chromium 기본(en-US)이라 사전 문장이 영어로 찍힌다.
// 모든 컨텍스트는 `wrapBrowserShotGuard` 한 곳을 지나므로(실제 브라우저를 띄우지 않고) 그 연결을 소스에서 잰다.

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../scripts");

describe("캡처 컨텍스트의 언어 (#5260)", () => {
  it("기본은 한국어고, 호출이 직접 정한 언어는 그대로 둔다", () => {
    expect(CAPTURE_LOCALE).toBe("ko-KR");
    expect(withCaptureLocale(undefined)).toEqual({ locale: "ko-KR" });
    expect(withCaptureLocale({ viewport: { width: 1440, height: 900 } })).toEqual({
      viewport: { width: 1440, height: 900 },
      locale: "ko-KR",
    });
    expect(withCaptureLocale({ locale: "en-US" })).toEqual({ locale: "en-US" });
    expect(withCaptureLocale({}, "ja-JP")).toEqual({ locale: "ja-JP" });
  });

  it("capture-screens의 모든 브라우저가 컨텍스트 언어를 주는 래퍼를 지난다", () => {
    const source = readFileSync(join(SCRIPTS, "capture-screens.mjs"), "utf8");
    // 래퍼가 모든 newContext 옵션에 언어를 더한다.
    expect(source).toMatch(/browser\.newContext = async \(options, \.\.\.rest\) => \{[\s\S]*?withCaptureLocale\(options\)/);
    // 띄우는 브라우저마다(launch) 래퍼를 지난다: 래퍼 없이 띄운 브라우저가 있으면 그 컨텍스트는 영어로 찍힌다.
    const launches = source.match(/chromium\.launch\(/g) ?? [];
    const wrapped = source.match(/wrapBrowserShotGuard\(\s*await chromium\.launch\(/g) ?? [];
    expect(launches.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(launches.length);
    expect(source).not.toMatch(/launchPersistentContext\(/);
  });

  it("대표 캡처(capture-5260)도 같은 문을 쓴다", () => {
    expect(readFileSync(join(SCRIPTS, "capture-5260.mjs"), "utf8")).toContain("withCaptureLocale(");
  });
});
