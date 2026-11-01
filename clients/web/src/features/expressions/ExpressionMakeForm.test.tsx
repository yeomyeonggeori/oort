// @vitest-environment jsdom
import { StrictMode, useState, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { createPortal } from "react-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { buildMakeRequest, MAKE_NOTE_MAX } from "@momo/core/features/expressions/make";
import type { Channel, Message, RosterMember } from "@momo/core/lib/api";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionMakeForm } from "./ExpressionMakeForm";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
import { MAKE_FIXTURE_AGENT, MAKE_FIXTURE_AGENT_B, MAKE_FIXTURE_AGENT_B_ID, MAKE_FIXTURE_AGENT_ID, makeFixtureAgent, makeFixturePhoto } from "./makeFixtures";

// 네트워크에 닿는 다섯 함수와 바이트 PUT 은 가짜로 바꾸고, 부른 순서를 `order` 한 줄에 쌓는다.
// 순서는 호출 횟수가 아니라 이 배열로 잰다.
const api = vi.hoisted(() => ({
  fetchRoster: vi.fn(),
  openDirectMessage: vi.fn(),
  createAttachmentUpload: vi.fn(),
  completeAttachmentUpload: vi.fn(),
  sendMessage: vi.fn(),
  putAttachmentBytes: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), ...api }));
vi.mock("@/features/attachments/uploadTransport", () => ({ putAttachmentBytes: (...args: unknown[]) => api.putAttachmentBytes(...args) }));

const DM_ID = "00000000-0000-7000-8000-0000000000d1";
const DM_B_ID = "00000000-0000-7000-8000-0000000000d2";
const ATTACHMENT_ID = "00000000-0000-7000-8000-0000000000a7";
const UPLOAD_URL = "https://upload.invalid/capability";
const dmFor = (id: string): Channel => ({ id, workspaceId: FIXTURE_WORKSPACE_ID, kind: "dm", muted: false, memberIds: [FIXTURE_MEMBER_ID] }) as unknown as Channel;
const order: string[] = [];
const PHOTO = "expression-make-photo";
const SUBMIT = "expression-make-submit";
const chip = (id: string) => `expression-make-chip-${id}`;
// 금지어는 조각으로 적어 이 파일에도 그대로 남지 않게 한다.
const BANNED = [["그", "리기"], ["그", "려"], ["그", "리는"]].map((parts) => parts.join(""));
const hasBanned = (text: string) => BANNED.some((word) => text.includes(word));

function setup(roster: RosterMember[] = [MAKE_FIXTURE_AGENT]) {
  order.length = 0;
  api.fetchRoster.mockReset().mockResolvedValue(roster);
  api.openDirectMessage.mockReset().mockImplementation(async (_workspace: string, memberId: string) => { order.push("dm"); return { channel: dmFor(memberId === MAKE_FIXTURE_AGENT_B_ID ? DM_B_ID : DM_ID), created: true }; });
  api.createAttachmentUpload.mockReset().mockImplementation(async () => { order.push("create"); return { id: ATTACHMENT_ID, status: "pending", uploadUrl: UPLOAD_URL }; });
  api.putAttachmentBytes.mockReset().mockImplementation(() => { order.push("put"); return { done: Promise.resolve({ ok: true }), abort: vi.fn() }; });
  api.completeAttachmentUpload.mockReset().mockImplementation(async () => { order.push("complete"); return { id: ATTACHMENT_ID, status: "complete" }; });
  api.sendMessage.mockReset().mockImplementation(async () => { order.push("send"); return { id: "message" } as Message; });
}

function makeStore() {
  return new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
}
function Where() { return <span data-testid="where">{useLocation().pathname}</span>; }
function mount(ui: ReactNode, store = makeStore()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/"]}><ExpressionsContext.Provider value={store}>{ui}<Where /></ExpressionsContext.Provider></MemoryRouter></QueryClientProvider>);
  return { view, store, client };
}
const form = (onClose?: () => void, onImport: () => void = () => {}) => <ExpressionMakeForm onImport={onImport} onClose={onClose} />;
const photoInput = (view: RenderResult) => view.getByTestId(PHOTO) as HTMLInputElement;
const choose = (view: RenderResult, file: File) => fireEvent.change(photoInput(view), { target: { files: { item: () => file, length: 1 } } });
const agentSelect = (view: RenderResult) => view.getByTestId("expression-make-agent") as HTMLSelectElement;
const pressed = (view: RenderResult, id: string) => view.getByTestId(chip(id)).getAttribute("aria-pressed");
const sizedFile = (size: number, name = "big.png", type = "image/png") => { const file = makeFixturePhoto(name, type); Object.defineProperty(file, "size", { value: size }); return file; };

/** 보낼 수 있는 상태로 채운다: 에이전트 선택, 사진, 움직임, 메모. */
async function fill(view: RenderResult, { presets = ["bounce"], note = "", photo = makeFixturePhoto() }: { presets?: string[]; note?: string; photo?: File } = {}) {
  await waitFor(() => expect(agentSelect(view).value).not.toBe(""));
  choose(view, photo);
  await view.findByTestId("expression-make-photo-preview");
  for (const id of presets) fireEvent.click(view.getByTestId(chip(id)));
  if (note !== "") fireEvent.change(view.getByTestId("expression-make-note"), { target: { value: note } });
  return photo;
}
const send = (view: RenderResult) => fireEvent.click(view.getByTestId(SUBMIT));
const errorText = (view: RenderResult) => view.getByTestId("expression-make-error").textContent;
const hiddenOf = (view: RenderResult, id: string) => (view.getByTestId(id) as HTMLElement).hidden;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
  setup();
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(URL, "createObjectURL"); });

