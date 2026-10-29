import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const settingsRequest = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({
  settingsRequest: (...args: unknown[]) => settingsRequest(...args) as Promise<unknown>,
}));

import {
  AGENT_INITIATIVE_SETTINGS_KEY,
  agentInitiativeSaveErrorCopy,
  classifyAgentInitiativeProbe,
  probeAgentInitiativeSwitch,
  readAgentInitiative,
  setAgentInitiativeSwitch,
} from "./agentInitiativeSwitch";

const WS = "00000000-0000-7000-8000-000000000001";

beforeEach(() => {
  // 중괄호가 필요하다: mock 자신을 돌려주면 vitest 가 그것을 정리 훅으로 불러 버린다.
  settingsRequest.mockReset();
});

function sentBody(call: number): Record<string, unknown> {
  const init = settingsRequest.mock.calls[call]?.[1] as { body: string; method: string };
  expect(init.method).toBe("PATCH");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("먼저 제안 끄개: 가방 읽기", () => {
  it("키가 없으면 켜짐이고 서버가 아는지는 모른다", () => {
    expect(readAgentInitiative({})).toEqual({ known: false, enabled: true });
    expect(readAgentInitiative(null)).toEqual({ known: false, enabled: true });
    expect(readAgentInitiative([])).toEqual({ known: false, enabled: true });
  });

  it("불리언이 있으면 그 값이고, 서버가 아는 것이다", () => {
    expect(readAgentInitiative({ agent_initiative: false })).toEqual({ known: true, enabled: false });
    expect(readAgentInitiative({ agent_initiative: true })).toEqual({ known: true, enabled: true });
  });

  it("불리언이 아닌 값은 서버가 닫힌 쪽으로 읽으니 켜진 것처럼 그리지 않는다", () => {
    for (const odd of ["false", "true", 0, 1, null, {}]) {
      expect(readAgentInitiative({ agent_initiative: odd })).toEqual({ known: true, enabled: false });
    }
  });
});

describe("먼저 제안 끄개: 기능 감지", () => {
  it("모르는 키라는 400 은 없음, 값이 틀렸다는 400 은 준비됨, 그 밖은 모름이다", () => {
    expect(
      classifyAgentInitiativeProbe(new ApiError(400, "unknown settings key: agent_initiative"))
    ).toBe("absent");
    expect(
      classifyAgentInitiativeProbe(new ApiError(400, "agent_initiative must be true or false"))
    ).toBe("ready");
    expect(classifyAgentInitiativeProbe(new ApiError(400, "invalid value"))).toBe("ready");
    expect(classifyAgentInitiativeProbe(new ApiError(403, "forbidden"))).toBe("unknown");
    expect(classifyAgentInitiativeProbe(new ApiError(500, "boom"))).toBe("unknown");
    expect(classifyAgentInitiativeProbe(new Error("network"))).toBe("unknown");
  });

  it("물음은 불리언이 아닌 값을 PATCH 하고, 200 이 오면 판정하지 않는다", async () => {
    settingsRequest.mockRejectedValueOnce(new ApiError(400, "agent_initiative must be true or false"));
    await expect(probeAgentInitiativeSwitch(WS)).resolves.toBe("ready");
    const probe = sentBody(0)[AGENT_INITIATIVE_SETTINGS_KEY];
    expect(typeof probe).not.toBe("boolean");
    expect(probe).not.toBeNull();

    settingsRequest.mockResolvedValueOnce({});
    await expect(probeAgentInitiativeSwitch(WS)).resolves.toBe("unknown");
  });
});

describe("먼저 제안 끄개: 저장", () => {
  it("켜기와 끄기는 불리언을 그대로 PATCH 한다", async () => {
    settingsRequest.mockResolvedValue({});
    await setAgentInitiativeSwitch(WS, false);
    await setAgentInitiativeSwitch(WS, true);
    expect(sentBody(0)).toEqual({ agent_initiative: false });
    expect(sentBody(1)).toEqual({ agent_initiative: true });
    expect(settingsRequest.mock.calls[0]?.[0]).toBe(`/v1/workspaces/${WS}/settings`);
  });

  it("키를 모르는 서버의 거절은 서버를 올리라고, 그 밖은 연결을 보라고 말한다", () => {
    const unknownKey = agentInitiativeSaveErrorCopy(new ApiError(400, "unknown settings key: agent_initiative"));
    const other = agentInitiativeSaveErrorCopy(new ApiError(500, "boom"));
    expect(unknownKey).not.toBe(other);
  });
});
