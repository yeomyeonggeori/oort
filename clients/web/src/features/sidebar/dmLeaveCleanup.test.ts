// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadState } from "@momo/core/lib/api";
import { runDmLeaveCleanup } from "@momo/core/features/channels/dmLeave";
import {
  adoptDraftAuthor,
  readDraft,
  readFailedSends,
  readThreadDraft,
  rememberFailedSend,
  writeDraft,
  writeThreadDraft,
} from "@/features/chat/draftStore";
import {
  addFiles,
  readSurface,
  resetAttachmentDraftsForTest,
  surfaceKey,
} from "@/features/attachments/draftStore";
import { collectDmLeaveRootIds, webDmLeaveCleanupPort } from "./dmLeaveCleanup";

// =============================================================================
// 1:1 「대화 나가기」 성공 뒤 이 기기의 정리 (ADR-0177 증보 2026-11-14 D17 기기 줄, #5825 · #5824 검수 r1 M4).
//
// 지운 것을 그것을 쓴 API 가 아니라 **저장소·캐시 쪽에서** 센다: 나간 대화(LEFT)의 것은 0, 다른 대화(KEEP)의 것은 그대로.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const LEFT = "00000000-0000-7000-8000-000000000301";
const KEEP = "00000000-0000-7000-8000-000000000302";
const ROOT_LEFT = "00000000-0000-7000-8000-00000000a001";
const ROOT_KEEP = "00000000-0000-7000-8000-00000000b001";
const NOW = Date.now();

function readRow(channelId: string, patch: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 4,
    latestSeq: 10,
    unreadCount: 6,
    mentionCount: 1,
    markedUnreadBeforeSeq: null,
    historyFromSeq: null,
    ...patch,
  };
}

const pending = (channelId: string, clientMsgId: string) => ({
  clientMsgId,
  channelId,
  authorMemberId: ME,
  body: "다음 주 일정 다시 볼게요",
  createdAtMs: NOW,
  sinceSeq: 10,
  status: "failed" as const,
});

const target = { workspaceId: WS, channelId: LEFT };

function seed(client: QueryClient): void {
  client.setQueryData(["read-state", WS], [readRow(LEFT), readRow(KEEP)]);
  client.setQueryData(["thread", WS, LEFT, ROOT_LEFT], { replies: ["옛 답글"] });
  client.setQueryData(["thread", WS, KEEP, ROOT_KEEP], { replies: ["남는 답글"] });
  client.setQueryData(["agent-runs", WS, LEFT], ["run"]);
  client.setQueryData(["inbox-mentions", WS, LEFT, 4, 1], ["mention"]);
  client.setQueryData(["inbox-mentions", WS, KEEP, 4, 1], ["mention"]);
  client.setQueryData(["message-search", WS, "일정", undefined], {
    pages: [{ hits: [{ channelId: LEFT, id: "h1" }, { channelId: KEEP, id: "h2" }] }],
    pageParams: [undefined],
  });
  client.setQueryData(["inbox", WS, "all"], {
    pages: [{ items: [{ id: "i1", channel: { id: LEFT } }, { id: "i2", channel: { id: KEEP } }] }],
    pageParams: [undefined],
  });
  client.setQueryData(["inbox-context", WS, "inbox:i1", 9], { channelId: LEFT, messages: [] });
  client.setQueryData(["inbox-context", WS, "inbox:i2", 9], { channelId: KEEP, messages: [] });
  writeDraft(WS, LEFT, "옛 대화에 쓰던 글", NOW);
  writeDraft(WS, KEEP, "다른 대화에 쓰던 글", NOW);
  writeThreadDraft(WS, ROOT_LEFT, "옛 스레드 답글 초안", NOW, LEFT);
  writeThreadDraft(WS, ROOT_KEEP, "다른 스레드 답글 초안", NOW, KEEP);
  rememberFailedSend(WS, pending(LEFT, "c-left"), null, NOW);
  rememberFailedSend(WS, pending(KEEP, "c-keep"), null, NOW);
  addFiles(surfaceKey(WS, LEFT), target, [], { folders: 1 });
  addFiles(surfaceKey(WS, LEFT, ROOT_LEFT), target, [], { folders: 1 });
  addFiles(surfaceKey(WS, KEEP), target, [], { folders: 1 });
}

