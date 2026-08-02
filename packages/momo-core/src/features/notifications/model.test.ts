import { describe, expect, it } from "vitest";
import type { MessageNewEvent } from "../../lib/realtimeEvents";
import {
  ANNOUNCED_CAP,
  armOpen,
  BODY_MAX,
  notifiableKind,
  notificationBody,
  notifyDecision,
  openTarget,
  OPEN_ARM_TTL_MS,
  rememberAnnounced,
  type NotifyContext,
} from "./model";
import type { Message } from "../../lib/api";

const NOW = 1_700_000_000_000;
const SELF = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-0000000005d1";
const AGENT = "00000000-0000-7000-8000-000000000103";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const OTHER_CHANNEL = "00000000-0000-7000-8000-000000000202";

function event(
  payload: Partial<MessageNewEvent["payload"]> = {},
  type: MessageNewEvent["type"] = "message.new"
): MessageNewEvent {
  return {
    type,
    v: 1,
    ts: NOW,
    seq: 42,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28225",
      channel_id: CHANNEL,
      seq: 42,
      type: "text",
      body: "@데모 사용자 배포 확인 부탁드립니다",
      author_member_id: OTHER,
      hlc_ts: NOW,
      hlc_count: 0,
      props: { mention_member_ids: [SELF] },
      ...payload,
    },
  };
}

function context(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    isDesktop: true,
    windowFocused: false,
    selfMemberId: SELF,
    isMuted: () => false,
    isAnnounced: () => false,
    actorFor: (id) => (id === AGENT ? "@hermes" : "곽성재"),
    nowMs: NOW,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "019F96A4-E717-7F82-9750-58B2D7D28225",
    channelId: CHANNEL,
    seq: 42,
    hlcTs: NOW,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: "text",
    body: "본문",
    createdAtMs: NOW,
    ...overrides,
  };
}

describe("notifiableKind", () => {
  it("reads the server's own mention decision, not the body text", () => {
    expect(
      notifiableKind(
        message({ body: "@데모 사용자", props: { mention_member_ids: [SELF] } }),
        SELF
      )
    ).toBe("mention");
    // The name is right there in the body and the server did NOT record it.
    expect(notifiableKind(message({ body: "@데모 사용자" }), SELF)).toBeNull();
  });

  it("matches mention ids case-insensitively (Swift upper / PG lower)", () => {
    expect(
      notifiableKind(
        message({ props: { mention_member_ids: [SELF.toUpperCase()] } }),
        SELF
      )
    ).toBe("mention");
  });

  it("counts an approval request only while it is still pending", () => {
    const pending = message({
      type: "approval_request",
      authorMemberId: AGENT,
      props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
    });
    expect(notifiableKind(pending, SELF)).toBe("approval");

    const decided = message({
      type: "approval_request",
      authorMemberId: AGENT,
      props: {
        approval_id: "019F8338-025E-7873-93A3-C1FBA9149185",
        approval_status: "approved",
      },
    });
    expect(notifiableKind(decided, SELF)).toBeNull();
  });

  it("says nothing about ordinary traffic or a tombstone", () => {
    expect(notifiableKind(message(), SELF)).toBeNull();
    expect(
      notifiableKind(
        message({ state: "deleted", props: { mention_member_ids: [SELF] } }),
        SELF
      )
    ).toBeNull();
  });
});

describe("notificationBody", () => {
  it("keeps the first line and drops the rest", () => {
    expect(notificationBody("첫 줄입니다\n둘째 줄입니다")).toBe("첫 줄입니다");
  });

  it("skips leading blank lines instead of returning nothing", () => {
    expect(notificationBody("\n\n  실제 내용  ")).toBe("실제 내용");
  });

  it("returns undefined when there is nothing to say", () => {
    expect(notificationBody(undefined)).toBeUndefined();
    expect(notificationBody("   \n  ")).toBeUndefined();
  });

  it("replaces code rather than quoting it", () => {
    expect(notificationBody("배포 명령은 `kubectl apply -f x.yaml` 입니다")).toBe(
      "배포 명령은 코드 입니다"
    );
    // The block goes; the sentence that explains it is what someone needs.
    expect(notificationBody("```\nexport TOKEN=abc\n```\n확인 부탁")).toBe(
      "확인 부탁"
    );
  });

  it("says 코드 when the message is nothing but code", () => {
    expect(notificationBody("```\nexport TOKEN=abcdef\n```")).toBe("코드");
    expect(notificationBody("`npm run build`")).toBe("코드");
  });

  it("redacts secret-shaped tokens", () => {
    expect(notificationBody("헤더에 Bearer abcdefgh12345678 넣으세요")).toBe(
      "헤더에 비공개 값 넣으세요"
    );
    expect(
      notificationBody("키는 sk-abcdefghijkl1234 입니다")
    ).toBe("키는 비공개 값 입니다");
    expect(
      notificationBody(
        "토큰 eyJhbGciOi.eyJzdWIiOj.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
      )
    ).toBe("토큰 비공개 값");
  });

  it("leaves ordinary prose, ids and urls alone", () => {
    const plain = "019f94e3-0e04-79cd-9dee-208f47edd9a8 채널 확인 부탁";
    expect(notificationBody(plain)).toBe(plain);
  });

  it("truncates to the banner budget with an ellipsis", () => {
    const body = notificationBody("가".repeat(200));
    expect(body).toHaveLength(BODY_MAX);
    expect(body?.endsWith("…")).toBe(true);
  });
});

