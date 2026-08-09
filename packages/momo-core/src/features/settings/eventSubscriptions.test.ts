import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import {
  DESTINATION_MAX_LENGTH,
  EVENT_SUBSCRIPTION_KINDS,
  UNVERIFIED_CREATE_MESSAGE,
  deliveryFailureLine,
  destinationError,
  destinationProblem,
  disabledReasonLine,
  eventKindLabel,
  eventKindPayload,
  eventKindsLabel,
  eventSubscriptionErrorMessage,
  eventSubscriptionState,
  eventSubscriptionStatus,
  isEventSubscriptionKind,
  normalizeDestination,
  sortEventSubscriptions,
  type EventSubscription,
} from "./eventSubscriptions";

const WORKSPACE = "019f94e3-0000-7000-8000-000000000001";

function row(overrides: Partial<EventSubscription> = {}): EventSubscription {
  return {
    id: "019f94e3-1111-7000-8000-000000000001",
    workspaceId: WORKSPACE,
    url: "https://hooks.example.com/oort",
    eventKinds: ["mention"],
    enabled: true,
    deliveryFailureCount: 0,
    createdAtMs: 1_770_000_000_000,
    updatedAtMs: 1_770_000_000_000,
    ...overrides,
  };
}

describe("destination validation", () => {
  it("accepts a public https destination and trims it", () => {
    expect(normalizeDestination("  https://hooks.example.com/oort  ")).toBe(
      "https://hooks.example.com/oort"
    );
    expect(destinationError("https://hooks.example.com/oort")).toBeNull();
  });

  it("keeps http, which the server accepts outside production", () => {
    // The client must not invent a gate the server does not have: the SSRF and
    // https-in-production rules are server-side, and refusing http here would
    // block a self-hosted staging destination the server would have taken.
    expect(destinationProblem("http://hooks.internal.example/oort")).toBeNull();
  });

  /**
   * RED PROOF 1 — credentials in the destination.
   *
   * `new URL("https://svc:s3cr3t@hooks.example.com/oort")` parses happily, so a
   * validator built on parse-success alone stores a third-party password in a
   * plaintext column and then PRINTS it in the subscription list, on the one
   * panel whose entire discipline is that secrets are shown once and never
   * again. Deleting the `username || password` branch in `destinationProblem`
   * makes exactly this assertion fail.
   */
  it("refuses a destination carrying an embedded credential", () => {
    expect(destinationProblem("https://svc:s3cr3t@hooks.example.com/oort")).toBe(
      "credentials"
    );
    expect(destinationProblem("https://svc@hooks.example.com/oort")).toBe(
      "credentials"
    );
    expect(normalizeDestination("https://svc:s3cr3t@hooks.example.com/oort")).toBeNull();
    expect(destinationError("https://svc:s3cr3t@hooks.example.com/oort")).toContain(
      "서명 비밀"
    );
  });

  it("refuses a fragment, a foreign scheme, an empty draft and an over-long one", () => {
    expect(destinationProblem("https://hooks.example.com/oort#tail")).toBe("fragment");
    expect(destinationProblem("ftp://hooks.example.com/oort")).toBe("scheme");
    expect(destinationProblem("javascript:alert(1)")).toBe("scheme");
    expect(destinationProblem("   ")).toBe("empty");
    expect(destinationProblem("hooks.example.com/oort")).toBe("unparsable");
    const long = `https://hooks.example.com/${"a".repeat(DESTINATION_MAX_LENGTH)}`;
    expect(destinationProblem(long)).toBe("too_long");
  });

  it("measures length in bytes, not code points", () => {
    // The column check is `length(url) BETWEEN 1 AND 2048` on a text column, and
    // a Korean path segment is 3 bytes per syllable. Counting characters would
    // let a draft through that the server refuses with a 400.
    const korean = `https://hooks.example.com/${"경".repeat(700)}`;
    expect(korean.length).toBeLessThan(DESTINATION_MAX_LENGTH);
    expect(destinationProblem(korean)).toBe("too_long");
  });

  /**
   * RED PROOF 3 (corrected, design review #1203 M4) — the gate was already
   * right and the SENTENCE was wrong.
   *
   * `destinationProblem` measures bytes because the column and the server do
   * (`value.utf8.count`), and the original proof for that still stands above.
   * What nothing asserted was the copy: it said "2048자", so a Korean path that
   * is 683 characters long got refused by a rule about characters. In a
   * codebase where mixed Korean and English is the default the two units are
   * three times apart, and a limit stated in the wrong unit is not a limit
   * anyone can plan against. Putting "자" back in this message fails here.
   */
  it("states the length limit in the unit it actually measures", () => {
    const korean = `https://hooks.example.com/${"경".repeat(700)}`;
    const message = destinationError(korean);
    expect(message).toContain(`${DESTINATION_MAX_LENGTH}바이트`);
    expect(message).not.toContain(`${DESTINATION_MAX_LENGTH}자`);
    // And it says why 683 자 tripped a 2048 limit, rather than leaving that a
    // surprise the reader has to reverse-engineer.
    expect(message).toContain("3바이트");
  });

  it("gives every problem its own next step", () => {
    const messages = [
      "",
      "hooks.example.com",
      "ftp://hooks.example.com",
      "https://a:b@hooks.example.com",
      "https://hooks.example.com/#x",
    ].map((raw) => destinationError(raw));
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).toBeTruthy();
  });
});

