// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { RespondingAvatar } from "@/features/agents/RespondingIndicator";
import { ProfileAvatar } from "@/features/settings/shell/ProfileAvatar";
import { PresenceBadge } from "@/features/sidebar/PresenceControl";
import { HUMAN_TONE_CLASSES, avatarToneIndex } from "./avatarTone";

// 나머지 아바타 표면(#4162): 설정 프로필 얼굴·「답하는 중」 얼굴·사이드바 내 배지가 목록·타임라인과 같은
// 문법(얇은 테두리 + 멤버 id 가 고르는 색조 채움)을 쓴다. 옛 `bg-surface-hover`/`bg-surface` 단색 채움이 아니다.

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  env.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const ID = "00000000-0000-7000-8000-000000000111";
function member(extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id: ID,
    workspaceId: "w",
    kind: "human",
    status: "active",
    displayName: "이도현",
    handle: "dohyun",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...extra,
  };
}
function mount(node: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}
const tone = HUMAN_TONE_CLASSES[avatarToneIndex(ID)];
const q = (h: HTMLElement, id: string) => h.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

describe("ProfileAvatar", () => {
  it("row: 사람은 테두리 + id 색조 채움이다(옛 bg-surface-hover 아님)", () => {
    const el = q(mount(createElement(ProfileAvatar, { member: member(), size: "row" })), "profile-avatar");
    expect(el.className).toContain("border border-line");
    expect(el.className).toContain(tone);
    expect(el.className).not.toContain("bg-surface-hover");
  });
  it("hero: 사람은 같은 색조 채움이고 옛 canvas-gradient 가 아니다", () => {
    const el = q(mount(createElement(ProfileAvatar, { member: member(), size: "hero" })), "profile-avatar");
    expect(el.className).toContain(tone);
    expect(el.className).not.toContain("canvas-gradient");
    expect(el.className).toContain("avatar-hero");
  });
  it("에이전트는 둥근 사각 + agent 토큰을 지킨다", () => {
    const el = q(mount(createElement(ProfileAvatar, { member: member({ kind: "agent" }), size: "row" })), "profile-avatar");
    expect(el.className).toContain("rounded-sm");
    expect(el.className).toContain("bg-agent-soft");
  });
  it("사진이 있으면 --avatar-edge 테두리다", () => {
    const el = q(
      mount(createElement(ProfileAvatar, { member: member({ avatarUrl: "data:image/png;base64,AAAA" }), size: "row" })),
      "profile-avatar"
    );
    expect(el.className).toContain("border-avatar-edge");
  });
});

describe("RespondingAvatar", () => {
  it("사람 답하는 중 얼굴도 id 색조 채움 + 테두리다", () => {
    const directory = makeDirectory([member()]);
    const el = q(mount(createElement(RespondingAvatar, { directory, memberId: ID })), "responding-avatar");
    expect(el.className).toContain("border border-line");
    expect(el.className).toContain(tone);
    expect(el.className).not.toContain("bg-surface-hover");
  });
  it("에이전트는 agent 토큰이다", () => {
    const directory = makeDirectory([member({ kind: "agent" })]);
    const el = q(mount(createElement(RespondingAvatar, { directory, memberId: ID })), "responding-avatar");
    expect(el.className).toContain("bg-agent-soft");
    expect(el.className).toContain("rounded-sm");
  });
});

describe("PresenceBadge(사이드바 하단 내 아바타)", () => {
  it("사진이 없으면 내 id 색조 채움 + 테두리이고 옛 흰 면(bg-surface)이 아니다", () => {
    const el = q(
      mount(createElement(PresenceBadge, { selfName: "곽성재", effective: "online", memberId: ID })),
      "presence-control"
    );
    expect(el.className).toContain("border border-line");
    expect(el.className).toContain(tone);
    expect(el.className).not.toMatch(/(^|\s)bg-surface(\s|$)/);
    expect(el.className).toContain("rounded-full");
  });
  it("사진이 있으면 --avatar-edge 테두리다", () => {
    const el = q(
      mount(createElement(PresenceBadge, { selfName: "곽성재", effective: "online", memberId: ID, avatarUrl: "data:image/png;base64,AAAA" })),
      "presence-control"
    );
    expect(el.className).toContain("border-avatar-edge");
  });
});
