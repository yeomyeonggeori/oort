import { describe, expect, it } from "vitest";
import {
  ACTIVE_REVEAL_PROOF_NOTE,
  ACTIVE_REVEAL_WARNING,
  agentPortEndpoint,
  hostedPreset,
  hostedRoutineLabel,
  HOSTED_AUTH_MODE_CHOICES,
  HOSTED_PRESETS,
  HOSTED_ROUTINE_TEMPLATE,
  PAIRING_REVEAL_SCOPE_NOTE,
  PAIRING_REVEAL_WARNING,
} from "./presets";

// =============================================================================
// #1360 HAP-UX1 — preset 과 주소.
//
// RED PROOF 넷:
//
//   ① Grok 줄이 성공을 미리 선언하지 않는다. `verified: false` 를 뒤집으면
//      붉어진다 (ADR-0162 D8: 폐곡선 전에는 그렇게 쓰지 않는다).
//   ② OAuth 는 목록에 서되 고를 수 없다. 줄을 지우거나 `disabled` 를 풀면 붉어진다.
//   ③ 다른 origin 으로 해석되는 주소를 내밀지 않는다. `agentPortEndpoint` 의
//      거절 세 줄 중 하나를 지우면 붉어진다.
//   ④ 두 비밀값의 문구가 서로를 대신하지 않는다.
// =============================================================================

describe("RED PROOF ① 실측되지 않은 것을 실측된 것처럼 말하지 않는다", () => {
  it("Grok preset 은 확인되지 않았다고 스스로 말한다", () => {
    const grok = hostedPreset("grok");
    expect(grok.verified).toBe(false);
    expect(grok.unverifiedNote).toContain("아직 확인되지 않았습니다");
  });

  it("어느 preset 문구도 즉시나 매끄러움을 약속하지 않는다", () => {
    for (const preset of HOSTED_PRESETS) {
      const text = [preset.detail, preset.unverifiedNote ?? "", ...preset.steps].join(" ");
      expect(text).not.toMatch(/즉시|자동으로 완료|바로 연결됩니다/);
    }
  });

  it("Grok 방식이 남기는 것을 미리 적는다", () => {
    // #1344 실측: connector Uninstall 은 앱 목록만 지우고 local plugin source 를
    // 남겼다. 나중에 해제할 사람이 그 사실을 지금 알아야 한다.
    expect(hostedPreset("grok").leavesBehind).toContain("플러그인 소스를 남깁니다");
  });

  it("모르는 preset id 는 일반 recipe 로 떨어진다", () => {
    expect(hostedPreset("generic").id).toBe("generic");
    expect(HOSTED_PRESETS.map((preset) => preset.id)).toEqual(["generic", "grok"]);
  });
});

describe("RED PROOF ② OAuth 는 사유와 함께 서 있고 고를 수 없다", () => {
  it("목록에서 지우지 않는다", () => {
    expect(HOSTED_AUTH_MODE_CHOICES.map((choice) => choice.id)).toEqual([
      "static_bearer",
      "oauth",
    ]);
  });

  it("고를 수 없고 왜 그런지 그 자리에서 말한다", () => {
    const oauth = HOSTED_AUTH_MODE_CHOICES[1];
    expect(oauth?.disabled).toBe(true);
    expect(oauth?.detail).toContain("아직 OAuth 인가 서버가 없어 고를 수 없습니다");
  });

  it("우리가 모르는 날짜를 약속하지 않는다", () => {
    const oauth = HOSTED_AUTH_MODE_CHOICES[1];
    expect(oauth?.detail).not.toMatch(/곧|다음 달|[0-9]{4}년/);
  });

  it("고를 수 있는 방식은 지금 하나뿐이다", () => {
    expect(HOSTED_AUTH_MODE_CHOICES.filter((choice) => !choice.disabled)).toHaveLength(1);
  });
});

describe("RED PROOF ③ 주소는 조립하되 추측하지 않는다", () => {
  it("이 서버의 Agent Port 주소를 만든다", () => {
    expect(agentPortEndpoint("https://oort.example.com")).toBe(
      "https://oort.example.com/v1/mcp/agent-port"
    );
  });

  it("경로가 붙은 base 도 같은 origin 의 정규 경로로 해석한다", () => {
    expect(agentPortEndpoint("https://oort.example.com/api")).toBe(
      "https://oort.example.com/v1/mcp/agent-port"
    );
  });

  it("http/https 가 아니면 내밀지 않는다", () => {
    expect(agentPortEndpoint("tauri://localhost")).toBeNull();
    expect(agentPortEndpoint("ws://oort.example.com")).toBeNull();
  });

  it("계정 정보가 붙은 주소는 주소가 아니라 자격증명이다", () => {
    expect(agentPortEndpoint("https://user:pw@oort.example.com")).toBeNull();
  });

  it("읽을 수 없는 값에는 아무 주소도 지어내지 않는다", () => {
    expect(agentPortEndpoint("")).toBeNull();
    expect(agentPortEndpoint("   ")).toBeNull();
    expect(agentPortEndpoint("oort.example.com")).toBeNull();
  });
});

describe("RED PROOF ④ 두 비밀값의 문구는 서로를 대신하지 않는다", () => {
  it("연결 값 문구는 그 값이 권한이 아니라고 말한다", () => {
    expect(PAIRING_REVEAL_SCOPE_NOTE).toContain("승격되지 않습니다");
    expect(PAIRING_REVEAL_WARNING).toContain("한 번만 보입니다");
  });

  it("자격증명 문구는 앞 값이 이미 죽었다고 말한다", () => {
    expect(ACTIVE_REVEAL_WARNING).toContain("이미 소비돼 더 이상 통하지 않습니다");
    expect(ACTIVE_REVEAL_PROOF_NOTE).toContain("첫 요청에 성공해야");
  });
});

describe("routine 이름과 지시", () => {
  it("이름은 결정적이라 나중에 정리할 때 찾을 수 있다", () => {
    expect(hostedRoutineLabel("오르트", "김인턴")).toBe("Oort Inbox: 오르트 / 김인턴");
  });

  it("긴 이름도 한 줄 안에 담긴다", () => {
    const label = hostedRoutineLabel("가".repeat(50), "나".repeat(50));
    expect(label).toContain("…");
    expect(label.startsWith("Oort Inbox: ")).toBe(true);
  });

  it("routine 지시는 inbox 확인, claim, 원래 자리 게시 셋을 말한다", () => {
    expect(HOSTED_ROUTINE_TEMPLATE).toContain("inbox");
    expect(HOSTED_ROUTINE_TEMPLATE).toContain("claim");
    expect(HOSTED_ROUTINE_TEMPLATE).toContain("thread");
  });
});
