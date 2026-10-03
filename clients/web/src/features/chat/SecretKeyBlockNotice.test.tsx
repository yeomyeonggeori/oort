// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SecretKeyBlockNotice } from "./SecretKeyBlockNotice";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function render(props: Parameters<typeof SecretKeyBlockNotice>[0]): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(SecretKeyBlockNotice, props)));
  const text = host.textContent ?? "";
  act(() => root.unmount());
  return text;
}

describe("키 차단 경고 문구 (#2942, review R2 M-2 · R3 M-3)", () => {
  it("채널: 카드 자리가 없으면 /연결 팀키가 설정으로 간다고 말한다", () => {
    const text = render({ id: "a", testId: "a", cardAvailable: false });
    expect(text).toContain("/연결 팀키로 AI의 입력 칸");
  });

  it("채널: 카드 자리가 있으면 카드의 입력 칸을 말한다", () => {
    expect(render({ id: "a", testId: "a", cardAvailable: true })).toContain(
      "/연결 팀키로 카드의 입력 칸"
    );
  });

  it("스레드: `/` 명령을 권하지 않는다(그 입력창에서는 평문 답글이 된다)", () => {
    const text = render({ id: "a", testId: "a", cardAvailable: true, surface: "thread" });
    expect(text).not.toContain("/연결");
    expect(text).toContain("AI의 입력 칸");
    expect(text).toContain("이 메시지는 보내지 않았어요");
  });
});