describe("subscription state", () => {
  /**
   * RED PROOF 2 — a row that is off with no reason recorded.
   *
   * The wire makes `disabledReason` optional, and the disable check only
   * requires `NOT enabled`. A mapping that treats "not enabled" as "an admin
   * turned it off" (the obvious two-branch version) tells an operator a person
   * did this, sending them to look for who instead of re-enabling or deleting.
   * Collapsing the default branch of `eventSubscriptionState` into
   * `disabled_by_admin` fails this test and nothing else.
   */
  it("does not blame an admin for a stop nobody recorded", () => {
    expect(eventSubscriptionState(row({ enabled: false }))).toBe("needs_review");
    expect(eventSubscriptionStatus(row({ enabled: false }))).toEqual({
      tone: "danger",
      label: "상태 확인 필요",
    });
    expect(disabledReasonLine(row({ enabled: false }))).toContain("기록되지 않았습니다");

    // An unknown future reason lands in the same honest bucket, not in a
    // silently wrong one.
    const future = row({ enabled: false, disabledReason: "destination_gone" });
    expect(eventSubscriptionState(future)).toBe("needs_review");
  });

  it("separates the admin stop from the automatic one", () => {
    const admin = row({ enabled: false, disabledReason: "disabled_by_admin" });
    const auto = row({
      enabled: false,
      disabledReason: "server_5xx_threshold",
      deliveryFailureCount: 3,
    });
    expect(eventSubscriptionStatus(admin)).toEqual({ tone: "muted", label: "관리자 중지" });
    expect(eventSubscriptionStatus(auto)).toEqual({ tone: "warn", label: "자동 중지" });
    expect(disabledReasonLine(auto)).toContain("0으로 돌아갑니다");
    expect(eventSubscriptionStatus(row())).toEqual({ tone: "ok", label: "사용 중" });
    expect(disabledReasonLine(row())).toBeNull();
  });

  it("states a failure streak only when there is one", () => {
    expect(deliveryFailureLine(0)).toBeNull();
    expect(deliveryFailureLine(3)).toBe("연속 전송 실패 3회");
  });

  it("orders newest first and holds still on a tie", () => {
    const a = row({ id: "aaa", createdAtMs: 5 });
    const b = row({ id: "bbb", createdAtMs: 9 });
    const c = row({ id: "ccc", createdAtMs: 5 });
    expect(sortEventSubscriptions([a, b, c]).map((r) => r.id)).toEqual([
      "bbb",
      "aaa",
      "ccc",
    ]);
    // Pure: the caller's array is not reordered under it.
    expect([a, b, c].map((r) => r.id)).toEqual(["aaa", "bbb", "ccc"]);
  });
});

