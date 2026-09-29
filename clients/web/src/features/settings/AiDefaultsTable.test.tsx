// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_DEFAULTS_LOCAL_SLOT } from "@momo/core/features/settings/aiDefaults";
import type { AiDefaultsTeamKey } from "@momo/core/features/settings/aiDefaults";
import { HarnessUnlinkDialog } from "@/features/welcome/harnessLogin/HarnessUnlinkDialog";
import { AiDefaultsTable, type TeamDefaultsState } from "./AiDefaultsTable";
import { probeModelLists } from "@momo/core/features/settings/defaultAi";
import { publishMyAccounts, writeAiDefaults } from "./aiDefaultsStore";

// =============================================================================
// 기본 AI 표 (#2881). 코어 판정(`aiDefaults.test.ts`)이 화면에 그대로 닿는지:
// 팀 줄에 선택 칸·구독 이름이 없고, 개인 줄 선택은 이 기기에 비밀값 없이 저장되며,
// 폴백은 문장으로 보이고, 해제 창이 그 칸을 이름으로 보인다.
// =============================================================================

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const TEAM: AiDefaultsTeamKey = { status: "present", name: "https://api.openai.com/v1", failed: false, modelCount: 12 };

function render<P extends object>(node: (props: P) => ReturnType<typeof AiDefaultsTable>, props: P) {
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
    act(() => writeAiDefaults({ appCommand: { kind: "teamKey" } }));
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
      "이 맥 기본 로그인",
      "Claude · 이 맥 기본 로그인 · 구독",
      "Claude · 개인 · 구독",
      "Claude · 회사 · 구독 (로그인 필요)",
    ]);
    // 앱 명령은 팀 키 하나 + 준비 중인 내 구독(고를 수 없음).
    const app = q("ai-default-appCommand-select") as HTMLSelectElement;
    expect(Array.from(app.options).map((o) => [o.textContent, o.disabled])).toEqual([
      ["팀 API 키 · api.openai.com", false],
      ["내 구독 · 준비 중", true],
    ]);
    // 앱 명령의 모델 줄은 한 번만 선다(저장 값이 팀 키여도).
    expect(q("ai-default-appCommand")?.querySelectorAll('[data-testid="ai-default-appCommand-model"]')).toHaveLength(1);
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
    expect(q("ai-default-localTerminal-fallback")?.textContent).toContain("이 칸은 「셸」로 넘어가요");
    // 낭독기: 선택 칸이 경고 줄을 설명으로 가리킨다.
    const select = q("ai-default-localTerminal-select") as HTMLSelectElement;
    expect(select.getAttribute("aria-describedby")?.split(" ")).toContain("ai-default-localTerminal-fallback");
    expect(document.getElementById("ai-default-localTerminal-fallback")).not.toBeNull();
    // 선택 칸은 저장한 값을 그대로 가리킨다.
    expect((q("ai-default-localTerminal-select") as HTMLSelectElement).value).toBe("profile:claude:회사");
  });

  it("목록에서 사라진 계정은 「목록에 없음」 선택지로 남는다", () => {
    act(() => writeAiDefaults({ remoteWork: { kind: "profile", harness: "codex", label: "옛 계정" } }));
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    const select = q("ai-default-remoteWork-select") as HTMLSelectElement;
    expect(select.value).toBe("profile:codex:옛 계정");
    expect(select.selectedOptions[0]?.textContent).toBe("ChatGPT · 옛 계정 · 구독 (목록에 없음)");
    expect(q("ai-default-remoteWork-fallback")?.textContent).toContain("「매번 묻기」로 넘어가요");
  });

  it("운영자 판정은 서버 답을 따른다: 403이면 운영자만 바꿀 수 있다는 줄", () => {
    render(AiDefaultsTable, { teamKey: { status: "hidden" }, operator: false, browserTab: false });
    expect(q("ai-defaults-team-foot")?.dataset.operator).toBe("no");
    expect(q("ai-defaults-team-foot")?.textContent).toBe("팀 줄은 이 서버의 운영자만 바꿀 수 있어요.");
    // 팀 키가 있다고 단정하지 않는다: 앱 명령은 고르는 칸이 아니라 이유 칸.
    expect(q("ai-default-appCommand-select")).toBeNull();
    expect(q("ai-default-appCommand")?.textContent).toContain("팀 API 키 · 운영자 설정");
    expect(q("ai-default-summary")?.textContent).toContain("팀 API 키 · 운영자 설정");
  });

  it("팀 키가 없으면 앱 명령·팀 에이전트는 막히고 이유를 말한다", () => {
    render(AiDefaultsTable, { teamKey: { status: "absent" }, operator: true, browserTab: false });
    expect(q("ai-default-appCommand-select")).toBeNull();
    expect(q("ai-default-appCommand-fallback")?.textContent).toContain("AI 계정을 연결하면 쓸 수 있어요");
    expect(q("ai-default-teamAgent-fallback")?.textContent).toContain("내 구독으로 넘어가지 않아요");
  });

  it("모의 응답뿐이면 팀 연결 절과 같은 말(모의 응답)", () => {
    render(AiDefaultsTable, { teamKey: { status: "mock" }, operator: true, browserTab: false });
    expect(q("ai-default-teamAgent-fallback")?.textContent).toContain("모의 응답으로만 대답해요");
    expect(q("ai-default-teamAgent")?.textContent).not.toContain("대답할 수 없어요");
  });

  it("표 밑에 「준비 중」·「적용 전」 줄이 없다: 원격 작업은 이 맥의 workd가 읽는다(#3157)", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false });
    expect(q("ai-defaults-not-applied")).toBeNull();
    expect(q("ai-defaults-table")?.parentElement?.textContent).not.toMatch(/원격 작업이 이 선택을 따르는 것은 준비 중/);
  });

  it("브라우저 탭에서는 이 맥 계정 줄을 고르지 않는다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: true });
    expect(q("ai-default-localTerminal-select")).toBeNull();
    expect(q("ai-default-localTerminal")?.textContent).toContain("데스크탑 앱에서 고를 수 있어요");
  });
});

