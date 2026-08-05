import { describe, expect, it } from "vitest";
import {
  asTypingFrame,
  centrifugoChannelName,
  centrifugoTypingChannelName,
} from "../../lib/realtimeEvents";
import { activitySuffix } from "../agents/turnCopy";
import { composerKeyIntent } from "./composerKeys";
import {
  emptyTypingSendState,
  liveTypists,
  mergeTypingSignal,
  nextTypingAction,
  pruneTypingSignals,
  renewMargin,
  typingGrantFrom,
  typingLabel,
  typingLead,
  typingSegments,
  typingSentence,
  typingTail,
  withTypingGrant,
  withTypingPublished,
  withTypingRefusal,
  TYPING_AGGREGATE_THRESHOLD_FALLBACK,
  TYPING_GRANT_RENEW_MARGIN_MS,
  type TypingSignal,
} from "./typing";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const OTHER_CH = "00000000-0000-7000-8000-000000000202";
const ME = "00000000-0000-7000-8000-000000000101";
const DOHYUN = "00000000-0000-7000-8000-000000000102";
const MINSEO = "00000000-0000-7000-8000-000000000103";
const JIWOO = "00000000-0000-7000-8000-000000000104";
const AGENT = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa613";

const NOW = 1_785_238_400_000;
/** 서버 값 그대로 (`momo-ephemeral::signal.rs`). */
const TTL = 6_000;
const REPUBLISH = 3_000;

function grant(over: Partial<ReturnType<typeof typingGrantFrom>> = {}) {
  return {
    ...typingGrantFrom({
      grant: "grant-token",
      channel: centrifugoTypingChannelName(WS, CH),
      expiresAtMs: NOW + 60_000,
      signalTtlMs: TTL,
      republishIntervalMs: REPUBLISH,
      aggregateThreshold: 3,
    }),
    ...over,
  };
}

function signal(over: Partial<TypingSignal> = {}): TypingSignal {
  const startedAtMs = over.startedAtMs ?? over.sentAtMs ?? NOW;
  return {
    channelId: CH,
    memberId: DOHYUN,
    startedAtMs,
    sentAtMs: startedAtMs,
    expiresAtMs: NOW + TTL,
    ...over,
  };
}

/** 재발행 한 건. 서버가 3초마다 새 만료로 같은 신호를 다시 실어 보내는 그 모양. */
function republish(
  list: TypingSignal[],
  memberId: string,
  atMs: number
): TypingSignal[] {
  return mergeTypingSignal(list, {
    channelId: CH,
    memberId,
    startedAtMs: atMs,
    sentAtMs: atMs,
    expiresAtMs: atMs + TTL,
  });
}

const humansOnly = (memberId: string) => memberId.toLowerCase() !== AGENT;

// ---------------------------------------------------------------------------
// 어휘 경계. 이 배치의 최악의 회귀는 기능이 아니라 낱말이다.
// ---------------------------------------------------------------------------

describe("사람은 작성 중, 에이전트는 작업 중", () => {
  it("never lets the word 작업 into a typing sentence", () => {
    for (const names of [[], ["이도현"], ["이도현", "김민서"], ["a", "b", "c"]]) {
      const sentence = typingSentence(names) ?? "";
      expect(sentence).not.toContain("작업");
      expect(sentence).not.toContain("승인");
    }
  });

  it("keeps the agent turn suffix saying 작업 중, so the two never converge", () => {
    // 반대 방향도 못박는다: 에이전트 문구가 「작성 중」으로 새면 봇 래핑이다.
    const agentLine = activitySuffix({
      key: "k",
      memberId: AGENT,
      name: { name: "김인턴" },
      state: "working",
    });
    expect(agentLine).toContain("작업 중");
    expect(agentLine).not.toContain("작성 중");
    expect(typingSentence(["이도현"])).toContain("작성 중");
  });

  it("drops an agent's signal even if one somehow reaches the rail", () => {
    // 서버가 403으로 막지만(`require_human`) 이것은 화면의 방어다: 그려지는 순간
    // 어휘 경계가 화면에서 깨진다.
    const list = [signal({ memberId: AGENT }), signal({ memberId: DOHYUN })];
    expect(
      liveTypists(list, {
        channelId: CH,
        nowMs: NOW,
        myMemberId: ME,
        isEligible: humansOnly,
      })
    ).toEqual([DOHYUN]);
  });
});

