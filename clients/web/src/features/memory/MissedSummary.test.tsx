// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  BEHIND_HEAD_COPY,
  MEMORY_OFF_COPY,
  MISSED_EMPTY_COPY,
  MISSED_NOT_YET_COPY,
} from "@momo/core/features/memory/presentation";
import type { MemoryDigest, MemorySettings } from "@momo/core/features/memory/model";
import { wantsMissedSummary } from "@momo/core/features/memory/presentation";
import { MissedSummary } from "./MissedSummary";
import {
  CH,
  OTHER_CH,
  WS,
  byTestId,
  click,
  digest,
  flush,
  mount,
  page,
  settings,
  unmount,
} from "./memoryTestKit";

const getMemorySettings = vi.hoisted(() => vi.fn());
const listMemoryDigests = vi.hoisted(() => vi.fn());

vi.mock("@momo/core/features/memory/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/memory/api")>();
  return {
    ...actual,
    getMemorySettings: (...args: unknown[]) => getMemorySettings(...args) as unknown,
    listMemoryDigests: (...args: unknown[]) => listMemoryDigests(...args) as unknown,
  };
});

beforeEach(() => {
  getMemorySettings.mockReset();
  listMemoryDigests.mockReset();
  getMemorySettings.mockResolvedValue(settings());
  listMemoryDigests.mockResolvedValue(page());
});
afterEach(unmount);

function card(onJump: (id: string, seq: number) => void = () => undefined, over = {}) {
  return createElement(MissedSummary, {
    workspaceId: WS,
    channelId: CH,
    lastReadSeq: 11,
    headSeq: 30,
    onJump,
    ...over,
  });
}

async function render(over = {}, onJump = vi.fn()) {
  const view = mount(card(onJump, over));
  // settings -> digests is a two-hop chain; settle until the card leaves loading.
  for (let i = 0; i < 20; i += 1) {
    await flush();
    const state = byTestId(view.host, "missed-summary-card")?.getAttribute("data-state");
    if (state !== "loading") break;
  }
  return { ...view, onJump, root: () => byTestId(view.host, "missed-summary-card") };
}

