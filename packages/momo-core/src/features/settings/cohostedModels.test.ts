import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  settingsRequest: request,
}));

import {
  fetchCohostedModels,
  hasHiddenModels,
  loggedInProviders,
  modelLabel,
  modelOptions,
  modelsFromWire,
  modelSaveErrorMessage,
  putCohostedModel,
  splitModelValue,
  modelValue,
} from "./cohostedModels";

// #4145: 엔진 #4149의 응답 모양(openapi.operator.yaml CohostedAgentModels)을 그대로 먹는다.
const WIRE = {
  schema: "momo.cohosted_agent.models.v0",
  agentId: "a1",
  pinned: true,
  current: { provider: "anthropic", model: "claude-sonnet-5-5" },
  providers: [
    {
      provider: "anthropic",
      models: [
        { id: "claude-sonnet-5-5", featured: true, current: true },
        { id: "claude-opus-5", featured: true, current: false },
        { id: "claude-haiku-4-5", featured: true, current: false },
        { id: "claude-sonnet-4", featured: false, current: false },
        { id: "claude-3-opus", featured: false, current: false },
      ],
    },
    { provider: "openai-codex", models: [{ id: "gpt-5.5", featured: true, current: false }] },
  ],
};

beforeEach(() => request.mockReset());

describe("models read", () => {
  it("parses the wire shape and treats listed providers as the logged-in ones", async () => {
    request.mockResolvedValueOnce(WIRE);
    const read = await fetchCohostedModels("w");
    expect(request.mock.calls[0][0]).toBe("/v1/workspaces/w/cohosted-agent/models");
    expect(read.kind).toBe("ready");
    if (read.kind !== "ready") return;
    expect([...loggedInProviders(read.models)]).toEqual(["anthropic", "openai-codex"]);
    expect(read.models.current).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
  });

  it("is hidden for a stranger and an old server, unknown for a body it cannot read or a 5xx", async () => {
    request.mockRejectedValueOnce(new ApiError(403, "no"));
    expect(await fetchCohostedModels("w")).toEqual({ kind: "hidden" });
    request.mockRejectedValueOnce(new ApiError(404, "no"));
    expect(await fetchCohostedModels("w")).toEqual({ kind: "hidden" });
    request.mockResolvedValueOnce({ schema: "proxy" });
    expect((await fetchCohostedModels("w")).kind).toBe("unknown");
    request.mockRejectedValueOnce(new ApiError(502, "x", "cohosted_models_unavailable"));
    expect(await fetchCohostedModels("w")).toEqual({ kind: "unknown", code: "cohosted_models_unavailable" });
  });

  it("rejects a provider whose model list is malformed instead of guessing", () => {
    expect(modelsFromWire({ ...WIRE, providers: [{ provider: "anthropic", models: [{ featured: true }] }] })).toBeNull();
  });
});

describe("featured first", () => {
  const models = modelsFromWire(WIRE)!;
  const current = models.current;

  it("shows only featured models by default and the rest behind 전체 보기", () => {
    expect(modelOptions(models, false, current).map((o) => o.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "gpt-5.5",
    ]);
    expect(modelOptions(models, true, current).map((o) => o.model)).toContain("claude-3-opus");
    expect(hasHiddenModels(models, current)).toBe(true);
  });

  it("keeps the model in use visible even when it is not featured", () => {
    const old = { provider: "anthropic", model: "claude-3-opus" };
    expect(modelOptions(models, false, old).map((o) => o.model)).toContain("claude-3-opus");
    expect(modelOptions(models, false, old).map((o) => o.model)).not.toContain("claude-sonnet-4");
  });

  it("has no 전체 보기 when everything is featured", () => {
    const small = modelsFromWire({ ...WIRE, providers: [WIRE.providers[1]] })!;
    expect(hasHiddenModels(small, null)).toBe(false);
  });
});

describe("choose", () => {
  it("PUTs provider and model together, and returns what the server wrote", async () => {
    request.mockResolvedValueOnce({
      schema: "momo.cohosted_agent.model.v0",
      agentId: "a1",
      pinned: true,
      current: { provider: "openai-codex", model: "gpt-5.5" },
    });
    const saved = await putCohostedModel("w", { provider: "openai-codex", model: "gpt-5.5" });
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/workspaces/w/cohosted-agent/model");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(saved).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
  });

  it("an unreadable answer is an error, not a silent success", async () => {
    request.mockResolvedValueOnce({ schema: "momo.cohosted_agent.model.v0" });
    await expect(putCohostedModel("w", { provider: "a", model: "b" })).rejects.toBeInstanceOf(ApiError);
  });

  it("round-trips the option value even when a model id contains punctuation", () => {
    const ref = { provider: "openai-codex", model: "gpt-5.5:high/x" };
    expect(splitModelValue(modelValue(ref))).toEqual(ref);
    expect(splitModelValue("nonsense")).toBeNull();
  });

  it("says in words why it failed, and that nothing changed", () => {
    expect(modelSaveErrorMessage(new ApiError(422, "x", "cohosted_model_not_offered"))).toContain("다시 골라");
    expect(modelSaveErrorMessage(new ApiError(403, "x"))).toContain("운영자");
    expect(modelSaveErrorMessage(new ApiError(502, "x", "cohosted_models_unavailable"))).toContain("바뀐 것은 없어요");
  });
});

describe("labels", () => {
  it("reads claude ids as names and leaves unknown ids alone", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Claude Opus 4.1");
    expect(modelLabel("claude-opus-5")).toBe("Claude Opus 5");
    expect(modelLabel("gpt-5.5")).toBe("gpt-5.5");
  });
});