// ---------------------------------------------------------------------------
// 송신
// ---------------------------------------------------------------------------

describe("nextTypingAction", () => {
  it("asks for a grant on the very first keystroke", () => {
    expect(nextTypingAction(emptyTypingSendState(), NOW)).toEqual({
      kind: "grant",
    });
  });

  it("publishes immediately once a grant is in hand", () => {
    const state = withTypingGrant(emptyTypingSendState(), grant(), NOW);
    expect(nextTypingAction(state, NOW)).toEqual({
      kind: "publish",
      grant: "grant-token",
    });
  });

  it("throttles the burst to the server's own interval", () => {
    let state = withTypingGrant(emptyTypingSendState(), grant(), NOW);
    state = withTypingPublished(state, NOW);
    expect(nextTypingAction(state, NOW + 1).kind).toBe("wait");
    expect(nextTypingAction(state, NOW + REPUBLISH - 1).kind).toBe("wait");
    expect(nextTypingAction(state, NOW + REPUBLISH).kind).toBe("publish");
  });

  /**
   * 「입력이 멈추면 송신이 멈춘다」는 코드가 아니라 **구조**로 지켜진다: 이 함수는
   * 키를 누를 때만 불리므로, 부르지 않으면 아무것도 나가지 않는다. 그 사실을 단정할
   * 수 있는 형태가 이것이다 — 이 모듈에는 스케줄러 이음새가 없다.
   */
  it("has no timer seam at all: a pause is simply nobody calling it", () => {
    let state = withTypingGrant(emptyTypingSendState(), grant(), NOW);
    state = withTypingPublished(state, NOW);
    // 30초 뒤에 다시 치면 그것은 새 버스트의 첫 타다. 그 사이에 무엇도 나가지 않았고
    // 표시는 TTL로 이미 사라졌다.
    expect(nextTypingAction(state, NOW + 30_000).kind).toBe("publish");
  });

  it("renews a grant before it dies, not after", () => {
    // 60초 자격을 55초 전에 받았다: 5초 남았고 여유는 10초이므로 갱신이 먼저다.
    const nearlyDead = grant({ expiresAtMs: NOW + 5_000 });
    const state = withTypingPublished(
      withTypingGrant(emptyTypingSendState(), nearlyDead, NOW - 55_000),
      NOW - REPUBLISH
    );
    expect(nextTypingAction(state, NOW).kind).toBe("grant");
  });

  /**
   * **실측으로 잡은 결함.** `gate-typing`의 GRANT red seam이 grant TTL을 1초로
   * 줄였을 때, 7초를 치는 동안 발행이 **0건**이었다: 수명(1s)이 여유(10s)보다
   * 짧으니 자격은 태어나자마자 「갱신 대상」이 되고, 클라는 grant만 계속 받으며
   * 한 번도 발행하지 않는다. 여유를 수명의 절반으로 깎는 것이 그 순환을 끊는다.
   */
  it("still publishes with a grant whose whole life is shorter than the margin", () => {
    const short = grant({ expiresAtMs: NOW + 1_000 });
    const state = withTypingGrant(emptyTypingSendState(), short, NOW);
    expect(renewMargin(short, NOW)).toBe(500);
    expect(nextTypingAction(state, NOW).kind).toBe("publish");
    // 수명의 절반이 지나면 그때 갱신한다.
    expect(nextTypingAction(state, NOW + 600).kind).toBe("grant");
  });

  it("keeps the margin at its ceiling for a long-lived grant", () => {
    expect(renewMargin(grant(), NOW)).toBe(TYPING_GRANT_RENEW_MARGIN_MS);
  });

  it("falls back to the ceiling when the issue time is unknown", () => {
    expect(renewMargin(grant(), null)).toBe(TYPING_GRANT_RENEW_MARGIN_MS);
  });

  it("keeps the renew margin above two republish periods", () => {
    // 그보다 작으면 만료 직전에 띄운 요청이 도착하는 사이 grant가 죽어 403이 되고,
    // 치고 있는 사람의 표시가 한 번 끊긴다.
    expect(TYPING_GRANT_RENEW_MARGIN_MS).toBeGreaterThan(REPUBLISH * 2);
  });
});

