// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Channel, ReadState, RosterMember } from "@momo/core/lib/api";
import { AVAILABILITY_REFRESH_MS } from "@momo/core/features/presence/model";
import {
  useDirectory,
  channelLabel,
  channelLabelParts,
  dmAutoReplyAgent,
  dmPeer,
  isAmbiguousName,
  makeDirectory,
  memberFor,
  memberNameParts,
  applyClosureToCache,
  applyReadStateToCache,
  mergeReadStateRow,
} from "./useWorkspace";

// =============================================================================
// Naming a destination (MOMO-611 R2 High). The demo workspace really holds two
// members displayed as 김인턴, a human (@intern-kim) and an agent (@kim-intern),
// so a DM row named by displayName alone names two different conversations.
// These are the live roster ids and handles, in the case the server sends them.
// =============================================================================

const fetchRosterCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchRoster: async () => {
      fetchRosterCalls.count += 1;
      return [];
    },
  };
});

const WS = "00000000-0000-7000-8000-000000000001";

function member(over: Partial<RosterMember> & { id: string }): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "이름",
    handle: "handle",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DEMO = member({
  id: "00000000-0000-7000-8000-000000000101",
  displayName: "데모 사용자",
  handle: "demo",
});
const SEONGJAE = member({
  id: "00000000-0000-7000-8000-0000000005d1",
  displayName: "곽성재",
  handle: "seongjae",
});
const INTERN_HUMAN = member({
  id: "00000000-0000-7000-8000-0000000005d2",
  displayName: "김인턴",
  handle: "intern-kim",
});
const INTERN_AGENT = member({
  id: "00000000-0000-7000-8000-000000000102",
  displayName: "김인턴",
  handle: "kim-intern",
  kind: "agent",
  ownerHumanId: DEMO.id,
});

const DIRECTORY = makeDirectory([DEMO, SEONGJAE, INTERN_HUMAN, INTERN_AGENT]);

function dm(peerId: string, id = "019f98d1-9d84-7625-9034-17f83367ca8a"): Channel {
  return {
    id,
    workspaceId: WS,
    kind: "dm",
    memberIds: [DEMO.id, peerId],
    dmKey: "a854e7444da734035b4faa15085844c8",
    muted: false,
  };
}

describe("makeDirectory / isAmbiguousName", () => {
  it("marks a display name carried by more than one member", () => {
    expect(isAmbiguousName(DIRECTORY, INTERN_HUMAN)).toBe(true);
    expect(isAmbiguousName(DIRECTORY, INTERN_AGENT)).toBe(true);
    expect(isAmbiguousName(DIRECTORY, SEONGJAE)).toBe(false);
  });

  it("folds case and edge whitespace when comparing names", () => {
    const directory = makeDirectory([
      member({ id: "a", displayName: "Hermes", handle: "hermes" }),
      member({ id: "b", displayName: " hermes ", handle: "hermes-2" }),
    ]);
    expect(directory.ambiguousNames.has("hermes")).toBe(true);
  });

  it("keeps the id lookup case-insensitive", () => {
    expect(memberFor(DIRECTORY, INTERN_HUMAN.id.toUpperCase())?.handle).toBe(
      "intern-kim"
    );
  });
});

describe("dmPeer", () => {
  it("resolves the other participant whatever case the ids arrive in", () => {
    const channel = dm(SEONGJAE.id.toUpperCase());
    expect(dmPeer(channel, DIRECTORY, DEMO.id)?.handle).toBe("seongjae");
  });

  it("is null for a channel, which has no single other participant", () => {
    const channel: Channel = {
      id: "019f8000-0000-7000-8000-000000000001",
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    };
    expect(dmPeer(channel, DIRECTORY, DEMO.id)).toBeNull();
  });
});

describe("dmAutoReplyAgent", () => {
  // goal B13 / QA H7. The composer promises "멘션 없이 바로 말하면 답합니다" on the
  // strength of this predicate, so every clause it gets wrong is a promise the
  // send path then breaks. It mirrors the server's
  // `momo_agent::dm::resolve_dm_addressing` clause for clause.
  it("names the single agent counterpart of a 1:1 DM", () => {
    expect(
      dmAutoReplyAgent(dm(INTERN_AGENT.id.toUpperCase()), DIRECTORY, DEMO.id)
        ?.handle
    ).toBe("kim-intern");
  });

  it("is null when the counterpart is a human, who does not run", () => {
    expect(dmAutoReplyAgent(dm(SEONGJAE.id), DIRECTORY, DEMO.id)).toBeNull();
  });

  it("is null for a group DM, which is back to \"who did you mean\"", () => {
    const group: Channel = {
      ...dm(INTERN_AGENT.id),
      memberIds: [DEMO.id, INTERN_AGENT.id, SEONGJAE.id],
    };
    expect(dmAutoReplyAgent(group, DIRECTORY, DEMO.id)).toBeNull();
    // …while `dmPeer` still answers with one of the two, which is exactly why
    // the hint may not be built on it.
    expect(dmPeer(group, DIRECTORY, DEMO.id)).not.toBeNull();
  });

  it("is null for a group channel however few members it has", () => {
    const channel: Channel = {
      id: "019f8000-0000-7000-8000-000000000002",
      workspaceId: WS,
      kind: "public",
      name: "general",
      memberIds: [DEMO.id, INTERN_AGENT.id],
      muted: false,
    };
    expect(dmAutoReplyAgent(channel, DIRECTORY, DEMO.id)).toBeNull();
  });

  it("is null for an agent that is no longer active", () => {
    const directory = makeDirectory([
      DEMO,
      { ...INTERN_AGENT, status: "suspended" },
    ]);
    expect(dmAutoReplyAgent(dm(INTERN_AGENT.id), directory, DEMO.id)).toBeNull();
  });
});

