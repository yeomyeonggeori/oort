import { describe, expect, it } from "vitest";
import { DECLARED_ONLY_REASON } from "@momo/core/features/agents/toolCatalog";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";
import {
  enabledToolsFromRows,
  isToolToggleLocked,
  mergeToolRows,
  toggleToolRow,
} from "./enabledToolsModel";

const LONG_NAME =
  "deploy.rollback.session-end-with-a-very-long-qualified-name";

const CATALOG: AgentToolCatalogEntry[] = [
  {
    name: LONG_NAME,
    description:
      "배포 전 롤백 절차를 확인한 뒤에만 쓰는 작업 세션 종료입니다. 호스트 상태와 정산 원장을 닫으며, 한 번 실행하면 같은 세션으로 되돌리지 못합니다.",
    executable: true,
    requiresApproval: true,
    unavailableReason: null,
  },
  {
    name: "work.session.spawn",
    description:
      "등록된 호스트에서 코딩 도구를 새 작업 세션으로 시작합니다. 승인하는 사람이 호스트를 고릅니다.",
    executable: true,
    requiresApproval: true,
    unavailableReason: null,
  },
  {
    name: "work.session.resume",
    description: "멈춘 작업 세션을 이어서 시작합니다.",
    executable: false,
    requiresApproval: true,
    unavailableReason: DECLARED_ONLY_REASON,
  },
];

describe("mergeToolRows", () => {
  it("카탈로그 전 항목을 행으로 두고, 서버가 보낸 모르는 이름은 승인 필요로 붙인다", () => {
    const rows = mergeToolRows(CATALOG, ["work.session.spawn", "web.search"]);
    expect(rows.map((row) => row.name)).toEqual([
      LONG_NAME,
      "work.session.spawn",
      "work.session.resume",
      "web.search",
    ]);
    expect(rows.find((row) => row.name === LONG_NAME)?.enabled).toBe(false);
    expect(rows.find((row) => row.name === "work.session.spawn")?.enabled).toBe(
      true
    );
    const unknown = rows.find((row) => row.name === "web.search");
    expect(unknown?.unknown).toBe(true);
    expect(unknown?.enabled).toBe(true);
    expect(unknown?.requiresApproval).toBe(true);
    expect(unknown?.executable).toBe(true);
  });
});

describe("toggleToolRow", () => {
  it("실행 가능 항목은 켜고 끌 수 있고 PUT 배열에 그대로 실린다", () => {
    const start = mergeToolRows(CATALOG, ["work.session.spawn"]);
    const added = toggleToolRow(start, LONG_NAME, true);
    expect(enabledToolsFromRows(added)).toEqual([LONG_NAME, "work.session.spawn"]);
    const removed = toggleToolRow(added, "work.session.spawn", false);
    expect(enabledToolsFromRows(removed)).toEqual([LONG_NAME]);
  });

  it("실행 불가 항목은 토글이 잠기고 배열이 바뀌지 않는다", () => {
    const start = mergeToolRows(CATALOG, ["work.session.spawn"]);
    const resume = start.find((row) => row.name === "work.session.resume");
    expect(resume).toBeDefined();
    if (!resume) return;
    expect(isToolToggleLocked(resume, false)).toBe(true);
    const next = toggleToolRow(start, "work.session.resume", true);
    expect(enabledToolsFromRows(next)).toEqual(["work.session.spawn"]);
  });

  it("읽기 전용이면 실행 가능 항목도 잠긴다", () => {
    const start = mergeToolRows(CATALOG, ["work.session.spawn"]);
    const spawn = start.find((row) => row.name === "work.session.spawn");
    expect(spawn).toBeDefined();
    if (!spawn) return;
    expect(isToolToggleLocked(spawn, false)).toBe(false);
    expect(isToolToggleLocked(spawn, true)).toBe(true);
  });
});
