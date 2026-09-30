// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { MemoryNotice } from "@momo/core/features/memory/model";
import {
  MEMORY_NOTICE_NEVER_COPY,
  MEMORY_NOTICE_NEVER_UNKNOWN,
  MEMORY_NOTICE_SENDS_COPY,
  MEMORY_NOTICE_SENDS_UNKNOWN,
  MEMORY_RESET_ADMIN_ONLY,
  MEMORY_RESET_CONFIRM_WORD,
} from "@momo/core/features/memory/presentation";
import { MemorySettingsSection } from "./MemorySettingsSection";
import { WS, byTestId, click, flush, mount, settings, type, unmount } from "./memoryTestKit";

const getMemorySettings = vi.hoisted(() => vi.fn());
const patchWorkspaceMemorySettings = vi.hoisted(() => vi.fn());
const getMemoryNotice = vi.hoisted(() => vi.fn());
const resetWorkspaceMemory = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    getMemorySettings: (...a: unknown[]) => getMemorySettings(...a) as unknown,
    patchWorkspaceMemorySettings: (...a: unknown[]) =>
      patchWorkspaceMemorySettings(...a) as unknown,
    getMemoryNotice: (...a: unknown[]) => getMemoryNotice(...a) as unknown,
    resetWorkspaceMemory: (...a: unknown[]) => resetWorkspaceMemory(...a) as unknown,
  };
});

const COUNTS = {
  digests: 12,
  items: 8,
  evidence: 30,
  topics: 3,
  topicSummaries: 3,
  embeddings: 8,
  proposals: 1,
  servings: 5,
  consolidationPairs: 0,
  consolidationState: 0,
};

function notice(over: Partial<MemoryNotice> = {}): MemoryNotice {
  return {
    enabled: true,
    paused: false,
    sending: true,
    resetEpoch: 2,
    summary: {
      configured: true,
      provider: { name: "OpenAI", host: "api.openai.com" },
      modelId: "gpt-5.4-mini",
    },
    embeddings: { model: "multilingual-e5-small", location: "local", sentToProvider: false },
    sends: ["channel_message_text", "digest_text", "memory_item_text", "topic_summary_input"],
    neverSends: ["human_direct_messages", "attachments"],
    ...over,
  };
}

beforeEach(() => {
  for (const fn of [getMemorySettings, patchWorkspaceMemorySettings, getMemoryNotice, resetWorkspaceMemory]) {
    fn.mockReset();
  }
  getMemorySettings.mockResolvedValue(
    settings({ workspace: { enabled: true, paused: false, resetEpoch: 2 } })
  );
  getMemoryNotice.mockResolvedValue(notice());
  patchWorkspaceMemorySettings.mockResolvedValue({ enabled: true, paused: false, resetEpoch: 2 });
  resetWorkspaceMemory.mockResolvedValue({ epoch: 3, deleted: COUNTS });
});
afterEach(unmount);

async function render(role: "owner" | "admin" | "member" | "guest", offline = false) {
  const view = mount(createElement(MemorySettingsSection, { workspaceId: WS, offline }), { role });
  for (let i = 0; i < 6; i += 1) await flush();
  return view;
}

const text = (host: HTMLElement, id: string) => byTestId(host, id)?.textContent ?? "";
const word = (host: HTMLElement) => byTestId<HTMLInputElement>(host, "memory-reset-word");

async function openReset(host: HTMLElement) {
  click(byTestId(host, "memory-reset-open"));
  await flush();
}
async function typeWord(host: HTMLElement, value = MEMORY_RESET_CONFIRM_WORD) {
  type(word(host), value);
  await flush();
}
async function submit(host: HTMLElement) {
  click(byTestId(host, "memory-reset-submit"));
  for (let i = 0; i < 4; i += 1) await flush();
}