// #3042: 팀 줄은 운영자(default-ai GET 200)에게 서버 저장 선택 칸이다.
const PROBE = {
  ok: true,
  entries: [
    {
      position: 0,
      endpointLabel: "https://api.openai.com/v1",
      probe: { outcome: "ok", method: "models", modelIds: ["gpt-4o", "gpt-4o-mini"] },
    },
    { position: 1, endpointLabel: "https://openrouter.ai/api/v1", probe: { outcome: "ok", method: "key" } },
  ],
};

function teamState(over: Partial<TeamDefaultsState> = {}): TeamDefaultsState {
  return {
    status: "ready",
    value: { teamAgent: null, summary: null },
    links: probeModelLists(PROBE),
    pending: null,
    saveError: null,
    offline: false,
    onChoose: () => undefined,
    ...over,
  };
}

describe("기본 AI 표 팀 줄 저장 (#3042)", () => {
  it("운영자에게는 선택 칸이고, 선택지는 연결 확인의 모델뿐이며 구독은 한 줄도 없다(교차)", () => {
    const onChoose = vi.fn();
    // 이 맥에 로그인된 구독 계정이 있어도(beforeEach) 팀 줄에는 오지 않는다.
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ onChoose }) });
    for (const id of ["teamAgent", "summary"]) {
      const select = q(`ai-default-${id}-select`) as HTMLSelectElement;
      expect(select).not.toBeNull();
      const texts = Array.from(select.options).map((o) => o.textContent ?? "");
      expect(texts.slice(1)).toEqual([
        "api.openai.com · 기본 모델",
        "api.openai.com · gpt-4o",
        "api.openai.com · gpt-4o-mini",
        "openrouter.ai · 기본 모델",
      ]);
      expect(texts.join("|")).not.toMatch(/구독|Claude|ChatGPT|이 맥/);
      expect(Array.from(select.options).map((o) => o.value).join("|")).not.toMatch(/profile/);
    }
    // 같은 화면의 개인 줄은 구독을 받는다(양성 대조).
    const local = q("ai-default-localTerminal-select") as HTMLSelectElement;
    expect(Array.from(local.options).some((o) => o.textContent?.includes("구독"))).toBe(true);
    // 가드레일은 여전히 읽기 전용.
    expect(q("ai-default-guardrail")?.querySelector("select")).toBeNull();

    const select = q("ai-default-teamAgent-select") as HTMLSelectElement;
    act(() => {
      select.value = "link:0:gpt-4o-mini";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenCalledWith("teamAgent", { linkPosition: 0, modelId: "gpt-4o-mini" });
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChoose).toHaveBeenLastCalledWith("teamAgent", null);
    // #3147: 서버가 이 선택을 읽는다. 「준비 중」이라 말하지 않고 적용 규칙을 적는다.
    // 채널 요약은 워커 경로가 없어 따른다고 말하지 않는다.
    const foot = q("ai-defaults-team-foot")?.textContent ?? "";
    expect(foot).toBe(
      "모델을 직접 고른 에이전트는 자기 모델을 써요. 고르지 않은 에이전트의 대답과 첫 인사가 이 선택을 따라요. 채널 요약은 아직 만들지 않아요."
    );
    expect(foot).not.toContain("준비 중");
    expect(foot).not.toContain("아직 적용");
  });

  it("목록을 주지 않는 연결을 고르면 기본 모델만이라고 말한다", () => {
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({
        value: {
          teamAgent: { linkPosition: 1, endpointLabel: "https://openrouter.ai/api/v1", linkResolved: true, modelId: null },
          summary: null,
        },
      }),
    });
    expect((q("ai-default-teamAgent-select") as HTMLSelectElement).value).toBe("link:1:");
    expect(q("ai-default-teamAgent-model")?.textContent).toBe(
      "이 연결은 모델 목록을 알려 주지 않아요. 기본 모델만 고를 수 있어요."
    );
  });

  it("연결 확인 전이면 모델을 지어내지 않고, 저장된 값과 할 일을 말한다", () => {
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({
        links: [],
        value: {
          teamAgent: { linkPosition: 0, endpointLabel: "https://api.openai.com/v1", linkResolved: true, modelId: "gpt-4o" },
          summary: null,
        },
      }),
    });
    expect(q("ai-default-teamAgent-select")).toBeNull();
    expect(q("ai-default-teamAgent")?.textContent).toContain("api.openai.com · gpt-4o");
    expect(q("ai-default-teamAgent-model")?.textContent).toBe("연결 확인을 하면 고를 수 있는 모델이 보여요.");
    expect(q("ai-default-summary")?.textContent).toContain("고르지 않음 · 서버가 정함");
  });

  it("고른 연결이 바뀌었으면(linkResolved:false) 조용히 따라가지 않고 말한다", () => {
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({
        value: {
          teamAgent: null,
          summary: { linkPosition: 3, endpointLabel: "https://old.example/v1", linkResolved: false, modelId: "m-1" },
        },
      }),
    });
    const select = q("ai-default-summary-select") as HTMLSelectElement;
    expect(select.value).toBe("link:3:m-1");
    expect(select.selectedOptions[0]?.textContent).toBe("old.example · m-1 (연결이 바뀜)");
    expect(q("ai-default-summary-saved")?.textContent).toBe(
      "고른 연결(old.example)이 연결 순서에서 바뀌었거나 빠졌어요. 다시 골라 주세요."
    );
  });

  it("서버가 403이면(hidden) 운영자여도 읽기 전용이고, 저장 오류는 그 줄에 말한다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ status: "hidden" }) });
    expect(q("ai-default-teamAgent-select")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({ saveError: { rowId: "summary", message: "팀 줄은 이 서버의 운영자만 바꿀 수 있어요." } }),
    });
    expect(q("ai-default-summary-error")?.getAttribute("role")).toBe("alert");
    expect(q("ai-default-teamAgent-error")).toBeNull();
  });
});

