import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 칸 → 수집기 배선(shareCollectors.ts)도 PTY 출력에 닿지 않는다(ADR-0190 D4-b).
const src = readFileSync(new URL("./shareCollectors.ts", import.meta.url), "utf8");
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

describe("배선 소스", () => {
  it("세션 표면은 subscribe·getSnapshot·lastOutputAtOf·ptyIdOf뿐이다", () => {
    const pick = src.match(/Pick<LocalSessions,([^>]*)>/)![1]!;
    expect([...pick.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort()).toEqual(
      ["getSnapshot", "lastOutputAtOf", "ptyIdOf", "subscribe"].sort()
    );
  });

  it("출력·미러·스크롤백·바이트를 가리키는 식별자가 코드에 없다", () => {
    expect(code).not.toMatch(/\b\w*(mirror|scrollback|xterm|bytes|stdout|buffer|chunk|TextDecoder|attach|persist)\w*\b/i);
    expect(code).not.toMatch(/"g5"|\bg5\b/);
  });
});