describe("팀 고지: 읽기", () => {
  it("멤버도 제공자·모델과 코드별 문장을 읽는다", async () => {
    const { host } = await render("member");
    const body = text(host, "memory-notice");
    expect(body).toContain("OpenAI (api.openai.com)");
    expect(body).toContain("gpt-5.4-mini");
    expect(text(host, "memory-notice-sends")).toContain(MEMORY_NOTICE_SENDS_COPY.channel_message_text);
    expect(text(host, "memory-notice-sends")).toContain(MEMORY_NOTICE_SENDS_COPY.digest_text);
    expect(text(host, "memory-notice-sends")).toContain(MEMORY_NOTICE_SENDS_COPY.topic_summary_input);
    expect(text(host, "memory-notice-never")).toContain(MEMORY_NOTICE_NEVER_COPY.human_direct_messages);
    expect(text(host, "memory-notice-embeddings")).toContain("밖으로 보내지 않아요");
    expect(getMemoryNotice).toHaveBeenCalledWith(WS);
  });

  it("게스트는 호스트 없는 「사용자 지정」을 읽는다", async () => {
    getMemoryNotice.mockResolvedValue(
      notice({ summary: { configured: true, provider: { name: "사용자 지정" } } })
    );
    const { host } = await render("guest");
    expect(text(host, "memory-notice")).toContain("사용자 지정");
    expect(text(host, "memory-notice")).not.toContain("api.");
  });

  it("모르는 코드는 원문 없이 일반 문장 한 줄로 그린다", async () => {
    getMemoryNotice.mockResolvedValue(
      notice({ sends: ["channel_message_text", "brand_new_code"], neverSends: ["other_new_code"] })
    );
    const { host } = await render("member");
    expect(text(host, "memory-notice-sends")).toContain(MEMORY_NOTICE_SENDS_UNKNOWN);
    expect(text(host, "memory-notice-never")).toContain(MEMORY_NOTICE_NEVER_UNKNOWN);
    expect(host.textContent).not.toContain("brand_new_code");
    expect(host.textContent).not.toContain("other_new_code");
  });

  it("불러오지 못하면 그 자리에서 다시 시도를 준다", async () => {
    getMemoryNotice.mockRejectedValue(new ApiError(500, "boom"));
    const { host } = await render("member");
    expect(text(host, "memory-notice-load")).toContain("팀 고지를 불러오지 못했어요");
    getMemoryNotice.mockResolvedValue(notice());
    click(host.querySelector('[data-testid="memory-notice-load"] button'));
    for (let i = 0; i < 4; i += 1) await flush();
    expect(byTestId(host, "memory-notice-body")).not.toBeNull();
  });
});

describe("팀 고지: 켤 때 확인", () => {
  beforeEach(() => {
    getMemorySettings.mockResolvedValue(
      settings({ workspace: { enabled: false, paused: false, resetEpoch: 0 } })
    );
  });

  it("스위치를 켜면 고지를 먼저 보여 주고 아직 아무것도 쓰지 않는다", async () => {
    const { host } = await render("admin");
    click(byTestId(host, "memory-workspace-enabled"));
    await flush();
    expect(byTestId(host, "memory-enable-ask")).not.toBeNull();
    expect(text(host, "memory-enable-ask")).toContain("OpenAI (api.openai.com)");
    expect(patchWorkspaceMemorySettings).not.toHaveBeenCalled();
    // 같은 고지를 한 화면에 두 번 그리지 않는다.
    expect(byTestId(host, "memory-notice")).toBeNull();
  });

  it("확인하고 켜기를 눌러야 서버에 enabled:true가 간다", async () => {
    const { host } = await render("admin");
    click(byTestId(host, "memory-workspace-enabled"));
    await flush();
    click(byTestId(host, "memory-enable-confirm"));
    await flush();
    expect(patchWorkspaceMemorySettings).toHaveBeenCalledWith(WS, { enabled: true });
  });

  it("취소하면 아무것도 쓰지 않고 고지 블록으로 돌아간다", async () => {
    const { host } = await render("admin");
    click(byTestId(host, "memory-workspace-enabled"));
    await flush();
    click(byTestId(host, "memory-enable-cancel"));
    await flush();
    expect(patchWorkspaceMemorySettings).not.toHaveBeenCalled();
    expect(byTestId(host, "memory-enable-ask")).toBeNull();
    expect(byTestId(host, "memory-notice")).not.toBeNull();
  });

  it("고지를 못 불러왔으면 켜기가 막히고 이유를 말한다", async () => {
    getMemoryNotice.mockRejectedValue(new ApiError(500, "boom"));
    const { host } = await render("admin");
    click(byTestId(host, "memory-workspace-enabled"));
    for (let i = 0; i < 4; i += 1) await flush();
    expect(text(host, "memory-enable-blocked")).toContain("켤 수 없어요");
    click(byTestId(host, "memory-enable-confirm"));
    await flush();
    expect(patchWorkspaceMemorySettings).not.toHaveBeenCalled();
  });

  it("끄는 것은 확인 없이 바로 나간다", async () => {
    getMemorySettings.mockResolvedValue(
      settings({ workspace: { enabled: true, paused: false, resetEpoch: 0 } })
    );
    const { host } = await render("admin");
    click(byTestId(host, "memory-workspace-enabled"));
    await flush();
    expect(patchWorkspaceMemorySettings).toHaveBeenCalledWith(WS, { enabled: false });
  });
});

