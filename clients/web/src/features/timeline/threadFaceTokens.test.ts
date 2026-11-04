import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THREAD_FACE_OVERLAP, THREAD_FACE_SIZE } from "@momo/core/features/timeline/threadSummary";
import { compileTokensCss } from "@/design/appearance/compileTokensTestKit";
import { cn } from "@/design/lib/cn";
import {
  THREAD_FACE_OVERLAP_CLASS,
  THREAD_FACE_RING_CLASS,
  THREAD_FACE_SIZE_CLASS,
} from "./spacing";

// 스레드 요약 줄의 겹친 얼굴: 코어의 규격 숫자와 화면의 클래스가 갈라지지 않는가 (#4878).
// `spacing.test.ts`·`avatarSize.test.ts`와 같은 다리 검사다 — 이 레포의 간격 스케일은 닫혀 있어서(`--spacing: initial`)
// 20·6처럼 격자 밖 숫자는 클래스 이름만 있고 규칙이 없을 수 있다(U4-4R W-1). 그래서 **컴파일된 CSS**를 읽는다.

const tokensCss = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const declared = (name: string) => {
  const match = tokensCss.match(new RegExp(`--spacing-${name}:\\s*(\\d+(?:\\.\\d+)?)px`));
  if (match === null) throw new Error(`tokens.css에 --spacing-${name}이 없다`);
  return Number(match[1]);
};

describe("겹친 얼굴의 규격 다리", () => {
  it("tokens.css의 이름 단계가 코어의 규격 숫자다: 웹 한 변 20 · 겹침 6", () => {
    expect(declared("thread-face")).toBe(THREAD_FACE_SIZE.web);
    expect(declared("thread-face-overlap")).toBe(THREAD_FACE_OVERLAP);
  });

  it("세 클래스가 실제로 컴파일된다 — 한 변은 폭·높이, 겹침은 음수 왼쪽 여백, 링은 2px 박스 그림자", async () => {
    const css = await compileTokensCss([
      THREAD_FACE_SIZE_CLASS,
      THREAD_FACE_OVERLAP_CLASS,
      ...THREAD_FACE_RING_CLASS.split(" "),
    ]);
    expect(css).toMatch(/\.size-thread-face\s*\{[^}]*width:\s*var\(--spacing-thread-face\)[^}]*height:\s*var\(--spacing-thread-face\)/);
    expect(css).toMatch(/\.-ml-thread-face-overlap\s*\{[^}]*margin-left:\s*calc\(var\(--spacing-thread-face-overlap\) \* -1\)/);
    expect(css).toMatch(/\.ring-2\s*\{[^}]*--tw-ring-shadow:[^;]*calc\(2px \+/);
    expect(css).toMatch(/\.ring-pane\s*\{[^}]*--tw-ring-color:\s*var\(--pane\)/);
  });

  it("격자 밖 철자(size-5·-ml-1.5)는 컴파일되지 않는다 — 이름 단계가 필요한 이유", async () => {
    const css = await compileTokensCss(["size-5", "-ml-1.5"]);
    expect(css).not.toMatch(/\.size-5\s*\{/);
    expect(css).not.toMatch(/\.-ml-1\\\.5\s*\{/);
  });

  it("공용 Avatar의 기본 size-8이 이름 단계에 진다 — cn이 같은 크기 그룹으로 안다", () => {
    expect(cn("size-8", THREAD_FACE_SIZE_CLASS)).toBe(THREAD_FACE_SIZE_CLASS);
    expect(cn("text-meta", "text-timestamp")).toBe("text-timestamp");
  });
});
