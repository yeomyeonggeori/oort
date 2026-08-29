import { describe, expect, it } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import type { DraftRecord } from "@/features/chat/draftStore";
import {
  channelPathForDraft,
  liveChannelIdSet,
  orphanDrafts,
  previewDraft,
  shouldShowDraftsNav,
  visibleDrafts,
} from "./model";

const WS = "00000000-0000-7000-8000-000000000001";
const CH_A = "00000000-0000-7000-8000-0000000000a1";
const CH_B = "00000000-0000-7000-8000-0000000000b1";
const GONE = "00000000-0000-7000-8000-0000000000c1";

function draft(channelId: string, text: string, atMs: number): DraftRecord {
  return {
    key: `momo.draft.v1:${WS}:${channelId}`,
    workspaceId: WS,
    channelId,
    text,
    atMs,
  };
}

function channel(id: string, name: string): Channel {
  return { id, workspaceId: WS, kind: "public", name, muted: false };
}

describe("previewDraft", () => {
  it("줄바꿈을 한 줄로 접는다", () => {
    expect(previewDraft("배포 롤백 근거를 정리하면\n두 번째 줄")).toBe(
      "배포 롤백 근거를 정리하면 두 번째 줄"
    );
  });
});

describe("visibleDrafts / 고아", () => {
  const drafts = [
    draft(CH_A, "엔진 점검 메모", 1),
    draft(GONE, "떠난 채널의 글", 2),
  ];
  const live = liveChannelIdSet([channel(CH_A, "엔진"), channel(CH_B, "general")]);

  it("채널 목록이 오기 전에는 출처 불명 행을 그리지 않는다", () => {
    expect(visibleDrafts(drafts, live, false)).toEqual([]);
    expect(orphanDrafts(drafts, live, false)).toEqual([]);
  });

  it("도착한 뒤에는 살아 있는 채널만 남기고 고아는 정리 대상으로 돌린다", () => {
    expect(visibleDrafts(drafts, live, true).map((row) => row.channelId)).toEqual(
      [CH_A]
    );
    expect(orphanDrafts(drafts, live, true).map((row) => row.channelId)).toEqual(
      [GONE]
    );
  });
});

describe("shouldShowDraftsNav", () => {
  it("초안 0이면 숨긴다", () => {
    expect(shouldShowDraftsNav([], new Set(), true)).toBe(false);
  });

  it("목록이 오기 전 이 워크스페이스에 초안이 있으면 보여 깜빡임을 피한다", () => {
    expect(
      shouldShowDraftsNav([draft(CH_A, "글", 1)], new Set(), false)
    ).toBe(true);
  });

  it("살아 있는 대상이 없으면 숨긴다", () => {
    expect(
      shouldShowDraftsNav([draft(GONE, "글", 1)], new Set([CH_A]), true)
    ).toBe(false);
  });
});

describe("channelPathForDraft", () => {
  it("채널 컴포저로 가는 주소를 만든다", () => {
    expect(channelPathForDraft(CH_A)).toBe(`/c/${CH_A}`);
  });
});
