// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import { DmAvatar } from "@/features/sidebar/DmAvatar";
import { MemberAvatar } from "./MemberAvatar";
import { HUMAN_TONE_CLASSES, avatarSurfaceClass, avatarToneIndex } from "./avatarTone";

// 사이드바 DM 기본 아바타 (#4148): 원형이 바탕에서 또렷이 읽히고, 사람은 멤버 id 로 서로 구분된다.

// 상태 점은 이 시험의 관심사가 아니다(세션·생존 쿼리가 필요하다): 점 없음으로 고정한다.
vi.mock("@/features/sidebar/useDmStatusDot", () => ({ useDmStatusDot: () => null }));

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

function member(id: string, extra: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
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

const dm = (m: RosterMember | null) => createElement(DmAvatar, { member: m, nowMs: 0, viewerMayAct: false });
const box = (h: HTMLElement) => h.querySelector<HTMLElement>('[data-testid="dm-avatar"]')!.firstElementChild as HTMLElement;

describe("avatarToneIndex", () => {
  it("같은 id 는 언제나 같은 색조이고(대소문자 무관) 범위 안이다", () => {
    const id = "00000000-0000-7000-8000-000000000111";
    expect(avatarToneIndex(id)).toBe(avatarToneIndex(id));
    expect(avatarToneIndex(id.toUpperCase())).toBe(avatarToneIndex(id));
    expect(avatarToneIndex(id)).toBeGreaterThanOrEqual(0);
    expect(avatarToneIndex(id)).toBeLessThan(HUMAN_TONE_CLASSES.length);
  });

  it("여러 멤버가 한 색에 몰리지 않는다: 열두 id 가 네 색조 이상으로 갈린다", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `00000000-0000-7000-8000-0000000001${String(i + 10)}`);
    expect(new Set(ids.map(avatarToneIndex)).size).toBeGreaterThanOrEqual(4);
  });
});

describe("avatarSurfaceClass: kind 별 채움·테두리", () => {
  it("human: 1px --line 테두리 + id 가 고른 색조 채움(옛 --surface-hover 아님)", () => {
    const cls = avatarSurfaceClass("human", "u1");
    expect(cls).toContain("border border-line");
    expect(cls).toContain(HUMAN_TONE_CLASSES[avatarToneIndex("u1")]);
    expect(cls).not.toContain("bg-surface-hover");
  });
  it("agent: 테두리 + agent 토큰", () => {
    expect(avatarSurfaceClass("agent", "a")).toBe("border border-line bg-agent-soft text-agent");
  });
  it("unknown: 점선 테두리, 채움 없음, 흐린 글자", () => {
    const cls = avatarSurfaceClass("unknown", null);
    expect(cls).toContain("border-dashed");
    expect(cls).toContain("bg-transparent");
    expect(cls).toContain("text-ink-muted");
  });
});

describe("avatarSurfaceClass: 사진 테두리 (#4162)", () => {
  it("사진이 있으면 모든 종류가 --avatar-edge 이고, 없으면 --line 이다", () => {
    for (const kind of ["human", "agent", "unknown"] as const) {
      expect(avatarSurfaceClass(kind, "u1", true), kind).toContain("border-avatar-edge");
      expect(avatarSurfaceClass(kind, "u1", false), kind).not.toContain("border-avatar-edge");
    }
  });
});

describe("DmAvatar 렌더", () => {
  it("사람 이니셜: 원 + 테두리 + 색조 채움, 크기 24 고정", () => {
    const h = mount(dm(member("u1")));
    const el = box(h);
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("border border-line");
    expect(el.className).toContain(HUMAN_TONE_CLASSES[avatarToneIndex("u1")]);
    expect(el.className).toContain("size-6");
    expect(el.textContent).toBe("이");
  });

  it("열두 사람 id 가 세 색조 이상으로 갈린다", () => {
    const tones = Array.from({ length: 12 }, (_, i) => `00000000-0000-7000-8000-0000000001${i + 10}`).map((id) => {
      const h = mount(dm(member(id)));
      const cls = HUMAN_TONE_CLASSES.find((t) => box(h).className.includes(t));
      act(() => root?.unmount());
      root = null;
      h.remove();
      host = null;
      return cls;
    });
    expect(tones.every((t) => t !== undefined)).toBe(true);
    expect(new Set(tones).size).toBeGreaterThanOrEqual(3);
  });

  it("에이전트: 둥근 사각 + agent 토큰 + 테두리", () => {
    const el = box(mount(dm(member("ag", { kind: "agent", displayName: "김인턴" }))));
    expect(el.className).toContain("rounded-sm");
    expect(el.className).not.toContain("rounded-full");
    expect(el.className).toContain("bg-agent-soft");
    expect(el.className).toContain("border border-line");
  });

  it("나간 멤버(unknown): 점선 테두리 원 + 사람 아이콘, 이니셜 없음", () => {
    const h = mount(dm(null));
    const el = box(h);
    expect(h.querySelector('[data-testid="dm-avatar"]')?.getAttribute("data-avatar-kind")).toBe("unknown");
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("border-dashed");
    expect(h.querySelector('[data-testid="dm-avatar-default"]')).not.toBeNull();
    expect(el.textContent).toBe("");
  });

  it("사진이 있으면 같은 원에 한 단 짙은 --avatar-edge 테두리를 두른다 (#4162)", () => {
    const h = mount(dm(member("u2", { avatarUrl: "/media/a.png" })));
    const el = box(h);
    expect(h.querySelector('[data-testid="dm-avatar-image"]')?.getAttribute("src")).toBe("/media/a.png");
    expect(el.className).toContain("rounded-full");
    expect(el.className).toContain("border border-avatar-edge");
    expect(el.className).not.toContain("border-line");
  });
});

describe("다른 표면과 같은 문법", () => {
  it("MemberAvatar(목록): 같은 id 는 DM 아바타와 같은 색조 채움이다", () => {
    const h = mount(createElement(MemberAvatar, { member: member("u1"), size: "md" }));
    const el = h.querySelector<HTMLElement>('[data-testid="member-avatar"]')!;
    expect(el.className).toContain(HUMAN_TONE_CLASSES[avatarToneIndex("u1")]);
    expect(el.className).toContain("border border-line");
  });
});
