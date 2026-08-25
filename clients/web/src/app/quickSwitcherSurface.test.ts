import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./QuickSwitcher.tsx", import.meta.url),
  "utf8"
);

function openingTag(testId: string): string {
  const match = source.match(
    new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`, "s")
  );
  if (!match) throw new Error(`${testId} 여는 태그를 찾지 못했습니다.`);
  return match[0];
}

describe("⌘K 입력 표면 (#1753)", () => {
  it("입력 자체는 보더와 포커스링을 그리지 않는다", () => {
    const input = openingTag("quick-switcher-input");
    expect(input).not.toMatch(/\bborder(?:-[a-z]+)?\b/);
    expect(input).not.toContain("focus-visible:focus-ring");
    expect(input).toContain("outline-none");
    expect(input).toContain("focus-visible:outline-none");
  });

  it("팔레트 머리 그릇이 구분선과 포커스 표시를 맡는다", () => {
    const vessel = openingTag("quick-switcher-input-vessel");
    expect(vessel).toContain("border-b border-line");
    expect(vessel).toContain("focus-within:focus-ring");
  });
});
