import { describe, expect, it } from "vitest";
import { parseExecutionPlan, SPAWN_EXECUTION_KIND } from "./executionPlan";

// =============================================================================
// #1114 클라 축 — 승인 payload/props의 `execution` 읽기.
//
// 이 파일이 지키는 것은 하나다: **모르는 것을 고를 수 있다고 말하지 않는다.**
// 픽커의 답은 되돌릴 수 없는 실행의 목적지가 되므로, 형상을 못 읽었을 때의
// 기본값은 언제나 "못 고름" 쪽이어야 한다.
//
// 픽스처는 서버 실측이다: `spawn_execution_object`(work_control.rs:1155)와
// `SpawnHostCandidate::to_json`(:1046)이 내는 그 모양, snake_case 그대로.
// =============================================================================

const LOCAL = "00000000-0000-7000-8000-0000000000a1";
const REMOTE = "00000000-0000-7000-8000-0000000000a2";
const DEAD = "00000000-0000-7000-8000-0000000000a3";
const CLOUD = "00000000-0000-7000-8000-0000000000a4";

/**
 * 서버가 내는 스폰 승인 payload. `execution` 안쪽만 덮어쓴다 — 바깥 키는 이
 * 파일의 주제가 아니고, 둘을 한 인자로 합치면 덮어쓰기가 서로를 지운다.
 */
function payload(execution: Record<string, unknown> = {}) {
  return {
    run_id: "run",
    action_type: "tool_call",
    tool_call: { call_id: "c1", name: "work.session.spawn" },
    execution: {
      kind: SPAWN_EXECUTION_KIND,
      tool: "codex",
      label: "리팩터링",
      requested_host_id: null,
      default_host_id: LOCAL,
      host_candidates: [
        {
          host_id: LOCAL,
          display_name: "내 맥",
          host_type: "app",
          tier: "local",
          scope: "member",
          online: true,
          selectable: true,
          unavailable_reason: null,
        },
        {
          host_id: REMOTE,
          display_name: "팀 VPS",
          host_type: "workd",
          tier: "remote",
          scope: "workspace",
          online: true,
          selectable: true,
          unavailable_reason: null,
        },
        {
          host_id: DEAD,
          display_name: "낡은 맥",
          host_type: "app",
          tier: "local",
          scope: "member",
          online: false,
          selectable: false,
          unavailable_reason: "offline",
        },
        {
          host_id: CLOUD,
          display_name: "momo Cloud",
          host_type: "cloud",
          tier: "cloud",
          scope: "workspace",
          online: true,
          selectable: false,
          unavailable_reason: "t3_disabled",
        },
      ],
      ...execution,
    },
  };
}

describe("execution 읽기", () => {
  it("서버가 내는 그대로의 스폰 payload를 읽는다", () => {
    const plan = parseExecutionPlan(payload());
    expect(plan).not.toBeNull();
    expect(plan?.tool).toBe("codex");
    expect(plan?.label).toBe("리팩터링");
    expect(plan?.defaultHostId).toBe(LOCAL);
    expect(plan?.candidates.map((c) => c.hostId)).toEqual([
      LOCAL,
      REMOTE,
      DEAD,
      CLOUD,
    ]);
  });

  it("자격 없는 후보를 버리지 않는다 — 사유와 함께 그대로 남는다", () => {
    // 서버가 숨기지 않기로 한 것을 클라이언트가 대신 숨기면, 「왜 내 랩탑을 못
    // 고르지」의 답이 화면에서 사라진다. 빈 목록은 그 질문의 답이 아니다.
    const plan = parseExecutionPlan(payload());
    const dead = plan?.candidates.find((c) => c.hostId === DEAD);
    expect(dead?.selectable).toBe(false);
    expect(dead?.unavailableReason).toBe("offline");
    const cloud = plan?.candidates.find((c) => c.hostId === CLOUD);
    expect(cloud?.unavailableReason).toBe("t3_disabled");
  });

  it("`execution`이 없는 승인은 픽커가 아니다", () => {
    expect(
      parseExecutionPlan({ run_id: "r", tool_call: { name: "x" } })
    ).toBeNull();
  });

  it("모르는 kind는 스폰 카드로 그리지 않는다", () => {
    const plan = parseExecutionPlan(payload({ kind: "future_thing" }));
    expect(plan).toBeNull();
  });

  it("`host_candidates` 키가 아예 없으면 픽커가 아니다", () => {
    // 서버의 `offers_host_choice`도 정확히 이 키의 존재로 판정한다. 화면과 게이트가
    // 다른 술어를 보면, 화면이 그린 픽커를 서버가 400으로 거절한다.
    const plan = parseExecutionPlan(payload({ host_candidates: undefined }));
    expect(plan).toBeNull();
  });
});

describe("fail-closed 읽기", () => {
  it("`selectable`이 참이 아니면 무엇이든 선택 불가다", () => {
    for (const value of [undefined, null, "true", 1, {}]) {
      const plan = parseExecutionPlan(
        payload({
          host_candidates: [
            { host_id: LOCAL, display_name: "내 맥", selectable: value },
          ],
        })
      );
      expect(plan?.candidates[0]?.selectable).toBe(false);
    }
  });

  it("모르는 tier는 추측하지 않고 unknown이다", () => {
    // 서버도 같은 선택을 한다(`host_tier`의 `_` 갈래): 등록기가 모르는 타입을
    // local로 읽으면 정체불명의 기계가 「내 기기」라는 뜻을 얻는다.
    const plan = parseExecutionPlan(
      payload({
        host_candidates: [
          {
            host_id: LOCAL,
            display_name: "정체불명",
            tier: "quantum",
            selectable: true,
          },
        ],
      })
    );
    expect(plan?.candidates[0]?.tier).toBe("unknown");
  });

  it("이름이나 id가 없는 줄은 그 줄만 버린다 — 목록 전체가 아니라", () => {
    const plan = parseExecutionPlan(
      payload({
        host_candidates: [
          { display_name: "이름만 있음", selectable: true },
          { host_id: LOCAL, selectable: true },
          { host_id: REMOTE, display_name: "팀 VPS", selectable: true },
        ],
      })
    );
    // id 없는 줄은 고를 대상이 없고, 이름 없는 줄은 사람이 무엇을 고르는지 모른다.
    // 그렇다고 나머지를 못 보여줄 이유는 없다.
    expect(plan?.candidates.map((c) => c.hostId)).toEqual([REMOTE]);
  });

  it("온라인 여부도 모르면 오프라인으로 읽는다", () => {
    const plan = parseExecutionPlan(
      payload({
        host_candidates: [
          { host_id: LOCAL, display_name: "내 맥", selectable: true },
        ],
      })
    );
    expect(plan?.candidates[0]?.online).toBe(false);
  });
});
