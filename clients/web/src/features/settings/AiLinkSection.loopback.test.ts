import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./AiLinkSection.tsx", import.meta.url)),
  "utf8"
);

describe("AI 연결 loopback 안내 (#2204)", () => {
  it("서버 거부를 토스트가 아니라 자리의 배너로 연다", () => {
    expect(source).toContain("loopbackProviderGuidance");
    expect(source).toContain("isLoopbackProviderUrl");
    expect(source).toContain('testId="ai-link-loopback-hint"');
    expect(source).not.toMatch(/toast/i);
  });
});
