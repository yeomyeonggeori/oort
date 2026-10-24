import { describe, expect, it } from "vitest";
import { workspaceActionLabel } from "../inbox/model";
import { parseApprovalAction } from "../timeline/agentCardModel";
import {
  AVATAR_PREVIEW_UNAVAILABLE,
  approvalAvatarPreviewPath,
  isApprovalAvatarPreviewPath,
  isMemberAvatarSetAction,
  memberAvatarSetHeadline,
  parseAvatarImagePreview,
} from "./avatarPreview";

// 서버가 카드 props 에 싣는 모양 그대로(`agent_port_tools.rs` 의 `avatar_preview`, #4385).
// 이름·핸들은 가상이다.
const SHA = "ab".repeat(32);
const WIRE_PREVIEW = {
  kind: "avatar_image",
  imageId: "11111111-1111-4111-8111-111111111111",
  sha256: SHA,
  mime: "image/png",
  width: 512,
  height: 384,
  sizeBytes: 48213,
  origin: "attachment",
};
const WS = "0199aa11-2222-7000-8000-000000000001";
const APPROVAL = "0199aa11-2222-7000-8000-0000000000a1";

describe("member.avatar.set 카드의 action.preview (#4394)", () => {
  it("서버 모양을 그대로 읽는다", () => {
    expect(parseAvatarImagePreview(WIRE_PREVIEW)).toEqual(WIRE_PREVIEW);
  });

  it.each<[string, unknown]>([
    ["다른 kind", { ...WIRE_PREVIEW, kind: "image" }],
    ["대문자 해시", { ...WIRE_PREVIEW, sha256: SHA.toUpperCase() }],
    ["짧은 해시", { ...WIRE_PREVIEW, sha256: "ab" }],
    ["주소를 깨는 해시", { ...WIRE_PREVIEW, sha256: `${"a".repeat(63)}/` }],
    ["치수 0", { ...WIRE_PREVIEW, width: 0 }],
    ["문자열 치수", { ...WIRE_PREVIEW, height: "384" }],
    ["id 없음", { ...WIRE_PREVIEW, imageId: "" }],
    ["배열", [WIRE_PREVIEW]],
    ["null", null],
  ])("모양이 어긋나면 사진 없이 물러난다: %s", (_label, value) => {
    expect(parseAvatarImagePreview(value)).toBeNull();
  });

  it("승인 카드의 action 블록이 preview 를 든다 — 없으면 null", () => {
    const withPreview = parseApprovalAction({
      id: "member.avatar.set",
      rows: [{ label: "대상", value: "이도현 (@dohyun)" }],
      required_role: "requesting_member",
      preview: WIRE_PREVIEW,
    });
    expect(withPreview?.preview).toEqual(WIRE_PREVIEW);
    expect(withPreview?.requiredRole).toBe("requesting_member");
    const without = parseApprovalAction({ id: "channel.create", rows: [] });
    expect(without).not.toBeNull();
    expect(without !== null && "preview" in without).toBe(false);
    // 모양이 어긋난 preview 도 키를 남기지 않는다.
    const bad = parseApprovalAction({ id: "member.avatar.set", rows: [], preview: { kind: "avatar_image" } });
    expect(bad !== null && "preview" in bad).toBe(false);
  });

  it("미리보기 주소는 승인 하나·해시 하나에 묶인다", () => {
    const preview = parseAvatarImagePreview(WIRE_PREVIEW);
    const path = approvalAvatarPreviewPath(WS, APPROVAL, preview);
    expect(path).toBe(`/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=${SHA}`);
    expect(isApprovalAvatarPreviewPath(path)).toBe(true);
    expect(approvalAvatarPreviewPath(WS, null, preview)).toBeNull();
    expect(approvalAvatarPreviewPath(null, APPROVAL, preview)).toBeNull();
    expect(approvalAvatarPreviewPath(WS, APPROVAL, null)).toBeNull();
  });

  it("베어러를 싣기 전의 모양 검사는 다른 경로를 거절한다", () => {
    for (const bad of [
      `/v1/workspaces/${WS}/members/${APPROVAL}/avatar/content?v=${SHA}`,
      `/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview`,
      `/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=zz`,
      `/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=abcd`, // 해시는 64자다
      `/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=${SHA}ab`, // 길어도 안 된다
      `/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=${SHA}&x=1`,
      `/v1/workspaces/${WS}/approvals/a/b/avatar-preview?v=${SHA}`,
      `https://evil.example/v1/workspaces/${WS}/approvals/${APPROVAL}/avatar-preview?v=${SHA}`,
    ]) {
      expect(isApprovalAvatarPreviewPath(bad)).toBe(false);
    }
  });

  it("첫 문장은 올린 에이전트 이름에 조사를 맞춘다 — 이 행동에만", () => {
    expect(memberAvatarSetHeadline("member.avatar.set", "김인턴")).toBe(
      "김인턴이 내 프로필 사진을 이 사진으로 바꾸려고 해요"
    );
    expect(memberAvatarSetHeadline("member.avatar.set", "Hermes")).toBe(
      "Hermes가 내 프로필 사진을 이 사진으로 바꾸려고 해요"
    );
    expect(memberAvatarSetHeadline("member.avatar.set", null)).toBe(
      "에이전트가 내 프로필 사진을 이 사진으로 바꾸려고 해요"
    );
    expect(memberAvatarSetHeadline("agent.profile.update", "김인턴")).toBeNull();
    expect(isMemberAvatarSetAction("member.avatar.set")).toBe(true);
    expect(isMemberAvatarSetAction("agent.rename")).toBe(false);
  });

  it("사진을 못 읽는 자리는 본인만 볼 수 있다고 말한다(404 와 네트워크 실패를 가르지 않는다)", () => {
    expect(AVATAR_PREVIEW_UNAVAILABLE).toContain("본인");
  });

  it("인박스 줄이 내부 낱말 대신 행동 이름을 말한다", () => {
    expect(workspaceActionLabel("member.avatar.set")).toBe("내 프로필 사진 바꾸기");
    expect(workspaceActionLabel("member.unknown")).toBe("워크스페이스 변경");
  });
});
