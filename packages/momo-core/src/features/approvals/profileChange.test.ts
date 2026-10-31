import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member, RosterMember } from "../../lib/api";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import type { DecisionOutcome } from "../timeline/approvalDecision";
import { refreshProfileAfterApproval } from "./profileChange";

const original: Member = { id: "person", workspaceId: "workspace", kind: "human", displayName: "이전 이름", handle: "sky" };
const roster: RosterMember[] = [{ ...original, displayName: "새 이름", avatarUrl: "/new-photo", status: "active", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 1, updatedAtMs: 2 }];
const approved: DecisionOutcome = { kind: "committed", status: "approved", result: { actionId: "member.display_name.set", ref: { type: "member", id: original.id }, secretOnce: null } };

function host(member: () => Member | null) {
  installCoreHost({ apiBase: () => "https://oort.test", absoluteApiBase: () => "https://oort.test", buildMode: () => "test", session: {
    getAccessToken: () => "access", getRefreshToken: () => "refresh",
    getPersistedSession: () => { const current = member(); return current ? { member: current, refreshToken: "refresh", realtimeWebSocketUrl: "wss://oort.test" } : null; },
    applyLogin: () => {}, applyRotation: () => {}, clearSession: () => {}, markAuthExpired: () => {},
  } });
}
afterEach(() => { resetCoreHost(); vi.unstubAllGlobals(); });

describe("프로필 승인 직후 반영 (#4791)", () => {
  it("네 행동의 승인만 실제 roster를 읽어 세션과 사진 캐시를 바꾼다", async () => {
    host(() => original);
    const fetch = vi.fn(async () => Response.json({ members: roster }));
    vi.stubGlobal("fetch", fetch);
    const replace = vi.fn(); const cache = vi.fn();
    for (const actionId of ["member.display_name.set", "member.avatar.set", "agent.rename", "agent.profile.update"]) {
      await refreshProfileAfterApproval({ ...approved, result: { ...approved.result!, actionId } }, replace, cache);
    }
    expect(replace).toHaveBeenCalledTimes(4);
    expect(replace).toHaveBeenLastCalledWith({ ...original, displayName: "새 이름" });
    expect(cache).toHaveBeenLastCalledWith(original.workspaceId, expect.arrayContaining([expect.objectContaining({ avatarUrl: "/new-photo" })]));
    for (const outcome of [ { ...approved, status: "rejected" as const }, { ...approved, kind: "error" as const }, { ...approved, result: { ...approved.result!, actionId: "channel.create" } } ]) {
      await refreshProfileAfterApproval(outcome, replace, cache);
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("응답 전에 로그아웃하거나 계정이 바뀌면 앞 계정의 이름과 사진을 버린다", async () => {
    for (const next of [null, { ...original, id: "another-person" }, { ...original, workspaceId: "another-workspace" }]) {
      let current: Member | null = original;
      host(() => current);
      let release = () => {};
      const answer = new Promise<Response>(resolve => { release = () => resolve(Response.json({ members: roster })); });
      vi.stubGlobal("fetch", vi.fn(() => answer));
      const replace = vi.fn(); const cache = vi.fn();
      const pending = refreshProfileAfterApproval(approved, replace, cache);
      current = next; release(); await pending;
      expect(replace).not.toHaveBeenCalled(); expect(cache).not.toHaveBeenCalled();
    }
  });
});