describe("원본 사진 검사", () => {
  it("사진이 없으면 보내지 않고 사진 칸에 줄을 띄우고 초점을 옮겨요", async () => {
    const { view } = mount(form());
    await waitFor(() => expect(agentSelect(view).value).toBe(MAKE_FIXTURE_AGENT_ID));
    fireEvent.click(view.getByTestId(chip("bounce")));
    send(view);
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("원본 사진을 골라 주세요.");
    expect(document.activeElement).toBe(photoInput(view));
    expect(api.openDirectMessage).not.toHaveBeenCalled();
    // 사진을 고르면 그 줄은 걷힌다.
    choose(view, makeFixturePhoto());
    await view.findByTestId("expression-make-photo-preview");
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("");
  });
  it("형식이 틀린 파일은 미리보기 없이 막아요", async () => {
    const { view } = mount(form());
    await waitFor(() => expect(agentSelect(view).value).not.toBe(""));
    choose(view, makeFixturePhoto("logo.svg", "image/svg+xml"));
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("PNG, JPG, WebP 또는 GIF 사진을 골라 주세요.");
    expect(view.queryByTestId("expression-make-photo-preview")).toBeNull();
    fireEvent.click(view.getByTestId(chip("bounce")));
    send(view);
    expect(api.openDirectMessage).not.toHaveBeenCalled();
  });
  it("5 MiB를 넘는 사진은 막고 정확히 5 MiB는 받아요", async () => {
    const { view } = mount(form());
    await waitFor(() => expect(agentSelect(view).value).not.toBe(""));
    choose(view, sizedFile(5 * 1024 * 1024 + 1));
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("사진이 너무 커요. 5MB 이하로 골라 주세요.");
    choose(view, sizedFile(5 * 1024 * 1024));
    await view.findByTestId("expression-make-photo-preview");
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("");
    choose(view, sizedFile(0, "empty.png"));
    expect(view.getByTestId("expression-make-photo-error").textContent).toBe("비어 있는 파일이에요. 다른 사진을 골라 주세요.");
  });
  it("미리보기는 data: 주소이고 blob: 을 만들지 않아요(배포 CSP)", async () => {
    const createObjectURL = vi.fn(() => "blob:never");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    const { view } = mount(form());
    await fill(view);
    const src = view.getByTestId("expression-make-photo-preview").querySelector("img")!.getAttribute("src")!;
    expect(src.startsWith("data:image/png")).toBe(true);
    expect(view.getByTestId("expression-make-preview-bounce").querySelector("img")!.getAttribute("src")).toBe(src);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it("디코드할 수 있으면 비율을 지켜 줄인 data: 그림을 쓰고 가로세로 한도를 재요", async () => {
    const drawImage = vi.fn();
    const bitmap = vi.fn().mockResolvedValue({ width: 1600, height: 900, close: vi.fn() });
    vi.stubGlobal("createImageBitmap", bitmap);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage }) as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,VEhVTUI=");
    const { view } = mount(form());
    await fill(view);
    expect(view.getByTestId("expression-make-photo-preview").querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,VEhVTUI=");
    expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 192, 108]);
    bitmap.mockResolvedValue({ width: 4097, height: 100, close: vi.fn() });
    choose(view, makeFixturePhoto("wide.png"));
    await waitFor(() => expect(view.getByTestId("expression-make-photo-error").textContent).toContain("가로세로가 너무 커요"));
    expect(view.queryByTestId("expression-make-photo-preview")).toBeNull();
    send(view);
    expect(api.openDirectMessage).not.toHaveBeenCalled();
  });
  it("열 수 없는 사진은 막아요", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode")));
    const { view } = mount(form());
    await waitFor(() => expect(agentSelect(view).value).not.toBe(""));
    choose(view, makeFixturePhoto());
    await waitFor(() => expect(view.getByTestId("expression-make-photo-error").textContent).toBe("이 사진을 열 수 없어요. 다른 사진을 골라 주세요."));
    fireEvent.click(view.getByTestId(chip("bounce")));
    send(view);
    expect(api.openDirectMessage).not.toHaveBeenCalled();
  });
});

describe("움직임 칩", () => {
  it("움직임을 하나도 안 고르면 막고 첫 칩에 초점을 줘요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    send(view);
    expect(view.getByTestId("expression-make-motion-status").textContent).toBe("움직임을 하나 이상 고르거나 「움직임 없이」를 골라 주세요.");
    expect(document.activeElement).toBe(view.getByTestId(chip("bounce")));
    expect(api.openDirectMessage).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId(chip("bounce")));
    expect(view.getByTestId("expression-make-motion-status").textContent).toBe("");
  });
  it("네 개를 고른 뒤 다섯 번째 칩은 막고 이유를 한 줄로 말해요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: ["bounce", "wobble", "pulse", "sparkle"] });
    expect(["bounce", "wobble", "pulse", "sparkle"].map((id) => pressed(view, id))).toEqual(["true", "true", "true", "true"]);
    fireEvent.click(view.getByTestId(chip("still")));
    expect(pressed(view, "still")).toBe("false");
    expect(["bounce", "wobble", "pulse", "sparkle"].map((id) => pressed(view, id))).toEqual(["true", "true", "true", "true"]);
    expect(view.getByTestId("expression-make-motion-status").textContent).toBe("「움직임 없이」는 다른 움직임과 함께 고를 수 없어요. 먼저 고른 쪽을 해제해 주세요.");
    fireEvent.click(view.getByTestId(chip("pulse")));
    expect(view.getByTestId("expression-make-motion-status").textContent).toBe("");
  });
  it("「움직임 없이」는 혼자만이에요: 서로를 막고 해제하면 풀려요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    fireEvent.click(view.getByTestId(chip("still")));
    expect(pressed(view, "still")).toBe("true");
    fireEvent.click(view.getByTestId(chip("bounce")));
    expect(pressed(view, "bounce")).toBe("false");
    expect(view.getByTestId("expression-make-motion-status").textContent).toContain("함께 고를 수 없어요");
    fireEvent.click(view.getByTestId(chip("still")));
    expect(pressed(view, "still")).toBe("false");
    fireEvent.click(view.getByTestId(chip("bounce")));
    expect(pressed(view, "bounce")).toBe("true");
  });
  it("칩은 안 눌린 채로 시작하고 진짜 버튼이에요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    for (const id of ["bounce", "wobble", "pulse", "sparkle", "still"]) {
      const button = view.getByTestId(chip(id));
      expect([button.tagName, button.getAttribute("type"), button.getAttribute("aria-pressed")]).toEqual(["BUTTON", "button", "false"]);
    }
  });
});

