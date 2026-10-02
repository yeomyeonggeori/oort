import { afterEach, describe, expect, it } from "vitest";
import type { MessageNewEvent } from "@momo/core/lib/realtimeEvents";
import type { NotifyContext } from "@momo/core/features/notifications/model";
import { notifyThisDevice } from "./deviceNotify";
import {
  reloadDesktopNotificationKindsForTest,
  setDesktopNotificationKind,
} from "./preference";

const NOW = 1_700_000_000_000;
const SELF = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-0000000005d1";
const AGENT = "00000000-0000-7000-8000-000000000103";
const CHANNEL = "00000000-0000-7000-8000-000000000201";

function mentionEvent(): MessageNewEvent {
  return {
    type: "message.new",
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
    },
  };
}

function approvalEvent(): MessageNewEvent {
  return {
    type: "message.new",
    v: 1,
    ts: NOW,
    seq: 43,
    payload: {
      id: "019F96A4-E717-7F82-9750-58B2D7D28226",
      channel_id: CHANNEL,
      seq: 43,
      type: "approval_request",
      body: "승인 요청",
      author_member_id: AGENT,
      hlc_ts: NOW,
      hlc_count: 0,
      props: { approval_id: "019F8338-025E-7873-93A3-C1FBA9149185" },
    },
  };
}

function context(): Omit<NotifyContext, "kindEnabled"> {
  return {
    isDesktop: true,
    windowFocused: false,
    selfMemberId: SELF,
    isMuted: () => false,
    isAnnounced: () => false,
    actorFor: () => "곽성재",
    nowMs: NOW,
  };
}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => reloadDesktopNotificationKindsForTest(null));

describe("notifyThisDevice", () => {
  it("does not fire a mention when that kind is off on this device", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("mention", false, storage);
    expect(notifyThisDevice(mentionEvent(), context())).toEqual({
      show: false,
      skip: "kind-disabled",
    });
  });

  it("does not fire an approval when that kind is off on this device", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("approval", false, storage);
    expect(notifyThisDevice(approvalEvent(), context())).toEqual({
      show: false,
      skip: "kind-disabled",
    });
  });

  it("still fires the other kind", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("mention", false, storage);
    const approval = notifyThisDevice(approvalEvent(), context());
    expect(approval.show).toBe(true);
    if (approval.show) expect(approval.notification.kind).toBe("approval");
  });

  // ---- #3339 ---------------------------------------------------------------
  function dmEvent(): MessageNewEvent {
    const e = mentionEvent();
    return {
      ...e,
      payload: { ...e.payload, props: {}, body: "점심 먹었어요?" },
    } as MessageNewEvent;
  }
  const dmContext = (over: Partial<Omit<NotifyContext, "kindEnabled">> = {}) => ({
    ...context(),
    isDirect: () => true,
    ...over,
  });

  it("새 DM은 기본으로 OS 알림이 가지 않는다(기본 끔)", () => {
    reloadDesktopNotificationKindsForTest(new MemoryStorage());
    expect(notifyThisDevice(dmEvent(), dmContext())).toEqual({
      show: false,
      skip: "kind-disabled",
    });
  });

  it("설정에서 켠 사람에게는 새 DM이 간다", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("dm", true, storage);
    const decision = notifyThisDevice(dmEvent(), dmContext());
    expect(decision.show).toBe(true);
    if (decision.show) expect(decision.notification.kind).toBe("dm");
  });

  it("창이 앞이고 그 DM이 화면에 보이면 켜도 알리지 않는다(포커스 억제)", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("dm", true, storage);
    expect(
      notifyThisDevice(dmEvent(), dmContext({ windowFocused: true, isTargetVisible: () => true }))
    ).toEqual({ show: false, skip: "focused" });
  });

  it("창이 앞이어도 그 DM이 화면에 없으면 알린다", () => {
    const storage = new MemoryStorage();
    reloadDesktopNotificationKindsForTest(storage);
    setDesktopNotificationKind("dm", true, storage);
    expect(
      notifyThisDevice(dmEvent(), dmContext({ windowFocused: true, isTargetVisible: () => false })).show
    ).toBe(true);
  });
});
