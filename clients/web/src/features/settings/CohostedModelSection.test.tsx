// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { chooseListbox, listboxChoices } from "@/design/ui/listboxTestKit";
import { CohostedModelSection } from "./CohostedModelSection";

// #4145 (#4143 화면): 연결된 Hermes의 「모델」 구획. 고르면 PUT 에 provider·model 이 함께 가고, 추린 모델만 기본으로
// 보이며, 서버가 거절하면 이유를 말하고 화면은 서버의 지금 모양으로 돌아온다. API 는 mock 이다(엔진 PR #4149 계약).

const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  settingsRequest: api.request,
}));

const WS = "00000000-0000-7000-8000-000000000001";
const MODELS = {
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
        { id: "claude-3-opus", featured: false, current: false },
      ],
    },
    { provider: "openai-codex", models: [{ id: "gpt-5.5", featured: true, current: false }] },
  ],
};
const SAVED = (provider: string, model: string) => ({
  schema: "momo.cohosted_agent.model.v0",
  agentId: "a1",
  pinned: true,
  current: { provider, model },
});

const flags = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(opts: { offline?: boolean; invite?: boolean } = {}): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CohostedModelSection, { workspaceId: WS, offline: opts.offline ?? false, invite: opts.invite ?? false })
      )
    );
  });
  return host;
}
const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
async function until(id: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!q(id)) throw new Error(id);
  });
  return q(id) as HTMLElement;
}
const calls = () =>
  api.request.mock.calls.map((call) => `${(call[1] as RequestInit | undefined)?.method ?? "GET"} ${call[0]}`);
const putBodies = () =>
  api.request.mock.calls
    .filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT")
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)));
const MODELS_PATH = `/v1/workspaces/${WS}/cohosted-agent/models`;

beforeEach(() => {
  flags.IS_REACT_ACT_ENVIRONMENT = true;
  api.request.mockReset();
  api.request.mockImplementation((_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return Promise.resolve(SAVED(body.provider, body.model));
    }
    return Promise.resolve(MODELS);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = "";
});

describe("CohostedModelSection", () => {
  it("says which model answers now, with the provider", async () => {
    mount();
    const now = await until("ai-cohosted-model-now");
    expect(now.textContent).toBe("Claude Sonnet 5.5 · Anthropic");
    expect(calls()).toEqual([`GET ${MODELS_PATH}`]);
  });

  it("choosing a model PUTs provider and model together, then says so in place", async () => {
    mount();
    await until("ai-cohosted-model-now");
    chooseListbox(q("ai-cohosted-model-select"), `openai-codex\u0000gpt-5.5`);
    await until("ai-cohosted-model-saved");
    expect(putBodies()).toEqual([{ provider: "openai-codex", model: "gpt-5.5" }]);
    expect(calls().filter((c) => c.startsWith("PUT"))).toEqual([`PUT /v1/workspaces/${WS}/cohosted-agent/model`]);
    expect(q("ai-cohosted-model-now")?.textContent).toBe("gpt-5.5 · OpenAI Codex");
    expect(q("ai-cohosted-model-saved")?.textContent).toContain("모델을 바꿨어요");
  });

  it("shows featured models only by default and opens the rest behind 전체 보기", async () => {
    mount();
    await until("ai-cohosted-model-now");
    const featured = listboxChoices(q("ai-cohosted-model-select")).map((c) => c.value.split("\u0000")[1]);
    expect(featured).toEqual(["claude-sonnet-5-5", "claude-opus-5", "claude-haiku-4-5", "gpt-5.5"]);
    await act(async () => q("ai-cohosted-model-toggle")?.click());
    const all = listboxChoices(q("ai-cohosted-model-select")).map((c) => c.value.split("\u0000")[1]);
    expect(all).toContain("claude-3-opus");
    expect(q("ai-cohosted-model-toggle")?.textContent).toBe("추천만 보기");
  });

  it("choosing the model already in use sends nothing", async () => {
    mount();
    await until("ai-cohosted-model-now");
    chooseListbox(q("ai-cohosted-model-select"), `anthropic\u0000claude-sonnet-5-5`);
    await act(async () => undefined);
    expect(putBodies()).toEqual([]);
  });

  it("a refusal (422) is said in words, the pick is not kept, and the list is read again", async () => {
    api.request.mockImplementation((_path: string, init?: RequestInit) =>
      init?.method === "PUT" ? Promise.reject(new ApiError(422, "x", "cohosted_model_not_offered")) : Promise.resolve(MODELS)
    );
    mount();
    await until("ai-cohosted-model-now");
    chooseListbox(q("ai-cohosted-model-select"), `anthropic\u0000claude-opus-5`);
    const banner = await until("ai-cohosted-model-save-error");
    expect(banner.textContent).toContain("다시 골라");
    expect(q("ai-cohosted-model-now")?.textContent).toBe("Claude Sonnet 5.5 · Anthropic");
    expect(q("ai-cohosted-model-saved")).toBeNull();
    await waitFor(() => expect(calls().filter((c) => c === `GET ${MODELS_PATH}`).length).toBe(2));
  });

  it("draws nothing for a stranger, and nothing is written", async () => {
    api.request.mockRejectedValue(new ApiError(403, "no"));
    const el = mount();
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    await act(async () => undefined);
    expect(el.querySelector("[data-testid='ai-cohosted-model']")).toBeNull();
    expect(putBodies()).toEqual([]);
  });

  it("with no logged-in provider there is nothing to choose, and it points at logging in", async () => {
    api.request.mockResolvedValue({ ...MODELS, providers: [], current: undefined, pinned: false });
    mount();
    const none = await until("ai-cohosted-model-none");
    expect(none.textContent).toContain("로그인된 제공자가 없어요");
    expect(q("ai-cohosted-model-select")).toBeNull();
  });

  it("when Hermes does not answer (502) it says so with a retry; a later read recovers", async () => {
    api.request.mockRejectedValueOnce(new ApiError(502, "x", "cohosted_models_unavailable"));
    mount();
    const banner = await until("ai-cohosted-model-error");
    expect(banner.textContent).toContain("모델 목록을 주지 않았어요");
    await act(async () => banner.querySelector("button")?.click());
    await until("ai-cohosted-model-now");
  });

  it("right after connecting it asks 「어떤 모델로 쓸까요?」 instead of the plain title", async () => {
    mount({ invite: true });
    await until("ai-cohosted-model-now");
    expect(q("ai-cohosted-model")?.querySelector("h4")?.textContent).toBe("어떤 모델로 쓸까요?");
  });

  it("offline locks the choice and says why", async () => {
    mount({ offline: true });
    await until("ai-cohosted-model-now");
    expect(q("ai-cohosted-model-select")?.hasAttribute("disabled")).toBe(true);
    expect(q("ai-cohosted-model-offline")).not.toBeNull();
  });
});
