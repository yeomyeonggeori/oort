import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_SEED_EVENT,
  clearAllDrafts,
  clearDraft,
  draftKey,
  pruneDrafts,
  listDrafts,
  listWorkspaceDrafts,
  parseDraftKey,
  readDraft,
  seedComposerText,
  writeDraft,
  DRAFT_TTL_MS,
  MAX_DRAFTS,
} from "./draftStore";

// =============================================================================
// 초안의 수명 (U4-f · 진단 H-10)
//
// 저장소는 진짜 `localStorage` 가 아니라 아래 가짜다. 세션 저장소 테스트와 같은
// 방식이고, 같은 이유다: 「이 동작 뒤 저장소에 무엇이 남았는가」를 그것을 쓴 API가
// 아니라 저장소 쪽에서 직접 확인해야 계약이 잠긴다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CH_A = "00000000-0000-7000-8000-0000000000a1";
const CH_B = "00000000-0000-7000-8000-0000000000b1";
const NOW = 1_800_000_000_000;

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe("초안은 채널을 옮겨도 남는다", () => {
  it("쓴 것을 그대로 되읽는다", () => {
    writeDraft(WS, CH_A, "배포 롤백 근거를 정리하면", NOW);
    expect(readDraft(WS, CH_A, NOW)).toBe("배포 롤백 근거를 정리하면");
  });

  it("채널마다 따로 산다", () => {
    writeDraft(WS, CH_A, "A 채널 초안", NOW);
    writeDraft(WS, CH_B, "B 채널 초안", NOW);
    expect(readDraft(WS, CH_A, NOW)).toBe("A 채널 초안");
    expect(readDraft(WS, CH_B, NOW)).toBe("B 채널 초안");
  });

  /**
   * 워크스페이스까지 열쇠에 넣는 이유. 채널 id 는 전역 유일하지만, 두 워크스페이스를
   * 오가는 사람의 초안이 한 이름 공간에 섞이면 지우는 일도 한꺼번에가 된다.
   */
  it("워크스페이스가 다르면 다른 초안이다", () => {
    const other = "00000000-0000-7000-8000-000000000002";
    writeDraft(WS, CH_A, "이쪽", NOW);
    writeDraft(other, CH_A, "저쪽", NOW);
    expect(readDraft(WS, CH_A, NOW)).toBe("이쪽");
    expect(readDraft(other, CH_A, NOW)).toBe("저쪽");
  });

  it("id 의 대소문자를 접는다 (와이어가 섞어 보낸다)", () => {
    expect(draftKey(WS, CH_A.toUpperCase())).toBe(draftKey(WS, CH_A));
  });
});

describe("수명", () => {
  it("비우면 저장이 아니라 삭제다: 빈 항목이 정원을 먹지 않는다", () => {
    writeDraft(WS, CH_A, "쓰다 말고", NOW);
    writeDraft(WS, CH_A, "", NOW);
    expect(store.size).toBe(0);
    expect(readDraft(WS, CH_A, NOW)).toBe("");
  });

  it("보내면 지운다", () => {
    writeDraft(WS, CH_A, "보낼 글", NOW);
    clearDraft(WS, CH_A);
    expect(readDraft(WS, CH_A, NOW)).toBe("");
  });

  it("로그아웃은 이 기기의 초안을 전부 지운다", () => {
    writeDraft(WS, CH_A, "하나", NOW);
    writeDraft(WS, CH_B, "둘", NOW);
    store.set("momo.web.session.v1", "{}");
    clearAllDrafts();
    expect(readDraft(WS, CH_A, NOW)).toBe("");
    expect(readDraft(WS, CH_B, NOW)).toBe("");
    // 남의 열쇠는 건드리지 않는다.
    expect(store.has("momo.web.session.v1")).toBe(true);
  });

  /**
   * 「한 달 전에 쓰다 만 문장」은 이어 쓸 글이 아니라 잊은 글이다. 그것이 채널을
   * 열 때 입력창에 복원되면 실수로 보내진다.
   */
  it("시한이 지난 초안은 읽는 순간 버려진다", () => {
    writeDraft(WS, CH_A, "오래된 초안", NOW);
    expect(readDraft(WS, CH_A, NOW + DRAFT_TTL_MS + 1)).toBe("");
    expect(store.size).toBe(0);
  });

  it("시한 직전까지는 살아 있다", () => {
    writeDraft(WS, CH_A, "아슬아슬", NOW);
    expect(readDraft(WS, CH_A, NOW + DRAFT_TTL_MS - 1)).toBe("아슬아슬");
  });

  it("손댈 때마다 시계가 갱신된다: 지금 쓰는 초안은 늙지 않는다", () => {
    writeDraft(WS, CH_A, "처음", NOW);
    writeDraft(WS, CH_A, "이어서 쓰는 중", NOW + DRAFT_TTL_MS - 1);
    expect(readDraft(WS, CH_A, NOW + DRAFT_TTL_MS + 1)).toBe("이어서 쓰는 중");
  });
});