describe("메모와 에이전트", () => {
  it("메모는 500자까지이고 501자는 보내기에서 막아요", async () => {
    const { view } = mount(form());
    await fill(view, { note: "가".repeat(500) });
    expect(view.getByTestId("expression-make-note-count").textContent).toBe(`500/${MAKE_NOTE_MAX}`);
    fireEvent.change(view.getByTestId("expression-make-note"), { target: { value: "가".repeat(501) } });
    expect(view.getByTestId("expression-make-note-count").textContent).toBe("501/500");
    send(view);
    expect(view.getByText("요청 메모는 500자까지 쓸 수 있어요.")).toBeTruthy();
    expect(document.activeElement).toBe(view.getByTestId("expression-make-note"));
    expect(api.openDirectMessage).not.toHaveBeenCalled();
    fireEvent.change(view.getByTestId("expression-make-note"), { target: { value: "가".repeat(500) } });
    expect(view.queryByText("요청 메모는 500자까지 쓸 수 있어요.")).toBeNull();
  });
  it("공백만 있는 메모는 빈 메모라 요청 줄이 없어요", async () => {
    const { view } = mount(form());
    await fill(view, { note: "   \n  " });
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][3]).toBe(buildMakeRequest({ presets: ["bounce"] }));
    expect(api.sendMessage.mock.calls[0][3]).not.toContain("요청:");
  });
  it("에이전트가 하나면 미리 골라 두고 안내 한 줄을 보여요", async () => {
    const { view } = mount(form());
    await waitFor(() => expect(agentSelect(view).value).toBe(MAKE_FIXTURE_AGENT_ID));
    expect(view.getByText("그림 만들기 도구가 없는 에이전트는 만들 수 없다고 답해요.")).toBeTruthy();
  });
  it("에이전트만 보이고 여럿이면 사람이 골라요", async () => {
    const human = makeFixtureAgent("00000000-0000-7000-8000-0000000000f1", "사람 멤버", "human", { kind: "human" });
    const gone = makeFixtureAgent("00000000-0000-7000-8000-0000000000f2", "그만둔 에이전트", "gone", { status: "suspended" });
    const asleep = makeFixtureAgent("00000000-0000-7000-8000-0000000000f3", "자는 에이전트", "asleep", { paused: true });
    setup([human, MAKE_FIXTURE_AGENT, gone, MAKE_FIXTURE_AGENT_B, asleep]);
    const { view } = mount(form());
    await waitFor(() => expect(view.queryByTestId("skeleton")).toBeNull());
    expect(Array.from(agentSelect(view).options).map((option) => option.textContent)).toEqual(["에이전트를 골라 주세요", "김인턴", "마루", "자는 에이전트 (잠들어 있어요)"]);
    expect(agentSelect(view).value).toBe("");
  });
  it("여럿일 때 고르지 않으면 막고, 고른 에이전트에게 요청이 가요", async () => {
    setup([MAKE_FIXTURE_AGENT, MAKE_FIXTURE_AGENT_B]);
    const { view } = mount(form());
    await waitFor(() => expect(view.queryByTestId("skeleton")).toBeNull());
    choose(view, makeFixturePhoto());
    await view.findByTestId("expression-make-photo-preview");
    fireEvent.click(view.getByTestId(chip("bounce")));
    send(view);
    expect(view.getByText("만들 에이전트를 골라 주세요.")).toBeTruthy();
    expect(document.activeElement).toBe(agentSelect(view));
    expect(api.openDirectMessage).not.toHaveBeenCalled();
    fireEvent.change(agentSelect(view), { target: { value: MAKE_FIXTURE_AGENT_B_ID } });
    expect(view.queryByText("만들 에이전트를 골라 주세요.")).toBeNull();
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.openDirectMessage.mock.calls[0].slice(0, 2)).toEqual([FIXTURE_WORKSPACE_ID, MAKE_FIXTURE_AGENT_B_ID]);
    expect(api.sendMessage.mock.calls[0][1]).toBe(DM_B_ID);
  });
});

