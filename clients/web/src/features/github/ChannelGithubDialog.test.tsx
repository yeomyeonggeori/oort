// @vitest-environment jsdom

import { createElement, createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { click, flush, mount, unmount, waitUntil } from "../memory/memoryTestKit";
import { ChannelGithubDialog } from "./ChannelGithubDialog";
import { GH_PUBLIC_CH, GH_WS, overview, q } from "./githubTestKit";

const fetchGithubOverview = vi.hoisted(() => vi.fn());
const unsubscribeGithub = vi.hoisted(() => vi.fn());
vi.mock("@momo/core/features/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/github/api")>();
  return {
    ...actual,
    fetchGithubOverview: (...a: unknown[]) => fetchGithubOverview(...a) as unknown,
    unsubscribeGithub: (...a: unknown[]) => unsubscribeGithub(...a) as unknown,
  };
});

const CHANNEL: Channel = { id: GH_PUBLIC_CH, workspaceId: GH_WS, kind: "public", name: "마케팅", muted: false };
const mine = {
  id: "s-mine",
  channelId: GH_PUBLIC_CH,
  installationId: 4001,
  repository: "yeomyeonggeori/oort",
  repoId: 11,
  features: ["pulls", "issues", "releases"],
  active: true,
  privateConfirmed: true,
};

beforeEach(() => {
  fetchGithubOverview.mockReset();
  unsubscribeGithub.mockReset();
  unsubscribeGithub.mockResolvedValue(undefined);
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

async function render() {
  mount(
    createElement(ChannelGithubDialog, {
      workspaceId: GH_WS,
      channel: CHANNEL,
      channelTitle: "마케팅",
      open: true,
      onOpenChange: () => undefined,
      opener: createRef<HTMLElement>(),
    }),
    { role: "owner" }
  );
  await flush();
}

describe("채널 ⋮ › GitHub 알림 (네 상태와 막힘)", () => {
  it("읽는 동안은 높이를 지키는 막대가 선다", async () => {
    fetchGithubOverview.mockReturnValue(new Promise(() => undefined));
    await render();
    expect(q("channel-github-dialog")).not.toBeNull();
    expect(document.body.textContent).not.toContain("저장소 더하기");
  });

  it("이 채널의 구독만 보이고 다른 채널 것은 섞이지 않는다", async () => {
    fetchGithubOverview.mockResolvedValue(
      overview({
        subscriptions: [mine, { ...mine, id: "s-other", channelId: "00000000-0000-7000-8000-000000000202", repository: "yeomyeonggeori/billing-internal" }],
      })
    );
    await render();
    await waitUntil(() => q("github-subscriptions") !== null, "구독 목록");
    const rows = document.querySelectorAll('[data-testid="github-subscription-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("yeomyeonggeori/oort");
    expect(rows[0].textContent).toContain("PR, 이슈, 릴리스");
    expect(rows[0].textContent).toContain("비공개 확인함");
    expect(fetchGithubOverview).toHaveBeenCalledWith(GH_WS, GH_PUBLIC_CH);
  });

  it("구독이 없으면 빈 상태 한 줄과 폼이 같이 선다", async () => {
    fetchGithubOverview.mockResolvedValue(overview());
    await render();
    await waitUntil(() => q("github-subscribe-form") !== null, "폼");
    expect(q("channel-github-empty")).not.toBeNull();
  });

  it("해제는 두 단계다: 한 번 눌러서는 요청이 나가지 않는다", async () => {
    fetchGithubOverview.mockResolvedValue(overview({ subscriptions: [mine] }));
    await render();
    await waitUntil(() => q("github-subscription-remove") !== null, "해제 버튼");
    click(q("github-subscription-remove"));
    expect(unsubscribeGithub).toHaveBeenCalledTimes(0);
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "해제하기");
    click(confirm ?? null);
    await flush();
    expect(unsubscribeGithub).toHaveBeenCalledWith(GH_WS, "s-mine");
  });

  it("소유자·관리자가 아니면(403) 누가 하는지 말하고 폼은 세우지 않는다", async () => {
    fetchGithubOverview.mockRejectedValue(new ApiError(403, "forbidden"));
    await render();
    await waitUntil(() => q("operator-notice") !== null, "권한 안내");
    expect(document.body.textContent).toContain("소유자와 관리자만");
    expect(q("github-subscribe-form")).toBeNull();
  });

  it("옛 서버(404)는 장애가 아니라 중립 문장과 대안으로 접힌다", async () => {
    fetchGithubOverview.mockRejectedValue(new ApiError(404, "not found"));
    await render();
    await waitUntil(() => q("channel-github-load-absent") !== null, "접힘");
    expect(document.body.textContent).toContain("이 서버는 아직 GitHub 알림을 받지 않아요");
    expect(document.body.textContent).not.toContain("다시 시도");
  });

  it("키가 없는 서버(503)는 운영자가 설정을 마쳐야 한다고 말한다", async () => {
    fetchGithubOverview.mockRejectedValue(new ApiError(503, "unavailable"));
    await render();
    await waitUntil(() => document.body.textContent?.includes("서버를 관리하는 분께 알려 주세요") === true, "503 문장");
    expect(q("github-subscribe-form")).toBeNull();
  });

  it("그 밖의 실패는 오류 문장과 다시 시도를 준다", async () => {
    fetchGithubOverview.mockRejectedValueOnce(new ApiError(500, "boom"));
    fetchGithubOverview.mockResolvedValue(overview());
    await render();
    await waitUntil(() => q("channel-github-load") !== null, "오류 배너");
    const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "다시 시도");
    click(retry ?? null);
    await waitUntil(() => q("github-subscribe-form") !== null, "다시 읽음");
  });

  it("앱이 없으면 운영자 안내와 설정으로 가는 길만 서고 폼은 없다", async () => {
    fetchGithubOverview.mockResolvedValue(overview({ appRegistered: false, installations: [] }));
    await render();
    await waitUntil(() => q("channel-github-no-app") !== null, "앱 없음");
    expect(q("github-subscribe-form")).toBeNull();
    expect(document.body.textContent).toContain("서버를 관리하는 분이 먼저 앱을 만들어야 해요");
  });

  it("연결된 계정이 없거나 모두 멈춰 있으면 연결하러 가는 길만 선다", async () => {
    fetchGithubOverview.mockResolvedValue(overview({ installations: [] }));
    await render();
    await waitUntil(() => q("channel-github-no-installation") !== null, "계정 없음");
    expect(q("github-subscribe-form")).toBeNull();
  });
});
