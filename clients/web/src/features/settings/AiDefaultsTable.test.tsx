// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_DEFAULTS_LOCAL_SLOT } from "@momo/core/features/settings/aiDefaults";
import type { AiDefaultsTeamKey } from "@momo/core/features/settings/aiDefaults";
import { HarnessUnlinkDialog } from "@/features/welcome/harnessLogin/HarnessUnlinkDialog";
import { AiDefaultsTable } from "./AiDefaultsTable";
import { publishMyAccounts, writeAiDefaults } from "./aiDefaultsStore";

// =============================================================================
// 기본 AI 표 (#2881). 코어 판정(`aiDefaults.test.ts`)이 화면에 그대로 닿는지:
// 팀 줄에 선택 칸·구독 이름이 없고, 개인 줄 선택은 이 기기에 비밀값 없이 저장되며,
// 폴백은 문장으로 보이고, 해제 창이 그 칸을 이름으로 보인다.
// =============================================================================

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const TEAM: AiDefaultsTeamKey = { status: "present", name: "OpenAI", failed: false, modelCount: 12 };

function render(node: Parameters<typeof createElement>[0], props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(node, props)));
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  window.localStorage.clear();
  act(() => {
    writeAiDefaults({});
    publishMyAccounts([
      { harness: "claude", label: null, auth: "logged_in" },
      { harness: "claude", label: "개인", auth: "logged_in" },
      { harness: "claude", label: "회사", auth: "needs_login" },
    ]);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  act(() => publishMyAccounts(null));
  vi.restoreAllMocks();
});

describe("기본 AI 표 화면", () => {
  it("팀이 보는 줄에는 선택 칸도 구독 이름도 없다(수용 기준, DOM)", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    for (const id of ["teamAgent", "summary", "guardrail"]) {
      const row = q(`ai-default-${id}`);
      expect(row?.dataset.audience).toBe("team");
      expect(row?.querySelector("select")).toBeNull();
      expect(row?.textContent).not.toMatch(/Claude|ChatGPT|구독/);
      expect(row?.textContent).toContain("운영자");
    }
    // 같은 화면의 개인 줄은 구독을 선택지로 받는다.
    const local = q("ai-default-localTerminal-select") as HTMLSelectElement;
    expect(Array.from(local.options).map((o) => o.textContent)).toEqual([
      "마지막에 쓴 계정",
      "Claude · 이 맥 기본 로그인 · 구독",
      "Claude · 개인 · 구독",
      "Claude · 회사 · 구독 (로그인 필요)",
    ]);
    // 앱 명령은 팀 키 하나 + 준비 중인 내 구독(고를 수 없음).
    const app = q("ai-default-appCommand-select") as HTMLSelectElement;
    expect(Array.from(app.options).map((o) => [o.textContent, o.disabled])).toEqual([
      ["OpenAI · 팀 기본 · API 키", false],
      ["내 구독 · 준비 중", true],
    ]);
    expect(q("ai-default-summary-model")?.textContent).toBe("모델은 서버가 정함 · 이 키로 쓸 수 있는 모델 12개");
  });

  it("고르면 이 기기에 저장되고, 저장 값에는 하네스 id와 라벨뿐이다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    const local = q("ai-default-localTerminal-select") as HTMLSelectElement;
    act(() => {
      local.value = "profile:claude:개인";
      local.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const raw = window.localStorage.getItem(AI_DEFAULTS_LOCAL_SLOT);
    expect(JSON.parse(raw ?? "null")).toEqual({
      localTerminal: { kind: "profile", harness: "claude", label: "개인" },
    });
    expect(raw).not.toMatch(/[/\\]|token|sk-/i);
    expect(q("ai-default-localTerminal-model")?.textContent).toBe("모델은 CLI 기본값");
  });

  it("저장한 계정이 로그인 필요면 조용히 바꾸지 않고 셸로 넘어간다고 말한다", () => {
    act(() => writeAiDefaults({ localTerminal: { kind: "profile", harness: "claude", label: "회사" } }));
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    expect(q("ai-default-localTerminal")?.dataset.state).toBe("fallback");
    expect(q("ai-default-localTerminal-fallback")?.textContent).toContain("셸로 열어요");
    // 선택 칸은 저장한 값을 그대로 가리킨다.
    expect((q("ai-default-localTerminal-select") as HTMLSelectElement).value).toBe("profile:claude:회사");
  });

  it("목록에서 사라진 계정은 「목록에 없음」 선택지로 남는다", () => {
    act(() => writeAiDefaults({ remoteWork: { kind: "profile", harness: "codex", label: "옛 계정" } }));
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    const select = q("ai-default-remoteWork-select") as HTMLSelectElement;
    expect(select.value).toBe("profile:codex:옛 계정");
    expect(select.selectedOptions[0]?.textContent).toBe("ChatGPT · 옛 계정 · 구독 (목록에 없음)");
    expect(q("ai-default-remoteWork-fallback")?.textContent).toContain("작업마다 계정을 물어요");
  });

  it("운영자 판정은 서버 답을 따른다: 403이면 운영자만 바꿀 수 있다는 줄", () => {
    render(AiDefaultsTable, { teamKey: { status: "hidden" }, operator: false, browserTab: false });
    expect(q("ai-defaults-team-foot")?.dataset.operator).toBe("no");
    expect(q("ai-defaults-team-foot")?.textContent).toBe("팀 줄은 이 서버의 운영자만 바꿀 수 있어요.");
  });

  it("팀 키가 없으면 앱 명령·팀 에이전트는 막히고 이유를 말한다", () => {
    render(AiDefaultsTable, { teamKey: { status: "absent" }, operator: true, browserTab: false });
    expect(q("ai-default-appCommand-select")).toBeNull();
    expect(q("ai-default-appCommand-fallback")?.textContent).toContain("AI 계정을 연결하면 쓸 수 있어요");
    expect(q("ai-default-teamAgent-fallback")?.textContent).toContain("내 구독으로 넘어가지 않아요");
  });

  it("브라우저 탭에서는 이 맥 계정 줄을 고르지 않는다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: true });
    expect(q("ai-default-localTerminal-select")).toBeNull();
    expect(q("ai-default-localTerminal")?.textContent).toContain("데스크탑 앱에서 고를 수 있어요");
  });
});