describe("withTypingRefusal", () => {
  it("re-acquires after a 403, because the capability is what died", () => {
    const state = withTypingRefusal(
      withTypingGrant(emptyTypingSendState(), grant(), NOW),
      403,
      { nowMs: NOW }
    );
    expect(state.grant).toBeNull();
    expect(state.disabled).toBe(false);
    expect(nextTypingAction(state, NOW).kind).toBe("grant");
  });

  it("waits after a 429 instead of trying again on the next keystroke", () => {
    const state = withTypingRefusal(
      withTypingGrant(emptyTypingSendState(), grant(), NOW),
      429,
      { nowMs: NOW, retryAfterMs: 5_000 }
    );
    expect(nextTypingAction(state, NOW + 4_999).kind).toBe("wait");
    expect(nextTypingAction(state, NOW + 5_000).kind).toBe("publish");
  });

  it("still backs off when the server sends no retry hint", () => {
    const state = withTypingRefusal(
      withTypingGrant(emptyTypingSendState(), grant(), NOW),
      429,
      { nowMs: NOW }
    );
    expect(state.backoffUntilMs).toBe(NOW + REPUBLISH);
  });

  /**
   * 503은 「이 인스턴스는 휘발 신호를 하지 않는다」이고, 그 말의 뜻은 그만 물으라는
   * 것이다. 매 키마다 503을 받는 클라는 그 자체로 부하다.
   */
  it("stops asking forever after a 503", () => {
    const state = withTypingRefusal(
      withTypingGrant(emptyTypingSendState(), grant(), NOW),
      503,
      { nowMs: NOW }
    );
    expect(state.disabled).toBe(true);
    expect(nextTypingAction(state, NOW).kind).toBe("wait");
    expect(nextTypingAction(state, NOW + 3_600_000).kind).toBe("wait");
  });

  it("leaves a 502 alone: the next keystroke IS the retry", () => {
    const before = withTypingGrant(emptyTypingSendState(), grant(), NOW);
    expect(withTypingRefusal(before, 502, { nowMs: NOW })).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 수신
// ---------------------------------------------------------------------------

describe("the registry forgets on its own (가드 4)", () => {
  it("keeps one entry per (channel, member)", () => {
    let list: TypingSignal[] = [];
    list = mergeTypingSignal(list, signal());
    list = mergeTypingSignal(list, signal({ expiresAtMs: NOW + TTL + 3_000 }));
    expect(list).toHaveLength(1);
    expect(list[0].expiresAtMs).toBe(NOW + TTL + 3_000);
  });

  /**
   * 휘발 네임스페이스에는 seq가 없으므로 순서 보장도 없다. 늦게 도착한 **오래된**
   * 신호가 이기면 살아 있는 표시가 과거로 되돌아가 깜박인다.
   */
  it("never lets a late-arriving older signal roll the expiry back", () => {
    let list = mergeTypingSignal([], signal({ expiresAtMs: NOW + 9_000 }));
    list = mergeTypingSignal(list, signal({ expiresAtMs: NOW + 6_000 }));
    expect(list[0].expiresAtMs).toBe(NOW + 9_000);
  });

  it("separates the same person typing in two channels", () => {
    let list = mergeTypingSignal([], signal());
    list = mergeTypingSignal(list, signal({ channelId: OTHER_CH }));
    expect(list).toHaveLength(2);
  });

  it("drops a signal the moment its own expiry passes", () => {
    const list = [signal({ expiresAtMs: NOW + TTL })];
    expect(pruneTypingSignals(list, NOW + TTL - 1)).toHaveLength(1);
    expect(pruneTypingSignals(list, NOW + TTL)).toHaveLength(0);
  });

  /**
   * 이 함수는 1Hz로 돈다. 버릴 것이 없을 때 새 배열을 만들면 그 사실만으로 화면이
   * 초당 한 번 다시 그려진다 — 아무도 치고 있지 않은 조용한 채널에서도.
   */
  it("returns the SAME array when nothing expired", () => {
    const list = [signal()];
    expect(pruneTypingSignals(list, NOW)).toBe(list);
  });
});

describe("liveTypists", () => {
  it("never shows me my own typing", () => {
    const list = [signal({ memberId: ME }), signal({ memberId: DOHYUN })];
    expect(
      liveTypists(list, {
        channelId: CH,
        nowMs: NOW,
        myMemberId: ME,
        isEligible: humansOnly,
      })
    ).toEqual([DOHYUN]);
  });

  it("shows only the channel being asked about", () => {
    const list = [signal(), signal({ channelId: OTHER_CH, memberId: MINSEO })];
    expect(
      liveTypists(list, { channelId: CH, nowMs: NOW, isEligible: humansOnly })
    ).toEqual([DOHYUN]);
  });

  it("drops a member the roster cannot name", () => {
    // 이름 없는 「누군가 작성 중」은 나르는 정보가 0이다.
    const list = [signal({ memberId: "00000000-0000-7000-8000-0000000009ff" })];
    expect(
      liveTypists(list, { channelId: CH, nowMs: NOW, isEligible: () => false })
    ).toEqual([]);
  });

  it("orders by when each person started, not by arrival", () => {
    const list = [
      signal({ memberId: MINSEO, startedAtMs: NOW + 500 }),
      signal({ memberId: DOHYUN, startedAtMs: NOW }),
    ];
    expect(
      liveTypists(list, { channelId: CH, nowMs: NOW + 600, isEligible: humansOnly })
    ).toEqual([DOHYUN, MINSEO]);
  });

  /**
   * **design-review #1059 H-1 회귀.** 위 테스트는 이 불변식에 이름을 붙여 놓고
   * 사람당 발행 1회만 다뤘고, 그래서 **재발행 경로가 비어 있었다** — 코드가 자기
   * 테스트가 이름 붙인 불변식을 깨는데 테스트는 그것을 못 봤다.
   *
   * 재발행은 3초마다 온다. 정렬 키가 갱신되면 순서는 「가장 최근에 발행한 사람 순」이
   * 되고, 두 사람이 위상차를 두고 치면 이름이 1.5초마다 뒤집힌다. 리뷰어가 코어를
   * 그대로 돌려 재현했고, 이 테스트가 그 시뮬레이션을 그대로 옮긴 것이다.
   */
  it("holds the name order across republishes (H-1)", () => {
    let list: TypingSignal[] = [];
    const order: string[] = [];
    // 이도현은 t=0,3,6…  김민서는 t=1.5,4.5,7.5… (위상차 1.5초)
    for (const t of [0, 1_500, 3_000, 4_500, 6_000, 7_500]) {
      const who = t % 3_000 === 0 ? DOHYUN : MINSEO;
      list = republish(list, who, NOW + t);
      const live = liveTypists(list, {
        channelId: CH,
        nowMs: NOW + t,
        isEligible: humansOnly,
      });
      if (live.length === 2) order.push(live.join(">"));
    }
    // 둘 다 살아 있는 매 시점에서 순서가 **같아야** 한다. 1차에서는 이 배열이
    // ["도현>민서", "민서>도현", "도현>민서", …] 로 번갈아 나왔다.
    expect(order.length).toBeGreaterThan(2);
    expect(new Set(order).size).toBe(1);
    expect(order[0]).toBe(`${DOHYUN}>${MINSEO}`);
  });

  /**
   * **정정된 서술 (B3M 폰 실측 → 코어 확인): 위상차는 필요 없다.**
   *
   * 첫 서술은 「1.5초 위상차를 두고 치면」이었는데, 정렬 키가 최근 발행 시각이면
   * **발행하는 순간 그 사람이 맨 뒤로** 가므로 조건이 아예 없다. 세 타이밍 전부에서
   * 1차 규칙은 순서를 뒤집었다 — 이 테스트는 셋 다 안정임을 요구한다.
   */
  it("holds the order for every timing relationship, not just an offset one", () => {
    const timings: Array<[string, Array<[string, number]>]> = [
      ["1.5s 위상차", [["A", 0], ["B", 1_500], ["A", 3_000], ["B", 4_500], ["A", 6_000]]],
      ["100ms 차", [["A", 0], ["B", 100], ["A", 3_000], ["B", 3_100], ["A", 6_000]]],
      ["완전 동시", [["A", 0], ["B", 0], ["A", 3_000], ["B", 3_000], ["A", 6_000]]],
    ];
    const idOf = (label: string) => (label === "A" ? DOHYUN : MINSEO);
    for (const [label, events] of timings) {
      let list: TypingSignal[] = [];
      const seen: string[] = [];
      for (const [who, t] of events) {
        list = republish(list, idOf(who), NOW + t);
        const live = liveTypists(list, {
          channelId: CH,
          nowMs: NOW + t,
          isEligible: humansOnly,
        });
        if (live.length === 2) seen.push(live.join(">"));
      }
      expect(seen.length, label).toBeGreaterThan(1);
      expect(new Set(seen).size, label).toBe(1);
    }
  });

  /**
   * 「먼저 시작한 사람이 계속 치면 계속 뒤로 밀린다」가 결함의 정확한 서술이었다.
   * 그 반대를 단정한다: 먼저 시작한 사람은 몇 번을 더 치든 앞에 남는다.
   */
  it("keeps the earlier starter first no matter how much they keep typing", () => {
    let list = republish([], DOHYUN, NOW);
    list = republish(list, MINSEO, NOW + 500);
    for (const t of [3_000, 6_000, 9_000, 12_000]) {
      list = republish(list, DOHYUN, NOW + t);
      expect(
        liveTypists(list, {
          channelId: CH,
          nowMs: NOW + t,
          isEligible: humansOnly,
        })[0]
      ).toBe(DOHYUN);
    }
  });

  it("keeps the first start time and moves only the expiry", () => {
    let list = republish([], DOHYUN, NOW);
    list = republish(list, DOHYUN, NOW + 3_000);
    expect(list).toHaveLength(1);
    expect(list[0].startedAtMs).toBe(NOW);
    expect(list[0].sentAtMs).toBe(NOW + 3_000);
    expect(list[0].expiresAtMs).toBe(NOW + 3_000 + TTL);
  });

  /**
   * 멈췄다 다시 시작하는 것은 **실제로 새 버스트**다. 만료로 명부에서 빠진 뒤의
   * 재등장은 새 엔트리이므로 새 시작 시각을 받아야 하고, 그러면 먼저 치고 있던
   * 사람 뒤에 선다.
   */
  it("gives a fresh start time to someone who stopped and came back", () => {
    let list = republish([], DOHYUN, NOW);
    list = republish(list, MINSEO, NOW + 1_000);
    // 이도현이 멈춘다 -> 만료 -> 청소
    list = pruneTypingSignals(list, NOW + TTL + 1);
    expect(list.map((s) => s.memberId)).toEqual([MINSEO]);
    // 다시 치기 시작한다: 이제 김민서 뒤다.
    list = republish(list, DOHYUN, NOW + TTL + 2);
    expect(
      liveTypists(list, {
        channelId: CH,
        nowMs: NOW + TTL + 2,
        isEligible: humansOnly,
      })
    ).toEqual([MINSEO, DOHYUN]);
  });

  /**
   * **수용 기준 밖의 추가분이고, 모바일(M2)이 알아야 하는 지점이다.**
   *
   * V8의 안정 정렬은 tie에서 삽입 순서를 지키는데, 삽입 순서는 프레임 도착 순서이고
   * 웹과 폰이 다를 수 있다. 그래서 tie를 member id로 가른다 — 화면 문장 단정을 쓰는
   * 쪽은 「같은 시작 시각이면 id 순」을 기대해야 하고 삽입 순서를 기대하면 안 된다.
   */
  it("breaks a start-time tie deterministically, not by arrival order", () => {
    const a = [
      signal({ memberId: MINSEO, startedAtMs: NOW }),
      signal({ memberId: DOHYUN, startedAtMs: NOW }),
    ];
    const b = [a[1], a[0]];
    const read = (list: TypingSignal[]) =>
      liveTypists(list, { channelId: CH, nowMs: NOW, isEligible: humansOnly });
    expect(read(a)).toEqual(read(b));

    // **결정적인 것만으로는 부족하다 — 어느 쪽으로 결정적인지를 못박는다** (#1065).
    //
    // 위 두 줄은 「도착 순서에 안 흔들린다」만 말한다. 그런데 이 tie를 실제로 읽는
    // 쪽(화면 문장 단정)은 **순서 그 자체**를 기대하고, 그 기대가 어디에도 적혀
    // 있지 않으면 픽스처 id가 우연히 정렬돼 초록인 테스트가 된다 — B3M의 M2 테스트가
    // 정확히 그 상태였다. 규칙은 **member id 오름차순**이다.
    expect(DOHYUN < MINSEO).toBe(true);
    expect(read(a)).toEqual([DOHYUN, MINSEO]);
  });

  /**
   * 같은 규칙을 문장 쪽에서 한 번 더. 이름이 아니라 **id**가 순서를 정한다는 것이
   * 요점이라, 이름 순서와 id 순서가 어긋나는 픽스처를 쓴다: 「지우」가 가나다순으로는
   * 앞이지만 id는 뒤(…104)이므로, 이름으로 정렬하는 구현은 여기서 걸린다.
   */
  it("spells the tie rule out in the sentence: id order, not name order", () => {
    const list = [
      signal({ memberId: JIWOO, startedAtMs: NOW }),
      signal({ memberId: DOHYUN, startedAtMs: NOW }),
    ];
    const names: Record<string, string> = {
      [DOHYUN]: "이도현",
      [JIWOO]: "박지우",
    };
    const ordered = liveTypists(list, {
      channelId: CH,
      nowMs: NOW,
      isEligible: humansOnly,
    }).map((id) => names[id]);
    expect(ordered).toEqual(["이도현", "박지우"]);
    expect(typingSentence(ordered)).toBe("이도현님, 박지우님이 작성 중…");
  });

  it("folds the mixed case the wire sends", () => {
    // 서버는 Swift `uuidString`으로 대문자 id를 보낸다; 명부의 id는 소문자다.
    const list = [signal({ memberId: DOHYUN.toUpperCase() })];
    expect(
      liveTypists(list, {
        channelId: CH.toUpperCase(),
        nowMs: NOW,
        myMemberId: ME,
        isEligible: humansOnly,
      })
    ).toHaveLength(1);
  });

  it("hides me even when my id arrives upper-cased", () => {
    const list = [signal({ memberId: ME.toUpperCase() })];
    expect(
      liveTypists(list, {
        channelId: CH,
        nowMs: NOW,
        myMemberId: ME,
        isEligible: humansOnly,
      })
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 문구
// ---------------------------------------------------------------------------

describe("typingSentence", () => {
  it("says nothing when nobody is typing", () => {
    expect(typingSentence([])).toBeNull();
    expect(typingLabel([])).toBeNull();
  });

  it("names one person", () => {
    expect(typingSentence(["이도현"])).toBe("이도현님이 작성 중…");
  });

  it("names two, which is the last count that fits a composer line", () => {
    expect(typingSentence(["이도현", "김민서"])).toBe(
      "이도현님, 김민서님이 작성 중…"
    );
  });

  it("collapses to a count at the server's threshold", () => {
    expect(typingSentence(["이도현", "김민서", "박지우"])).toBe("3명이 작성 중…");
  });

  it("uses the threshold the SERVER sent, not the mirror", () => {
    // grant 응답의 값이 언제나 이긴다. 서버가 2로 내리면 두 명부터 뭉친다.
    expect(typingSentence(["이도현", "김민서"], 2)).toBe("2명이 작성 중…");
    expect(typingSentence(["이도현"], 2)).toBe("이도현님이 작성 중…");
    // 4로 올리면 이름이 세 개까지 남는다.
    expect(typingSentence(["이도현", "김민서", "박지우"], 4)).toBe(
      "이도현님, 김민서님, 박지우님이 작성 중…"
    );
  });

  it("survives a nonsensical threshold rather than printing an empty name list", () => {
    for (const threshold of [0, 1, -3]) {
      expect(typingSentence(["이도현"], threshold)).toBe("이도현님이 작성 중…");
      expect(typingSentence(["이도현", "김민서"], threshold)).toBe(
        "2명이 작성 중…"
      );
    }
  });

  it("mirrors the server's threshold, and says so where it can drift", () => {
    expect(TYPING_AGGREGATE_THRESHOLD_FALLBACK).toBe(3);
  });

  it("hands the names out as their own segments (M-1)", () => {
    expect(typingSegments(["이도현"])).toEqual([
      { kind: "name", text: "이도현" },
      { kind: "plain", text: "님이 작성 중…" },
    ]);
    expect(typingSegments(["이도현", "김민서"])).toEqual([
      { kind: "name", text: "이도현" },
      { kind: "plain", text: "님, " },
      { kind: "name", text: "김민서" },
      { kind: "plain", text: "님이 작성 중…" },
    ]);
  });

  /**
   * N-1. 1차는 `join(", ")` 뒤에 님을 **한 번** 붙여 「이도현, 김민서님이」가 됐다 —
   * 존대가 마지막 사람에게만 간 문장이고, 같은 화면 위 채널 헤더는 나열에 님을 아예
   * 쓰지 않아 한 화면에 나열 규칙이 둘이었다. 통일은 「이름마다 님」 쪽이다(님을 떼면
   * 사람 줄의 유일한 낱말 표지가 사라진다 — 코어 독스트링).
   */
  it("puts 님 on every listed name, not only the last one (N-1)", () => {
    // 이름 개수 = 님 개수. 하나라도 맨이름으로 남으면 여기서 걸린다.
    for (const [names, threshold, count] of [
      [["이도현"], 3, 1],
      [["이도현", "김민서"], 3, 2],
      [["이도현", "김민서", "박지우"], 4, 3],
    ] as const) {
      const sentence = typingSentence([...names], threshold) ?? "";
      expect(sentence.match(/님/g)).toHaveLength(count);
    }
    // 집계 문구에는 이름이 없으므로 님도 없다.
    expect(typingSentence(["a", "b", "c"])).not.toContain("님");
  });

  /**
   * N-2. 집계 숫자는 2 → 3 → 4명으로 **바뀌는** 숫자다. 문자열 안에 녹아 있으면
   * 자릿폭 고정(`data-numeric`)을 걸 자리가 없어 줄이 미세하게 흔들린다.
   * 조각으로 빼되 **문장은 한 글자도 바뀌지 않는다**(아래 concat 단정이 그것을 잡는다).
   */
  it("hands the aggregate count out as its own segment (N-2)", () => {
    expect(typingSegments(["a", "b", "c"])).toEqual([
      { kind: "count", text: "3" },
      { kind: "plain", text: "명이 작성 중…" },
    ]);
    // 숫자 조각은 숫자만 든다 — 낱말이 섞이면 자릿폭 고정이 낱말까지 잡아 늘린다.
    const [count] = typingSegments(["a", "b", "c", "d"]);
    expect(count).toEqual({ kind: "count", text: "4" });
    expect(count.text).toMatch(/^\d+$/);
  });

  it("has no name segment in the collapsed form, because it names nobody", () => {
    expect(typingSegments(["a", "b", "c"]).some((s) => s.kind === "name")).toBe(
      false
    );
    expect(typingSegments([])).toEqual([]);
  });

  /**
   * M-3의 계약. 한국어는 동사가 끝에 오므로, 자리가 모자라 뒤가 잘리면 사라지는 것이
   * 하필 「작성 중」이고 남는 것은 이름 나열 + `…` — 집계 문구도 아니고 아무 말도 아닌
   * 문자열이다. 화면은 [`typingLead`]만 줄이고 꼬리는 줄이지 않는데, 그 방어는 **꼬리에
   * 언제나 동사가 있고 앞부분에는 없다**는 이 계약 위에 서 있다.
   *
   * 마지막 단정이 M-3의 나머지 절반이다: `…`가 꼬리에만 있으므로, 잘림이 만드는 `…`는
   * 언제나 **이름 안쪽**에 생긴다 — 그래야 잘린 줄과 온전한 줄이 구분된다.
   */
  it("always keeps the verb in the tail segment (M-3)", () => {
    for (const names of [
      ["이도현"],
      ["이도현", "김민서"],
      ["a", "b", "c"],
      ["a", "b", "c", "d", "e"],
    ]) {
      for (const threshold of [2, 3, 4]) {
        const segments = typingSegments(names, threshold);
        const tail = typingTail(segments);
        expect(tail?.kind).toBe("plain");
        expect(tail?.text).toContain("작성 중");
        for (const segment of typingLead(segments)) {
          expect(segment.text).not.toContain("작성 중");
          expect(segment.text).not.toContain("…");
        }
      }
    }
    expect(typingTail([])).toBeNull();
    expect(typingLead([])).toEqual([]);
  });

  /** 조각을 이어 붙이면 문장과 **정확히** 같아야 한다. 두 경로가 갈리면 화면과
   *  보조기술이 다른 문장을 말한다. */
  it("concatenates back into exactly the sentence", () => {
    for (const names of [
      ["이도현"],
      ["이도현", "김민서"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
      [],
    ]) {
      for (const threshold of [2, 3, 4]) {
        const joined = typingSegments(names, threshold)
          .map((segment) => segment.text)
          .join("");
        expect(joined).toBe(typingSentence(names, threshold) ?? "");
      }
    }
  });

  it("strips the ellipsis for assistive tech", () => {
    expect(typingLabel(["이도현"])).toBe("이도현님이 작성 중");
    expect(typingLabel([JIWOO, MINSEO, DOHYUN])).toBe("3명이 작성 중");
  });
});

// ---------------------------------------------------------------------------
// 와이어
// ---------------------------------------------------------------------------

describe("the ephemeral rail is its own namespace (가드 1)", () => {
  it("never collides with the durable channel name", () => {
    const typing = centrifugoTypingChannelName(WS, CH);
    expect(typing).toBe(`typing:ws${WS.toUpperCase()}.${CH.toUpperCase()}`);
    expect(typing).not.toBe(centrifugoChannelName(WS, CH));
    expect(typing.startsWith("ch:")).toBe(false);
    expect(typing.startsWith("dm:")).toBe(false);
  });

  it("uppercases ids like every other momo channel", () => {
    // 케이싱이 갈리면 레일은 조용히 비어 있고 어디에도 오류가 남지 않는다.
    expect(centrifugoTypingChannelName(WS.toLowerCase(), CH.toLowerCase())).toBe(
      centrifugoTypingChannelName(WS.toUpperCase(), CH.toUpperCase())
    );
  });
});

describe("asTypingFrame", () => {
  const good = {
    type: "ephemeral.typing",
    v: 1,
    ts: NOW,
    payload: {
      workspace_id: WS.toUpperCase(),
      channel_id: CH.toUpperCase(),
      member_id: DOHYUN.toUpperCase(),
      expires_at: NOW + TTL,
    },
  };

  it("accepts the frame the server actually publishes", () => {
    expect(asTypingFrame(good)).not.toBeNull();
  });

  /**
   * ADR-0149 가드 2의 클라 쪽 절반. 새 휘발 신호가 생기면 서버의 enum과 이 좁힘이
   * 함께 늘어야 하고, 그 둘이 리뷰에 걸리는 것이 가드의 전부다.
   */
  it("refuses every signal type v0 did not open", () => {
    for (const type of ["ephemeral.reading", "ephemeral.online", "message.new"]) {
      expect(asTypingFrame({ ...good, type })).toBeNull();
    }
  });

  it("refuses a frame with no expiry, which nothing could ever forget", () => {
    const { expires_at: _dropped, ...rest } = good.payload;
    expect(asTypingFrame({ ...good, payload: rest })).toBeNull();
    expect(
      asTypingFrame({ ...good, payload: { ...good.payload, expires_at: "soon" } })
    ).toBeNull();
  });

  it("refuses malformed ids and non-objects", () => {
    expect(
      asTypingFrame({ ...good, payload: { ...good.payload, member_id: 7 } })
    ).toBeNull();
    expect(asTypingFrame(null)).toBeNull();
    expect(asTypingFrame("ephemeral.typing")).toBeNull();
    expect(asTypingFrame({ type: "ephemeral.typing", v: 1, ts: NOW })).toBeNull();
  });

  /** 불변식 4 — 휘발 신호는 seq를 소비하지 않는다. 서버가 키를 아예 빼서 보낸다. */
  it("carries no seq to be mistaken for a gap", () => {
    const frame = asTypingFrame(good);
    expect(frame).not.toBeNull();
    expect((frame as unknown as Record<string, unknown>).seq).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 컴포저 키: 인용 취소와 겹치지 않는지 (W1과의 접점)
// ---------------------------------------------------------------------------

describe("Esc keeps one meaning per open thing", () => {
  const key = (over = {}) => ({
    key: "Escape",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    composing: false,
    ...over,
  });

  it("closes the mention list before it touches a pinned quote", () => {
    expect(
      composerKeyIntent(key(), {
        mentionsOpen: true,
        justComposed: false,
        enterSends: true,
        quoteOpen: true,
      })
    ).toBe("mention-close");
  });

  it("cancels the quote only when nothing else is open", () => {
    expect(
      composerKeyIntent(key(), {
        mentionsOpen: false,
        justComposed: false,
        enterSends: true,
        quoteOpen: true,
      })
    ).toBe("quote-cancel");
  });

  it("stays out of the way when there is nothing to close", () => {
    expect(
      composerKeyIntent(key(), {
        mentionsOpen: false,
        justComposed: false,
        enterSends: true,
      })
    ).toBe("pass");
  });

  it("never fights an IME", () => {
    expect(
      composerKeyIntent(key({ composing: true }), {
        mentionsOpen: false,
        justComposed: false,
        enterSends: true,
        quoteOpen: true,
      })
    ).toBe("pass");
  });
});
