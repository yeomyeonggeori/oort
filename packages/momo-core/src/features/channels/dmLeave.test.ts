import { afterEach, describe, expect, it } from "vitest";
import { createMessageService, loadMessageCatalog, messageKeys } from "../../i18n";
import { ApiError, type Channel, type ReadState, type RosterMember } from "../../lib/api";
import { addPending, type PendingMessage } from "../timeline/model";
import { makeDirectory } from "../workspace/directory";
import { dmVisibility } from "../sidebar/dmVisibility";
import {
  DM_LEAVE_CLEANUP_STEPS,
  DM_LEAVE_KEYS,
  dmLeaveConfirmCopy,
  dmLeaveFailure,
  dmLeaveFolded,
  dmLeaveMode,
  dmLeaveOffered,
  dmLeaveScheduledCount,
  dmLeaveSeenSeq,
  foldDmLeaveAbsent,
  higherHistoryFloor,
  isBelowHistoryFloor,
  isMessageBeforeLeave,
  isPersonToPersonDm,
  pendingAfterSendFailure,
  readProjectionCarriesLeave,
  readStateAfterLeave,
  resetDmLeaveFoldForTest,
  runDmLeaveCleanup,
  settleDmLeaveFailure,
  type DmLeaveCleanupPort,
  type DmLeaveCleanupStep,
  type DmLeaveOfferInput,
} from "./dmLeave";

// 가상 인물만: 김도현(나) · 이서연(상대) · 박지우(셋째) · 정리봇(에이전트).
const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000000a1";
const PEER = "00000000-0000-7000-8000-0000000000b2";
const THIRD = "00000000-0000-7000-8000-0000000000c3";
const BOT = "00000000-0000-7000-8000-0000000000d4";
const DM_ID = "00000000-0000-7000-8000-000000000301";

