// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_DEFAULTS_LOCAL_SLOT } from "@momo/core/features/settings/aiDefaults";
import type { AiDefaultsTeamKey } from "@momo/core/features/settings/aiDefaults";

// =============================================================================
// 원격 작업 행 → 이 맥의 workd (#3157). 셸(소켓)과 로그인 창은 가짜로 갈아 끼우고,
// 표가 (1) 셸이 받은 뒤에만 이 기기에 저장하는지 (2) 거부 라벨을 문장으로 말하는지
// (3) 거부되면 조용히 다른 계정으로 넘어가지 않는지(칸이 이전 값으로 돌아오는지)를 본다.
// =============================================================================

const shell = vi.hoisted(() => ({
  set: vi.fn(),
  prepare: vi.fn(),
  status: vi.fn(),
}));

vi.mock("@/lib/tauri", async (original) => ({
  ...(await original<typeof import("@/lib/tauri")>()),
  desktopRemoteProfile: { set: shell.set, prepare: shell.prepare },
  harnessProfileRemoteStatus: shell.status,
}));

// 로그인 창은 PTY를 만든다: 가짜 창이 연결됨·닫기 두 단추만 낸다.
vi.mock("@/features/welcome/harnessLogin/HarnessLoginDialog", () => ({
  HarnessLoginDialog: (props: {
    harness: string;
    profile: string | null;
    remote?: boolean;
    onClose: () => void;
    onConnected: (harness: never) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "fake-login", "data-remote": String(props.remote === true), "data-profile": props.profile ?? "" },
      createElement("button", { "data-testid": "fake-connect", onClick: () => props.onConnected(props.harness as never) }),
      createElement("button", { "data-testid": "fake-close", onClick: props.onClose })
    ),
}));

import { AiDefaultsTable } from "./AiDefaultsTable";
import { publishMyAccounts, writeAiDefaults } from "./aiDefaultsStore";
import { resetRemoteWorkForTest } from "./remoteWorkStore";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const TEAM: AiDefaultsTeamKey = { status: "present", name: "https://api.openai.com/v1", failed: false, modelCount: 12 };
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const select = () => q("ai-default-remoteWork-select") as HTMLSelectElement;
const stored = () => JSON.parse(window.localStorage.getItem(AI_DEFAULTS_LOCAL_SLOT) ?? "{}");
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: false })));
}

