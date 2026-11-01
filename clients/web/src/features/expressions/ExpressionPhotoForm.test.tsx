// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID, fixtureGeneratedDraft } from "@momo/core/features/expressions/fixtures";
import { PHOTO_REQUEST_TIMEOUT_MS, type PhotoFailure } from "@momo/core/features/expressions/photo";
import type { MessageKey } from "@momo/core/i18n";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { browserLocalePort, createAppLocale, type AppLocale } from "@/i18n/localeStore";
import { ExpressionStore } from "./ExpressionStore";
import { ExpressionHttpError, type ExpressionRequest, type ExpressionTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionPhotoForm } from "./ExpressionPhotoForm";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { makeFixturePhoto } from "./makeFixtures";

// 서버는 가짜 전송이다: 부른 요청(경로·본문·파일·시간)을 `calls`에 쌓고, 답은 시험이 정한다.
// 문장은 사전에서 읽어 비교한다(시험이 문구를 따로 들고 있지 않게). 한국어 한 줄과 영어 한 줄만 글자 그대로 본다.
const BASE = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}`;
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MODEL = { available: true, provider: "openai", branches: ["cutout", "caricature"], canManage: false };

let locale: AppLocale;
const t = (key: MessageKey, args?: Record<string, string>) => (locale.service.formatMessage as (key: string, args?: Record<string, string>) => string)(key, args);

function fake(script: { model?: () => unknown; draft?: (request: ExpressionRequest) => Promise<unknown> | unknown }) {
  const calls: ExpressionRequest[] = [];
  const transport: ExpressionTransport = {
    async json(request) {
      calls.push(request);
      if (request.method === "GET") return script.model ? script.model() : MODEL;
      if (request.path === `${BASE}/expressions/photo-drafts`) return script.draft!(request);
      throw new Error(`unscripted ${request.method} ${request.path}`);
    },
    async image() { return PIXEL; },
  };
  return { transport, calls, posts: () => calls.filter((call) => call.method === "POST") };
}

function Where() { const where = useLocation(); return <span data-testid="where">{where.pathname + where.search}</span>; }
const handlers = { onImport: vi.fn(), onAgent: vi.fn(), onDone: vi.fn(), onClose: vi.fn() };
function mount(transport: ExpressionTransport, ui: ReactNode = <ExpressionPhotoForm {...handlers} />) {
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  return render(<MemoryRouter initialEntries={["/"]}><LocaleProvider locale={locale}><ExpressionsContext.Provider value={store}>{ui}<Where /></ExpressionsContext.Provider></LocaleProvider></MemoryRouter>);
}
const id = (view: RenderResult, testId: string) => view.getByTestId(testId);
const type = (view: RenderResult, testId: string, value: string) => fireEvent.change(id(view, testId), { target: { value } });
const choose = (view: RenderResult, file: File) => fireEvent.change(id(view, "expression-photo-file"), { target: { files: { item: () => file, length: 1 } } });
const ready = async (view: RenderResult) => { await view.findByTestId("expression-photo-form"); };

/** 보낼 수 있는 상태로 채운다. */
async function fill(view: RenderResult, { name = "my_face", branch, photo = makeFixturePhoto(), consent = true }: { name?: string; branch?: MessageKey; photo?: File; consent?: boolean } = {}) {
  await ready(view);
  choose(view, photo);
  await view.findByTestId("expression-photo-preview");
  if (branch) fireEvent.click(view.getByLabelText(t(branch)));
  type(view, "expression-photo-name", name);
  type(view, "expression-photo-display-name", "내 얼굴");
  type(view, "expression-photo-tags", "사진, 얼굴");
  if (consent) fireEvent.click(id(view, "expression-photo-consent"));
  return photo;
}
const send = (view: RenderResult) => fireEvent.click(id(view, "expression-photo-submit"));

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["ko-KR"] });
  locale = await createAppLocale(browserLocalePort());
  for (const handler of Object.values(handlers)) handler.mockReset();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("모델이 있는지 먼저 묻는다", () => {
  it("확인하는 동안에는 양식이 없고, 없으면 만들지 않고 연결하라고 안내한다", async () => {
    const { transport, posts } = fake({ model: () => ({ ...MODEL, available: false, provider: null }) });
    const view = mount(transport);
    expect(view.queryByTestId("expression-photo-form")).toBeNull();
    expect(id(view, "expression-photo-checking").textContent).toContain(t("expressions.photo.checking"));
    const guide = await view.findByTestId("expression-photo-no-model");
    expect(guide.textContent).toContain("연결된 이미지 모델이 없어요");
    expect(guide.textContent).toContain(t("expressions.photo.noModelDetail"));
    expect(guide.textContent).toContain("OpenAI");
    expect(guide.textContent).toContain("Gemini");
    // 만들 길은 열려 있지 않다.
    expect(view.queryByTestId("expression-photo-form")).toBeNull();
    expect(view.queryByTestId("expression-photo-file")).toBeNull();
    expect(posts()).toEqual([]);
  });

  it("운영자가 아니면 운영자에게 알리라고 하고, 등록은 가져오기로 늘 된다", async () => {
    const { transport } = fake({ model: () => ({ ...MODEL, available: false, provider: null, canManage: false }) });
    const view = mount(transport);
    await view.findByTestId("expression-photo-no-model");
    expect(id(view, "expression-photo-ask").textContent).toBe(t("expressions.photo.noModelAsk"));
    expect(view.queryByTestId("expression-photo-manage")).toBeNull();
    fireEvent.click(id(view, "expression-photo-import"));
    expect(handlers.onImport).toHaveBeenCalledTimes(1);
  });

  it("운영자이면 설정으로 가는 길이 있다: AI 연결 설정으로 가고 고르개를 닫는다", async () => {
    const { transport } = fake({ model: () => ({ ...MODEL, available: false, provider: null, canManage: true }) });
    const view = mount(transport);
    await view.findByTestId("expression-photo-no-model");
    expect(view.queryByTestId("expression-photo-ask")).toBeNull();
    fireEvent.click(id(view, "expression-photo-manage"));
    expect(id(view, "where").textContent).toBe("/settings?section=ai");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("확인하지 못하면 줄과 다시 시도가 서고, 다시 시도하면 이어진다", async () => {
    let attempt = 0;
    const { transport, calls } = fake({ model: () => { if (attempt++ === 0) throw new Error("down"); return MODEL; } });
    const view = mount(transport);
    const banner = await view.findByTestId("expression-photo-check-error");
    expect(banner.textContent).toContain(t("expressions.photo.checkFailed"));
    // 확인이 안 돼도 에이전트에게 부탁하는 길은 막히지 않는다.
    fireEvent.click(id(view, "expression-photo-agent"));
    expect(handlers.onAgent).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByText(t("expressions.photo.retry")));
    await ready(view);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("추가 권한이 없다는 답이면 확인 실패가 아니라 그렇다고 말하고, 다시 시도는 두지 않는다", async () => {
    const { transport, calls } = fake({ model: () => { throw new ExpressionHttpError(403, "expression_role_required"); } });
    const view = mount(transport);
    const banner = await view.findByTestId("expression-photo-check-refused");
    expect(banner.textContent).toContain(t("expressions.photo.errorRole"));
    expect(banner.textContent).not.toContain(t("expressions.photo.checkFailed"));
    expect(view.queryByTestId("expression-photo-check-error")).toBeNull();
    expect(view.queryByText(t("expressions.photo.retry"))).toBeNull();
    expect(view.queryByTestId("expression-photo-form")).toBeNull();
    // 에이전트에게 부탁하는 길은 이 확인과 상관없이 열려 있다.
    fireEvent.click(id(view, "expression-photo-agent"));
    expect(handlers.onAgent).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("어긋난 답(모델이 있다는데 회사가 없다)은 믿지 않는다", async () => {
    const { transport } = fake({ model: () => ({ ...MODEL, provider: null }) });
    const view = mount(transport);
    await view.findByTestId("expression-photo-check-error");
    expect(view.queryByTestId("expression-photo-form")).toBeNull();
  });
});

describe("보내기 전 검사와 동의", () => {
  it("동의한 회사의 이름이 문장에 들어 있다", async () => {
    for (const [provider, shown] of [["openai", "OpenAI"], ["gemini", "Google Gemini"]] as const) {
      const { transport } = fake({ model: () => ({ ...MODEL, provider }) });
      const view = mount(transport);
      await ready(view);
      const row = id(view, "expression-photo-consent-row");
      expect(row.textContent).toBe(t("expressions.photo.consent", { provider: shown }));
      expect(row.textContent).toContain(shown);
      cleanup();
    }
  });

  it("사진도 동의도 없으면 보내지 않고 그 칸에 줄을 띄운다", async () => {
    const { transport, posts } = fake({ draft: () => { throw new Error("must not be called"); } });
    const view = mount(transport);
    await ready(view);
    send(view);
    expect((await view.findByTestId("expression-photo-error-photo")).textContent).toBe(t("expressions.photo.photoMissing"));
    expect(id(view, "expression-photo-error-consent").textContent).toBe(t("expressions.photo.consentMissing"));
    expect(posts()).toEqual([]);
    // 사진은 있어도 동의가 없으면 여전히 보내지 않는다.
    await fill(view, { consent: false });
    send(view);
    await waitFor(() => expect(id(view, "expression-photo-error-consent").textContent).toBe(t("expressions.photo.consentMissing")));
    expect(view.queryByTestId("expression-photo-error-photo")).toBeNull();
    expect(posts()).toEqual([]);
  });

  it("형식이 틀리거나 5 MiB를 넘는 사진, 이름 규칙 위반, 다른 사람 얼굴은 보내지 않는다", async () => {
    const { transport, posts } = fake({ draft: () => { throw new Error("must not be called"); } });
    const view = mount(transport);
    await ready(view);
    await fill(view, { photo: makeFixturePhoto("doc.pdf", "application/pdf") });
    send(view);
    expect((await view.findByTestId("expression-photo-error-photo")).textContent).toBe(t("expressions.photo.photoType"));
    const big = makeFixturePhoto("big.png");
    Object.defineProperty(big, "size", { value: 5 * 1024 * 1024 + 1 });
    choose(view, big);
    send(view);
    await waitFor(() => expect(id(view, "expression-photo-error-photo").textContent).toBe(t("expressions.photo.photoSize")));
    choose(view, makeFixturePhoto());
    type(view, "expression-photo-name", "A");
    send(view);
    await waitFor(() => expect(id(view, "expression-photo-error-fields").textContent).toBe(t("expressions.photo.fieldsInvalid")));
    type(view, "expression-photo-name", "grinning");
    send(view);
    await waitFor(() => expect(id(view, "expression-photo-error-fields").textContent).toBe(t("expressions.photo.errorName")));
    type(view, "expression-photo-name", "my_face");
    fireEvent.change(id(view, "expression-photo-face"), { target: { value: "2" } });
    send(view);
    await waitFor(() => expect(id(view, "expression-photo-error-face").textContent).toBe(t("expressions.photo.faceOtherBlocked")));
    expect(posts()).toEqual([]);
  });
});

describe("보내기", () => {
  it("사진은 파일로, 동의한 회사·갈래·이름은 본문으로, 자유 글 칸 없이 한 번 간다", async () => {
    const draft = fixtureGeneratedDraft(0);
    const { transport, posts } = fake({ draft: () => ({ draft, cutout: "unchanged" }) });
    const view = mount(transport);
    const photo = await fill(view, { branch: "expressions.photo.caricatureLabel" });
    fireEvent.change(id(view, "expression-photo-face"), { target: { value: "1" } });
    send(view);
    const made = await view.findByTestId("expression-photo-made");
    expect(posts()).toHaveLength(1);
    const request = posts()[0];
    expect(request).toMatchObject({ method: "POST", path: `${BASE}/expressions/photo-drafts`, file: photo, timeoutMs: PHOTO_REQUEST_TIMEOUT_MS });
    expect(request.body).toEqual({ branch: "caricature", acknowledgedProvider: "openai", name: "my_face", displayName: "내 얼굴", tags: ["사진", "얼굴"], subjectMemberId: FIXTURE_MEMBER_ID });
    // 서버가 배경에 한 일과, 보이는 그림이 곧 저장될 그림이라는 말.
    const note = id(view, "expression-photo-cutout");
    expect(note.getAttribute("data-cutout")).toBe("unchanged");
    expect(note.textContent).toBe(t("expressions.photo.cutoutUnchanged"));
    expect(made.textContent).toContain(draft.displayName);
  });

  it("동의한 회사는 화면이 말한 그 회사다: 요청에 그대로 실린다", async () => {
    for (const provider of ["openai", "gemini"] as const) {
      const { transport, posts } = fake({ model: () => ({ ...MODEL, provider }), draft: () => ({ draft: fixtureGeneratedDraft(0), cutout: "model" }) });
      const view = mount(transport);
      await fill(view);
      send(view);
      await view.findByTestId("expression-photo-made");
      expect((posts()[0].body as { acknowledgedProvider: string }).acknowledgedProvider).toBe(provider);
      cleanup();
    }
  });

  it("배경 지우기 결과는 서버가 한 일에 맞는 말을 하고, 캐리커처는 말이 없다", async () => {
    for (const [cutout, key] of [["model", "expressions.photo.cutoutModel"], ["erased", "expressions.photo.cutoutErased"]] as const) {
      const { transport } = fake({ draft: () => ({ draft: fixtureGeneratedDraft(0), cutout }) });
      const view = mount(transport);
      await fill(view);
      send(view);
      expect((await view.findByTestId("expression-photo-cutout")).textContent).toBe(t(key));
      cleanup();
    }
    const { transport } = fake({ draft: () => ({ draft: fixtureGeneratedDraft(0), cutout: null }) });
    const view = mount(transport);
    await fill(view);
    send(view);
    await view.findByTestId("expression-photo-made");
    expect(view.queryByTestId("expression-photo-cutout")).toBeNull();
  });

  it("두 번 눌러도 요청은 한 번이고, 가는 동안 양식은 잠기고 말을 한다", async () => {
    let release: (value: unknown) => void = () => {};
    const { transport, posts } = fake({ draft: () => new Promise((resolve) => { release = resolve; }) });
    const view = mount(transport);
    await fill(view);
    fireEvent.submit(id(view, "expression-photo-form"));
    fireEvent.submit(id(view, "expression-photo-form"));
    await view.findByTestId("expression-photo-busy");
    expect(id(view, "expression-photo-busy").textContent).toBe(t("expressions.photo.busy"));
    expect((id(view, "expression-photo-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((id(view, "expression-photo-file") as HTMLInputElement).disabled).toBe(true);
    expect(posts()).toHaveLength(1);
    release({ draft: fixtureGeneratedDraft(0), cutout: null });
    await view.findByTestId("expression-photo-made");
    expect(posts()).toHaveLength(1);
  });

  it("다른 워크스페이스의 초안이나 모양이 틀린 답은 받지 않고 실패로 말한다", async () => {
    const other = { ...fixtureGeneratedDraft(0), workspaceId: "00000000-0000-4000-8000-0000000000ff" };
    for (const answer of [{ draft: other, cutout: null }, { draft: fixtureGeneratedDraft(0), cutout: "kept" }, fixtureGeneratedDraft(0)]) {
      const { transport } = fake({ draft: () => answer });
      const view = mount(transport);
      await fill(view);
      send(view);
      await view.findByTestId("expression-photo-failure");
      expect(view.queryByTestId("expression-photo-made")).toBeNull();
      cleanup();
    }
  });

  const failures: [string, unknown, PhotoFailure, MessageKey][] = [
    ["연결된 모델이 없거나 키가 쓸 수 없음", new ExpressionHttpError(409, "image_model_unavailable"), "unavailable", "expressions.photo.errorUnavailable"],
    ["동의한 회사가 바뀜", new ExpressionHttpError(409, "image_model_changed"), "changed", "expressions.photo.errorChanged"],
    ["공급자가 사진을 거절", new ExpressionHttpError(422, "image_model_refused"), "refused", "expressions.photo.errorRefused"],
    ["공급자 오류", new ExpressionHttpError(502, "image_model_failed"), "failed", "expressions.photo.errorFailed"],
    ["시간 초과", new ExpressionHttpError(504, "image_model_timeout"), "timeout", "expressions.photo.errorTimeout"],
    ["서버가 바쁨", new ExpressionHttpError(503, undefined), "busy", "expressions.photo.errorBusy"],
    ["만드는 중인 초안이 너무 많음", new ExpressionHttpError(409, "expression_quota"), "quota", "expressions.photo.errorQuota"],
    ["권한 없음", new ExpressionHttpError(403, "expression_role_required"), "role", "expressions.photo.errorRole"],
    ["사진 형식", new ExpressionHttpError(415, "expression_media_invalid"), "media", "expressions.photo.errorMedia"],
    ["사진이 큼", new ExpressionHttpError(413, "expression_media_invalid"), "too_large", "expressions.photo.photoSize"],
    ["연결이 끊김", new TypeError("Failed to fetch"), "offline", "expressions.photo.errorOffline"],
  ];
  it.each(failures)("실패: %s", async (_label, error, want, key) => {
    const { transport, posts } = fake({ draft: () => { throw error; } });
    const view = mount(transport);
    await fill(view);
    send(view);
    const line = await view.findByTestId("expression-photo-failure");
    expect(line.getAttribute("data-failure")).toBe(want);
    expect(line.textContent).toBe(t(key));
    // 입력은 그대로이고 같은 양식에서 다시 보낼 수 있다.
    expect((id(view, "expression-photo-name") as HTMLInputElement).value).toBe("my_face");
    expect((id(view, "expression-photo-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it("만든 그림을 승인하면 등록 요청이 가고 양식이 닫힌다", async () => {
    const draft = fixtureGeneratedDraft(0);
    const { transport, calls } = fake({ draft: () => ({ draft, cutout: null }) });
    const view = mount(transport);
    await fill(view);
    send(view);
    await view.findByTestId("expression-photo-made");
    fireEvent.click(id(view, "expression-photo-again"));
    // 다른 사진으로 다시: 양식으로 돌아오고 동의는 다시 받는다.
    await ready(view);
    expect((id(view, "expression-photo-consent") as HTMLInputElement).checked).toBe(false);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("에이전트에게 부탁하는 길은 단추 하나로 남는다", async () => {
    const { transport } = fake({});
    const view = mount(transport);
    await ready(view);
    fireEvent.click(id(view, "expression-photo-agent"));
    expect(handlers.onAgent).toHaveBeenCalledTimes(1);
  });
});

describe("출처 문장 앞의 말", () => {
  const SERVER_SENTENCE = "사진을 바탕으로 새로 그린 캐리커처";
  it("사진 길의 초안은 서버가 쓴 문장이라 「만든 방법」이라고 말한다", async () => {
    const draft = fixtureGeneratedDraft(0, { prompt: SERVER_SENTENCE, sourceAttachmentId: null });
    const { transport } = fake({ draft: () => ({ draft, cutout: null }) });
    const view = mount(transport);
    await fill(view);
    send(view);
    await view.findByTestId("expression-photo-made");
    expect(id(view, "expression-draft-prompt").textContent).toBe(`${t("expressions.photo.originLabel")} ${SERVER_SENTENCE}`);
  });

  it("에이전트가 제안한 초안은 문장이 같아도 「에이전트가 쓴 설명」이다: 문장으로 가르지 않는다", async () => {
    const draft = fixtureGeneratedDraft(0, { prompt: SERVER_SENTENCE });
    const { transport } = fake({});
    const view = mount(transport, <ExpressionDraftCard draft={draft} onReplace={() => {}} onApprove={async () => {}} />);
    await waitFor(() => expect(view.queryByTestId("expression-draft-prompt")).not.toBeNull());
    expect(id(view, "expression-draft-prompt").textContent).toBe(`에이전트가 쓴 설명: ${SERVER_SENTENCE}`);
    expect(id(view, "expression-draft-prompt").textContent).not.toContain(t("expressions.photo.originLabel"));
  });
});

describe("문장은 사전에서 온다", () => {
  it("영어 설정이면 같은 양식이 영어로 말한다", async () => {
    await locale.setPreference("en-US");
    const { transport } = fake({ model: () => ({ ...MODEL, provider: "gemini" }) });
    const view = mount(transport);
    await ready(view);
    expect(id(view, "expression-photo-submit").textContent).toBe("Make it");
    expect(id(view, "expression-photo-consent-row").textContent).toBe("I agree to send my photo to Google Gemini. The cost is billed to the key your team connected.");
    expect(view.container.textContent).not.toMatch(/[가-힣]/);
  });
});
