import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { ProviderChain } from "./api";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsRequest: request,
}));

import {
  agentOwnsModel,
  agentPinFromWire,
  fetchAgentProviderPin,
  pinChoiceBody,
  pinOptions,
  pinSaveMessage,
  pinUnresolvedSentence,
  pinnableAgent,
  putAgentProviderPin,
} from "./agentProviderPin";

// #3875: 에이전트별 AI 연결 고정. 판정이 지는 것: 403/404 는 선택기를 그리지 않는 「없음」,
// 모양이 틀린 200 은 「핀 없음」이 아니라 오류, PUT 본문에는 참조뿐, 풀리지 않는 핀은 문장으로.

const SCHEMA = "momo.agent.provider_pin.v0";

function chain(entries: Partial<ProviderChain["entries"][number]>[]): ProviderChain {
  return {
    schema: "momo.provider_link.chain.v0",
    fallbackCount: 0,
    entries: entries.map((entry, index) => ({
      position: index,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://x.example/v1",
      endpointLabel: `https://host${index}.example/v1`,
      enabled: true,
      bearerConfigured: true,
      ...entry,
    })),
  };
}

beforeEach(() => request.mockReset());

describe("agentPinFromWire", () => {
  it("reads no pin, an env pin and a team pin", () => {
    expect(agentPinFromWire({ schema: SCHEMA, agentId: "a", pin: null })).toEqual({ pin: null });
    const env = agentPinFromWire({
      schema: SCHEMA,
      pin: { kind: "operator_env", endpointLabel: "http://hermes.railway.internal:8642/v1", linkResolved: true, updatedAtMs: 5 },
    });
    expect(env?.pin).toMatchObject({ kind: "operator_env", linkPosition: null, linkResolved: true });
    const team = agentPinFromWire({
      schema: SCHEMA,
      pin: { kind: "team_link", linkPosition: 2, endpointLabel: "https://h/v1", linkResolved: false, updatedAtMs: 6 },
    });
    expect(team?.pin).toMatchObject({ kind: "team_link", linkPosition: 2, linkResolved: false });
  });

  it("refuses a body it cannot read instead of reading it as 'no pin'", () => {
    expect(agentPinFromWire({ schema: "other", pin: null })).toBeNull();
    expect(agentPinFromWire({ schema: SCHEMA })).toBeNull();
    expect(agentPinFromWire({ schema: SCHEMA, pin: { kind: "team_link", linkResolved: true, updatedAtMs: 1 } })).toBeNull();
    expect(agentPinFromWire({ schema: SCHEMA, pin: { kind: "weird", linkResolved: true, updatedAtMs: 1 } })).toBeNull();
  });
});

describe("fetchAgentProviderPin", () => {
  it("maps 403 and 404 to quiet 'absent' answers and anything else to unknown", async () => {
    request.mockRejectedValueOnce(new ApiError(403, "no"));
    expect(await fetchAgentProviderPin("w", "a")).toEqual({ kind: "forbidden" });
    request.mockRejectedValueOnce(new ApiError(404, "no"));
    expect(await fetchAgentProviderPin("w", "a")).toEqual({ kind: "absent" });
    request.mockRejectedValueOnce(new ApiError(500, "boom"));
    expect((await fetchAgentProviderPin("w", "a")).kind).toBe("unknown");
    request.mockResolvedValueOnce({ schema: "proxy-200" });
    expect((await fetchAgentProviderPin("w", "a")).kind).toBe("unknown");
    request.mockResolvedValueOnce({ schema: SCHEMA, pin: null });
    expect(await fetchAgentProviderPin("w", "a")).toEqual({ kind: "ready", pin: null });
  });
});