async function pick(value: string) {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  window.localStorage.clear();
  resetRemoteWorkForTest();
  shell.set.mockReset().mockResolvedValue({ ok: true, reset: false });
  shell.prepare.mockReset().mockResolvedValue({ ok: true });
  shell.status.mockReset().mockResolvedValue({ id: "claude", installed: true, auth: "logged_in" });
  act(() => {
    writeAiDefaults({});
    publishMyAccounts([
      { harness: "claude", label: null, auth: "logged_in" },
      { harness: "claude", label: "개인", auth: "logged_in" },
      { harness: "codex", label: "회사", auth: "needs_login" },
    ]);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  act(() => publishMyAccounts(null));
});

describe("원격 작업 행", () => {
  it("이 맥 기본 로그인은 선택지가 아니다(원격은 계정 폴더로만 뜬다)", () => {
    render();
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual([
      "매번 묻기",
      "Claude · 개인 · 구독",
      "ChatGPT · 회사 · 구독 (로그인 필요)",
    ]);
  });

  it("로그인돼 있으면 셸이 받은 뒤에 이 기기에 저장하고, 표 밑 「준비 중」 줄은 없다", async () => {
    render();
    await flush();
    shell.set.mockClear();
    await pick("profile:claude:개인");
    expect(shell.prepare).toHaveBeenCalledWith("claude", "개인");
    expect(shell.set.mock.calls).toEqual([["claude", "개인"], ["codex", null]]);
    expect(stored()).toEqual({ remoteWork: { kind: "profile", harness: "claude", label: "개인" } });
    expect(select().value).toBe("profile:claude:개인");
    expect(q("ai-default-remoteWork-note")?.textContent).toContain("원격 작업용으로 따로 로그인한 이 계정");
    expect(q("ai-default-remoteWork")?.textContent).not.toContain("준비 중");
    expect(q("ai-defaults-not-applied")).toBeNull();
  });

  it("거부 라벨은 해요체 문장으로 말하고, 저장하지 않으며 칸은 이전 값으로 돌아온다(교차)", async () => {
    render();
    await flush();
    const cases: [string, string][] = [
      ["profile_not_found", "이 맥에 원격 작업용 계정 폴더가 없어요."],
      ["profile_refused", "원격 작업용 계정 폴더가 바뀌었거나 안전하지 않아 쓰지 않았어요."],
      ["profile_login_required", "원격 작업용 계정이 로그인돼 있지 않아요."],
    ];
    for (const [code, lead] of cases) {
      shell.set.mockReset().mockResolvedValue({ ok: false, code });
      await pick("profile:claude:개인");
      const line = q("ai-default-remoteWork-error");
      expect(line?.textContent, code).toContain(lead);
      expect(line?.textContent, code).toContain("다른 계정으로 대신 시작하지 않아요.");
      expect(line?.getAttribute("role")).toBe("alert");
      // 거부를 말하는 동안 「이 계정으로 떠요」 안내는 서지 않는다.
      expect(q("ai-default-remoteWork-note"), code).toBeNull();
      expect(window.localStorage.getItem(AI_DEFAULTS_LOCAL_SLOT) ?? "{}", code).not.toContain("개인");
      expect(select().value, code).toBe("");
      // 실패 뒤에 「고르지 않음」으로 지우는 호출(=다른 계정/기본으로의 조용한 이동)이 없다.
      expect(shell.set.mock.calls.filter(([, label]) => label === null), code).toEqual([]);
    }
  });

  it("준비 단계 거부(호스트 꺼짐)도 저장 없이 이유를 말한다", async () => {
    render();
    await flush();
    shell.set.mockClear();
    shell.prepare.mockResolvedValue({ ok: false, code: "not_running" });
    await pick("profile:claude:개인");
    expect(q("ai-default-remoteWork-error")?.textContent).toContain("작업 호스트로 켜져 있지 않아");
    expect(shell.set).not.toHaveBeenCalledWith("claude", "개인");
    expect(stored()).toEqual({});
  });

  it("로그인이 필요하면 원격 작업용 로그인 창을 열고, 연결된 뒤에만 저장한다", async () => {
    shell.status.mockResolvedValue({ id: "codex", installed: true, auth: "needs_login" });
    render();
    await flush();
    await pick("profile:codex:회사");
    const dialog = q("fake-login");
    expect(dialog?.dataset.remote).toBe("true");
    expect(dialog?.dataset.profile).toBe("회사");
    expect(shell.set).not.toHaveBeenCalledWith("codex", "회사");
    expect(stored()).toEqual({});
    await act(async () => q("fake-connect")?.click());
    await flush();
    expect(shell.set).toHaveBeenCalledWith("codex", "회사");
    expect(stored()).toEqual({ remoteWork: { kind: "profile", harness: "codex", label: "회사" } });
  });

  it("로그인을 마치지 않고 닫으면 아무것도 바꾸지 않고 그 사실을 말한다", async () => {
    shell.status.mockResolvedValue({ id: "codex", installed: true, auth: "needs_login" });
    render();
    await flush();
    await pick("profile:codex:회사");
    await act(async () => q("fake-close")?.click());
    await flush();
    expect(shell.set).not.toHaveBeenCalledWith("codex", "회사");
    expect(stored()).toEqual({});
    expect(q("fake-login")).toBeNull();
    expect(q("ai-default-remoteWork-saved")?.textContent).toBe("로그인을 마치지 않아 원격 작업 계정을 바꾸지 않았어요.");
  });

  it("「매번 묻기」로 되돌리면 두 하네스의 선택을 지우고 저장도 지운다", async () => {
    act(() => writeAiDefaults({ remoteWork: { kind: "profile", harness: "claude", label: "개인" } }));
    render();
    await flush();
    shell.set.mockClear();
    await pick("");
    expect(shell.set.mock.calls).toEqual([["claude", null], ["codex", null]]);
    expect(stored()).toEqual({});
  });

  it("선택 파일이 초기화됐다고 답하면 그 사실을 알린다", async () => {
    render();
    await flush();
    shell.set.mockResolvedValue({ ok: true, reset: true });
    await pick("profile:claude:개인");
    expect(q("ai-default-remoteWork-error")?.textContent).toBe(
      "원격 작업 계정 선택이 초기화됐어요. 계정을 다시 골라 주세요."
    );
  });

  it("표를 열면 저장된 선택을 이 맥에 다시 넘기고, 폴더가 사라졌으면 거부 문장이 남는다", async () => {
    act(() => writeAiDefaults({ remoteWork: { kind: "profile", harness: "claude", label: "개인" } }));
    shell.set.mockImplementation(async (_harness: string, label: string | null) =>
      label === "개인" ? { ok: false, code: "profile_not_found" } : { ok: true, reset: false }
    );
    render();
    await flush();
    expect(shell.set).toHaveBeenCalledWith("claude", "개인");
    expect(q("ai-default-remoteWork-error")?.textContent).toContain("이 맥에 원격 작업용 계정 폴더가 없어요.");
    // 다시 고르라는 문장만 남기고 저장 값은 조용히 지우지 않는다.
    expect(stored().remoteWork).toEqual({ kind: "profile", harness: "claude", label: "개인" });
  });

  it("브라우저 탭에서는 이 맥에 아무것도 묻지 않는다", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(createElement(AiDefaultsTable, { teamKey: TEAM, operator: true, browserTab: true })));
    await flush();
    expect(shell.set).not.toHaveBeenCalled();
    expect(shell.prepare).not.toHaveBeenCalled();
  });
});
