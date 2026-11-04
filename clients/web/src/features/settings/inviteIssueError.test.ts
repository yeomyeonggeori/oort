import { describe, expect, it } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { ERROR_MESSAGE_UNREACHABLE } from "@momo/core/features/settings/model";
import { INVITE_ISSUE_ERROR, inviteIssueErrorCopy } from "./inviteIssueError";

// #5221: 초대 링크를 만들지 못했을 때 화면은 서버의 영어 문장을 말하지 않는다. 이 화면의 안내(무엇이 안 됐고 어디서 다시 하는지)가
// 문장이고, 서버가 답한 상태는 진단용 보조(detail)로만 남는다. 응답이 없던 실패는 분류 문장이다.

describe("inviteIssueErrorCopy", () => {
  // 지키는 것: 서버가 준 문장(영어 검증 문장·내부 사정)은 어떤 상태에서도 문장으로 나가지 않는다.
  it("서버가 답한 거절은 서버의 문장이 아니라 이 화면의 안내를 말하고 상태는 보조로만 남긴다", () => {
    for (const [status, wire] of [
      [400, "maxUses must be between 1 and 100"],
      [403, "forbidden: only owners can invite"],
      [429, "too many invites"],
      [503, "HTTP 503"],
    ] as const) {
      const copy = inviteIssueErrorCopy(new ApiError(status, wire));
      expect(copy.message).toBe(INVITE_ISSUE_ERROR);
      expect(copy.message).not.toContain(wire === "HTTP 503" ? "HTTP" : wire);
      expect(copy.detail).toBe(wire === "HTTP 503" ? "HTTP 503" : `HTTP ${status}`);
    }
  });

  // 지키는 것: 응답이 없던 실패는 닫힌 분류 문장이다.
  it("응답이 없던 실패는 서버에 닿지 못함 문장이다", () => {
    expect(inviteIssueErrorCopy(new NetworkError("unreachable", 15_000))).toEqual({
      message: ERROR_MESSAGE_UNREACHABLE,
      detail: undefined,
    });
  });

  // 지키는 것: 게스트 초대 멈춤은 사전 키로 말한다(서버 영어가 아니다).
  it("게스트 초대가 멈춰 있으면 사전 키로 말한다", () => {
    expect(inviteIssueErrorCopy(new ApiError(400, "guest invites are paused", "guest_invites_paused"))).toEqual({
      key: "settings.invite.guestInvitesPaused",
    });
  });
});
