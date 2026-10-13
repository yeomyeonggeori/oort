// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PERSONAL_ASSISTANTS } from "@momo/core/features/hostedAgents/personalAssistants";
import { AiConnectList } from "./AiConnectList";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(rows: Parameters<typeof AiConnectList>[0]["rows"]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(AiConnectList, {
        rows,
        selected: null,
        onSelect: () => undefined,
        pill: () => "checking" as const,
        onLoginOpen: () => undefined,
        onRecheck: () => undefined,
        grokPill: null,
        locked: false,
        probed: true,
      })
    );
  });
  return host;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe("온보딩 AI 연결 목록의 「곧」 줄 (#3773)", () => {
  it("설정의 개인 비서 목록과 같은 카탈로그에서 dots와 Muse를 가져오고 고를 수 없다", () => {
    const el = mount(["api-key", "grok"]);
    const soon = [...el.querySelectorAll('[data-testid="ai-connect-soon-row"]')];
    const catalogSoon = PERSONAL_ASSISTANTS.filter((entry) => entry.state === "soon");
    expect(soon.map((row) => row.getAttribute("data-row-id"))).toEqual(
      catalogSoon.map((entry) => entry.id)
    );
    for (const row of soon) {
      expect(row.querySelector("input")).toBeNull();
      expect(row.querySelector("button")).toBeNull();
      // 고를 수 있어 보이는 라디오 원이 없다(눌러도 반응 없는 컨트롤을 만들지 않는다).
      expect(row.querySelector(".ai-connect-radio")).toBeNull();
      expect(row.textContent).toContain("곧");
    }
    expect(soon.find((row) => row.getAttribute("data-row-id") === "muse")?.textContent).toContain(
      "Meta"
    );
    expect(soon.find((row) => row.getAttribute("data-row-id") === "dots")?.textContent).not.toMatch(
      /OpenAI/
    );
  });

  it("그록봇 줄 바로 뒤, 내 도구 묶음 앞에 선다", () => {
    const el = mount(["api-key", "grok", "claude", "codex"]);
    const order = [...el.querySelectorAll("[data-row-id]")].map((row) => row.getAttribute("data-row-id"));
    expect(order).toEqual(["api-key", "grok", "dots", "muse", "claude", "codex"]);
  });
});
