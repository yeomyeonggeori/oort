import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 출처 규칙(ADR-0190 D4-b, Q3, #2861): 공유 요약 수집기는 PTY 출력을 읽지 않는다.
// 행동 시험(core shareSummary.test.ts)과 별개로, 소스에 그 길이 없음을 잠근다.
const src = readFileSync(
  new URL("../../../../../../packages/momo-core/src/features/workbench/shareSummary.ts", import.meta.url),
  "utf8"
);

/** 주석·문자열 리터럴을 지운 코드만. 식별자만 본다. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("공유 요약 수집기 소스 (ADR-0190 D4-b 「긁지 않는다」)", () => {
  const code = codeOnly(src);

  it("import는 칸 판정·git 필드·상태 어휘 타입뿐이다(터미널·pty·세션 저장소 없음)", () => {
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["./gitRead", "./paneStatus", "./paneStatus", "./sessionList"].sort());
  });

  it("출력·바이트·스크롤백·xterm·커밋 제목을 가리키는 식별자가 코드에 없다", () => {
    expect(code).not.toMatch(/\b\w*(output|stdout|stderr|bytes|scrollback|xterm|buffer|chunk|onData|transcript)\w*\b/i);
    expect(code).not.toMatch(/\b(subject|commitTitle|commitMessage)\b/i);
    // G5(커밋 읽기) 입구가 없다.
    expect(code).not.toMatch(/\bg5\b/);
  });

  it("문자열 입구는 제목(글자 모양 하나)과 PR URL(형식 검증) 둘뿐이다", () => {
    const iface = src.slice(src.indexOf("export interface ShareCollector"), src.indexOf("/** 칸 폴더의 git 읽기 결과"));
    const strings = [...iface.matchAll(/^\s+(on\w+)\(([^)]*)\)/gm)].filter(([, , args]) => /string/.test(args!));
    expect(strings.map(([, name]) => name).sort()).toEqual(["onLifecycle", "onPrUrl", "onTitle"]);
  });

  it("셸 입구·네트워크·파일·프로세스를 쓰지 않는다", () => {
    expect(code).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|invoke|child_process|readFile|exec)\b/);
  });
});
