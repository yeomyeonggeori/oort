import { describe, expect, it } from "vitest";

import type { RosterMember } from "../../lib/api";
import {
  avatarCarriesIdentityColor,
  avatarIdentity,
  avatarInitial,
  renderableAvatarUrl,
  AVATAR_SHAPE,
  AVATAR_SIZE,
} from "./avatar";

// =============================================================================
// 아바타 계약 (chat-ui-audit H-11)
// =============================================================================

const ORIGIN = "https://app.momo.dev";

function member(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe("renderableAvatarUrl — CSP가 실을 수 있는 것만", () => {
  it("같은 오리진의 경로는 통과한다", () => {
    expect(renderableAvatarUrl("/v1/media/avatars/a.png", ORIGIN)).toBe(
      "/v1/media/avatars/a.png"
    );
    // 오리진을 몰라도 상대 경로는 정의상 'self' 다.
    expect(renderableAvatarUrl("/a.png")).toBe("/a.png");
  });

  it("data:image 는 통과한다 — 헤더가 명시적으로 허용한다", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(renderableAvatarUrl(data)).toBe(data);
    expect(renderableAvatarUrl("data:text/html,<b>x</b>")).toBeNull();
  });

  it("다른 오리진은 막는다 — 브라우저가 조용히 거절하고 깨진 상자가 남는다", () => {
    expect(renderableAvatarUrl("https://cdn.example/a.png", ORIGIN)).toBeNull();
    // 오리진을 모르면 절대 주소는 전부 막힌다: 모르면 안 연다.
    expect(renderableAvatarUrl(`${ORIGIN}/a.png`)).toBeNull();
    expect(renderableAvatarUrl(`${ORIGIN}/a.png`, ORIGIN)).toBe(
      `${ORIGIN}/a.png`
    );
  });

  /**
   * 이 두 줄이 없으면 `startsWith("/")` 나 `startsWith(origin)` 이 통과시킨다 —
   * 둘 다 다른 오리진인데도.
   */
  it("프로토콜 상대 주소와 접두가 겹치는 오리진을 막는다", () => {
    expect(renderableAvatarUrl("//cdn.example/a.png", ORIGIN)).toBeNull();
    expect(
      renderableAvatarUrl("https://app.momo.dev.evil.test/a.png", ORIGIN)
    ).toBeNull();
  });

  it("스킴이 이미지가 아니면 막는다", () => {
    expect(renderableAvatarUrl("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(renderableAvatarUrl("blob:https://app.momo.dev/x", ORIGIN)).toBeNull();
  });

  it("빈 값은 이미지가 없는 것이다", () => {
    expect(renderableAvatarUrl(undefined)).toBeNull();
    expect(renderableAvatarUrl(null)).toBeNull();
    expect(renderableAvatarUrl("   ")).toBeNull();
  });
});

describe("avatarInitial", () => {
  it("첫 글자를 코드포인트로 자른다 — 서로게이트 쌍을 반으로 가르지 않는다", () => {
    expect(avatarInitial("곽성재")).toBe("곽");
    expect(avatarInitial("dohyun")).toBe("D");
    expect(avatarInitial("𠮷田")).toBe("𠮷");
  });

  /**
   * H-11 3번의 수리. `MessageRow` 는 작성자를 못 찾으면 uuid 앞 8자를 이름으로
   * 삼았고, 그 첫 글자가 이니셜이 됐다 — `0199dddd…` 는 「0」이라는 이니셜을
   * 가진 사람처럼 그려진다.
   */
  it("uuid 조각처럼 글자로 시작하지 않는 것은 이니셜이 아니다", () => {
    expect(avatarInitial("0199dddd")).toBeNull();
    expect(avatarInitial("#general")).toBeNull();
    expect(avatarInitial("")).toBeNull();
    expect(avatarInitial(null)).toBeNull();
  });
});

describe("avatarIdentity", () => {
  it("사람과 에이전트를 가른다", () => {
    expect(avatarIdentity(member()).kind).toBe("human");
    expect(avatarIdentity(member({ kind: "agent" })).kind).toBe("agent");
  });

  it("명부에 없으면 모른다 — uuid 조각으로 이니셜을 짓지 않는다", () => {
    const unknown = avatarIdentity(null);
    expect(unknown.kind).toBe("unknown");
    expect(unknown.fallback).toEqual({ kind: "unknown" });
    expect(unknown.imageUrl).toBeNull();
  });

  it("이름이 비면 이니셜 대신 모른다로 물러난다", () => {
    expect(avatarIdentity(member({ displayName: "  " })).fallback).toEqual({
      kind: "unknown",
    });
  });

  it("실을 수 없는 avatarUrl 은 이미지가 아니라 이니셜이 된다", () => {
    const identity = avatarIdentity(
      member({ avatarUrl: "https://cdn.example/a.png" }),
      ORIGIN
    );
    expect(identity.imageUrl).toBeNull();
    expect(identity.fallback).toEqual({ kind: "initial", text: "곽" });
  });

  it("실을 수 있으면 이미지 주소가 나온다", () => {
    expect(
      avatarIdentity(member({ avatarUrl: "/v1/media/a.png" }), ORIGIN).imageUrl
    ).toBe("/v1/media/a.png");
  });
});

describe("모양과 크기", () => {
  it("아바타는 24px보다 크다 — 그 크기에서는 아바타로 읽히지 않았다", () => {
    expect(AVATAR_SIZE).toBeGreaterThan(24);
    // 그리고 이 레포의 간격 표 안의 값이다(웹에서 실제로 컴파일되는 유일한 길).
    expect(AVATAR_SIZE % 8).toBe(0);
  });

  it("정체는 색 말고 모양으로도 나른다", () => {
    expect(AVATAR_SHAPE.human).not.toBe(AVATAR_SHAPE.agent);
  });

  it("모르는 것은 정체 색을 갖지 않는다", () => {
    expect(avatarCarriesIdentityColor("human")).toBe(true);
    expect(avatarCarriesIdentityColor("agent")).toBe(true);
    expect(avatarCarriesIdentityColor("unknown")).toBe(false);
  });
});
