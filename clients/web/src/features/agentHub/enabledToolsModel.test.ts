import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DECLARED_ONLY_REASON } from "@momo/core/features/agents/toolCatalog";
import type { AgentToolCatalogEntry } from "@momo/core/features/agents/toolCatalog";
import type { AgentProfile } from "@momo/core/lib/api";
import {
  INSTRUCTION_BYTE_LIMIT,
  UNKNOWN_TOOL_REASON,
  enabledToolsFromRows,
  isToolToggleLocked,
  mergeToolRows,
  toggleToolRow,
  toolsProfilePut,
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
    expect(unknown?.executable).toBe(false);
    expect(unknown?.unavailableReason).toBe(UNKNOWN_TOOL_REASON);
  });

  it("H-2: enabledTools 의 shell 이 카탈로그에 없으면 실행 가능이 아니다", () => {
    const rows = mergeToolRows(CATALOG, ["shell"]);
    const shell = rows.find((row) => row.name === "shell");
    expect(shell?.unknown).toBe(true);
    expect(shell?.executable).toBe(false);
    expect(isToolToggleLocked(shell!, false)).toBe(false);
    const off = toggleToolRow(rows, "shell", false);
    expect(enabledToolsFromRows(off)).toEqual([]);
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

function savedProfile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentMemberId: "AGENT",
    workspaceId: "WS",
    instructions: "저장된 지시문",
    modelPref: "hermes-agent",
    effortPref: "high",
    enabledTools: ["work.session.spawn"],
    triggers: { mention: true },
    paused: false,
    version: 1,
    updatedBy: "ME",
    updatedAtMs: 1,
    ...over,
  };
}

describe("toolsProfilePut", () => {
  it("H-1: 도구 PUT 은 저장된 프로필 필드만 싣고 초안을 인자로 받지 않는다", () => {
    const saved = savedProfile();
    const built = toolsProfilePut(saved, ["work.session.spawn", LONG_NAME]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.instructions).toBe("저장된 지시문");
    expect(built.input.modelPref).toBe("hermes-agent");
    expect(built.input.effortPref).toBe("high");
    expect(built.input.enabledTools).toEqual([
      "work.session.spawn",
      LONG_NAME,
    ]);
    expect(toolsProfilePut.length).toBe(2);
  });

  it("H-1: 도구 PUT 경로도 8KB 지시문 가드를 돌린다", () => {
    const huge = "한".repeat(INSTRUCTION_BYTE_LIMIT);
    const built = toolsProfilePut(savedProfile({ instructions: huge }), [
      "work.session.spawn",
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.message).toContain("8KB");
  });
});

describe("AgentHubRoute tools save wiring", () => {
  it("H-1: 도구 저장 콜백은 지시문/모델 초안을 싣지 않는다", () => {
    const source = readFileSync(
      new URL("./AgentHubRoute.tsx", import.meta.url),
      "utf8"
    );
    const start = source.indexOf("<EnabledToolsSection");
    const end = source.indexOf("<PermissionsSection");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, end);
    expect(block).toContain("toolsProfilePut(handle.profile");
    expect(block).not.toContain("currentInstructions");
    expect(block).not.toContain("currentDraft");
  });
});

describe("M-3 StatusChip vessel", () => {
  it("H-6: 중립 칩은 muted-soft 그릇만 쓰고 컨트롤 테두리는 없다", () => {
    const source = readFileSync(
      new URL("./StatusChip.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toContain("bg-muted-soft");
    expect(source).not.toContain("border-ink-muted");
    expect(source).not.toMatch(/tone === "neutral" &&[\s\S]*border /);
  });
});