describe("put body", () => {
  it("carries a reference and nothing else", async () => {
    expect(pinChoiceBody({ kind: "default" })).toEqual({ kind: "default" });
    expect(pinChoiceBody({ kind: "operator_env" })).toEqual({ kind: "operator_env" });
    expect(pinChoiceBody({ kind: "team_link", linkPosition: 3 })).toEqual({ kind: "team_link", linkPosition: 3 });
    request.mockResolvedValueOnce({ schema: SCHEMA, pin: null });
    await putAgentProviderPin("w", "a", { kind: "default" });
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/workspaces/w/agents/a/provider-pin");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "default" });
  });

  it("throws on a body it cannot read so a stored pin is never reported as cleared", async () => {
    request.mockResolvedValueOnce({ schema: "x" });
    await expect(putAgentProviderPin("w", "a", { kind: "default" })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("pinOptions", () => {
  it("offers default, the env link only when the server has one, and enabled team links", () => {
    const entries = chain([{ source: "provider_link" }, { enabled: false }, { source: "chain" }]);
    const none = pinOptions({ pin: null, chain: entries, envLinkAvailable: false, ownsModel: true });
    expect(none.map((o) => o.key)).toEqual(["default", "team_link:0", "team_link:2"]);
    expect(none[1]?.label).toBe("연결 1: https://host0.example/v1");
    const withEnv = pinOptions({ pin: null, chain: entries, envLinkAvailable: true, ownsModel: true });
    expect(withEnv.map((o) => o.key)).toContain("operator_env");
  });

  it("never offers the environment head as a team link (position 0 is the stored link)", () => {
    const entries = chain([{ source: "environment" }]);
    const options = pinOptions({ pin: null, chain: entries, envLinkAvailable: true, ownsModel: true });
    expect(options.map((o) => o.key)).toEqual(["default", "operator_env"]);
  });

  it("locks team links until the agent owns its model, with the reason", () => {
    const options = pinOptions({ pin: null, chain: chain([{ source: "provider_link" }]), envLinkAvailable: false, ownsModel: false });
    const team = options.find((o) => o.key === "team_link:0");
    expect(team?.disabled).toBe(true);
    expect(team?.hint).toContain("자기 모델");
  });

  it("keeps a stored pin whose link vanished, marked as changed and not pickable", () => {
    const pin = agentPinFromWire({
      schema: SCHEMA,
      pin: { kind: "team_link", linkPosition: 4, endpointLabel: "https://gone/v1", linkResolved: false, updatedAtMs: 1 },
    })?.pin ?? null;
    const options = pinOptions({ pin, chain: chain([{ source: "provider_link" }]), envLinkAvailable: false, ownsModel: true });
    const ghost = options.find((o) => o.key === "team_link:4");
    expect(ghost?.label).toContain("(바뀜)");
    expect(ghost?.disabled).toBe(true);
    expect(pinUnresolvedSentence(pin!)).toContain("다른 연결로 넘어가지 않고");
  });
});

describe("agent facts and messages", () => {
  it("does not offer a picker for personal or subscription agents", () => {
    expect(pinnableAgent({ callableBy: "owner_only", brain: "team_key" })).toBe(false);
    expect(pinnableAgent({ brain: "subscription" })).toBe(false);
    expect(pinnableAgent({ brain: "personal_key" })).toBe(false);
    expect(pinnableAgent({ callableBy: "everyone", brain: "team_key" })).toBe(true);
    expect(pinnableAgent({})).toBe(true);
  });

  it("an instance_default agent does not own a model", () => {
    expect(agentOwnsModel({ brain: "instance_default" })).toBe(false);
    expect(agentOwnsModel({ brain: "team_key" })).toBe(true);
  });

  it("names the server's refusals by code, never by its wording", () => {
    expect(pinSaveMessage(new ApiError(409, "x", "owner_only_agent_cannot_be_pinned"))).toContain("개인 에이전트");
    expect(pinSaveMessage(new ApiError(409, "x", "agent_own_model_required"))).toContain("자기 모델");
    expect(pinSaveMessage(new ApiError(403, "x"))).toContain("운영자");
    expect(pinSaveMessage(new ApiError(500, "x"))).toContain("저장하지 못했어요");
  });
});