describe("네 상태", () => {
  it("불러오는 중에는 막대가 서고 보낼 수 없어요", async () => {
    api.fetchRoster.mockReturnValue(new Promise(() => {}));
    const { view } = mount(form());
    expect(view.getByTestId("skeleton")).toBeTruthy();
    expect((view.getByTestId(SUBMIT) as HTMLButtonElement).disabled).toBe(true);
    // 기다리는 동안에도 사진과 움직임은 미리 고를 수 있다.
    expect(hiddenOf(view, "expression-make-body")).toBe(false);
  });
  it("에이전트가 없으면 빈 상태 한 줄과 가져오기 행동만 서고 양식은 숨어요", async () => {
    setup([]);
    const onImport = vi.fn();
    const { view } = mount(form(undefined, onImport));
    await view.findByTestId("expression-make-empty");
    expect(view.getByText("아직 에이전트가 없어요")).toBeTruthy();
    expect([hiddenOf(view, "expression-make-body"), hiddenOf(view, "expression-make-footer")]).toEqual([true, true]);
    fireEvent.click(view.getByRole("button", { name: "가져오기" }));
    expect(onImport).toHaveBeenCalledTimes(1);
  });
  it("목록을 못 불러오면 줄과 다시 시도가 서고 다시 시도하면 이어져요", async () => {
    api.fetchRoster.mockRejectedValueOnce(new Error("offline"));
    const { view } = mount(form());
    const banner = await view.findByTestId("expression-make-roster-error");
    expect(banner.textContent).toContain("에이전트 목록을 불러오지 못했어요");
    expect([hiddenOf(view, "expression-make-body"), hiddenOf(view, "expression-make-footer")]).toEqual([true, true]);
    fireEvent.click(view.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(agentSelect(view).value).toBe(MAKE_FIXTURE_AGENT_ID));
    expect([hiddenOf(view, "expression-make-body"), hiddenOf(view, "expression-make-footer")]).toEqual([false, false]);
    expect(view.queryByTestId("expression-make-roster-error")).toBeNull();
  });
  it("성공하면 보냈다는 줄이 서요", async () => {
    const { view } = mount(form());
    await fill(view);
    send(view);
    expect((await view.findByTestId("expression-make-sent")).textContent).toBe("요청을 보냈어요. 에이전트의 답과 승인 카드는 대화에서 볼 수 있어요.");
    expect(view.getByTestId("expression-make-form").getAttribute("data-state")).toBe("sent");
    expect((view.getByTestId(SUBMIT) as HTMLButtonElement).disabled).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("보내는 순서", () => {
  it("DM 열기, 첨부 올리기, 보내기 순서로 가고 본문과 첨부는 한 메시지예요", async () => {
    const { view, client } = mount(form());
    const photo = await fill(view, { presets: ["sparkle", "bounce"], note: "웃는 얼굴로" });
    send(view);
    await waitFor(() => expect(order).toEqual(["dm", "create", "put", "complete", "send"]));
    expect(api.openDirectMessage.mock.calls[0]).toEqual([FIXTURE_WORKSPACE_ID, MAKE_FIXTURE_AGENT_ID]);
    expect(api.createAttachmentUpload.mock.calls[0]).toEqual([FIXTURE_WORKSPACE_ID, DM_ID, { name: "photo.png", mime: "image/png", size: photo.size }]);
    const put = api.putAttachmentBytes.mock.calls[0];
    expect([put[0], put[1], put[2]]).toEqual([UPLOAD_URL, photo, "image/png"]);
    expect(api.completeAttachmentUpload.mock.calls[0]).toEqual([FIXTURE_WORKSPACE_ID, DM_ID, ATTACHMENT_ID]);
    const call = api.sendMessage.mock.calls[0];
    expect(call.slice(0, 2)).toEqual([FIXTURE_WORKSPACE_ID, DM_ID]);
    expect(call[2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(call[3]).toBe(["이 사진으로 움직이는 팀 이모티콘을 만들어 주세요.", "- 움직임: 통통(bounce), 반짝(sparkle)", "- 크기: 360", "- 요청: 웃는 얼굴로"].join("\n"));
    expect(call[4]).toEqual({ attachmentIds: [ATTACHMENT_ID] });
    // 본문에는 파일 이름도 주소도 id 도 없다.
    for (const leaked of ["photo.png", UPLOAD_URL, ATTACHMENT_ID, DM_ID]) expect(call[3]).not.toContain(leaked);
    await waitFor(() => expect(view.getByTestId("where").textContent).toBe(`/c/${DM_ID}`));
    expect((client.getQueryData(["channels", FIXTURE_WORKSPACE_ID]) as Channel[]).map((channel) => channel.id)).toEqual([DM_ID]);
  });
  it("「움직임 없이」 요청은 새 이모티콘 문장과 없음(정지) 줄이에요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: ["still"] });
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.sendMessage.mock.calls[0][3]).toBe(["이 사진으로 새 팀 이모티콘을 만들어 주세요.", "- 움직임: 없음(정지)", "- 크기: 360"].join("\n"));
  });
  it("보낸 뒤에 고르개를 닫고 그 DM으로 이동해요(엄격 모드에서도 한 번)", async () => {
    const onClose = vi.fn();
    const { view } = mount(<StrictMode>{form(onClose)}</StrictMode>);
    await fill(view);
    send(view);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("where").textContent).toBe(`/c/${DM_ID}`);
    expect(order.at(-1)).toBe("send");
  });
  it("두 번 눌러도 요청은 한 번이에요", async () => {
    let release!: () => void;
    api.openDirectMessage.mockImplementation(() => new Promise((resolve) => { release = () => { order.push("dm"); resolve({ channel: dmFor(DM_ID), created: true }); }; }));
    const { view } = mount(form());
    await fill(view);
    // 한 번의 act 안에서 제출이 두 번 들어온다: 화면 상태가 아직 바뀌기 전이라 자물쇠만이 막는다.
    const target = view.getByTestId("expression-make-form");
    act(() => { fireEvent.submit(target); fireEvent.submit(target); });
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
    expect(view.getByTestId(SUBMIT).getAttribute("aria-disabled")).toBe("true");
    expect(view.getByTestId(SUBMIT).textContent).toBe("요청 보내는 중");
    expect(view.getByTestId("expression-make-status").textContent).toBe("에이전트와 대화 여는 중");
    send(view);
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["dm", "create", "put", "complete", "send"]);
  });
  it("제출 이벤트는 바깥 폼으로 오르지 않아요(컴포저 폼 안의 포털에서 열릴 때)", async () => {
    const outer = vi.fn();
    // 포털은 DOM 에서는 밖이지만 React 이벤트는 React 트리의 조상 폼까지 오른다.
    const { view } = mount(<form onSubmit={(event) => { event.preventDefault(); outer(); }}>{createPortal(form(), document.body)}</form>);
    await fill(view);
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(outer).not.toHaveBeenCalled();
  });
  it("오프라인이면 보내기를 막고 이유를 말해요", async () => {
    const { view, store } = mount(form());
    await fill(view);
    await act(async () => { store.setOffline(true); });
    const button = view.getByTestId(SUBMIT) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText("연결이 끊겼어요. 연결되면 요청을 보낼 수 있어요.").id).toBe(button.getAttribute("aria-describedby"));
    fireEvent.submit(view.getByTestId("expression-make-form"));
    expect(api.openDirectMessage).not.toHaveBeenCalled();
    await act(async () => { store.setOffline(false); });
    expect((view.getByTestId(SUBMIT) as HTMLButtonElement).disabled).toBe(false);
  });
  it("화면이 사라지면 올리던 것을 멈추고 보내지 않아요", async () => {
    let finish!: (result: { ok: boolean; failure?: string }) => void;
    const abort = vi.fn(() => finish({ ok: false, failure: "aborted" }));
    api.putAttachmentBytes.mockImplementation(() => { order.push("put"); return { done: new Promise((resolve) => { finish = resolve; }), abort }; });
    const { view } = mount(form());
    await fill(view);
    send(view);
    await waitFor(() => expect(order).toEqual(["dm", "create", "put"]));
    view.unmount();
    expect(abort).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); });
    expect(api.completeAttachmentUpload).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("화면이 사라진 뒤", () => {
  type Pending = "openDirectMessage" | "createAttachmentUpload" | "completeAttachmentUpload";
  /** 그 호출이 끝나기 전에 화면을 지우고, 그제서야 호출을 끝낸다. */
  async function unmountWhile(pending: Pending, result: unknown) {
    let release!: () => void;
    api[pending].mockImplementation(() => new Promise((resolve) => { release = () => resolve(result); }));
    const { view } = mount(form());
    await fill(view);
    send(view);
    await waitFor(() => expect(api[pending]).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
  }
  it("대화를 여는 중이었으면 첨부를 올리지 않아요", async () => {
    await unmountWhile("openDirectMessage", { channel: dmFor(DM_ID), created: true });
    expect(api.createAttachmentUpload).not.toHaveBeenCalled();
  });
  it("올릴 자리를 받는 중이었으면 바이트를 보내지 않아요", async () => {
    await unmountWhile("createAttachmentUpload", { id: ATTACHMENT_ID, status: "pending", uploadUrl: UPLOAD_URL });
    expect(api.putAttachmentBytes).not.toHaveBeenCalled();
  });
  it("올린 파일을 확인하는 중이었으면 메시지를 보내지 않아요", async () => {
    await unmountWhile("completeAttachmentUpload", { id: ATTACHMENT_ID, status: "complete" });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("단계별 실패와 다시 시도", () => {
  it("대화를 열지 못하면 그 줄을 보이고 첨부는 건드리지 않아요", async () => {
    api.openDirectMessage.mockRejectedValueOnce(new Error("down"));
    const { view } = mount(form());
    await fill(view);
    send(view);
    expect(await view.findByTestId("expression-make-error")).toBeTruthy();
    expect(errorText(view)).toBe("에이전트와 대화를 열지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    expect(api.createAttachmentUpload).not.toHaveBeenCalled();
    expect(view.getByTestId(SUBMIT).textContent).toBe("다시 시도");
  });
  it("첨부를 올리지 못하면 그 줄을 보이고 보내지 않아요: 세 왕복 어디서 떨어져도 같아요", async () => {
    const cases: [string, () => void][] = [
      ["create", () => api.createAttachmentUpload.mockRejectedValueOnce(new Error("down"))],
      ["put", () => api.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: false, failure: "network" }), abort: vi.fn() }))],
      ["complete", () => api.completeAttachmentUpload.mockRejectedValueOnce(new Error("down"))],
    ];
    for (const [, arrange] of cases) {
      cleanup(); setup();
      arrange();
      const { view } = mount(form());
      await fill(view);
      send(view);
      await view.findByTestId("expression-make-error");
      expect(errorText(view)).toBe("사진을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
      expect(api.sendMessage).not.toHaveBeenCalled();
    }
  });
  it("고칠 수 없는 원인은 그대로 말해요: 보관소 없음, 막힌 배포, 큰 파일", async () => {
    const { ApiError } = await vi.importActual<typeof import("@momo/core/lib/api")>("@momo/core/lib/api");
    const lines: [() => void, string][] = [
      [() => api.createAttachmentUpload.mockRejectedValueOnce(new ApiError(503, "no archive")), "파일 보관소가 연결되어 있지 않아 사진을 올릴 수 없어요. 서버 관리자에게 알려 주세요."],
      [() => api.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: false, failure: "blocked" }), abort: vi.fn() })), "이 서버의 보안 설정이 파일 보관소 주소를 막았어요. 서버 관리자에게 알려 주세요."],
      [() => api.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: false, failure: "status", status: 413 }), abort: vi.fn() })), "사진이 너무 커서 올리지 못했어요. 더 작은 사진을 골라 주세요."],
    ];
    for (const [arrange, line] of lines) {
      cleanup(); setup();
      arrange();
      const { view } = mount(form());
      await fill(view);
      send(view);
      await view.findByTestId("expression-make-error");
      expect(errorText(view)).toBe(line);
    }
  });
  it("보내지 못하면 그 줄을 보이고, 다시 시도하면 올린 첨부와 같은 메시지 키로 이어가요", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    const { view } = mount(form());
    await fill(view);
    send(view);
    await view.findByTestId("expression-make-error");
    expect(errorText(view)).toBe("요청을 보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.");
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
    expect(api.createAttachmentUpload).toHaveBeenCalledTimes(1);
    expect(api.completeAttachmentUpload).toHaveBeenCalledTimes(1);
    const [first, second] = api.sendMessage.mock.calls;
    expect(second[2]).toBe(first[2]);
    expect(second[3]).toBe(first[3]);
    expect(second[4]).toEqual({ attachmentIds: [ATTACHMENT_ID] });
  });
  it("올리기에서 떨어지면 다시 시도는 이미 연 대화를 다시 열지 않아요", async () => {
    api.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: false, failure: "network" }), abort: vi.fn() }));
    const { view } = mount(form());
    await fill(view);
    send(view);
    await view.findByTestId("expression-make-error");
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
    expect(api.createAttachmentUpload).toHaveBeenCalledTimes(2);
    expect(view.queryByTestId("expression-make-error")).toBeNull();
  });
  it("보내기가 실패한 뒤 메모를 바꾸면 새 메시지로 첨부도 다시 올려요", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    const { view } = mount(form());
    await fill(view, { note: "처음" });
    send(view);
    await view.findByTestId("expression-make-error");
    fireEvent.change(view.getByTestId("expression-make-note"), { target: { value: "바꾼 메모" } });
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    const [first, second] = api.sendMessage.mock.calls;
    expect(second[2]).not.toBe(first[2]);
    expect(second[3]).toContain("바꾼 메모");
    expect(api.createAttachmentUpload).toHaveBeenCalledTimes(2);
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
  });
  it("대화를 열지 못한 원인이 권한이나 없는 멤버면 그대로 말해요", async () => {
    const { ApiError } = await vi.importActual<typeof import("@momo/core/lib/api")>("@momo/core/lib/api");
    const lines: [number, string][] = [
      [403, "이 워크스페이스에서 에이전트와 대화를 열 권한이 없어요. 관리자에게 문의해 주세요."],
      [404, "이 에이전트를 찾을 수 없어요. 목록을 다시 불러온 뒤 골라 주세요."],
    ];
    for (const [status, line] of lines) {
      cleanup(); setup();
      api.openDirectMessage.mockRejectedValueOnce(new ApiError(status, "denied"));
      const { view } = mount(form());
      await fill(view);
      send(view);
      await view.findByTestId("expression-make-error");
      expect(errorText(view)).toBe(line);
      expect(api.createAttachmentUpload).not.toHaveBeenCalled();
    }
  });
  it("다른 사진을 고르면 같은 대화에서 새 메시지로 다시 올려요", async () => {
    api.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    const { view } = mount(form());
    await fill(view);
    send(view);
    await view.findByTestId("expression-make-error");
    choose(view, makeFixturePhoto("second.png"));
    await waitFor(() => expect(view.getByTestId("expression-make-photo-preview").textContent).toContain("second.png"));
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.openDirectMessage).toHaveBeenCalledTimes(1);
    expect(api.createAttachmentUpload.mock.calls.map((call) => (call[2] as { name: string }).name)).toEqual(["photo.png", "second.png"]);
    expect(api.sendMessage.mock.calls[1][2]).not.toBe(api.sendMessage.mock.calls[0][2]);
  });
  it("다른 에이전트를 고르면 대화부터 새로 열어요", async () => {
    setup([MAKE_FIXTURE_AGENT, MAKE_FIXTURE_AGENT_B]);
    api.sendMessage.mockRejectedValueOnce(new Error("timeout"));
    const { view } = mount(form());
    await waitFor(() => expect(view.queryByTestId("skeleton")).toBeNull());
    fireEvent.change(agentSelect(view), { target: { value: MAKE_FIXTURE_AGENT_ID } });
    await fill(view);
    send(view);
    await view.findByTestId("expression-make-error");
    fireEvent.change(agentSelect(view), { target: { value: MAKE_FIXTURE_AGENT_B_ID } });
    send(view);
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    expect(api.openDirectMessage.mock.calls.map((call) => call[1])).toEqual([MAKE_FIXTURE_AGENT_ID, MAKE_FIXTURE_AGENT_B_ID]);
    expect(api.createAttachmentUpload.mock.calls.map((call) => call[1])).toEqual([DM_ID, DM_B_ID]);
  });
});

