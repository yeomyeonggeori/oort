import type { RosterMember } from "@momo/core/lib/api";
import { FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";

// 「AI와 만들기」 상태를 다시 만들 때 쓰는 고정값 (#4820 B). 시험과 캡처가 같이 쓴다.
// 이름은 지어낸 것이고, 사진은 1x1 PNG 한 장이다.

export function makeFixtureAgent(id: string, displayName: string, handle: string, patch: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: FIXTURE_WORKSPACE_ID,
    kind: "agent",
    status: "active",
    displayName,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...patch,
  };
}

export const MAKE_FIXTURE_AGENT_ID = "00000000-0000-7000-8000-0000000000e1";
export const MAKE_FIXTURE_AGENT_B_ID = "00000000-0000-7000-8000-0000000000e2";
export const MAKE_FIXTURE_AGENT = makeFixtureAgent(MAKE_FIXTURE_AGENT_ID, "김인턴", "intern");
export const MAKE_FIXTURE_AGENT_B = makeFixtureAgent(MAKE_FIXTURE_AGENT_B_ID, "마루", "maru");

const PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 원본 사진 자리에 쓰는 1x1 PNG. 형식은 image/png, 크기는 수십 바이트. */
export function makeFixturePhoto(name = "photo.png", type = "image/png"): File {
  const bytes = Uint8Array.from(atob(PIXEL_PNG_BASE64), (char) => char.charCodeAt(0));
  return new File([bytes], name, { type });
}