describe("notifyDecision: suppression", () => {
  it("shows a mention when the window is in the background", () => {
    const decision = notifyDecision(event(), context());
    expect(decision).toEqual({
      show: true,
      notification: {
        kind: "mention",
        messageId: "019F96A4-E717-7F82-9750-58B2D7D28225",
        channelId: CHANNEL,
        title: "곽성재",
        body: "@데모 사용자 배포 확인 부탁드립니다",
      },
    });
  });

  it("does nothing in a browser", () => {
    expect(notifyDecision(event(), context({ isDesktop: false }))).toEqual({
      show: false,
      skip: "browser",
    });
  });

  it("stays silent while the window has focus", () => {
    expect(notifyDecision(event(), context({ windowFocused: true }))).toEqual({
      show: false,
      skip: "focused",
    });
  });

  it("ignores an edit of an already-delivered message", () => {
    expect(notifyDecision(event({}, "message.edited"), context())).toEqual({
      show: false,
      skip: "edited",
    });
  });

  it("ignores ordinary channel traffic", () => {
    expect(notifyDecision(event({ props: {} }), context())).toEqual({
      show: false,
      skip: "not-notifiable",
    });
  });

  it("does not announce one's own message back", () => {
    expect(
      notifyDecision(event({ author_member_id: SELF }), context())
    ).toEqual({ show: false, skip: "self" });
  });

  it("honours the server mute for the channel", () => {
    expect(
      notifyDecision(
        event(),
        context({ isMuted: (id) => id === CHANNEL })
      )
    ).toEqual({ show: false, skip: "muted" });
  });

  it("drops a replay that arrived long after the fact", () => {
    expect(
      notifyDecision(event({ hlc_ts: NOW - 600_000 }), context())
    ).toEqual({ show: false, skip: "stale" });
  });

  it("treats an unstamped event as live rather than as a replay", () => {
    const decision = notifyDecision(event({ hlc_ts: 0 }), context());
    expect(decision.show).toBe(true);
  });

  it("never announces the same message twice", () => {
    expect(
      notifyDecision(event(), context({ isAnnounced: () => true }))
    ).toEqual({ show: false, skip: "duplicate" });
  });
});

describe("notifyDecision: approval copy", () => {
  it("titles the agent and quotes the server's public approval title", () => {
    const decision = notifyDecision(
      event({
        type: "approval_request",
        author_member_id: AGENT,
        body: "승인 요청",
        props: {
          approval_id: "019F8338-025E-7873-93A3-C1FBA9149185",
          title: "스테이징에 배포",
          // Opaque payload the card model refuses to read; it must not leak
          // into a banner either.
          arguments: { command: "kubectl apply -f secret.yaml" },
        },
      }),
      context()
    );
    expect(decision).toEqual({
      show: true,
      notification: {
        kind: "approval",
        messageId: "019F96A4-E717-7F82-9750-58B2D7D28225",
        channelId: CHANNEL,
        title: "@hermes",
        body: "스테이징에 배포",
      },
    });
  });

  it("omits the body entirely when there is no copy to show", () => {
    const decision = notifyDecision(event({ body: null }), context());
    expect(decision.show).toBe(true);
    if (decision.show) expect("body" in decision.notification).toBe(false);
  });
});

// The two frames below are VERBATIM momowebqa publications, captured off the
// live Centrifugo rail on 2026-07-25 (MOMO-607 verification). They are here
// because three things this module depends on are only observable on the wire:
// `props` really does ride the broadcast (the relay forwards the API envelope
// as-is), member ids arrive UPPERCASE from Swift, and `created_at_ms` is NOT in
// the envelope at all — which is why staleness is judged on `hlc_ts`.
const LIVE_ORDINARY = {
  seq: 1,
  v: 1,
  ts: 1784962532045,
  type: "message.new",
  payload: {
    id: "019F980E-C2CF-718B-B86B-03AE305E9574",
    hlc_ts: 1784962532045,
    type: "text",
    root_id: null,
    body: "배포 로그는 여기에 있습니다",
    author_member_id: "00000000-0000-7000-8000-0000000005D1",
    channel_id: "019F9803-AFA6-7941-BA00-27BCF74C1228",
    seq: 1,
    hlc_count: 0,
  },
} as unknown as MessageNewEvent;