describe("미리보기 재생", () => {
  it("사진을 고르면 칩마다 같은 사진으로 재생하고, 끝나면 멈추고, 누르면 다시 재생해요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    const states = () => ["bounce", "wobble", "pulse", "sparkle", "still"].map((id) => view.getByTestId(`expression-make-preview-${id}`).getAttribute("data-state"));
    expect(states()).toEqual(["playing", "playing", "playing", "playing", "still"]);
    const bounce = view.getByTestId("expression-make-preview-bounce");
    fireEvent.animationEnd(bounce.querySelector(".expression-make-picture")!);
    expect(bounce.getAttribute("data-state")).toBe("stopped");
    fireEvent.click(view.getByTestId(chip("bounce")));
    expect(bounce.getAttribute("data-state")).toBe("playing");
  });
  it("다른 사진을 고르면 모든 미리보기가 처음부터 다시 재생해요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    const bounce = view.getByTestId("expression-make-preview-bounce");
    fireEvent.animationEnd(bounce.querySelector(".expression-make-picture")!);
    expect(bounce.getAttribute("data-state")).toBe("stopped");
    choose(view, makeFixturePhoto("another.png"));
    await waitFor(() => expect(bounce.getAttribute("data-state")).toBe("playing"));
  });
  it("동작 줄이기면 정지 그림만 보여요", async () => {
    vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const { view } = mount(form());
    await fill(view, { presets: [] });
    for (const id of ["bounce", "wobble", "pulse", "sparkle", "still"]) {
      const preview = view.getByTestId(`expression-make-preview-${id}`);
      expect([preview.getAttribute("data-state"), preview.getAttribute("data-animated")]).toEqual(["still", "false"]);
      expect(preview.querySelector("img")).not.toBeNull();
    }
    expect(view.container.querySelectorAll(".expression-make-star")).toHaveLength(0);
  });
});