describe("기억 초기화", () => {
  it("멤버와 게스트에게는 버튼이 없고 누가 할 수 있는지만 말한다", async () => {
    for (const role of ["member", "guest"] as const) {
      unmount();
      const { host } = await render(role);
      expect(byTestId(host, "memory-reset-open")).toBeNull();
      expect(text(host, "memory-reset-admin-only")).toBe(MEMORY_RESET_ADMIN_ONLY);
    }
    expect(resetWorkspaceMemory).not.toHaveBeenCalled();
  });

  it("관리자와 오너에게는 버튼이 있다", async () => {
    for (const role of ["admin", "owner"] as const) {
      unmount();
      const { host } = await render(role);
      expect(byTestId(host, "memory-reset-open")).not.toBeNull();
      expect(byTestId(host, "memory-reset-admin-only")).toBeNull();
    }
  });

  it("무엇을 지우고 무엇을 남기는지 API가 하는 만큼만 말한다", async () => {
    const { host } = await render("admin");
    const body = text(host, "memory-reset");
    expect(body).toContain("영구히 지워요");
    expect(body).toContain("스위치는 지금 상태 그대로");
    expect(body).toContain("잊기로 한 것은 계속 잊은 채로");
    expect(body).toContain("초기화한 뒤에 올라온 메시지부터");
  });

  it("확인 단계 없이는 요청이 나가지 않는다", async () => {
    const { host } = await render("admin");
    await openReset(host);
    // 아무것도 입력하지 않고 삭제 버튼을 눌러도, 엔터를 쳐도 나가지 않는다.
    await submit(host);
    expect(resetWorkspaceMemory).not.toHaveBeenCalled();
    await typeWord(host, "초기");
    await submit(host);
    expect(resetWorkspaceMemory).not.toHaveBeenCalled();
    act(() => {
      byTestId<HTMLFormElement>(host, "memory-reset-confirm")?.requestSubmit();
    });
    await flush();
    expect(resetWorkspaceMemory).not.toHaveBeenCalled();
    expect(byTestId(host, "memory-reset-submit")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("낱말을 맞게 쓰면 화면이 보여 준 expectedEpoch와 함께 한 번만 나간다", async () => {
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    expect(byTestId(host, "memory-reset-submit")?.getAttribute("aria-disabled")).toBeNull();
    await submit(host);
    expect(resetWorkspaceMemory).toHaveBeenCalledTimes(1);
    expect(resetWorkspaceMemory).toHaveBeenCalledWith(WS, 2);
  });

  it("끝나면 새 세대와 지운 개수를 말하고 확인 단계를 닫고 설정을 다시 읽는다", async () => {
    const { host } = await render("admin");
    const before = getMemorySettings.mock.calls.length;
    await openReset(host);
    await typeWord(host);
    await submit(host);
    const done = text(host, "memory-reset-done");
    expect(done).toContain("3번째 초기화");
    expect(done).toContain("요약 12개");
    expect(done).toContain("영수증 5개");
    expect(byTestId(host, "memory-reset-confirm")).toBeNull();
    expect(getMemorySettings.mock.calls.length).toBeGreaterThan(before);
  });

  it("진행 중에는 낱말이 「지우는 중」으로 바뀌고 두 번째 요청은 나가지 않는다", async () => {
    let release: (value: unknown) => void = () => undefined;
    resetWorkspaceMemory.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    click(byTestId(host, "memory-reset-submit"));
    await flush();
    const button = byTestId(host, "memory-reset-submit");
    expect(button?.textContent).toBe("지우는 중");
    expect(button?.getAttribute("aria-busy")).toBe("true");
    click(button);
    await flush();
    expect(resetWorkspaceMemory).toHaveBeenCalledTimes(1);
    release({ epoch: 3, deleted: COUNTS });
    for (let i = 0; i < 4; i += 1) await flush();
  });

  it("409는 이미 초기화됐다고 말하고 닫고 설정을 다시 읽는다", async () => {
    resetWorkspaceMemory.mockRejectedValue(new ApiError(409, "stale"));
    const { host } = await render("admin");
    const before = getMemorySettings.mock.calls.length;
    await openReset(host);
    await typeWord(host);
    await submit(host);
    expect(text(host, "memory-reset-error")).toContain("이미 초기화된 상태예요");
    expect(host.querySelector('[data-kind="stale"]')).not.toBeNull();
    expect(byTestId(host, "memory-reset-confirm")).toBeNull();
    expect(getMemorySettings.mock.calls.length).toBeGreaterThan(before);
  });

  it("503은 나중에 다시 하라고 말하고 확인 단계를 열어 둔다", async () => {
    resetWorkspaceMemory.mockRejectedValue(new ApiError(503, "memory_reset_busy"));
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    await submit(host);
    expect(text(host, "memory-reset-error")).toContain("잠시 뒤에 다시 시도");
    expect(host.querySelector('[data-kind="busy"]')).not.toBeNull();
    expect(byTestId(host, "memory-reset-confirm")).not.toBeNull();
    resetWorkspaceMemory.mockResolvedValue({ epoch: 3, deleted: COUNTS });
    await submit(host);
    expect(resetWorkspaceMemory).toHaveBeenCalledTimes(2);
    expect(byTestId(host, "memory-reset-done")).not.toBeNull();
  });

  it("낡은 역할표로 서버가 403을 주면 관리자만 할 수 있다고 말한다", async () => {
    resetWorkspaceMemory.mockRejectedValue(new ApiError(403, "forbidden"));
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    await submit(host);
    expect(text(host, "memory-reset-error")).toContain(MEMORY_RESET_ADMIN_ONLY);
    expect(host.querySelector('[data-kind="forbidden"]')).not.toBeNull();
  });

  it("그 밖의 실패는 상태 숫자 없이 다시 시도를 안내한다", async () => {
    resetWorkspaceMemory.mockRejectedValue(new ApiError(500, "boom"));
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    await submit(host);
    const message = text(host, "memory-reset-error");
    expect(message).toContain("다시 시도");
    expect(message).not.toContain("500");
  });

  it("취소하면 요청 없이 닫히고 다시 열면 낱말이 비어 있다", async () => {
    const { host } = await render("admin");
    await openReset(host);
    await typeWord(host);
    click(byTestId(host, "memory-reset-cancel"));
    await flush();
    expect(byTestId(host, "memory-reset-confirm")).toBeNull();
    await openReset(host);
    expect(word(host)?.value).toBe("");
    expect(resetWorkspaceMemory).not.toHaveBeenCalled();
  });

  it("연결이 끊기면 열 수 없고 이유를 말한다", async () => {
    const { host } = await render("admin", true);
    expect(text(host, "memory-reset-offline")).toContain("연결이 끊겨");
    click(byTestId(host, "memory-reset-open"));
    await flush();
    expect(byTestId(host, "memory-reset-confirm")).toBeNull();
  });
});