describe("놓친 대화 요약 카드 상태", () => {
  it("로딩: 설정이 아직 안 왔을 때 높이를 지키는 막대와 상태 문구를 그린다", () => {
    getMemorySettings.mockReturnValue(new Promise(() => undefined));
    const { host } = mount(card());
    const el = byTestId(host, "missed-summary-card");
    expect(el?.getAttribute("data-state")).toBe("loading");
    expect(byTestId(host, "missed-summary-loading")?.getAttribute("aria-busy")).toBe("true");
  });

  it("준비됨: 요약 본문, 근거 수, 근거 링크를 그리고 서버가 준 것만 쓴다", async () => {
    const { root, host } = await render();
    expect(root()?.getAttribute("data-state")).toBe("ready");
    expect(host.textContent).toContain("결제 오류는 재시도 큐를 늘려 해결하기로 했어요.");
    expect(host.textContent).toContain("대화 18개를 요약했어요");
    expect(host.querySelectorAll('[data-testid="missed-summary-evidence-link"]')).toHaveLength(2);
    // 클라이언트가 지어낸 요약 줄이 없다: 본문은 서버 문자열 하나다.
    expect(host.querySelectorAll('[data-testid="missed-summary-digest"]')).toHaveLength(1);
  });

  it("안 읽은 커서를 열 때 얼린 값으로 묻는다: sinceSeq 고정, sinceLastRead 없음", async () => {
    await render();
    expect(listMemoryDigests).toHaveBeenCalledTimes(1);
    const [ws, ch, options] = listMemoryDigests.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(ws).toBe(WS);
    expect(ch).toBe(CH);
    expect(options).toEqual({ sinceSeq: 11, limit: 10 });
    expect(options).not.toHaveProperty("sinceLastRead");
  });

  it("한 번도 읽지 않은 채널은 sinceSeq 0으로 묻는다", async () => {
    await render({ lastReadSeq: null });
    expect((listMemoryDigests.mock.calls[0] as unknown[])[2]).toEqual({ sinceSeq: 0, limit: 10 });
  });

  it("비어 있음: 따라잡았는데 요약이 없으면 요약할 내용이 없다고 말한다", async () => {
    listMemoryDigests.mockResolvedValue(page({ digests: [], summarizedThroughSeq: 30 }));
    const { root, host } = await render();
    expect(root()?.getAttribute("data-state")).toBe("empty");
    expect(host.textContent).toContain(MISSED_EMPTY_COPY);
  });

  it("아직 요약 전: 머리보다 뒤에 있으면 비었다고 하지 않고 아직이라고 말한다", async () => {
    listMemoryDigests.mockResolvedValue(page({ digests: [], summarizedThroughSeq: 12 }));
    const { root, host } = await render();
    expect(root()?.getAttribute("data-state")).toBe("notYet");
    expect(host.textContent).toContain(MISSED_NOT_YET_COPY);
    expect(host.textContent).not.toContain(MISSED_EMPTY_COPY);
  });

  it("일부만 요약됨: 요약은 보이고 최근 구간이 빠졌다고 사실대로 덧붙인다", async () => {
    listMemoryDigests.mockResolvedValue(page({ summarizedThroughSeq: 26 }));
    const { host } = await render();
    expect(byTestId(host, "missed-summary-behind")?.textContent).toBe(BEHIND_HEAD_COPY);
  });

  it("따라잡았으면 덧붙임이 없고, 다시 만드는 중이라는 말은 어디에도 없다", async () => {
    const { host } = await render();
    expect(byTestId(host, "missed-summary-behind")).toBeNull();
    expect(host.textContent).not.toMatch(/다시 만드는/);
  });

  it.each<[keyof typeof MEMORY_OFF_COPY, Partial<MemorySettings>]>([
    ["workspaceOff", { workspace: { enabled: false, paused: false, resetEpoch: 0 } }],
    ["workspacePaused", { workspace: { enabled: true, paused: true, resetEpoch: 0 } }],
    ["channelExcluded", { channels: [{ channelId: CH, excluded: true, paused: false }] }],
    ["channelPaused", { channels: [{ channelId: CH, excluded: false, paused: true }] }],
    ["mePaused", { me: { paused: true } }],
  ])("꺼짐·멈춤 %s: 이유를 설명하고 요약을 요청하지 않는다", async (reason, over) => {
    getMemorySettings.mockResolvedValue(settings(over));
    const { root, host } = await render();
    expect(root()?.getAttribute("data-state")).toBe("off");
    expect(host.textContent).toContain(MEMORY_OFF_COPY[reason]);
    expect(listMemoryDigests).not.toHaveBeenCalled();
  });

  it("오류: 요약 요청이 5xx면 다음 행동과 다시 시도를 준다", async () => {
    listMemoryDigests.mockRejectedValue(new ApiError(500, "boom"));
    const { root, host } = await render();
    expect(root()?.getAttribute("data-state")).toBe("error");
    expect(host.textContent).toContain("다시 시도");
    listMemoryDigests.mockResolvedValue(page());
    click(byTestId(host, "missed-summary-retry"));
    for (let i = 0; i < 20; i += 1) await flush();
    expect(root()?.getAttribute("data-state")).toBe("ready");
  });

  it("서버에 기억 경로가 없으면(404) 카드를 그리지 않는다", async () => {
    getMemorySettings.mockRejectedValue(new ApiError(404, "not found"));
    const { root } = await render();
    expect(root()).toBeNull();
  });

  it("닫으면 사라지고, 새 요약이 오면 다시 나온다", async () => {
    const { root, host, client } = await render();
    click(byTestId(host, "missed-summary-dismiss"));
    expect(root()).toBeNull();
    // 더 새로운 요약이 같은 방문 안에 도착하면 다시 보인다.
    const newer: MemoryDigest = digest({ id: "b", fromSeq: 31, toSeq: 44 });
    const key = ["memory", "digests", WS, CH, 11];
    act(() => {
      client.setQueryData(key, page({ digests: [digest(), newer], summarizedThroughSeq: 44 }));
    });
    await flush();
    expect(root()).not.toBeNull();
  });
});

describe("닫기", () => {
  it("불러오는 동안 닫으면 요약이 도착해도 다시 나오지 않는다", async () => {
    let release: (value: unknown) => void = () => undefined;
    getMemorySettings.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { host } = mount(card());
    click(byTestId(host, "missed-summary-dismiss"));
    expect(byTestId(host, "missed-summary-card")).toBeNull();
    release(settings());
    for (let i = 0; i < 6; i += 1) await flush();
    expect(byTestId(host, "missed-summary-card")).toBeNull();
  });

  it("닫은 뒤 알림 콜백을 부른다(초점을 돌려줄 자리)", async () => {
    const onDismissed = vi.fn();
    const view = mount(card(undefined, { onDismissed }));
    for (let i = 0; i < 6; i += 1) await flush();
    click(byTestId(view.host, "missed-summary-dismiss"));
    expect(onDismissed).toHaveBeenCalledTimes(1);
  });

  it("근거 링크의 접근 이름은 보이는 글자로 시작한다", async () => {
    const { host } = await render();
    const link = byTestId(host, "missed-summary-evidence-link");
    expect(link?.getAttribute("aria-label")?.startsWith(link?.textContent ?? "?")).toBe(true);
  });
});