describe("키보드만으로 끝까지", () => {
  const tabbables = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]"))
    .filter((element) => !(element as HTMLButtonElement).disabled && element.tabIndex >= 0 && element.closest("[hidden], [aria-hidden='true']") === null);
  it("탭 순서는 사진, 움직임 칩, 에이전트, 메모, 보내기예요", async () => {
    const { view } = mount(form());
    await fill(view, { presets: [] });
    const stops = tabbables(view.getByTestId("expression-make-form"));
    expect(stops.map((element) => element.getAttribute("data-testid"))).toEqual([PHOTO, chip("bounce"), chip("wobble"), chip("pulse"), chip("sparkle"), chip("still"), "expression-make-agent", "expression-make-note", SUBMIT]);
    expect(stops.every((element) => element.tabIndex === 0)).toBe(true);
  });
  it("진행 중에는 칸이 잠기고 보내기 버튼이 초점을 지켜요", async () => {
    let release!: () => void;
    api.openDirectMessage.mockImplementation(() => new Promise((resolve) => { release = () => { order.push("dm"); resolve({ channel: dmFor(DM_ID), created: true }); }; }));
    const { view } = mount(form());
    await fill(view);
    view.getByTestId(SUBMIT).focus();
    send(view);
    expect(document.activeElement).toBe(view.getByTestId(SUBMIT));
    expect((view.getByTestId(chip("bounce")) as HTMLButtonElement).disabled).toBe(true);
    expect(photoInput(view).disabled).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
  });
});