describe("정원", () => {
  it("상한을 넘기면 가장 오래된 것부터 버린다", () => {
    for (let i = 0; i < MAX_DRAFTS + 5; i++) {
      writeDraft(WS, `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`, `초안 ${i}`, NOW + i);
    }
    expect(store.size).toBe(MAX_DRAFTS);
    // 가장 오래된 다섯은 없고, 방금 쓴 것은 있다.
    expect(readDraft(WS, "00000000-0000-7000-8000-000000000000", NOW)).toBe("");
    expect(
      readDraft(WS, `00000000-0000-7000-8000-${String(MAX_DRAFTS + 4).padStart(12, "0")}`, NOW)
    ).toBe(`초안 ${MAX_DRAFTS + 4}`);
  });

  it("읽을 수 없는 항목은 초안이 아니다 (손으로 고쳐졌거나 옛 판이다)", () => {
    store.set(draftKey(WS, CH_A), "{not json");
    expect(readDraft(WS, CH_A, NOW)).toBe("");
    store.set(draftKey(WS, CH_A), JSON.stringify({ text: 42, atMs: NOW }));
    expect(readDraft(WS, CH_A, NOW)).toBe("");
    pruneDrafts(NOW);
    expect(store.size).toBe(0);
  });
});

describe("저장소가 막힌 환경", () => {
  it("던지지 않는다: 초안이 안 남을 뿐 입력은 그대로 동작한다", () => {
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("blocked");
      },
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => writeDraft(WS, CH_A, "글", NOW)).not.toThrow();
    expect(readDraft(WS, CH_A, NOW)).toBe("");
    expect(() => clearAllDrafts()).not.toThrow();
  });
});

describe("컴포저 시드", () => {
  it("빈 칸에만 심고 쓰다 만 글은 덮지 않는다", () => {
    expect(seedComposerText(WS, CH_A, "@grokbot ", NOW)).toBe(true);
    expect(readDraft(WS, CH_A, NOW)).toBe("@grokbot ");
    expect(seedComposerText(WS, CH_A, "@other ", NOW)).toBe(false);
    expect(readDraft(WS, CH_A, NOW)).toBe("@grokbot ");
  });

  it("같은 탭 사건을 낸다", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: dispatch });
    class FakeEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    }
    vi.stubGlobal("CustomEvent", FakeEvent);
    expect(seedComposerText(WS, CH_A, "@grokbot ", NOW)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: COMPOSER_SEED_EVENT,
      detail: { workspaceId: WS, channelId: CH_A, text: "@grokbot " },
    });
  });
});

describe("목록", () => {
  it("열쇠에서 워크스페이스와 채널을 푼다", () => {
    expect(parseDraftKey(draftKey(WS, CH_A))).toEqual({
      workspaceId: WS,
      channelId: CH_A,
    });
    expect(parseDraftKey("momo.web.session.v1")).toBeNull();
  });

  it("최근 수정순으로 모은다", () => {
    writeDraft(WS, CH_A, "먼저 쓴 채널 초안", NOW);
    writeDraft(WS, CH_B, "방금 고친 초안", NOW + 5_000);
    expect(listDrafts(NOW + 5_000).map((row) => row.channelId)).toEqual([
      CH_B,
      CH_A,
    ]);
    expect(listDrafts(NOW + 5_000).map((row) => row.text)).toEqual([
      "방금 고친 초안",
      "먼저 쓴 채널 초안",
    ]);
  });

  it("다른 워크스페이스 초안은 섞지 않는다", () => {
    const other = "00000000-0000-7000-8000-000000000002";
    writeDraft(WS, CH_A, "이쪽", NOW);
    writeDraft(other, CH_B, "저쪽", NOW);
    expect(listWorkspaceDrafts(WS, NOW).map((row) => row.text)).toEqual(["이쪽"]);
  });

  it("시한이 지난 초안은 목록에 올리지 않는다", () => {
    writeDraft(WS, CH_A, "오래된 초안", NOW);
    expect(listDrafts(NOW + DRAFT_TTL_MS + 1)).toEqual([]);
  });
});