describe("근거 링크", () => {
  it("같은 채널의 근거는 타임라인 점프로 간다", async () => {
    const { host, onJump } = await render();
    const links = host.querySelectorAll('[data-testid="missed-summary-evidence-link"]');
    click(links[1]);
    expect(onJump).toHaveBeenCalledWith("00000000-0000-7000-8000-000000000302", 27);
  });

  it("다른 채널의 근거는 라우트 링크가 된다", async () => {
    listMemoryDigests.mockResolvedValue(
      page({
        digests: [
          digest({
            evidence: [{ messageId: "00000000-0000-7000-8000-000000000309", channelId: OTHER_CH, seq: 3 }],
          }),
        ],
      })
    );
    const { host, onJump } = await render();
    const link = byTestId(host, "missed-summary-evidence-link") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain(OTHER_CH);
    expect(link.getAttribute("href")).toContain("msg=00000000-0000-7000-8000-000000000309");
    click(link);
    expect(onJump).not.toHaveBeenCalled();
  });

  it("근거 라벨에 시퀀스 번호를 쓰지 않고 순서 이름만 쓴다", async () => {
    const { host } = await render();
    const labels = [...host.querySelectorAll('[data-testid="missed-summary-evidence-link"]')].map(
      (el) => el.textContent
    );
    expect(labels).toEqual(["근거 1", "근거 2"]);
  });

  it("근거가 많으면 접어 두고 펼칠 수 있다", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      messageId: `00000000-0000-7000-8000-00000000${String(500 + index)}`,
      channelId: CH,
      seq: index + 1,
    }));
    listMemoryDigests.mockResolvedValue(page({ digests: [digest({ evidence: many })] }));
    const { host } = await render();
    expect(host.querySelectorAll('[data-testid="missed-summary-evidence-link"]')).toHaveLength(4);
    click(byTestId(host, "missed-summary-evidence-more"));
    expect(host.querySelectorAll('[data-testid="missed-summary-evidence-link"]')).toHaveLength(7);
  });
});

describe("이전 요약 접기", () => {
  it("요약이 둘을 넘으면 오래된 것은 접고 시간순으로 펼친다", async () => {
    const digests = [1, 2, 3, 4, 5].map((n) =>
      digest({ id: `d${n}`, fromSeq: n * 10, toSeq: n * 10 + 9, body: `요약 본문 ${n}` })
    );
    listMemoryDigests.mockResolvedValue(page({ digests: digests.reverse(), summarizedThroughSeq: 60 }));
    const { host } = await render();
    const shown = () =>
      [...host.querySelectorAll('[data-testid="missed-summary-digest"] p:first-child')].map(
        (el) => el.textContent
      );
    expect(shown()).toEqual(["요약 본문 4", "요약 본문 5"]);
    click(byTestId(host, "missed-summary-older"));
    expect(shown()).toEqual([
      "요약 본문 1",
      "요약 본문 2",
      "요약 본문 3",
      "요약 본문 4",
      "요약 본문 5",
    ]);
  });
});

describe("wantsMissedSummary", () => {
  const base = { provided: true, channelId: CH, unreadCount: 5, eligible: true };

  it("서버가 싣고 안 읽음이 다섯 이상일 때만 세운다", () => {
    expect(wantsMissedSummary(base)).toBe(true);
    expect(wantsMissedSummary({ ...base, unreadCount: 4 })).toBe(false);
    expect(wantsMissedSummary({ ...base, provided: false, unreadCount: 40 })).toBe(false);
    expect(wantsMissedSummary({ ...base, channelId: null, unreadCount: 40 })).toBe(false);
  });

  it("사람끼리의 DM처럼 서버가 요약하지 않는 방에는 세우지 않는다", () => {
    expect(wantsMissedSummary({ ...base, eligible: false, unreadCount: 40 })).toBe(false);
  });
});
