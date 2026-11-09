import { describe, expect, it } from "vitest";
import type { MessageNewEvent } from "../../lib/realtimeEvents";
import { catalog as enCatalog } from "../../i18n/generated/en-US";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageService } from "../../i18n/service";
import {
  admitThreadBanner,
  ANNOUNCED_CAP,
  armOpen,
  BODY_MAX,
  INVITE_LINK_KIND,
  inviteLinkNotificationText,
  EMPTY_THREAD_BANNER_LEDGER,
  notifiableKind,
  notificationBody,
  notifyDecision,
  windowIsFront,
  openTarget,
  OPEN_ARM_TTL_MS,
  rememberAnnounced,
  THREAD_BANNER_CAP,
  THREAD_BANNER_WINDOW_MS,
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
    actorFor: (id) => (id === AGENT ? "@hermes" : "구민수"),
    inviteLinkSentence: () => "사전의 고정 문장",
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

describe("승인 알림 문구: member.avatar.set (#4394)", () => {
  it("OS 배너는 서버가 정한 행동 이름을 말하고 원문 id 를 내지 않는다", () => {
    const decision = notifyDecision(
      event({
        type: "approval_request",
        author_member_id: AGENT,
        body: "승인 요청: 내 프로필 사진 바꾸기",
        props: {
          approval_id: "019F8338-025E-7873-93A3-C1FBA9149185",
          status: "pending",
          title: "내 프로필 사진 바꾸기",
          action: { id: "member.avatar.set", rows: [], required_role: "requesting_member" },
        },
      }),
      context()
    );
    expect(decision.show).toBe(true);
    if (!decision.show) return;
    expect(decision.notification.title).toBe("승인 필요 · @hermes");
    expect(decision.notification.body).toBe("내 프로필 사진 바꾸기");
    expect(JSON.stringify(decision.notification)).not.toContain("member.avatar.set");
  });
});

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
        title: "구민수",
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

  it("does not fire a mention this device turned off", () => {
    expect(
      notifyDecision(
        event(),
        context({ kindEnabled: (kind) => kind !== "mention" })
      )
    ).toEqual({ show: false, skip: "kind-disabled" });
  });

  it("does not fire an approval this device turned off", () => {
    expect(
      notifyDecision(
        event({
          type: "approval_request",
          author_member_id: AGENT,
          props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
        }),
        context({ kindEnabled: (kind) => kind !== "approval" })
      )
    ).toEqual({ show: false, skip: "kind-disabled" });
  });

  it("still fires the other kind when one is off", () => {
    const mention = notifyDecision(
      event(),
      context({ kindEnabled: (kind) => kind === "mention" })
    );
    expect(mention.show).toBe(true);
    if (mention.show) expect(mention.notification.kind).toBe("mention");

    const approval = notifyDecision(
      event({
        type: "approval_request",
        author_member_id: AGENT,
        props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
      }),
      context({ kindEnabled: (kind) => kind === "approval" })
    );
    expect(approval.show).toBe(true);
    if (approval.show) expect(approval.notification.kind).toBe("approval");
  });
});