describe("channelLabelParts", () => {
  it("carries the handle when the name alone names two members", () => {
    expect(channelLabelParts(dm(INTERN_HUMAN.id), DIRECTORY, DEMO.id)).toEqual({
      text: "김인턴",
      handle: "@intern-kim",
      isAgent: false,
      kind: "peer",
    });
    expect(channelLabelParts(dm(INTERN_AGENT.id), DIRECTORY, DEMO.id)).toEqual({
      text: "김인턴",
      handle: "@kim-intern",
      isAgent: true,
      kind: "peer",
    });
  });

  it("leaves the handle off when the name is already unique", () => {
    expect(channelLabelParts(dm(SEONGJAE.id), DIRECTORY, DEMO.id)).toEqual({
      text: "곽성재",
      handle: null,
      isAgent: false,
      kind: "peer",
    });
  });

  it("falls back without inventing a name when the roster has not loaded", () => {
    const empty = makeDirectory([]);
    expect(channelLabelParts(dm(SEONGJAE.id), empty, DEMO.id)).toEqual({
      text: "불러오는 중",
      handle: null,
      isAgent: false,
      kind: "pending",
    });
  });

  it("names a channel by its name, never by a participant", () => {
    const channel: Channel = {
      id: "019f8000-0000-7000-8000-000000000001",
      workspaceId: WS,
      kind: "public",
      name: "general",
      muted: false,
    };
    expect(channelLabelParts(channel, DIRECTORY, DEMO.id)).toEqual({
      text: "general",
      handle: null,
      isAgent: false,
      kind: "channel",
    });
  });
});

describe("channelLabel", () => {
  it("keeps the disambiguator in the one-string form", () => {
    expect(channelLabel(dm(INTERN_AGENT.id), DIRECTORY, DEMO.id)).toBe(
      "김인턴 @kim-intern"
    );
    expect(channelLabel(dm(SEONGJAE.id), DIRECTORY, DEMO.id)).toBe("곽성재");
  });
});

describe("memberNameParts", () => {
  // The same rule for the surfaces that name a MEMBER rather than a channel:
  // the agent turn pill and the composer activity line (MOMO-613).
  it("carries the handle exactly where the name alone is a coin toss", () => {
    expect(memberNameParts(DIRECTORY, INTERN_AGENT.id, "에이전트")).toEqual({
      name: "김인턴",
      handle: "@kim-intern",
    });
    expect(memberNameParts(DIRECTORY, SEONGJAE.id, "에이전트")).toEqual({
      name: "곽성재",
    });
  });

  it("folds id case and falls back rather than naming nobody", () => {
    expect(
      memberNameParts(DIRECTORY, INTERN_HUMAN.id.toUpperCase(), "에이전트").handle
    ).toBe("@intern-kim");
    expect(
      memberNameParts(DIRECTORY, "019f0000-0000-7000-8000-000000000999", "에이전트")
    ).toEqual({ name: "에이전트" });
  });
});


// =============================================================================
// 읽음 투영 캐시의 합류 (ADR-0177 D10, #4228): `PUT read-state` 응답과 실시간 프레임은 `latestReadableSeq`·`closedAtSeq` 를 싣지 않는다.
// 「이번 응답이 말하지 않음」(`undefined`)이 「닫힘 없음」(`null`)으로 바뀌면 닫은 DM 이 되살아난다.
// =============================================================================

const READ_CH = "00000000-0000-7000-8000-000000000301";
const OTHER_CH = "00000000-0000-7000-8000-000000000302";

function readRow(channelId: string, patch: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...patch,
  };
}