function member(id: string, displayName: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle: displayName,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const ROSTER = [
  member(ME, "김도현"),
  member(PEER, "이서연"),
  member(THIRD, "박지우"),
  member(BOT, "정리봇", { kind: "agent" }),
];

function dm(over: Partial<Channel> = {}): Channel {
  return {
    id: DM_ID,
    workspaceId: WS,
    kind: "dm",
    dmKey: `${ME}:${PEER}`,
    memberIds: [ME, PEER],
    muted: false,
    ...over,
  };
}

function row(over: Partial<ReadState> = {}): ReadState {
  return {
    channelId: DM_ID,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    latestReadableSeq: 10,
    closedAtSeq: null,
    historyFromSeq: null,
    ...over,
  };
}

afterEach(() => resetDmLeaveFoldForTest());

describe("옛 서버 판별 (D21)", () => {
  it("GET 행에 history_from_seq 키가 있으면 새 서버다 - 값이 null 이어도", () => {
    expect(dmLeaveMode({ workspaceId: WS, rows: [row({ historyFromSeq: null })] })).toBe("server");
    expect(dmLeaveMode({ workspaceId: WS, rows: [row({ historyFromSeq: 4 })] })).toBe("server");
  });

  it("행은 있는데 아무도 그 키를 말하지 않으면 옛 서버다", () => {
    const { historyFromSeq: _omit, ...old } = row();
    void _omit;
    expect(dmLeaveMode({ workspaceId: WS, rows: [old, { ...old, channelId: "other" }] })).toBe("legacy");
  });

  it("한 행이라도 말하면 새 서버다(PUT 응답으로 바뀐 행이 섞여도)", () => {
    const { historyFromSeq: _omit, ...merged } = row({ channelId: "merged" });
    void _omit;
    expect(dmLeaveMode({ workspaceId: WS, rows: [merged, row()] })).toBe("server");
  });

  it("투영이 없거나 행이 0 개면 모른다", () => {
    expect(dmLeaveMode({ workspaceId: WS, rows: undefined })).toBe("unknown");
    expect(dmLeaveMode({ workspaceId: WS, rows: [] })).toBe("unknown");
  });

  it("접기는 워크스페이스 id 의 대소문자를 가리지 않는다", () => {
    foldDmLeaveAbsent(WS.toUpperCase());
    expect(dmLeaveMode({ workspaceId: WS, rows: [row()] })).toBe("legacy");
  });

  it("나가기 경로가 404·405·501 로 접힌 워크스페이스는 투영이 뭐라 하든 옛 서버다 - 그 워크스페이스만", () => {
    for (const status of [404, 405, 501]) {
      resetDmLeaveFoldForTest();
      expect(settleDmLeaveFailure(WS.toUpperCase(), new ApiError(status, "gone"))).toBe("absent");
      expect(dmLeaveFolded(WS)).toBe(true);
      expect(dmLeaveMode({ workspaceId: WS, rows: [row()] })).toBe("legacy");
      expect(dmLeaveMode({ workspaceId: "ws-other", rows: [row()] })).toBe("server");
    }
  });
});

describe("내미는가 (D20·D21)", () => {
  const directory = makeDirectory(ROSTER);
  const OK: DmLeaveOfferInput = {
    mode: "server",
    phase: "ready",
    channel: dm(),
    directory,
    selfMemberId: ME,
  };

  it("새 서버 · 투영 준비 · 사람끼리 1:1 이면 내민다", () => {
    expect(dmLeaveOffered(OK)).toBe(true);
  });

  it("옛 서버(칸 없음)·모르는 서버에서는 메뉴 항목이 없다", () => {
    expect(dmLeaveOffered({ ...OK, mode: "legacy" })).toBe(false);
    expect(dmLeaveOffered({ ...OK, mode: "unknown" })).toBe(false);
  });

  it("투영이 오는 중이거나 오류면 내밀지 않는다(seenSeq 를 적을 수 없다)", () => {
    expect(dmLeaveOffered({ ...OK, phase: "loading" })).toBe(false);
    expect(dmLeaveOffered({ ...OK, phase: "error" })).toBe(false);
  });

  it("범위 밖은 하나씩 각각 막는다: 채널 · 보관 · 그룹 키 · 에이전트가 앉은 1:1 · 셋 이상 · 에이전트 DM · 나간 상대 · 내가 없음", () => {
    const cases: [string, Partial<Channel>][] = [
      ["채널", { kind: "public", dmKey: undefined }],
      ["보관된 DM", { archivedAtMs: 1 }],
      ["group: 키", { dmKey: `group:${ME}:${PEER}` }],
      ["admitted: 키", { dmKey: `admitted:${ME}:${PEER}` }],
      ["셋 이상", { memberIds: [ME, PEER, THIRD] }],
      ["에이전트 DM", { memberIds: [ME, BOT], dmKey: `${ME}:${BOT}` }],
      ["명부에 없는 상대(나간 멤버)", { memberIds: [ME, "00000000-0000-7000-8000-0000000000ee"] }],
      ["참여자 목록 없음(옛 DTO)", { memberIds: undefined }],
      ["나 혼자", { memberIds: [ME, ME] }],
      ["내가 참여자가 아님", { memberIds: [PEER, THIRD] }],
    ];
    for (const [name, over] of cases) {
      expect({ name, offered: dmLeaveOffered({ ...OK, channel: dm(over) }) }).toEqual({ name, offered: false });
    }
  });

  it("상대가 지워진 멤버면 내밀지 않고, 정지된 멤버면 내민다(참여 행이 남아 있다)", () => {
    const deleted = makeDirectory([member(ME, "김도현"), member(PEER, "이서연", { status: "deleted" })]);
    const suspended = makeDirectory([member(ME, "김도현"), member(PEER, "이서연", { status: "suspended" })]);
    expect(dmLeaveOffered({ ...OK, directory: deleted })).toBe(false);
    expect(dmLeaveOffered({ ...OK, directory: suspended })).toBe(true);
  });

  it("내가 사람이 아니면(에이전트 신원) 내밀지 않는다", () => {
    expect(isPersonToPersonDm(dm({ memberIds: [BOT, PEER] }), directory, BOT)).toBe(false);
  });

  it("dm_key 가 없어도(옛 DTO) 둘 다 사람인 1:1 이면 대상이다 - 서버가 마지막 말을 한다", () => {
    expect(isPersonToPersonDm(dm({ dmKey: undefined }), directory, ME)).toBe(true);
  });
});

describe("내가 본 seq 와 하한 (D16·D22)", () => {
  it("seenSeq 는 투영의 latest_seq 와 실시간으로 받은 seq 중 큰 쪽이다", () => {
    expect(dmLeaveSeenSeq({ latestSeq: 10 }, 12)).toBe(12);
    expect(dmLeaveSeenSeq({ latestSeq: 10 }, 7)).toBe(10);
    expect(dmLeaveSeenSeq({ latestSeq: 10 }, null)).toBe(10);
    expect(dmLeaveSeenSeq(undefined, undefined)).toBe(0);
    expect(dmLeaveSeenSeq({ latestSeq: -3 }, 2.5)).toBe(0);
  });

  it("하한은 내려가지 않는다", () => {
    expect(higherHistoryFloor(5, 9)).toBe(9);
    expect(higherHistoryFloor(9, 5)).toBe(9);
    expect(higherHistoryFloor(null, 5)).toBe(5);
    expect(higherHistoryFloor(undefined, null)).toBeNull();
    expect(higherHistoryFloor(0, null)).toBeNull();
  });

  it("하한 아래 발행물은 버리고, 하한 이상·seq 없는 프레임·하한 없는 대화는 통과한다", () => {
    expect(isBelowHistoryFloor(10, 11)).toBe(true);
    expect(isBelowHistoryFloor(1, 11)).toBe(true);
    expect(isBelowHistoryFloor(11, 11)).toBe(false);
    expect(isBelowHistoryFloor(12, 11)).toBe(false);
    expect(isBelowHistoryFloor(undefined, 11)).toBe(false);
    expect(isBelowHistoryFloor(10, null)).toBe(false);
    expect(isBelowHistoryFloor(10, undefined)).toBe(false);
  });

  it("204 뒤 투영 행: 하한 s+1, 읽음·숨김 s, 안 읽음 0, 「여기부터 안 읽음」 지움 - 그리고 3a 가 바로 숨긴다", () => {
    const before = row({ lastReadSeq: 4, latestSeq: 10, unreadCount: 6, mentionCount: 2, markedUnreadBeforeSeq: 3, latestReadableSeq: 10 });
    const after = readStateAfterLeave(before, 10);
    expect(after).toMatchObject({
      historyFromSeq: 11,
      lastReadSeq: 10,
      closedAtSeq: 10,
      unreadCount: 0,
      mentionCount: 0,
      markedUnreadBeforeSeq: null,
    });
    const verdict = dmVisibility({
      isOpen: false,
      starredOrSectioned: true,
      counterpart: "present",
      phase: "ready",
      closedAtSeq: after.closedAtSeq,
      historyFromSeq: after.historyFromSeq,
      latestReadableSeq: after.latestReadableSeq ?? after.latestSeq,
      lastReadSeq: after.lastReadSeq,
      markedUnreadBeforeSeq: after.markedUnreadBeforeSeq,
      mentionCount: after.mentionCount,
    });
    expect(verdict).toEqual({ visibility: "hidden", rule: "3a" });
  });

  it("확인 창을 보는 사이에 온 글(seenSeq 위)은 묻히지 않는다: 안 읽음으로 남는다", () => {
    const after = readStateAfterLeave(row({ latestSeq: 12, lastReadSeq: 10, unreadCount: 2, mentionCount: 1 }), 10);
    expect(after.historyFromSeq).toBe(11);
    expect(after.unreadCount).toBe(2);
    expect(after.mentionCount).toBe(1);
  });

  it("이미 더 높은 하한이 있으면 그대로 둔다(늦은 재전송이 하한을 내리지 않는다)", () => {
    const after = readStateAfterLeave(row({ historyFromSeq: 20, lastReadSeq: 19, closedAtSeq: 19, latestSeq: 19 }), 10);
    expect(after.historyFromSeq).toBe(20);
    expect(after.lastReadSeq).toBe(19);
    expect(after.closedAtSeq).toBe(19);
  });
});

describe("응답 갈래 (D16·D21)", () => {
  it("404·405·501 은 absent, 409 dm_leave_unavailable 은 unavailable, 그 밖은 failed", () => {
    expect(dmLeaveFailure(new ApiError(404, "x"))).toBe("absent");
    expect(dmLeaveFailure(new ApiError(405, "x"))).toBe("absent");
    expect(dmLeaveFailure(new ApiError(501, "x"))).toBe("absent");
    expect(dmLeaveFailure(new ApiError(409, "x", "dm_leave_unavailable"))).toBe("unavailable");
    expect(dmLeaveFailure(new ApiError(409, "x", "other"))).toBe("failed");
    expect(dmLeaveFailure(new ApiError(403, "x"))).toBe("failed");
    expect(dmLeaveFailure(new ApiError(500, "x"))).toBe("failed");
    expect(dmLeaveFailure(new TypeError("network"))).toBe("failed");
  });

  it("접는 것은 absent 뿐이다 - 409·5xx·네트워크 뒤에도 메뉴는 그대로", () => {
    settleDmLeaveFailure(WS, new ApiError(409, "x", "dm_leave_unavailable"));
    settleDmLeaveFailure(WS, new ApiError(503, "x"));
    settleDmLeaveFailure(WS, new TypeError("network"));
    expect(dmLeaveFolded(WS)).toBe(false);
  });
});

describe("확인 창 (D21)", () => {
  it("예약 N 개는 그 방의 pending 과 failed 를 같이 센다 - 다른 방·보낸·취소한 것은 세지 않는다", () => {
    const rows = [
      { channelId: DM_ID.toUpperCase(), status: "pending" as const },
      { channelId: DM_ID, status: "failed" as const },
      { channelId: DM_ID, status: "sent" as const },
      { channelId: DM_ID, status: "cancelled" as const },
      { channelId: "other", status: "pending" as const },
    ];
    expect(dmLeaveScheduledCount(rows, DM_ID)).toBe(2);
    expect(dmLeaveScheduledCount([], DM_ID)).toBe(0);
  });

  it("한국어 문장은 결정 문서 그대로이고, 예약 줄은 N > 0 일 때만 끝에 선다", async () => {
    const service = createMessageService({ messageLocale: "ko-KR", catalog: await loadMessageCatalog("ko-KR") });
    const format = service.formatMessage.bind(service);
    expect(dmLeaveConfirmCopy(format, { name: "이서연", scheduledCount: 0 })).toEqual({
      title: "이서연 님과의 대화에서 나갈까요?",
      lines: [
        "내 화면에서 지금까지의 대화가 사라져요. 이서연 님의 화면에는 그대로 남아요.",
        "다시 글이 오면 그 글부터 새 대화로 보여요.",
        "나간 뒤에는 되돌릴 수 없어요.",
      ],
      cancel: "취소",
      confirm: "나가기",
    });
    expect(dmLeaveConfirmCopy(format, { name: "이서연", scheduledCount: 2 }).lines.at(-1)).toBe(
      "예약해 둔 메시지 2개도 취소돼요."
    );
    expect(format(DM_LEAVE_KEYS.action)).toBe("대화 나가기");
    expect(format(DM_LEAVE_KEYS.done)).toBe("대화에서 나갔어요.");
    expect(format(DM_LEAVE_KEYS.failed)).toBe("나가지 못했어요. 다시 시도해 주세요.");
  });

  it("영어는 한글이 없고 예약 줄이 단수·복수를 가른다", async () => {
    const service = createMessageService({ messageLocale: "en-US", catalog: await loadMessageCatalog("en-US") });
    const format = service.formatMessage.bind(service);
    const one = dmLeaveConfirmCopy(format, { name: "Seoyeon", scheduledCount: 1 });
    const many = dmLeaveConfirmCopy(format, { name: "Seoyeon", scheduledCount: 3 });
    expect(one.lines.at(-1)).toBe("1 scheduled message will also be canceled.");
    expect(many.lines.at(-1)).toBe("3 scheduled messages will also be canceled.");
    for (const text of [one.title, ...one.lines, one.cancel, one.confirm]) {
      expect(text).not.toMatch(/[가-힯]/);
    }
  });

  it("사전의 channels.dmLeave.* 키와 DM_LEAVE_KEYS 가 정확히 같다", () => {
    const inCatalog = messageKeys.filter((key) => key.startsWith("channels.dmLeave.")).sort();
    expect(Object.values(DM_LEAVE_KEYS).sort()).toEqual(inCatalog);
  });
});

/** 성공 뒤 정리를 기록하는 가짜 문. 단계마다 이 대화의 것만 지우는지 본다. */
function recordingPort(throwAt?: DmLeaveCleanupStep) {
  const calls: [DmLeaveCleanupStep, string][] = [];
  let readRow: ReadState = row({ latestSeq: 10, lastReadSeq: 3, unreadCount: 7 });
  const port: DmLeaveCleanupPort = {
    updateReadRow(channelId, update) {
      calls.push(["updateReadRow", channelId]);
      if (throwAt === "updateReadRow") throw new Error("boom");
      readRow = update(readRow);
    },
    dropTimeline: (channelId) => {
      calls.push(["dropTimeline", channelId]);
      if (throwAt === "dropTimeline") throw new Error("boom");
    },
    dropSearchResults: (channelId) => {
      calls.push(["dropSearchResults", channelId]);
      if (throwAt === "dropSearchResults") throw new Error("boom");
    },
    dropInboxItems: (channelId) => {
      calls.push(["dropInboxItems", channelId]);
      if (throwAt === "dropInboxItems") throw new Error("boom");
    },
    clearDrafts: (channelId) => {
      calls.push(["clearDrafts", channelId]);
      if (throwAt === "clearDrafts") throw new Error("boom");
    },
    forgetFailedSends: (channelId) => {
      calls.push(["forgetFailedSends", channelId]);
      if (throwAt === "forgetFailedSends") throw new Error("boom");
    },
  };
  return { port, calls, readRow: () => readRow };
}

describe("나가기 성공 뒤 정리 (D17 기기 캐시·쓰던 초안 줄)", () => {
  it("투영 행 → 이력·스레드 → 검색 → 받은함 → 초안 → 못 보낸 글을 그 대화에 대해서만 차례대로 지운다", () => {
    const { port, calls, readRow } = recordingPort();
    expect(runDmLeaveCleanup(port, { channelId: DM_ID, seenSeq: 10 })).toEqual([]);
    expect(calls).toEqual([
      ["updateReadRow", DM_ID],
      ["dropTimeline", DM_ID],
      ["dropSearchResults", DM_ID],
      ["dropInboxItems", DM_ID],
      ["clearDrafts", DM_ID],
      ["forgetFailedSends", DM_ID],
    ]);
    expect(calls.map(([step]) => step)).toEqual([...DM_LEAVE_CLEANUP_STEPS]);
    // 투영 행에는 이 기기가 아는 하한이 들어가 다음 GET 전에도 3a 와 실시간 판정이 읽는다.
    expect(readRow().historyFromSeq).toBe(11);
    expect(readRow().lastReadSeq).toBe(10);
  });

  it("한 단계가 던져도 나머지는 돌고, 던진 단계만 돌려준다", () => {
    for (const step of DM_LEAVE_CLEANUP_STEPS) {
      const { port, calls } = recordingPort(step);
      expect(runDmLeaveCleanup(port, { channelId: DM_ID, seenSeq: 10 })).toEqual([step]);
      expect(calls).toHaveLength(DM_LEAVE_CLEANUP_STEPS.length);
    }
  });
});

describe("보내기 재시도의 409 message_before_leave (D17 쓰기 길 표)", () => {
  const pending = (clientMsgId: string): PendingMessage => ({
    clientMsgId,
    channelId: DM_ID,
    authorMemberId: ME,
    body: "안녕하세요",
    createdAtMs: 0,
    sinceSeq: 10,
    status: "sending",
  });

  it("409 message_before_leave 는 실패 행으로 남기지 않고 조용히 지운다", () => {
    const list = addPending(addPending([], pending("a")), pending("b"));
    const error = new ApiError(409, "before leave", "message_before_leave");
    expect(isMessageBeforeLeave(error)).toBe(true);
    const settled = pendingAfterSendFailure(list, "a", error);
    expect(settled.dropped).toBe(true);
    expect(settled.list.map((p) => p.clientMsgId)).toEqual(["b"]);
  });

  it("다른 409·5xx·네트워크 실패는 지금처럼 실패 행이다", () => {
    const list = [pending("a")];
    for (const error of [
      new ApiError(409, "x", "dm_leave_unavailable"),
      new ApiError(409, "x"),
      new ApiError(500, "x", "message_before_leave"),
      new TypeError("network"),
    ]) {
      expect(isMessageBeforeLeave(error)).toBe(false);
      const settled = pendingAfterSendFailure(list, "a", error);
      expect(settled.dropped).toBe(false);
      expect(settled.list).toEqual([{ ...pending("a"), status: "failed" }]);
    }
  });
});

describe("접기는 메뉴만 닫는다 (D18·D21)", () => {
  it("나가기 경로가 접혀도 투영이 하한을 싣는 한 보임 판정은 하한을 계속 읽는다 - 이미 나간 대화가 되살아나지 않는다", () => {
    const rows = [row({ historyFromSeq: 11, closedAtSeq: 10 })];
    settleDmLeaveFailure(WS, new ApiError(404, "not found"));
    expect(dmLeaveMode({ workspaceId: WS, rows })).toBe("legacy");
    expect(dmLeaveOffered({ mode: dmLeaveMode({ workspaceId: WS, rows }), phase: "ready", channel: dm(), directory: makeDirectory(ROSTER), selfMemberId: ME })).toBe(false);
    expect(readProjectionCarriesLeave(rows)).toBe(true);
  });

  it("투영이 하한 키를 싣지 않으면(옛 서버) 보임 판정도 하한을 읽지 않는다", () => {
    const { historyFromSeq: _omit, ...old } = row();
    void _omit;
    expect(readProjectionCarriesLeave([old])).toBe(false);
    expect(readProjectionCarriesLeave([])).toBe(false);
    expect(readProjectionCarriesLeave(undefined)).toBe(false);
  });
});