describe("팀 줄 상태 (design-review #3042)", () => {
  it("읽는 중에는 불러오지 못했다고 말하지 않는다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ status: "loading", value: null }) });
    expect(q("ai-defaults-team-foot")?.textContent).toBe("팀 줄은 운영자 설정이에요.");
    act(() => root?.unmount());
    host?.remove();
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ status: "error", value: null }) });
    expect(q("ai-defaults-team-foot")?.textContent).toContain("불러오지 못해");
  });

  it("오프라인이면 칸을 잠그고 이유를 적는다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ offline: true }) });
    const select = q("ai-default-teamAgent-select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(q("ai-default-teamAgent-note")?.textContent).toBe("연결이 끊겨 지금은 바꿀 수 없어요.");
    expect(select.getAttribute("aria-describedby")).toContain("ai-default-teamAgent-note");
    act(() => root?.unmount());
    host?.remove();
    // 확인 전에도: 잠긴 확인 버튼을 누르라고 하지 않는다.
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState({ offline: true, links: [] }) });
    expect(q("ai-default-teamAgent-note")?.textContent).toBe("연결이 끊겨 지금은 바꿀 수 없어요.");
    expect(q("ai-default-teamAgent-model")).toBeNull();
  });

  it("저장이 날고 있는 줄은 두 번째 고름을 보내지 않는다", () => {
    const onChoose = vi.fn();
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({ onChoose, pending: { rowId: "teamAgent", input: { linkPosition: 0, modelId: "gpt-4o" } } }),
    });
    const select = q("ai-default-teamAgent-select") as HTMLSelectElement;
    expect(select.getAttribute("aria-disabled")).toBe("true");
    // #3064: 잠금 문법은 흐림까지다. aria-disabled 만 달고 칸이 멀쩡해 보이면
    // 고를 수 있는 칸처럼 읽힌다(#3042 design-review L1).
    const classes = select.className.split(/\s+/);
    expect(classes).toContain("aria-disabled:opacity-50");
    expect(classes).toContain("aria-disabled:cursor-not-allowed");
    expect(q("ai-default-teamAgent-saved")?.textContent).toBe("저장하고 있어요");
    expect(select.getAttribute("aria-describedby")).toContain("ai-default-teamAgent-saved");
    act(() => {
      select.value = "link:0:gpt-4o-mini";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChoose).not.toHaveBeenCalled();
    // 다른 줄은 막지 않는다.
    expect(q("ai-default-summary-select")?.getAttribute("aria-disabled")).toBeNull();
  });

  it("확인 전 + 바뀐 연결은 할 일을 한 문장에 순서대로 말한다", () => {
    render(AiDefaultsTable, {
      teamKey: TEAM,
      operator: true,
      browserTab: false,
      team: teamState({
        links: [],
        value: {
          teamAgent: null,
          summary: { linkPosition: 3, endpointLabel: "https://old.example/v1", linkResolved: false, modelId: null },
        },
      }),
    });
    expect(q("ai-default-summary-model")).toBeNull();
    expect(q("ai-default-summary")?.textContent).toContain("old.example · 기본 모델 (연결이 바뀜)");
    expect(q("ai-default-summary-saved")?.textContent).toBe(
      "고른 연결(old.example)이 연결 순서에서 바뀌었거나 빠졌어요. 연결 확인을 한 뒤 다시 골라 주세요."
    );
  });

  it("열린 팀 줄의 운영자 표지에는 자물쇠가 없고, 읽기 전용 줄에는 있다", () => {
    render(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false, team: teamState() });
    expect(q("ai-default-teamAgent")?.querySelector("svg")).toBeNull();
    expect(q("ai-default-guardrail")?.querySelector("svg")).not.toBeNull();
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
        { rowId: "localTerminal", title: "로컬 터미널 새 세션", fallback: "이 맥 기본 로그인" },
        { rowId: "remoteWork", title: "원격 작업 기본 계정", fallback: "매번 묻기" },
      ],
    });
    const box = q("my-account-unlink-impact");
    expect(box?.textContent).toContain("기본 AI에서 이 계정을 고른 칸은 이렇게 돌아가요.");
    expect(Array.from(box?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual([
      "로컬 터미널 새 세션: 이 맥 기본 로그인",
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