describe("event kinds", () => {
  it("names the three the server accepts", () => {
    expect([...EVENT_SUBSCRIPTION_KINDS]).toEqual([
      "mention",
      "approval_request",
      "work.status_changed",
    ]);
    expect(eventKindsLabel(["mention", "work.status_changed"])).toBe(
      "멘션 · 작업 상태 변경"
    );
    expect(isEventSubscriptionKind("mention")).toBe(true);
    expect(isEventSubscriptionKind("channel.created")).toBe(false);
  });

  /**
   * A kind this build does not know still has to reach the screen: this panel
   * exists to say what leaves the workspace, and a label that dropped the
   * unknown entry would understate exactly that.
   */
  it("renders an unknown kind as itself rather than dropping it", () => {
    expect(eventKindLabel("channel.created")).toBe("channel.created");
    expect(eventKindsLabel(["mention", "channel.created"])).toBe(
      "멘션 · channel.created"
    );
  });

  it("says which events carry the message body", () => {
    expect(eventKindPayload("mention").content).toContain("본문");
    expect(eventKindPayload("approval_request").content).toContain("본문");
    expect(eventKindPayload("work.status_changed").content).toContain(
      "메시지 본문은 들어 있지 않습니다"
    );
  });

  /**
   * RED PROOF 4 (design review #1203 H1) — an enumeration is read as a complete
   * list, so an incomplete one in a complete list's grammar lies.
   *
   * Two ways the first version got this wrong, both of which this test catches:
   * `mention_member_ids` — who was mentioned, the most personal field after the
   * body itself — was on the wire and not in the sentence; and 멘션 named
   * 채널/작성자 while 승인 요청 stayed silent about the identical fields, which
   * reads as "승인 요청 does not send those".
   *
   * Dropping the mention clause, or letting one kind describe its identifiers
   * while another does not, fails here and nowhere else.
   */
  it("names every field the trigger puts on the wire, in one grammar", () => {
    const mention = eventKindPayload("mention");
    const approval = eventKindPayload("approval_request");
    const work = eventKindPayload("work.status_changed");

    // 033_event_subscription.sql: both message projections carry the mention
    // list — `mention_member_ids` directly, `props` as the whole bag.
    expect(mention.content).toContain("멘션된 멤버 ID");
    expect(approval.content).toContain("멘션된 멤버 ID");

    // The same identifiers, named by both, in the same clause shape.
    for (const payload of [mention, approval]) {
      expect(payload.identifiers).toContain("채널");
      expect(payload.identifiers).toContain("작성자");
      expect(payload.identifiers).toContain("순번");
    }

    // No kind gets to skip the identifier clause: silence is what made the two
    // message kinds read as if they sent different things.
    for (const kind of EVENT_SUBSCRIPTION_KINDS) {
      const payload = eventKindPayload(kind);
      expect(payload.content).toMatch(/나갑니다\./);
      expect(payload.identifiers).toMatch(/ID.*함께 붙습니다\.$/);
    }

    // 작업 상태 변경 says its own full set, message body explicitly excluded.
    for (const fact of ["도구 이름", "종료 코드", "종료 사유", "시작·끝 시각"]) {
      expect(work.content).toContain(fact);
    }
    // 12/12, not 11/12: `resumed_from_session_id` rides along too (R2 N-R1).
    for (const id of ["작업 세션", "이어받은 세션", "채널", "스레드", "멤버"]) {
      expect(work.identifiers).toContain(id);
    }
  });
});

describe("failure copy", () => {
  it("names the action and the next move for every status", () => {
    expect(eventSubscriptionErrorMessage("load", new ApiError(403, "nope"))).toContain(
      "오너나 관리자"
    );
    expect(eventSubscriptionErrorMessage("delete", new ApiError(404, "gone"))).toBe(
      "구독을 지우지 못했습니다. 이 구독은 이미 바뀌었거나 지워졌습니다. 목록을 다시 불러오세요."
    );
    expect(eventSubscriptionErrorMessage("create", new ApiError(400, "bad"))).toContain(
      "공개 https"
    );
    expect(eventSubscriptionErrorMessage("enable", new ApiError(429, "slow"))).toContain(
      "잠시 뒤에"
    );
  });

  it("never leaks the wire message from a mapped status", () => {
    const wire = "event subscriptions require a human admin";
    expect(eventSubscriptionErrorMessage("create", new ApiError(403, wire))).not.toContain(
      wire
    );
  });

  /**
   * A create that answered 2xx with a body this client could not verify is not
   * "try again": the row may exist and its signing secret is already gone for
   * good, so the sentence has to say to reconcile the list first.
   */
  it("treats an unverifiable create as its own outcome", () => {
    expect(eventSubscriptionErrorMessage("create", new WireShapeError())).toBe(
      UNVERIFIED_CREATE_MESSAGE
    );
    expect(eventSubscriptionErrorMessage("create", new WireShapeError())).toContain(
      "다시 받을 수 없으니"
    );
    // Every other action keeps the plain reload instruction.
    expect(eventSubscriptionErrorMessage("load", new WireShapeError())).toContain(
      "목록을 다시 불러오세요"
    );
  });

  it("passes a network failure's own Korean copy through", () => {
    const network = new Error("서버에 닿지 못했습니다. 주소와 네트워크를 확인하고 다시 시도하세요.");
    expect(eventSubscriptionErrorMessage("load", network)).toContain("닿지 못했습니다");
  });
});
