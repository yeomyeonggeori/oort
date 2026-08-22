import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// DOM 없는 node 환경이라 렌더를 보지 않는다. 재는 것은 이 파일의 구조적
// 불변식: 제출 잠금이 로그인 형제와 같은 문법인지, 실패 착지가 종단·재시도
// 양쪽 배너에 실리는지.

const source = readFileSync(
  fileURLToPath(new URL("./ClaimPage.tsx", import.meta.url)),
  "utf8"
);

describe("claim page submit lock", () => {
  it("locks submit only while busy or offline, same grammar as ConnectPage", () => {
    expect(source).toContain("disabled={busy || offline}");
    expect(source).not.toContain('password === ""');
    expect(source).not.toContain('confirm === ""');
  });

  it("lets required speak for empty fields", () => {
    expect(source).toMatch(/id="claim-password"[\s\S]*?\brequired\b/);
    expect(source).toMatch(/id="claim-confirm"[\s\S]*?\brequired\b/);
  });
});

describe("claim page failure landing", () => {
  it("moves focus to the error banner, including the form-unmount path", () => {
    expect(source).toContain("landingRef.current?.focus({ preventScroll: true });");
    expect(source).toContain("tabIndex={-1}");
    expect(source).toContain("focus-visible:focus-ring");
    expect(source).toContain('data-landing="claim-failure"');
    // 토큰 부재 · 재시도형(폼 안) · 종단(폼 언마운트)이 같은 착지 노드를 쓴다.
    expect(source.match(/data-landing="claim-failure"/g)?.length).toBe(3);
  });
});