describe("읽음 투영 캐시: 두 필드는 말하지 않은 응답이 지우지 않는다", () => {
  it("말하지 않은 응답(undefined)은 캐시의 값을 지키고, 나머지 칸은 응답을 따른다", () => {
    const current = readRow(READ_CH, { closedAtSeq: 10, latestReadableSeq: 9, lastReadSeq: 4 });
    const incoming = readRow(READ_CH, { lastReadSeq: 10 });
    expect(mergeReadStateRow(current, incoming)).toEqual({
      ...incoming,
      closedAtSeq: 10,
      latestReadableSeq: 9,
    });
  });

  it("null 은 답이다(「안 닫았다」): 캐시의 값을 대신한다", () => {
    const current = readRow(READ_CH, { closedAtSeq: 10, latestReadableSeq: 9 });
    const incoming = readRow(READ_CH, { closedAtSeq: null, latestReadableSeq: 12 });
    const merged = mergeReadStateRow(current, incoming);
    expect(merged.closedAtSeq).toBeNull();
    expect(merged.latestReadableSeq).toBe(12);
  });

  it("캐시에도 응답에도 없으면 키를 만들지 않는다(여전히 「말하지 않음」)", () => {
    const merged = mergeReadStateRow(readRow(READ_CH), readRow(READ_CH));
    expect("closedAtSeq" in merged).toBe(false);
    expect("latestReadableSeq" in merged).toBe(false);
  });

  it("applyReadStateToCache: PUT 응답이 다른 DM 의 닫힘을 지우지 않고, 그 채널 자신의 닫힘도 지키며, 새 행은 덧붙인다", () => {
    const client = new QueryClient();
    client.setQueryData<ReadState[]>(["read-state", WS], [
      readRow(READ_CH, { closedAtSeq: 10, latestReadableSeq: 10 }),
      readRow(OTHER_CH, { closedAtSeq: null, latestReadableSeq: 3 }),
    ]);
    // 다른 DM 을 열어 읽음 커서를 올렸다(PUT 응답: 두 필드 없음).
    applyReadStateToCache(client, WS, readRow(OTHER_CH, { lastReadSeq: 3, latestSeq: 3 }));
    // 닫은 DM 자신에게도 읽음 쓰기가 온다.
    applyReadStateToCache(client, WS, readRow(READ_CH, { lastReadSeq: 10 }));
    const rows = client.getQueryData<ReadState[]>(["read-state", WS]) ?? [];
    expect(rows.find((row) => row.channelId === READ_CH)?.closedAtSeq).toBe(10);
    expect(rows.find((row) => row.channelId === OTHER_CH)?.closedAtSeq).toBeNull();
    // 행이 없던 채널은 응답 그대로 덧붙는다.
    applyReadStateToCache(client, WS, readRow("00000000-0000-7000-8000-000000000303"));
    expect(client.getQueryData<ReadState[]>(["read-state", WS])).toHaveLength(3);
  });

  it("applyClosureToCache: 쓴 기기는 즉시 반영한다(D10) - 숫자는 닫힘, null 은 다시 열기, 다른 행은 그대로", () => {
    const client = new QueryClient();
    client.setQueryData<ReadState[]>(["read-state", WS], [
      readRow(READ_CH, { closedAtSeq: null, latestReadableSeq: 10 }),
      readRow(OTHER_CH, { closedAtSeq: null, latestReadableSeq: 3 }),
    ]);
    applyClosureToCache(client, WS, READ_CH, 10);
    let rows = client.getQueryData<ReadState[]>(["read-state", WS]) ?? [];
    expect(rows.map((row) => row.closedAtSeq)).toEqual([10, null]);
    applyClosureToCache(client, WS, READ_CH, null);
    rows = client.getQueryData<ReadState[]>(["read-state", WS]) ?? [];
    expect(rows.map((row) => row.closedAtSeq)).toEqual([null, null]);
  });

  it("applyClosureToCache: 캐시가 아직 없으면 만들지 않는다(없는 투영을 지어내지 않는다)", () => {
    const client = new QueryClient();
    applyClosureToCache(client, WS, READ_CH, 10);
    expect(client.getQueryData(["read-state", WS])).toBeUndefined();
  });
});

// #4692: a dot is as fresh as the last roster read (availability is read by the server when it builds
// the roster), so the roster has to be re-read while a screen that draws dots is in front of the person.
describe("useDirectory: the roster is re-read on the availability cadence (#4692)", () => {
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.useRealTimers();
  });

  function Probe() {
    useDirectory(WS);
    return null;
  }

  it("reads once on mount, again each cadence while mounted, and stops when unmounted", async () => {
    vi.useFakeTimers();
    fetchRosterCalls.count = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    expect(fetchRosterCalls.count).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_REFRESH_MS - 1);
    });
    expect(fetchRosterCalls.count).toBe(1); // not before its time

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetchRosterCalls.count).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_REFRESH_MS);
    });
    expect(fetchRosterCalls.count).toBe(3);

    act(() => root?.unmount());
    root = null;
    await act(async () => {
      vi.advanceTimersByTime(AVAILABILITY_REFRESH_MS * 3);
    });
    expect(fetchRosterCalls.count).toBe(3); // nobody is looking: nobody is asking
  });
});
