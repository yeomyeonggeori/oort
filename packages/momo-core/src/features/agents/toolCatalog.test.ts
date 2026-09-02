import { describe, expect, it } from "vitest";
import {
  DECLARED_ONLY_REASON,
  parseAgentToolCatalog,
} from "./toolCatalog";

const LONG_NAME =
  "deploy.rollback.session-end-with-a-very-long-qualified-name";
const LONG_DESCRIPTION =
  "배포 전 롤백 절차를 확인한 뒤에만 쓰는 작업 세션 종료입니다. 호스트 상태와 정산 원장을 닫으며, 한 번 실행하면 같은 세션으로 되돌리지 못합니다.";

describe("parseAgentToolCatalog", () => {
  it("tools 키가 없으면 부재로 읽고 카탈로그를 지어내지 않는다", () => {
    expect(parseAgentToolCatalog({})).toBeNull();
    expect(parseAgentToolCatalog(null)).toBeNull();
    expect(parseAgentToolCatalog({ tool: [] })).toBeNull();
  });

  it("이름·한 줄 설명·실행 가능·승인 기본값을 카탈로그 순으로 읽는다", () => {
    const parsed = parseAgentToolCatalog({
      tools: [
        {
          name: LONG_NAME,
          description: LONG_DESCRIPTION,
          executable: true,
          requiresApproval: true,
        },
        {
          name: "work.session.resume",
          description:
            "멈춘 작업 세션을 이어서 시작합니다. 이 서버는 아직 이 도구를 실행하지 않습니다.",
          executable: false,
          requiresApproval: true,
          unavailableReason: DECLARED_ONLY_REASON,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        name: LONG_NAME,
        description: LONG_DESCRIPTION,
        executable: true,
        requiresApproval: true,
        unavailableReason: null,
      },
      {
        name: "work.session.resume",
        description:
          "멈춘 작업 세션을 이어서 시작합니다. 이 서버는 아직 이 도구를 실행하지 않습니다.",
        executable: false,
        requiresApproval: true,
        unavailableReason: DECLARED_ONLY_REASON,
      },
    ]);
  });

  it("requiresApproval 이 없으면 G6 대로 승인 필요로 접는다", () => {
    const parsed = parseAgentToolCatalog({
      tools: [
        {
          name: "mystery.tool",
          description: "서버가 승인 기본값을 안 실은 도구입니다.",
          executable: true,
        },
      ],
    });
    expect(parsed).toEqual([
      {
        name: "mystery.tool",
        description: "서버가 승인 기본값을 안 실은 도구입니다.",
        executable: true,
        requiresApproval: true,
        unavailableReason: null,
      },
    ]);
  });

  it("실행 불가인데 사유가 없으면 표준 사유를 채운다", () => {
    const parsed = parseAgentToolCatalog({
      tools: [
        {
          name: "agent.pause",
          description: "에이전트를 일시정지합니다.",
          executable: false,
        },
      ],
    });
    expect(parsed?.[0]?.unavailableReason).toBe(DECLARED_ONLY_REASON);
  });

  it("이름이나 설명이 빈 항목은 건너뛰고, 빈 배열은 부재가 아니다", () => {
    expect(parseAgentToolCatalog({ tools: [] })).toEqual([]);
    expect(
      parseAgentToolCatalog({
        tools: [
          { name: "", description: "x", executable: true },
          { name: "ok.tool", description: "   ", executable: true },
          {
            name: "kept.tool",
            description: "한 줄 설명이 있는 도구입니다.",
            executable: true,
            requiresApproval: false,
          },
        ],
      })
    ).toEqual([
      {
        name: "kept.tool",
        description: "한 줄 설명이 있는 도구입니다.",
        executable: true,
        requiresApproval: false,
        unavailableReason: null,
      },
    ]);
  });
});