// 서버의 알림 일시 중지(`notification_rule.dnd`)는 폰 푸시를 멈춘다. 같은 규칙이 이 기기의 OS 배너도
// 멈춰야 「알림도 함께 멈춰요」가 거짓이 아니다(#4197). 종류를 가리지 않는다: 멘션·승인·DM 모두다.
describe("notifyDecision: 알림 일시 중지 (#4197)", () => {
  const approvalEvent = () =>
    event({
      type: "approval_request",
      author_member_id: AGENT,
      props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
    });
  const dmEvent = () => event({ props: {}, body: "점심 먹었어요?" });

  it.each<[string, () => MessageNewEvent, Partial<NotifyContext>]>([
    ["멘션", () => event(), {}],
    ["승인 요청", approvalEvent, {}],
    ["DM", dmEvent, { isDirect: () => true }],
  ])("%s은(는) 일시 중지 중에 OS 배너가 되지 않는다", (_kind, make, extra) => {
    expect(notifyDecision(make(), context({ ...extra, paused: true }))).toEqual({
      show: false,
      skip: "paused",
    });
    // 같은 입력에서 일시 중지만 끄면 뜬다: 위 단정이 다른 규칙 때문에 통과한 것이 아니다.
    expect(notifyDecision(make(), context({ ...extra, paused: false })).show).toBe(true);
  });

  it("일시 중지가 채널 음소거·이 기기의 종류 스위치보다 먼저 판정된다 (ADR-0124 D5)", () => {
    expect(
      notifyDecision(
        event(),
        context({ paused: true, isMuted: () => true, kindEnabled: () => false })
      )
    ).toEqual({ show: false, skip: "paused" });
  });

  it("규칙을 읽지 못했으면(입력이 비어 있으면) 배너를 막지 않는다", () => {
    expect(notifyDecision(event(), context()).show).toBe(true);
    expect(notifyDecision(event(), context({ paused: undefined })).show).toBe(true);
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
        title: "승인 필요 · @hermes",
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
      actorFor: () => "구민수",
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
        title: "구민수",
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

describe("notifyDecision: DM kind and target visibility (#3339)", () => {
  const dm = (over: Partial<NotifyContext> = {}) =>
    context({ isDirect: () => true, ...over });

  it("a DM without a mention is the dm kind, and nothing else is", () => {
    const decision = notifyDecision(
      event({ props: {}, body: "점심 먹었어요?" }),
      dm()
    );
    expect(decision.show).toBe(true);
    if (decision.show) expect(decision.notification.kind).toBe("dm");
  });

  it("a system row in a DM is not a dm notification", () => {
    expect(
      notifyDecision(event({ props: {}, type: "system", body: "참여했어요" }), dm())
    ).toEqual({ show: false, skip: "not-notifiable" });
  });

  it("without isDirect an ordinary message is still silent", () => {
    expect(notifyDecision(event({ props: {} }), context())).toEqual({
      show: false,
      skip: "not-notifiable",
    });
  });

  it("a focused window that is looking at another channel still gets the banner", () => {
    const decision = notifyDecision(
      event(),
      context({ windowFocused: true, isTargetVisible: () => false })
    );
    expect(decision.show).toBe(true);
  });

  it("a focused window looking at the channel gets none", () => {
    expect(
      notifyDecision(
        event(),
        context({ windowFocused: true, isTargetVisible: () => true })
      )
    ).toEqual({ show: false, skip: "focused" });
  });
});

describe("windowIsFront (#3340)", () => {
  it("needs the tab visible AND focused", () => {
    expect(windowIsFront("visible", true)).toBe(true);
    expect(windowIsFront("visible", false)).toBe(false);
    expect(windowIsFront("hidden", true)).toBe(false);
    expect(windowIsFront(undefined, true)).toBe(false);
  });
});

describe("알림이 카드로 착지한다 (#3738)", () => {
  const CARD = "019F96A4-E717-7F82-9750-58B2D7D28226";
  const OTHER_CARD = "019F96A4-E717-7F82-9750-58B2D7D28299";

  it("같은 카드를 가리키는 무장은 그 카드로 착지한다", () => {
    const armed = armOpen(null, CHANNEL, NOW, undefined, CARD);
    expect(openTarget(armed, NOW + 1_000)).toBe(
      `/c/${encodeURIComponent(CHANNEL)}?msg=${CARD.toLowerCase()}`
    );
  });

  it("같은 채널의 다른 카드가 끼면 채널로 돌아간다 — 어느 카드인지 추측하지 않는다", () => {
    const armed = armOpen(
      armOpen(null, CHANNEL, NOW, undefined, CARD),
      CHANNEL,
      NOW + 500,
      undefined,
      OTHER_CARD
    );
    expect(openTarget(armed, NOW + 600)).toBe(`/c/${CHANNEL}`);
  });

  it("카드를 모르는 알림(멘션)이 끼어도 채널이다", () => {
    const armed = armOpen(
      armOpen(null, CHANNEL, NOW, undefined, CARD),
      CHANNEL,
      NOW + 500
    );
    expect(openTarget(armed, NOW + 600)).toBe(`/c/${CHANNEL}`);
  });
});

describe("사진만 보낸 DM·멘션의 배너 본문 (#4294)", () => {
  const wire = (n: number, mime = "image/jpeg") =>
    Array.from({ length: n }, (_, i) => ({ id: `att-${mime}-${i}`, name: `파일${i}`, mime, sizeBytes: 2048 }));
  const dm = (over: Partial<NotifyContext> = {}) =>
    context({ isDirect: () => true, actorFor: () => "서연", ...over });
  const shown = (decision: ReturnType<typeof notifyDecision>) => {
    expect(decision.show).toBe(true);
    if (!decision.show) throw new Error("expected a banner");
    return decision.notification;
  };

  it("글 없는 DM은 제목만 있는 배너가 아니라 「사진 1장」을 본문으로 한다", () => {
    const n = shown(notifyDecision(event({ props: {}, body: "", attachments: wire(1) }), dm()));
    expect(n).toMatchObject({ kind: "dm", title: "서연", body: "사진 1장" });
  });

  it("본문 키 자체가 null로 와도 같다 (서버는 빈 본문을 null로 싣는다)", () => {
    const n = shown(
      notifyDecision(event({ props: {}, body: null, attachments: wire(3) }), dm())
    );
    expect(n.body).toBe("사진 3장");
  });

  it("멘션도 파일만 있으면 개수로 말한다", () => {
    const n = shown(
      notifyDecision(event({ body: "", attachments: wire(2, "application/pdf") }), context())
    );
    expect(n).toMatchObject({ kind: "mention", body: "파일 2개" });
  });

  it("사진과 파일이 섞이면 사진이 먼저다", () => {
    const n = shown(
      notifyDecision(
        event({ props: {}, body: "", attachments: [...wire(1, "application/pdf"), ...wire(2)] }),
        dm()
      )
    );
    expect(n.body).toBe("사진 2장, 파일 1개");
  });

  it("글이 있으면 글이 이긴다", () => {
    const n = shown(
      notifyDecision(event({ props: {}, body: "회의 자료예요", attachments: wire(1) }), dm())
    );
    expect(n.body).toBe("회의 자료예요");
  });

  it("코드뿐인 글도 글이다: 「코드」가 첨부 문구보다 앞선다", () => {
    const n = shown(
      notifyDecision(event({ props: {}, body: "```\nls -la\n```", attachments: wire(1) }), dm())
    );
    expect(n.body).toBe("코드");
  });

  it("글도 첨부도 없으면 예전처럼 본문을 싣지 않는다", () => {
    const n = shown(notifyDecision(event({ props: {}, body: "" }), dm()));
    expect(n).not.toHaveProperty("body");
  });

  it("파일 이름은 배너에 싣지 않는다", () => {
    const n = shown(
      notifyDecision(
        event({ props: {}, body: "", attachments: [{ id: "a", name: "급여명세서-비공개.png", mime: "image/png", sizeBytes: 1 }] }),
        dm()
      )
    );
    expect(n.body).toBe("사진 1장");
    expect(JSON.stringify(n)).not.toContain("급여명세서");
  });
});

describe("도우미 초대 링크 메시지의 배너 문장 (#5025, ADR-0201 증보 v3 B4-2)", () => {
  const LINK = "https://oort.test/join?code=Ab3-_xQ7zK9";
  const PREVIEW = "초대 링크를 올렸어요";
  // 사전의 고정 문장은 호출자가 준다. 서버 문장과 **다른 값**을 줘서 어느 쪽이 쓰였는지 가린다.
  const FALLBACK = "링크 없는 고정 문장";
  const KIND = "team_ai_invite_link";
  const dm = (over: Partial<NotifyContext> = {}) =>
    context({ isDirect: () => true, actorFor: () => "도우미", inviteLinkSentence: () => FALLBACK, ...over });
  const banner = (payload: Partial<MessageNewEvent["payload"]>, ctx: NotifyContext = dm()) => {
    const decision = notifyDecision(event({ props: {}, ...payload }), ctx);
    expect(decision.show).toBe(true);
    if (!decision.show) throw new Error("expected a banner");
    // 어떤 경우에도 링크는 배너 문장에 없다.
    expect(JSON.stringify(decision.notification)).not.toContain("join?code");
    return decision.notification;
  };

  // 서버 본문은 「문장 + 줄바꿈 + 링크」라 첫 줄만 쓰는 지금 코드도 우연히 안전하다. 그 우연에 기대지 않게
  // 링크가 **첫 줄에 오는** 모양도 묶는다: 분기가 빠지면 이 두 줄이 빨개진다.
  it.each([
    ["서버가 보내는 그대로(문장, 링크)", `${PREVIEW}\n${LINK}`],
    ["링크가 첫 줄", `${LINK}\n${PREVIEW}`],
    ["한 줄에 문장과 링크", `${PREVIEW} ${LINK}`],
  ])("표지가 있으면 본문 모양과 무관하게 preview를 말한다: %s", (_name, body) => {
    const n = banner({ body, props: { kind: KIND, preview: PREVIEW } });
    expect(n).toMatchObject({ kind: "dm", title: "도우미", body: PREVIEW });
  });

  it.each([
    ["preview 없음", {}],
    ["빈 preview", { preview: "" }],
    ["공백뿐인 preview", { preview: "  \n " }],
    ["글자가 아닌 preview", { preview: 42 }],
  ])("preview를 못 쓰면 사전의 고정 문장으로 물러난다: %s", (_name, extra) => {
    const n = banner({ body: `${LINK}\n${PREVIEW}`, props: { kind: KIND, ...extra } });
    expect(n.body).toBe(FALLBACK);
  });

  it.each([
    ["링크 그대로", LINK],
    ["딥링크", "oort://join?code=Ab3-_xQ7zK9"],
    ["퍼센트 인코딩", "https://oort.test/join%3Fcode%3DAb3-_xQ7zK9"],
    ["문장에 섞인 링크", `${PREVIEW} ${LINK}`],
  ])("preview가 링크 모양이면 쓰지 않는다: %s", (_name, preview) => {
    const n = banner({ body: PREVIEW, props: { kind: KIND, preview } });
    expect(n.body).toBe(FALLBACK);
  });

  it("표지가 없는 메시지는 지금까지 그대로다: 본문 첫 줄, preview 칸이 있어도 다른 종류면 쓰지 않는다", () => {
    expect(banner({ body: "점심 먹었어요?\n메뉴는 비밀" }).body).toBe("점심 먹었어요?");
    const other = banner({
      body: "배포 끝났어요",
      props: { kind: "tool_result", preview: "다른 문장" },
    });
    expect(other.body).toBe("배포 끝났어요");
  });

  it("사전의 고정 문장은 ko·en 모두 있고, 링크 모양이 아니다 (스스로 preview 검사를 통과한다)", () => {
    for (const [locale, catalog] of [
      ["ko-KR", koCatalog],
      ["en-US", enCatalog],
    ] as const) {
      const sentence = createMessageService({ messageLocale: locale, catalog }).formatMessage(
        "notifications.inviteLink.fallback"
      );
      expect(sentence.trim()).not.toBe("");
      // 사전의 문장이 링크 모양이면 preview 검사가 이 값을 버린다 — 그러면 물러나는 자리의 문장이 곧 링크 모양이 된다.
      expect(
        inviteLinkNotificationText({ kind: INVITE_LINK_KIND, preview: sentence }, () => "물러남")
      ).toBe(sentence);
    }
  });

  it("멘션으로 가는 길에서도 같다: 채널의 멘션 배너도 preview를 말한다", () => {
    const n = banner(
      { body: `${LINK}\n${PREVIEW}`, props: { kind: KIND, preview: PREVIEW, mention_member_ids: [SELF] } },
      context({ inviteLinkSentence: () => FALLBACK })
    );
    expect(n).toMatchObject({ kind: "mention", body: PREVIEW });
  });
});

// =============================================================================
// 참여한 스레드의 새 답글 (#4890, ADR-0206 증보 1). 따라가는지는 서버가 알려 준 값을 `isFollowingThread` 로 받고, 이 모듈은
// 그것을 **맨 끝에서** 읽는다. 아래 셋은 사보타주 대상이다: 「내가 쓴 답글 제외」·「그 스레드를 보고 있으면 안 띄움」·「끈 종류 무시」.
// =============================================================================

describe("참여한 스레드의 새 답글 (#4890)", () => {
  const ROOT = "019F96A4-E717-7F82-9750-58B2D7D28100";
  const reply = (over: Partial<MessageNewEvent["payload"]> = {}) =>
    event({ root_id: ROOT, props: {}, body: "확인했어요", ...over });
  const follows = (value: boolean | undefined) => ({ isFollowingThread: () => value });
  const notOpen = { isThreadVisible: () => false };

  it("따라가는 스레드에 남이 쓴 답글은 배너가 된다 — 보낸 사람이 제목, 본문 한 줄", () => {
    const decision = notifyDecision(reply(), context({ ...follows(true), ...notOpen }));
    expect(decision).toMatchObject({
      show: true,
      notification: { kind: "thread-reply", channelId: CHANNEL, title: "구민수", body: "확인했어요" },
    });
  });

  it("에이전트가 쓴 글 답글도 남이 쓴 답글이다 — 보낸 사람이 @핸들로 나온다", () => {
    const decision = notifyDecision(
      reply({ author_member_id: AGENT }),
      context({ ...follows(true), ...notOpen })
    );
    expect(decision.show && decision.notification.title).toBe("@hermes");
  });

  it("서버가 따라가지 않는다고 했으면 not-followed, 아직 모르면 follow-unknown, 답을 줄 길이 없는 표면은 예전 그대로 not-notifiable", () => {
    expect(notifyDecision(reply(), context({ ...follows(false), ...notOpen }))).toEqual({
      show: false,
      skip: "not-followed",
    });
    expect(notifyDecision(reply(), context({ ...follows(undefined), ...notOpen }))).toEqual({
      show: false,
      skip: "follow-unknown",
    });
    expect(notifyDecision(reply(), context(notOpen))).toEqual({ show: false, skip: "not-notifiable" });
  });

  it("내가 쓴 답글은 따라가는 스레드여도 알리지 않는다 (사보타주: 이 제외를 빼면 RED)", () => {
    const decision = notifyDecision(
      reply({ author_member_id: SELF }),
      context({ ...follows(true), ...notOpen })
    );
    expect(decision).toEqual({ show: false, skip: "self" });
  });

  it("그 스레드를 보고 있으면(창이 앞이고 그 루트의 패널이 열려 있으면) 안 띄운다 (사보타주: 이 억제를 빼면 RED)", () => {
    const watching = context({ ...follows(true), windowFocused: true, isThreadVisible: (id) => id === ROOT });
    expect(notifyDecision(reply(), watching)).toEqual({ show: false, skip: "focused" });
    // 창이 뒤에 있으면 열려 있어도 안 보고 있는 것이다.
    expect(
      notifyDecision(reply(), { ...watching, windowFocused: false }).show
    ).toBe(true);
  });

  it("채널이 화면에 있어도 그 스레드 패널이 닫혀 있으면 본 것이 아니다 — 답글은 본류 목록의 줄이 아니다", () => {
    const channelOnly = context({
      ...follows(true),
      windowFocused: true,
      isTargetVisible: () => true,
      isThreadVisible: () => false,
    });
    expect(notifyDecision(reply(), channelOnly).show).toBe(true);
    // 다른 스레드가 열려 있는 것도 같다.
    expect(
      notifyDecision(reply(), { ...channelOnly, isThreadVisible: (id) => id === "다른 루트" }).show
    ).toBe(true);
  });

  it("옛날에 「대화에도 보내기」로 보낸 답글도 스레드에만 그려지므로 채널이 앞에 있어도 본 것이 아니다 (#5324)", () => {
    const channelOnly = context({
      ...follows(true),
      windowFocused: true,
      isTargetVisible: () => true,
      isThreadVisible: () => false,
    });
    // 서버 필드(`also_in_channel`)가 와도 화면은 본류에 그리지 않는다 — 배너가 이 답글을 알리는 유일한 길이다.
    expect(notifyDecision(reply({ also_in_channel: true }), channelOnly).show).toBe(true);
    // 그 스레드 패널이 열려 있으면 본 것이다(값과 무관).
    expect(
      notifyDecision(reply({ also_in_channel: true }), { ...channelOnly, isThreadVisible: (id) => id === ROOT })
    ).toEqual({ show: false, skip: "focused" });
  });

  it("이 기기에서 이 종류를 끄면 안 띄운다 — 다른 종류 스위치와 상관없다 (사보타주: 끔을 무시하면 RED)", () => {
    const off = context({
      ...follows(true),
      ...notOpen,
      kindEnabled: (kind) => kind !== "thread-reply",
    });
    expect(notifyDecision(reply(), off)).toEqual({ show: false, skip: "kind-disabled" });
    // 멘션은 같은 기기에서 그대로 온다.
    expect(
      notifyDecision(
        event({ root_id: ROOT }),
        context({ ...follows(false), ...notOpen, kindEnabled: (kind) => kind !== "thread-reply" })
      )
    ).toMatchObject({ show: true, notification: { kind: "mention" } });
  });

  it("알림 일시 중지·채널 음소거는 스레드 답글에도 선다", () => {
    expect(notifyDecision(reply(), context({ ...follows(true), ...notOpen, paused: true }))).toEqual({
      show: false,
      skip: "paused",
    });
    expect(notifyDecision(reply(), context({ ...follows(true), ...notOpen, isMuted: () => true }))).toEqual({
      show: false,
      skip: "muted",
    });
  });

  it("나를 멘션한 답글은 멘션이 이긴다 — 따라가는지 서버에 묻지도 않는다", () => {
    const asked: string[] = [];
    const decision = notifyDecision(
      event({ root_id: ROOT, props: { mention_member_ids: [SELF] } }),
      context({ ...notOpen, isFollowingThread: (id) => (asked.push(id), false) })
    );
    expect(decision).toMatchObject({ show: true, notification: { kind: "mention" } });
    expect(asked).toEqual([]);
  });

  it("진행 줄·삭제된 줄·DM은 스레드 답글 후보가 아니다", () => {
    expect(
      notifyDecision(reply({ type: "tool_call" }), context({ ...follows(true), ...notOpen }))
    ).toEqual({ show: false, skip: "not-notifiable" });
    expect(
      notifyDecision(reply({ state: "deleted" }), context({ ...follows(true), ...notOpen }))
    ).toEqual({ show: false, skip: "not-notifiable" });
    // DM 채널의 글은 `dm` 종류가 맡는다: 따라가기를 읽지 않는다.
    const asked: string[] = [];
    notifyDecision(
      reply(),
      context({ ...notOpen, isDirect: () => true, isFollowingThread: (id) => (asked.push(id), true) })
    );
    expect(asked).toEqual([]);
  });

  it("서버에 묻는 일은 다른 이유로 걸러질 글에는 나가지 않는다 — 걸러진 글마다 요청이 가지 않게", () => {
    const asked: string[] = [];
    const ask = { isFollowingThread: (id: string) => (asked.push(id), undefined) };
    notifyDecision(reply({ author_member_id: SELF }), context({ ...ask, ...notOpen }));
    notifyDecision(reply(), context({ ...ask, ...notOpen, paused: true }));
    notifyDecision(reply(), context({ ...ask, ...notOpen, isMuted: () => true }));
    notifyDecision(reply(), context({ ...ask, ...notOpen, kindEnabled: () => false }));
    notifyDecision(reply(), context({ ...ask, ...notOpen, isAnnounced: () => true }));
    notifyDecision(reply({ hlc_ts: NOW - 10 * 60_000 }), context({ ...ask, ...notOpen }));
    notifyDecision(reply(), context({ ...ask, windowFocused: true, isThreadVisible: () => true }));
    expect(asked).toEqual([]);
    // 걸러질 이유가 없으면 그때 한 번 묻는다.
    notifyDecision(reply(), context({ ...ask, ...notOpen }));
    expect(asked).toEqual([ROOT]);
  });
});

describe("같은 스레드의 답글 여럿은 그 스레드로 착지한다 (#5017)", () => {
  const ROOT = "019F96A4-E717-7F82-9750-58B2D7D28100";
  const OTHER_ROOT = "019F96A4-E717-7F82-9750-58B2D7D28101";
  const FIRST = "019F96A4-E717-7F82-9750-58B2D7D28201";
  const SECOND = "019F96A4-E717-7F82-9750-58B2D7D28202";
  const THIRD = "019F96A4-E717-7F82-9750-58B2D7D28203";

  it("같은 채널·같은 스레드의 다른 답글이 쌓이면 스레드(rootId)를 지키고 가장 늦은 답글을 기억한다 — 채널로 물러나지 않는다", () => {
    const armed = armOpen(
      armOpen(armOpen(null, CHANNEL, NOW, undefined, FIRST, ROOT), CHANNEL, NOW + 300, undefined, SECOND, ROOT.toLowerCase()),
      CHANNEL,
      NOW + 600,
      undefined,
      THIRD,
      ROOT
    );
    expect(armed).toMatchObject({ channelId: CHANNEL, messageId: THIRD, rootId: ROOT });
    expect(openTarget(armed, NOW + 700)).toBe(`/c/${encodeURIComponent(CHANNEL)}?msg=${THIRD.toLowerCase()}`);
  });

  it("스레드가 다르거나, 스레드가 아닌 알림(멘션)이 끼면 예전처럼 채널이다 — 어느 스레드인지 추측하지 않는다", () => {
    const first = armOpen(null, CHANNEL, NOW, undefined, FIRST, ROOT);
    const otherThread = armOpen(first, CHANNEL, NOW + 300, undefined, SECOND, OTHER_ROOT);
    expect(otherThread).toEqual({ channelId: CHANNEL, armedAtMs: NOW + 300 });
    expect(openTarget(otherThread, NOW + 400)).toBe(`/c/${CHANNEL}`);
    const mention = armOpen(first, CHANNEL, NOW + 300);
    expect(mention).toEqual({ channelId: CHANNEL, armedAtMs: NOW + 300 });
    // 스레드 알림이 먼저, 같은 스레드가 아닌 다른 채널이 끼면 둘 다 접힌다(멘션 인박스).
    expect(openTarget(armOpen(first, OTHER_CHANNEL, NOW + 300, undefined, SECOND, ROOT), NOW + 400)).toBe(
      "/inbox?filter=mentions"
    );
  });
});

describe("스레드 배너 상한 (#5017): 폰 푸시의 스레드당 분당 6건과 같은 값", () => {
  const ROOT = "019F96A4-E717-7F82-9750-58B2D7D28100";
  const OTHER_ROOT = "019F96A4-E717-7F82-9750-58B2D7D28101";

  it("값은 한 곳에 못 박혀 있다: 60초에 6건 (서버 `bulk.rs` 의 INDIVIDUAL_PER_WINDOW·WINDOW_SECONDS 와 같다)", () => {
    expect(THREAD_BANNER_CAP).toBe(6);
    expect(THREAD_BANNER_WINDOW_MS).toBe(60_000);
  });

  it("한 스레드는 상한까지만 허락하고 넘으면 거절한다. 다른 스레드는 따로 세고, 창이 지나면 다시 허락하며, 장부는 늘어나지 않는다", () => {
    let ledger = EMPTY_THREAD_BANNER_LEDGER;
    const admit = (root: string, at: number): boolean => {
      const verdict = admitThreadBanner(ledger, root, at);
      ledger = verdict.ledger;
      return verdict.admitted;
    };
    const first = Array.from({ length: 8 }, (_, n) => admit(ROOT, NOW + n * 1_000));
    expect(first).toEqual([true, true, true, true, true, true, false, false]);
    // 대소문자가 다른 같은 루트도 한 스레드다. 거절한 시도는 창을 밀지 않는다(시각을 적지 않는다).
    expect(admit(ROOT.toLowerCase(), NOW + 30_000)).toBe(false);
    // 다른 스레드의 첫 답글들은 이 스레드의 한도를 쓰지 않는다.
    expect(admit(OTHER_ROOT, NOW + 31_000)).toBe(true);
    // 첫 허락(NOW)에서 60초가 지난 뒤에는 그 자리가 비어 다시 한 건이 나간다(미끄러지는 창).
    expect(admit(ROOT, NOW + THREAD_BANNER_WINDOW_MS)).toBe(true);
    expect(admit(ROOT, NOW + THREAD_BANNER_WINDOW_MS + 1)).toBe(false);
    // 창 밖의 항목은 다음 판정에서 버려진다: 한참 뒤에는 장부에 지난 스레드가 남지 않는다.
    admit(OTHER_ROOT, NOW + 10 * THREAD_BANNER_WINDOW_MS);
    expect([...ledger.keys()]).toEqual([OTHER_ROOT.toLowerCase()]);
  });
});

// =============================================================================
// #5595 (ADR-0188 D5·D8): 맥 작업 세션의 권한 요청도 승인 배너다 — 세션 주인에게만.
// 줄의 모양은 서버가 세션 스레드에 남기는 System 메시지 그대로다(`work_sessions.rs` `validated_acp_event`,
// 미리보기는 빠지고 해시만 남는다). 세션 주인은 작성자가 아니라 서버 원장(`workSession`)이 말한다.
// =============================================================================

describe("작업 세션 권한 요청 → OS 배너 (#5595)", () => {
  const SESSION = "019F9A10-0000-7000-8000-0000000000A1";
  const ROOT = "019F9A10-0000-7000-8000-0000000000B1";
  const EVENT_ID = "019F9A10-0000-7000-8000-0000000000C1";
  const ALIAS = "00000000-0000-7000-8000-000000000104";

  function workEvent(
    overrides: { author?: string; options?: unknown[]; eventType?: string; type?: string; status?: string } = {}
  ): MessageNewEvent {
    return event({
      id: "019F9A10-0000-7000-8000-0000000000D1",
      type: overrides.type ?? "system",
      body: "Approval requested",
      author_member_id: overrides.author ?? SELF,
      root_id: ROOT,
      props: {
        kind: "work_session_event",
        schema: "momo.work_session.acp_event.v1",
        source: "acp",
        event_id: EVENT_ID,
        event_type: overrides.eventType ?? "approval.requested",
        event_ts: NOW,
        event: {
          run_id: SESSION,
          work_session_id: SESSION,
          channel_id: CHANNEL,
          action: "requested",
          action_type: "tool_call",
          status: overrides.status ?? "pending",
          options: overrides.options ?? [
            { option_id: "allow", name: "Allow once", kind: "allow_once" },
            { option_id: "reject", name: "Reject", kind: "reject_once" },
          ],
          preview_sha256: "a".repeat(64),
        },
      },
    });
  }

  const mine = { memberId: SELF, status: "running" as const, label: "UI 검수" };
  function workContext(overrides: Partial<NotifyContext> = {}): NotifyContext {
    return context({
      workSession: (id) => (id.toLowerCase() === SESSION.toLowerCase() ? mine : undefined),
      workPermissionTitle: () => "응답 필요",
      workPermissionSentence: (session) => `${session}: 맥에서 실행 허락을 기다려요`,
      ...overrides,
    });
  }

  it("세션 주인에게 승인 배너: 로컬 칸 배너와 같은 꼴(제목 「응답 필요」, 본문 「<세션 이름>: 맥에서 실행 허락을 기다려요」), 세션 id를 싣는다. 서버의 영어 본문·선택지 이름은 없다", () => {
    const decision = notifyDecision(workEvent(), workContext());
    expect(decision).toEqual({
      show: true,
      notification: {
        kind: "approval",
        messageId: "019F9A10-0000-7000-8000-0000000000D1",
        channelId: CHANNEL,
        title: "응답 필요",
        body: "UI 검수: 맥에서 실행 허락을 기다려요",
        workSessionId: SESSION,
        summaryLabel: "UI 검수",
        bannerGroup: "waiting",
      },
    });
    expect(JSON.stringify(decision)).not.toMatch(/Approval requested|Allow once|Reject/);
  });

  it("작성자가 나 자신이어도 알린다 — 세션은 별칭을 부르지 않았으면 주인의 이름으로 말한다(사보타주: self 제외를 넣으면 RED)", () => {
    expect(notifyDecision(workEvent({ author: SELF }), workContext()).show).toBe(true);
    // 별칭(에이전트)이 쓴 줄도 같다: 주인은 원장이 말한다.
    expect(notifyDecision(workEvent({ author: ALIAS }), workContext()).show).toBe(true);
  });

  it("세션 주인이 아니면 채널에 같이 있어도 알리지 않는다(ADR-0188 D3·D5) — 작성자가 나여도", () => {
    const teammates = { memberId: OTHER, status: "running" as const, label: "남의 작업" };
    for (const author of [SELF, OTHER, ALIAS]) {
      expect(notifyDecision(workEvent({ author }), workContext({ workSession: () => teammates })), author).toEqual({
        show: false,
        skip: "not-owner",
      });
    }
  });

  it("이 기기가 아직 모르는 세션은 owner-unknown(호출자가 원장을 읽고 다시 묻는다), 원장을 못 주는 표면은 평범한 줄", () => {
    expect(notifyDecision(workEvent(), workContext({ workSession: () => undefined }))).toEqual({
      show: false,
      skip: "owner-unknown",
    });
    // 브라우저 탭: 허락은 앱의 일이라(ADR-0146 D-4) 원장 입력이 없다. 예전처럼 알리지 않는다(작성자가 나면 self, 남이면 not-notifiable).
    expect(notifyDecision(workEvent({ author: OTHER }), context())).toEqual({ show: false, skip: "not-notifiable" });
    expect(notifyDecision(workEvent(), context()).show).toBe(false);
  });

  it("결정할 수 있는 선택지가 없거나, 요청이 아닌 세션 이벤트, System이 아닌 줄은 배너가 아니다", () => {
    const always = [{ option_id: "always", name: "Always allow", kind: "allow_always" }];
    expect(notifyDecision(workEvent({ author: OTHER, options: always }), workContext()).show).toBe(false);
    expect(notifyDecision(workEvent({ author: OTHER, eventType: "approval.decided" }), workContext()).show).toBe(false);
    expect(notifyDecision(workEvent({ author: OTHER, eventType: "agent.partial" }), workContext()).show).toBe(false);
    expect(notifyDecision(workEvent({ author: OTHER, type: "text" }), workContext()).show).toBe(false);
  });

  it("끝난 세션의 요청은 이미 취소됐다: 알리지 않는다", () => {
    for (const status of ["ended", "orphaned"] as const) {
      const closed = { ...mine, status };
      expect(notifyDecision(workEvent(), workContext({ workSession: () => closed })).show, status).toBe(false);
    }
    const idle = { ...mine, status: "idle" as const };
    expect(notifyDecision(workEvent(), workContext({ workSession: () => idle })).show).toBe(true);
  });

  it("기존 알림 설정을 그대로 따른다: 이 기기의 승인 스위치·알림 일시 중지·채널 음소거·재연결 재생·두 번째 도착", () => {
    expect(notifyDecision(workEvent(), workContext({ kindEnabled: (kind) => kind !== "approval" }))).toEqual({
      show: false,
      skip: "kind-disabled",
    });
    expect(notifyDecision(workEvent(), workContext({ kindEnabled: (kind) => kind !== "mention" })).show).toBe(true);
    expect(notifyDecision(workEvent(), workContext({ paused: true }))).toEqual({ show: false, skip: "paused" });
    expect(notifyDecision(workEvent(), workContext({ isMuted: () => true }))).toEqual({ show: false, skip: "muted" });
    expect(notifyDecision(workEvent(), workContext({ nowMs: NOW + 10 * 60_000 }))).toEqual({
      show: false,
      skip: "stale",
    });
    expect(notifyDecision(workEvent(), workContext({ isAnnounced: () => true }))).toEqual({
      show: false,
      skip: "duplicate",
    });
  });

  it("창이 앞이어도 그 세션의 카드(칸)가 안 보이면 알린다. 카드가 보이면 조용하다. 채널이 보이는 것은 카드가 아니다", () => {
    expect(
      notifyDecision(workEvent(), workContext({ windowFocused: true, isTargetVisible: () => true })).show
    ).toBe(true);
    expect(
      notifyDecision(
        workEvent(),
        workContext({ windowFocused: true, isWorkSessionVisible: (id) => id.toLowerCase() === SESSION.toLowerCase() })
      )
    ).toEqual({ show: false, skip: "focused" });
    expect(
      notifyDecision(workEvent(), workContext({ windowFocused: false, isWorkSessionVisible: () => true })).show
    ).toBe(true);
  });

  it("세션 이름이 비면 말한 이의 이름으로 말한다. 제목 사전이 없으면 이름이 제목이다", () => {
    const unnamed = { ...mine, label: "  " };
    const decision = notifyDecision(workEvent({ author: ALIAS }), workContext({ workSession: () => unnamed, actorFor: () => "@dohyun-claude" }));
    expect(decision.show && decision.notification.body).toBe("@dohyun-claude: 맥에서 실행 허락을 기다려요");
    expect(decision.show && decision.notification.summaryLabel).toBe("@dohyun-claude");
    const untitled = notifyDecision(workEvent(), workContext({ workPermissionTitle: undefined }));
    expect(untitled.show && untitled.notification.title).toBe("UI 검수");
  });
});