describe("＋ 메뉴", () => {
  const panel = (onClose?: () => void) => <TeamExpressionsPanel purpose="insert" onPick={() => {}} onClose={onClose} />;
  async function mountPanel(onClose?: () => void) {
    const store = makeStore();
    await store.refresh();
    return mount(panel(onClose), store);
  }
  async function openMenu(view: RenderResult, key = "Enter") {
    const trigger = view.getByTestId("expression-add-menu");
    trigger.focus();
    fireEvent.keyDown(trigger, { key });
    await view.findByRole("menu");
    return trigger;
  }
  it("키보드로 열고 항목은 둘이에요: 가져오기, AI와 만들기", async () => {
    const { view } = await mountPanel();
    await openMenu(view);
    expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["가져오기", "AI와 만들기"]);
    expect(hasBanned(document.body.textContent ?? "")).toBe(false);
    expect(view.getByTestId("expression-add-menu").textContent).toBe("추가하기");
  });
  it("Escape로 닫으면 초점이 「추가하기」로 돌아와요", async () => {
    const { view } = await mountPanel();
    const trigger = await openMenu(view, " ");
    fireEvent.keyDown(view.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("AI와 만들기를 고르면 양식이 서고 초점은 「목록으로」에 있고, 돌아가면 「추가하기」로 와요", async () => {
    const { view } = await mountPanel();
    await openMenu(view);
    fireEvent.keyDown(view.getAllByRole("menuitem")[1], { key: "Enter" });
    await view.findByTestId("expression-make-form");
    const back = view.getByRole("button", { name: "목록으로" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(view.queryByTestId("expression-add-menu")).toBeNull();
    fireEvent.click(back);
    await waitFor(() => expect(document.activeElement).toBe(view.getByTestId("expression-add-menu")));
    expect(view.queryByTestId("expression-make-form")).toBeNull();
  });
  it("에이전트가 없을 때 빈 상태의 가져오기는 올리기 양식으로 바꿔 줘요", async () => {
    setup([]);
    const { view } = await mountPanel();
    await openMenu(view);
    fireEvent.keyDown(view.getAllByRole("menuitem")[1], { key: "Enter" });
    await view.findByTestId("expression-make-empty");
    fireEvent.click(view.getByRole("button", { name: "가져오기" }));
    expect(await view.findByLabelText("고정 이름")).toBeTruthy();
    expect(view.queryByTestId("expression-make-form")).toBeNull();
  });
  it("가져오기를 고르면 지금의 올리기 양식이 그대로 서요", async () => {
    const { view } = await mountPanel();
    await openMenu(view);
    fireEvent.keyDown(view.getAllByRole("menuitem")[0], { key: "Enter" });
    expect((await view.findByLabelText("고정 이름")) as HTMLInputElement).toBeTruthy();
    for (const label of ["표시 이름", "태그 (쉼표로 구분)", "사람 얼굴", "출처 링크 (선택)", "직접 올릴 그림"]) expect(view.getByLabelText(label)).toBeTruthy();
    expect(view.queryByTestId("expression-make-form")).toBeNull();
  });
  it("요청을 보내면 고르개를 닫는 onClose 가 불려요", async () => {
    const onClose = vi.fn();
    const { view } = await mountPanel(onClose);
    await openMenu(view);
    fireEvent.keyDown(view.getAllByRole("menuitem")[1], { key: "Enter" });
    await view.findByTestId("expression-make-form");
    await fill(view);
    send(view);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(view.getByTestId("where").textContent).toBe(`/c/${DM_ID}`);
  });
});

describe("이모지 고르개 안에서", () => {
  // 실제 호스트: 포인터 기기에서는 모달 팝오버다. Radix 가 ResizeObserver 를 부르므로 jsdom 에 빈 구현을 둔다.
  function Host({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
    const [open, setOpen] = useState(true);
    const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
    return <>
      <button type="button" ref={setOpener} data-testid="picker-opener">열기</button>
      <EmojiPickerDialog open={open} onOpenChange={(next) => { setOpen(next); onOpenChange(next); }} onPick={() => {}} opener={opener} anchor={opener} purpose="insert" testId="picker" />
    </>;
  }
  // 기본 이모지 표가 선택 칸을 스크롤해 보이게 하는데 jsdom 에는 그 함수가 없다.
  const stubBrowserOnlyApis = () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: () => {}, configurable: true, writable: true });
  };
  afterEach(() => { Reflect.deleteProperty(Element.prototype, "scrollIntoView"); });
  async function openMakeForm(onOpenChange: (open: boolean) => void) {
    stubBrowserOnlyApis();
    const store = makeStore();
    await store.refresh();
    const mounted = mount(<Host onOpenChange={onOpenChange} />, store);
    fireEvent.click(await mounted.view.findByRole("button", { name: "우리 팀" }));
    const trigger = await mounted.view.findByTestId("expression-add-menu");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown((await mounted.view.findAllByRole("menuitem"))[1], { key: "Enter" });
    await mounted.view.findByTestId("expression-make-form");
    return mounted;
  }
  it("Escape 한 번은 열린 메뉴만 닫고, 양식에서의 Escape는 고르개를 닫아요", async () => {
    const onOpenChange = vi.fn();
    const { view } = await mountedMenuThenEscape(onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(view.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
  it("삭제 확인 단계의 Escape는 단계만 취소하고 고르개를 닫지 않아요, 다음 Escape가 고르개를 닫아요 (#4986)", async () => {
    // 실제 모달 팝오버 안에서: Radix 는 Escape 를 문서 캡처 단계에서 먼저 가져가므로, 확인 단계가 서 있는 동안
    // 고르개가 단계의 취소를 부르지 않으면 한 번의 Escape 가 고르개를 통째로 닫는다(확인에서 길을 잃는다).
    stubBrowserOnlyApis();
    const onOpenChange = vi.fn();
    const store = makeStore();
    await store.refresh();
    const { view } = mount(<Host onOpenChange={onOpenChange} />, store);
    fireEvent.click(await view.findByRole("button", { name: "우리 팀" }));
    const manage = await view.findByRole("button", { name: "파티 앵무새 관리" });
    fireEvent.pointerDown(manage, { button: 0, pointerType: "mouse", ctrlKey: false });
    fireEvent.keyDown(manage, { key: "Enter" });
    fireEvent.click(await view.findByRole("menuitem", { name: "삭제하기" }));
    expect(view.getByTestId("expression-confirm")).toBeTruthy();
    // 이 순간 열린 대화상자는 고르개 하나뿐이다: 두 번째 표면이 없다.
    expect(document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"]')).toHaveLength(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(view.queryByTestId("expression-confirm")).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "파티 앵무새 관리" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
  it("요청을 보내면 onClose 를 거쳐 고르개가 닫히고 그 DM으로 가요", async () => {
    const onOpenChange = vi.fn();
    const { view } = await openMakeForm(onOpenChange);
    await fill(view);
    send(view);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("where").textContent).toBe(`/c/${DM_ID}`);
  });
  async function mountedMenuThenEscape(onOpenChange: (open: boolean) => void) {
    stubBrowserOnlyApis();
    const store = makeStore();
    await store.refresh();
    const mounted = mount(<Host onOpenChange={onOpenChange} />, store);
    fireEvent.click(await mounted.view.findByRole("button", { name: "우리 팀" }));
    const trigger = await mounted.view.findByTestId("expression-add-menu");
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await mounted.view.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(mounted.view.queryByRole("menu")).toBeNull());
    // 메뉴가 닫혀도 고르개와 「추가하기」는 남아 있다.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(mounted.view.getByTestId("expression-add-menu")).toBeTruthy();
    // 이제 양식을 연 뒤 그 Escape 를 시험한다.
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown((await mounted.view.findAllByRole("menuitem"))[1], { key: "Enter" });
    await mounted.view.findByTestId("expression-make-form");
    return mounted;
  }
});

describe("문구", () => {
  const read = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");
  it("화면에 선 모든 상태의 글자에 손으로 그린다는 말이 없어요", async () => {
    const seen: string[] = [];
    const text = (view: RenderResult) => view.container.textContent ?? "";
    api.sendMessage.mockRejectedValueOnce(new Error("down"));
    const { view } = mount(form());
    seen.push(text(view));
    await fill(view, { presets: ["bounce", "wobble", "pulse", "sparkle"] });
    fireEvent.click(view.getByTestId(chip("still")));
    seen.push(text(view));
    send(view);
    await view.findByTestId("expression-make-error");
    seen.push(text(view));
    send(view);
    await view.findByTestId("expression-make-sent");
    seen.push(text(view));
    expect(seen).toHaveLength(4);
    expect(seen.every((entry) => entry.length > 40)).toBe(true);
    expect(seen.filter(hasBanned)).toEqual([]);
  });
  it("주석과 시험 이름까지 포함해 소스 어디에도 그 말이 없어요", () => {
    const files = ["ExpressionMakeForm.tsx", "ExpressionMakePreview.tsx", "makeFlow.ts", "makeFixtures.ts", "TeamExpressionsPanel.tsx", "expressions.css", "ExpressionMakeForm.test.tsx", "ExpressionMakePreview.test.tsx", "../../../../../packages/momo-core/src/features/expressions/make.ts", "../../../../../packages/momo-core/src/features/expressions/make.test.ts"];
    const hits = files.flatMap((name) => { const text = read(name); return text.length > 0 ? BANNED.filter((word) => text.includes(word)).map((word) => `${name}:${word.length}`) : [`${name}:empty`]; });
    expect(hits).toEqual([]);
    expect(BANNED.some((word) => ["그림을 ", "그", "려요"].join("").includes(word))).toBe(true);
  });
});
