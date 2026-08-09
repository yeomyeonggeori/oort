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
  eventKindDetail,
  eventKindLabel,
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
    expect(eventKindDetail("mention")).toContain("본문");
    expect(eventKindDetail("approval_request")).toContain("본문");
    expect(eventKindDetail("work.status_changed")).toContain(
      "메시지 본문은 들어 있지 않습니다"
    );
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
