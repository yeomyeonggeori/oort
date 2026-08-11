import { describe, expect, it } from "vitest";
import type { WorkHost } from "@momo/core/lib/api";
import { workConsoleLocation, workConsoleSessionPath } from "./model";

const host = (type: string, id = "HOST-1"): WorkHost => ({
  id,
  workspaceId: "workspace-1",
  scope: "member",
  ownerMemberId: "member-1",
  type,
  displayName: "실행 호스트",
  capabilities: {},
  createdAtMs: 1,
  online: true,
});

describe("workConsoleLocation", () => {
  it.each([
    ["app", "t1", "T1 · 데스크톱 앱"],
    ["workd", "t2", "T2 · 셀프호스트"],
    ["cloud", "t3", "T3 · 클라우드"],
  ] as const)("maps only the canonical %s host type", (type, key, label) => {
    expect(workConsoleLocation({ hostId: "host-1" }, [host(type)])).toMatchObject({
      key,
      label,
    });
  });

  it("fails closed when the host is absent or its type is unknown", () => {
    expect(workConsoleLocation({ hostId: "missing" }, [host("cloud")])).toEqual({
      key: "unknown",
      label: "실행 위치 확인 필요",
      host: null,
    });
    expect(
      workConsoleLocation({ hostId: "host-1" }, [host("cloud-preview")])
    ).toMatchObject({ key: "unknown", label: "실행 위치 확인 필요" });
    expect(workConsoleLocation({ hostId: "host-1" }, undefined)).toEqual({
      key: "unknown",
      label: "실행 위치 확인 필요",
      host: null,
    });
  });
});

describe("workConsoleSessionPath", () => {
  it("makes the selected session linkable and normalizes its identity", () => {
    expect(workConsoleSessionPath("ABC/DEF")).toBe("/work?session=abc%2Fdef");
  });
});
