import { describe, expect, it } from "vitest";
import {
  ApiError,
  huddleFromWire,
  type Huddle,
} from "@/lib/api";
import { asHuddleLifecycleFrame } from "@/lib/realtime";
import {
  huddleErrorCopy,
  huddleErrorKind,
  huddleParticipantSummary,
  initialHuddleProjection,
  reduceHuddleProjection,
} from "./huddleModel";

const ACTIVE: Huddle = {
  id: "00000000-0000-7000-8000-000000000643",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  channelId: "00000000-0000-7000-8000-000000000201",
  startedBy: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
  startedAtMs: 1_722_000_000_000,
  participants: [
    {
      memberId: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
      displayName: "곽성재",
      joinedAtMs: 1_722_000_001_000,
    },
    {
      memberId: "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90",
      displayName: "Nadia Rahman",
      joinedAtMs: 1_722_000_002_000,
    },
  ],
};

describe("huddle projection ordering", () => {
  it("does not resurrect a Live badge from an active response delayed past huddle_ended", () => {
    let state = initialHuddleProjection(ACTIVE.channelId);
    state = reduceHuddleProjection(state, {
      type: "load-started",
      requestId: 1,
    });
    state = reduceHuddleProjection(state, {
      type: "huddle-ended",
      huddleId: ACTIVE.id.toUpperCase(),
    });
    state = reduceHuddleProjection(state, {
      type: "load-succeeded",
      requestId: 1,
      huddle: ACTIVE,
    });

    expect(state.status).toBe("ready");
    expect(state.active).toBeNull();
  });

  it("lets the newest active request win when fixture timings are inverted", () => {
    let state = initialHuddleProjection(ACTIVE.channelId);
    state = reduceHuddleProjection(state, {
      type: "load-started",
      requestId: 1,
    });
    state = reduceHuddleProjection(state, {
      type: "load-started",
      requestId: 2,
    });
    state = reduceHuddleProjection(state, {
      type: "load-succeeded",
      requestId: 2,
      huddle: ACTIVE,
    });
    state = reduceHuddleProjection(state, {
      type: "load-succeeded",
      requestId: 1,
      huddle: null,
    });

    expect(state.active?.id).toBe(ACTIVE.id);
  });
});

describe("huddle wire parsing", () => {
  it("accepts the server DTO and preserves participant display names", () => {
    expect(huddleFromWire(ACTIVE)).toEqual(ACTIVE);
  });

  it.each([
    null,
    {},
    { ...ACTIVE, participants: null },
    { ...ACTIVE, participants: [{ memberId: 3 }] },
    { ...ACTIVE, startedAtMs: "yesterday" },
  ])("rejects malformed REST shapes: %j", (wire) => {
    expect(() => huddleFromWire(wire)).toThrow();
  });

  it("parses all three exact Core event names and rejects type inversions", () => {
    const base = {
      v: 1,
      ts: 1_722_000_003_000,
      payload: {
        huddle_id: ACTIVE.id,
        channel_id: ACTIVE.channelId,
        participant_member_ids: ACTIVE.participants.map(
          (participant) => participant.memberId
        ),
      },
    };
    for (const type of [
      "huddle_started",
      "huddle_participants_changed",
      "huddle_ended",
    ] as const) {
      expect(asHuddleLifecycleFrame({ ...base, type })?.type).toBe(type);
    }
    expect(
      asHuddleLifecycleFrame({
        ...base,
        type: "huddle_ended",
        payload: { ...base.payload, participant_member_ids: "none" },
      })
    ).toBeNull();
    expect(asHuddleLifecycleFrame({ ...base, type: "huddle.ended" })).toBeNull();
  });
});

describe("huddle user states", () => {
  it("treats 503 as operator configuration state, not a generic failure", () => {
    expect(huddleErrorKind(new ApiError(503, "허들 미구성"))).toBe(
      "unconfigured"
    );
    expect(huddleErrorCopy("unconfigured")).toContain("운영자가 LiveKit을 구성");
  });

  it("names microphone denial and expiry without hiding the next action", () => {
    expect(
      huddleErrorKind(new DOMException("Permission denied", "NotAllowedError"))
    ).toBe("microphone-denied");
    expect(huddleErrorCopy("microphone-denied")).toContain(
      "브라우저 설정에서 마이크를 허용"
    );
    expect(huddleErrorCopy("expired")).toContain("다시 참가");
  });

  it("keeps a dense participant summary while preserving mixed team names", () => {
    expect(huddleParticipantSummary(ACTIVE)).toBe("곽성재, Nadia Rahman");
    expect(
      huddleParticipantSummary({
        ...ACTIVE,
        participants: [
          ...ACTIVE.participants,
          {
            memberId: "third",
            displayName: "박지훈",
            joinedAtMs: 1_722_000_003_000,
          },
        ],
      })
    ).toBe("곽성재, Nadia Rahman 외 1명");
  });
});