const LIVE_MENTION = {
  seq: 2,
  v: 1,
  ts: 1784962532068,
  type: "message.new",
  payload: {
    seq: 2,
    type: "text",
    author_member_id: "00000000-0000-7000-8000-0000000005D1",
    id: "019F980E-C2E5-70D9-9C43-7541DA39B4F2",
    channel_id: "019F9803-AFA6-7941-BA00-27BCF74C1228",
    root_id: null,
    hlc_count: 0,
    hlc_ts: 1784962532068,
    props: { mention_member_ids: ["00000000-0000-7000-8000-0000000005D2"] },
    body: "@intern-kim 스테이징 배포 확인 부탁드립니다",
  },
} as unknown as MessageNewEvent;

describe("live momowebqa frames", () => {
  const live = (overrides: Partial<NotifyContext> = {}) =>
    context({
      selfMemberId: "00000000-0000-7000-8000-0000000005d2",
      actorFor: () => "곽성재",
      nowMs: 1784962532068 + 1_000,
      ...overrides,
    });

  it("notifies for the mention the server actually recorded", () => {
    expect(notifyDecision(LIVE_MENTION, live())).toEqual({
      show: true,
      notification: {
        kind: "mention",
        messageId: "019F980E-C2E5-70D9-9C43-7541DA39B4F2",
        channelId: "019F9803-AFA6-7941-BA00-27BCF74C1228",
        title: "곽성재",
        body: "@intern-kim 스테이징 배포 확인 부탁드립니다",
      },
    });
  });

  it("stays silent for the ordinary line sent one frame earlier", () => {
    expect(notifyDecision(LIVE_ORDINARY, live())).toEqual({
      show: false,
      skip: "not-notifiable",
    });
  });

  it("suppresses the same mention while the window is in front", () => {
    expect(
      notifyDecision(LIVE_MENTION, live({ windowFocused: true }))
    ).toEqual({ show: false, skip: "focused" });
  });
});

describe("rememberAnnounced", () => {
  it("appends without duplicating", () => {
    const once = rememberAnnounced([], "a");
    expect(rememberAnnounced(once, "a")).toEqual(["a"]);
    expect(rememberAnnounced(once, "b")).toEqual(["a", "b"]);
  });

  it("does not mutate the list it was given", () => {
    const original = ["a"];
    rememberAnnounced(original, "b");
    expect(original).toEqual(["a"]);
  });

  it("drops the oldest id past the cap", () => {
    let announced: string[] = [];
    for (let i = 0; i < ANNOUNCED_CAP + 5; i += 1) {
      announced = rememberAnnounced(announced, `m${i}`);
    }
    expect(announced).toHaveLength(ANNOUNCED_CAP);
    expect(announced[0]).toBe("m5");
    expect(announced.at(-1)).toBe(`m${ANNOUNCED_CAP + 4}`);
  });
});

describe("click landing", () => {
  it("lands on the channel a single notification pointed at", () => {
    const armed = armOpen(null, CHANNEL, NOW);
    expect(openTarget(armed, NOW + 1_000)).toBe(`/c/${CHANNEL}`);
  });

  it("keeps the channel when the same one notifies twice", () => {
    const armed = armOpen(armOpen(null, CHANNEL, NOW), CHANNEL, NOW + 500);
    expect(openTarget(armed, NOW + 600)).toBe(`/c/${CHANNEL}`);
  });

  it("falls back to the mentions inbox when two channels disagree", () => {
    const armed = armOpen(armOpen(null, CHANNEL, NOW), OTHER_CHANNEL, NOW + 500);
    expect(openTarget(armed, NOW + 600)).toBe("/inbox?filter=mentions");
  });

  it("re-arms cleanly once the previous arm expired", () => {
    const stale = armOpen(null, CHANNEL, NOW);
    const fresh = armOpen(stale, OTHER_CHANNEL, NOW + OPEN_ARM_TTL_MS + 1);
    expect(openTarget(fresh, NOW + OPEN_ARM_TTL_MS + 2)).toBe(
      `/c/${OTHER_CHANNEL}`
    );
  });

  it("expires, so a later focus is not hijacked", () => {
    const armed = armOpen(null, CHANNEL, NOW);
    expect(openTarget(armed, NOW + OPEN_ARM_TTL_MS + 1)).toBeNull();
    expect(openTarget(null, NOW)).toBeNull();
  });
});