describe("연결 해제 창: 기본 AI 칸을 이름으로 (#2878이 기다리던 목록)", () => {
  it("이 계정을 쓰던 칸과 넘어갈 곳을 확인 단계에 보인다", () => {
    const opener = createRef<HTMLElement>();
    render(HarnessUnlinkDialog, {
      row: { harness: "claude", profile: "회사" },
      opener,
      onClose: () => undefined,
      onRemoveFromList: () => undefined,
      onUnlinked: () => undefined,
      fixture: { status: { phase: "confirm" } },
      impact: [
        { rowId: "localTerminal", title: "로컬 터미널 새 세션", fallback: "셸" },
        { rowId: "remoteWork", title: "원격 작업 기본 계정", fallback: "매번 묻기" },
      ],
    });
    const box = q("my-account-unlink-impact");
    expect(box?.textContent).toContain("기본 AI에서 이 계정을 쓰던 칸은 이렇게 바뀌어요.");
    expect(Array.from(box?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual([
      "로컬 터미널 새 세션: 셸",
      "원격 작업 기본 계정: 매번 묻기",
    ]);
  });

  it("영향이 없으면 줄을 그리지 않는다", () => {
    const opener = createRef<HTMLElement>();
    render(HarnessUnlinkDialog, {
      row: { harness: "claude", profile: null },
      opener,
      onClose: () => undefined,
      onRemoveFromList: () => undefined,
      onUnlinked: () => undefined,
      impact: [],
    });
    expect(q("my-account-unlink-dialog")).not.toBeNull();
    expect(q("my-account-unlink-impact")).toBeNull();
  });
});