let client: QueryClient;

beforeEach(() => {
  localStorage.clear();
  adoptDraftAuthor(ME);
  resetAttachmentDraftsForTest();
  client = new QueryClient();
  seed(client);
});

afterEach(() => {
  client.clear();
  localStorage.clear();
  resetAttachmentDraftsForTest();
});

describe("나가기 성공 뒤 정리 - 그 대화의 것만", () => {
  it("뿌리 글 id 는 PUT 전에 스레드 캐시와 답글 초안이 적어 둔 대화에서 모은다(다른 대화의 뿌리는 없다)", () => {
    expect(collectDmLeaveRootIds(client, WS, LEFT).sort()).toEqual([ROOT_LEFT]);
    expect(collectDmLeaveRootIds(client, WS, LEFT, ["M-OPEN"]).sort()).toEqual([ROOT_LEFT, "m-open"].sort());
  });

  it("투영 행에 하한을 먼저 적고, 캐시·초안·답글 초안·트레이·못 보낸 글에서 나간 대화의 것이 0 이 된다 - 다른 대화의 것은 그대로", () => {
    const rootIds = collectDmLeaveRootIds(client, WS, LEFT);
    const failed = runDmLeaveCleanup(webDmLeaveCleanupPort(client, WS, ME), { channelId: LEFT, seenSeq: 10, rootIds });
    expect(failed).toEqual([]);

    const rows = client.getQueryData<ReadState[]>(["read-state", WS])!;
    expect(rows.find((row) => row.channelId === LEFT)).toMatchObject({ historyFromSeq: 11, lastReadSeq: 10, unreadCount: 0, mentionCount: 0 });
    expect(rows.find((row) => row.channelId === KEEP)).toEqual(readRow(KEEP));

    // 이력·스레드·실행·그 대화 범위의 받은함 멘션
    expect(client.getQueryData(["thread", WS, LEFT, ROOT_LEFT])).toBeUndefined();
    expect(client.getQueryData(["agent-runs", WS, LEFT])).toBeUndefined();
    expect(client.getQueryData(["inbox-mentions", WS, LEFT, 4, 1])).toBeUndefined();
    expect(client.getQueryData(["thread", WS, KEEP, ROOT_KEEP])).toEqual({ replies: ["남는 답글"] });
    expect(client.getQueryData(["inbox-mentions", WS, KEEP, 4, 1])).toEqual(["mention"]);

    // 검색 · 받은함(여러 대화를 담은 캐시는 그 대화의 항목만 빠진다)
    const search = client.getQueryData<{ pages: { hits: { id: string }[] }[] }>(["message-search", WS, "일정", undefined])!;
    expect(search.pages[0].hits.map((hit) => hit.id)).toEqual(["h2"]);
    const inbox = client.getQueryData<{ pages: { items: { id: string }[] }[] }>(["inbox", WS, "all"])!;
    expect(inbox.pages[0].items.map((item) => item.id)).toEqual(["i2"]);
    expect(client.getQueryData(["inbox-context", WS, "inbox:i1", 9])).toBeUndefined();
    expect(client.getQueryData(["inbox-context", WS, "inbox:i2", 9])).toEqual({ channelId: KEEP, messages: [] });

    // 이 기기에만 있는 것
    expect(readDraft(WS, LEFT)).toBe("");
    expect(readThreadDraft(WS, ROOT_LEFT)).toBe("");
    expect(readFailedSends(WS, LEFT, ME)).toEqual([]);
    expect(readSurface(surfaceKey(WS, LEFT)).folders).toBe(0);
    expect(readSurface(surfaceKey(WS, LEFT, ROOT_LEFT)).folders).toBe(0);
    expect(readDraft(WS, KEEP)).toBe("다른 대화에 쓰던 글");
    expect(readThreadDraft(WS, ROOT_KEEP)).toBe("다른 스레드 답글 초안");
    expect(readFailedSends(WS, KEEP, ME).map(({ row }) => row.clientMsgId)).toEqual(["c-keep"]);
    expect(readSurface(surfaceKey(WS, KEEP)).folders).toBe(1);
  });
});
