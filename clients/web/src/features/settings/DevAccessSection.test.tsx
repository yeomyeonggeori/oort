// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_READ_SCOPES,
  DEV_READ_WRITE_SCOPES,
  parseDevCredential,
} from "@momo/core/features/auth/devAccess";
import {
  DEV_NOTICES,
  DEV_ONE_TIME_COPY,
  devAccessErrorText,
  devAccessGate,
  devCredentialRow,
  devScopeLabel,
  devToolLabel,
  retryAfterPhrase,
} from "@momo/core/features/auth/devAccessModel";
import { GONE_MEMBER_LABEL } from "@momo/core/features/workspace/directory";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import { chooseListbox } from "@/design/ui/listboxTestKit";
import { DevAccessSection } from "./DevAccessSection";

// 설정 › 명령줄·AI 도구 (#4663, ADR-0216). 화면과 코어와 훅은 진짜로 돌리고 **서버 쪽(HTTP `fetch`)만**
// 가짜로 둔다. 가짜의 답은 서버 문서(OpenAPI `DevAccessPolicyResponse` 등)의 실제 JSON 모양이고,
// 서버 동작을 흉내 내지 않는다(어떤 요청에 어떤 답을 줄지는 각 시험이 적는다).
// 실서버 확인은 서버(#4660)가 승격된 뒤다(runtime-unverified).

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";
const GONE = "00000000-0000-7000-8000-000000000199";
const CH_GENERAL = "00000000-0000-7000-8000-000000000201";
const CH_PRODUCT = "00000000-0000-7000-8000-000000000202";
const CH_NOTICE = "00000000-0000-7000-8000-000000000203";

const NOW = Date.now();
const DAY = 86_400_000;

/** 값 모양만 맞춘 가짜다. 진짜 토큰이 아니다. */
const SECRET_TAIL = "EXAMPLEnotARealSecret0123456789abcdefg";
const TOKEN = `momo_dev_v1.${WS}.${SECRET_TAIL}`;
const PASSWORD = "초록-고래-테스트용-비밀번호-7Q";

const ROOT = `/v1/workspaces/${WS}/dev-access`;
const CREDENTIALS = `${ROOT}/credentials`;

// ---- 서버가 주는 JSON (OpenAPI 표본) ---------------------------------------------------

function policy(overrides: Record<string, unknown> = {}) {
  return { policy: "admins", canCreate: true, canManageAll: false, ...overrides };
}

function wireCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "019f9b10-0000-7000-8000-0000000000b1",
    memberId: ME,
    kind: "card",
    name: "Claude Code",
    tool: "claude_code",
    scopes: [...DEV_READ_SCOPES],
    channelRestricted: false,
    createdAtMs: NOW - 3 * DAY,
    expiresAtMs: NOW + 27 * DAY,
    ...overrides,
  };
}

function created(overrides: Record<string, unknown> = {}) {
  return {
    id: "019f9b10-0000-7000-8000-0000000000a1",
    kind: "card",
    name: "Claude Code",
    tool: "claude_code",
    scopes: [...DEV_READ_SCOPES],
    createdAtMs: NOW,
    expiresAtMs: NOW + 30 * DAY,
    token: TOKEN,
    ...overrides,
  };
}

const OTHER_NAME = "박서연";
const ROSTER = [
  member(ME, "이도현", "dohyun", "owner"),
  member(OTHER, OTHER_NAME, "seoyeon", "member"),
];

function member(id: string, displayName: string, handle: string, role: string) {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

const CHANNELS = [
  { id: CH_GENERAL, workspaceId: WS, kind: "public", name: "일반", muted: false },
  { id: CH_PRODUCT, workspaceId: WS, kind: "private", name: "제품-회의", muted: false },
  { id: CH_NOTICE, workspaceId: WS, kind: "public", name: "달무리-공지", muted: false },
];

// ---- 가짜 서버 문 ------------------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

let calls: Call[] = [];
let routes: Record<string, Handler> = {};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorBody(code: string | null, status: number, headers: Record<string, string> = {}) {
  return json({ error: { ...(code === null ? {} : { code }), message: "server message" } }, status, headers);
}

/** 기본 길: 만들 수 있는 관리자, 연결 없음, 명부와 채널. 시험이 필요한 문만 덮어쓴다. */
function defaultRoutes(): Record<string, Handler> {
  return {
    [`GET ${ROOT}`]: () => json(policy()),
    [`GET ${CREDENTIALS}`]: () => json({ credentials: [] }),
    [`GET /v1/workspaces/${WS}/roster`]: () => json({ members: ROSTER }),
    [`GET /v1/workspaces/${WS}/channels`]: () => json({ channels: CHANNELS }),
  };
}

function installFetch(): void {
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost:3000");
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: Call = { method, path: url.pathname, search: url.search, body };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    if (handler === undefined) return errorBody(null, 404);
    return handler(call);
  });
}

function createCalls(): Call[] {
  return calls.filter((call) => call.method === "POST" && call.path === CREDENTIALS);
}

function revokeCalls(): Call[] {
  return calls.filter((call) => call.method === "DELETE");
}

// ---- 화면 다루기 -----------------------------------------------------------------------------

let client: QueryClient;

function mount(options: { offline?: boolean } = {}) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DevAccessSection workspaceId={WS} memberId={ME} offline={options.offline ?? false} />
    </QueryClientProvider>
  );
}

const byId = (id: string) => screen.getByTestId(id);
const maybe = (id: string) => screen.queryByTestId(id);
const input = (id: string) => byId(id) as HTMLInputElement;

async function mountReady(options: { offline?: boolean } = {}) {
  const view = mount(options);
  await screen.findByTestId("dev-access-create-form");
  return view;
}

function type(id: string, value: string) {
  fireEvent.change(input(id), { target: { value } });
}

/** `id`로 찾는 입력(라디오·체크 목록)을 누른다. */
function pick(id: string) {
  fireEvent.click(document.getElementById(id) as HTMLElement);
}

/** `data-testid`로 찾는 입력(세그먼트 컨트롤의 칸)을 누른다. */
function choose(testId: string) {
  fireEvent.click(byId(testId));
}

/** Radix가 바깥 클릭 귀를 다음 틱에 단다. 그 틱을 넘긴 뒤에야 바깥 클릭 시험이 의미가 있다. */
async function flushMacrotask() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function submitWith(password = PASSWORD) {
  type("dev-access-password", password);
  fireEvent.click(byId("dev-access-create"));
}

async function createAndReveal() {
  routes[`POST ${CREDENTIALS}`] = () => json(created(), 201);
  await mountReady();
  await submitWith();
  await screen.findByTestId("dev-access-reveal");
}

function secretsOnScreen(): string {
  return document.body.textContent ?? "";
}

function cacheDump(): string {
  const queries = client.getQueryCache().getAll().map((query) => query.state.data);
  const mutations = client.getMutationCache().getAll().map((mutation) => mutation.state.data);
  return JSON.stringify([queries, mutations]);
}

beforeAll(() => {
  // 이 클라이언트의 시험은 vitest 전역(`beforeAll`)을 쓰지 않아 RTL이 act 환경을 켜 주지 않는다.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
  );
});

beforeEach(() => {
  routes = defaultRoutes();
  installFetch();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  resetEscapeLayers();
  vi.unstubAllGlobals();
});

// ===========================================================================================

describe("명령줄·AI 도구: 만들기 요청의 본문", () => {
  it("기본 선택은 「읽기만」이고, 기본값은 본문에서 키가 빠진다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => json(created(), 201);
    await mountReady();

    expect((document.getElementById("dev-access-preset-read") as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById("dev-access-preset-read_write") as HTMLInputElement).checked).toBe(false);

    await submitWith();
    await screen.findByTestId("dev-access-reveal");

    const [call] = createCalls();
    // 읽기만 + 모든 채널 + 30일은 `scopes`·`channelIds`·`expiresInDays` 키 자체가 없다(null·[]·0은 400이다).
    expect(call.body).toEqual({
      name: devToolLabel("claude_code"),
      tool: "claude_code",
      currentPassword: PASSWORD,
    });
    for (const key of ["scopes", "channelIds", "expiresInDays"]) {
      expect(call.body && key in call.body, key).toBe(false);
    }
  });

  it("읽기 + 보내기, 채널 둘, 60일을 고르면 다섯 범위와 채널 id와 60이 실린다", async () => {
    routes[`POST ${CREDENTIALS}`] = () =>
      json(
        created({
          scopes: [...DEV_READ_WRITE_SCOPES],
          channelIds: [CH_GENERAL, CH_NOTICE],
          expiresAtMs: NOW + 60 * DAY,
        }),
        201
      );
    await mountReady();

    pick("dev-access-preset-read_write");
    fireEvent.click(byId("dev-access-restrict"));
    await screen.findByTestId("dev-access-channels");
    pick(`dev-access-channels-${CH_GENERAL}`);
    pick(`dev-access-channels-${CH_NOTICE}`);
    chooseListbox(byId("dev-access-expiry"), "60");
    await submitWith();
    await screen.findByTestId("dev-access-reveal");

    const [call] = createCalls();
    expect(call.body).toEqual({
      name: devToolLabel("claude_code"),
      tool: "claude_code",
      scopes: [...DEV_READ_WRITE_SCOPES],
      channelIds: [CH_GENERAL, CH_NOTICE],
      expiresInDays: 60,
      currentPassword: PASSWORD,
    });
  });

  it("직접 정한 만료 일수가 실리고, 30일은 직접 쳐도 키가 빠진다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => json(created(), 201);
    await mountReady();

    chooseListbox(byId("dev-access-expiry"), "custom");
    type("dev-access-days", "45");
    await submitWith();
    await screen.findByTestId("dev-access-reveal");
    expect(createCalls()[0].body?.expiresInDays).toBe(45);
  });

  it("쓰는 도구를 바꾸면 이름 칸의 시작값이 따라가고, 사람이 고친 이름은 지키며, 보낸 도구가 실린다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => json(created({ tool: "codex", name: "Codex" }), 201);
    await mountReady();

    choose("dev-access-tool-codex");
    expect(input("dev-access-name").value).toBe(devToolLabel("codex"));
    type("dev-access-name", "달무리 노트북");
    choose("dev-access-tool-cli");
    expect(input("dev-access-name").value).toBe("달무리 노트북");

    choose("dev-access-tool-codex");
    await submitWith();
    await screen.findByTestId("dev-access-reveal");
    expect(createCalls()[0].body).toMatchObject({ name: "달무리 노트북", tool: "codex" });
  });
});

describe("명령줄·AI 도구: 입력 검증과 오류", () => {
  it("틀린 입력은 요청을 보내지 않고 그 칸에 말하며 초점을 그리로 옮긴다", async () => {
    await mountReady();

    type("dev-access-name", "   ");
    fireEvent.click(byId("dev-access-create"));
    expect(createCalls()).toHaveLength(0);
    const name = input("dev-access-name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toContain("dev-access-name-error");
    expect(document.activeElement).toBe(name);

    // 이름을 고치면 이름의 오류만 사라지고, 비밀번호가 비어 있다는 말은 남는다.
    type("dev-access-name", "달무리 서버 점검");
    expect(name.getAttribute("aria-invalid")).not.toBe("true");
    fireEvent.click(byId("dev-access-create"));
    expect(createCalls()).toHaveLength(0);
    expect(input("dev-access-password").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input("dev-access-password"));
  });

  it("직접 정한 만료가 범위 밖이면 보내지 않는다", async () => {
    await mountReady();
    chooseListbox(byId("dev-access-expiry"), "custom");
    type("dev-access-days", "91");
    type("dev-access-password", PASSWORD);
    fireEvent.click(byId("dev-access-create"));
    expect(createCalls()).toHaveLength(0);
    expect(input("dev-access-days").getAttribute("aria-invalid")).toBe("true");
  });

  it("「고른 채널만」을 켜고 채널을 안 고르면 보내지 않는다", async () => {
    await mountReady();
    fireEvent.click(byId("dev-access-restrict"));
    await screen.findByTestId("dev-access-channels");
    type("dev-access-password", PASSWORD);
    fireEvent.click(byId("dev-access-create"));
    expect(createCalls()).toHaveLength(0);
    expect(maybe("dev-access-channels-validation")).not.toBeNull();
  });

  it("틀린 비밀번호는 비밀번호 칸에 묶이고, 칸은 비워지며, 토큰 화면은 없다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => errorBody("current_password_incorrect", 403);
    await mountReady();
    await submitWith();

    const password = input("dev-access-password");
    await waitFor(() => expect(password.getAttribute("aria-invalid")).toBe("true"));
    expect(password.getAttribute("aria-describedby")).toContain("dev-access-password-error");
    expect(
      document.getElementById("dev-access-password-error")?.textContent
    ).toBe(devAccessErrorText({ kind: "password_incorrect" }, "create"));
    expect(password.value).toBe("");
    expect(maybe("dev-access-reveal")).toBeNull();
    expect(maybe("dev-access-create-error")).toBeNull();
    expect(document.activeElement).toBe(password);

    // 다시 치기 시작하면 그 오류는 걷힌다.
    type("dev-access-password", "다시");
    expect(password.getAttribute("aria-invalid")).not.toBe("true");
  });

  it.each([
    ["current_password_unavailable", 403, { kind: "password_unavailable" }],
    ["dev_access_denied", 403, { kind: "access_denied" }],
    ["dev_credential_limit", 409, { kind: "limit" }],
  ] as const)("%s 는 비밀번호 칸이 아니라 따로 선 문장으로 말한다", async (code, status, failure) => {
    routes[`POST ${CREDENTIALS}`] = () => errorBody(code, status);
    await mountReady();
    await submitWith();

    const banner = await screen.findByTestId("dev-access-create-error");
    expect(banner.textContent).toContain(devAccessErrorText(failure, "create"));
    expect(input("dev-access-password").getAttribute("aria-invalid")).not.toBe("true");
    expect(maybe("dev-access-reveal")).toBeNull();
  });

  it("429는 서버가 알려 준 초를 문장에 쓴다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => errorBody(null, 429, { "Retry-After": "42" });
    await mountReady();
    await submitWith();

    const banner = await screen.findByTestId("dev-access-create-error");
    expect(banner.textContent).toContain(retryAfterPhrase(42));
    expect(banner.textContent).toBe(
      devAccessErrorText({ kind: "rate_limited", retryAfterSeconds: 42 }, "create")
    );
  });

  it("초를 말하지 않은 429와 503은 잠시 뒤에 다시라고 말한다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => errorBody(null, 429);
    await mountReady();
    await submitWith();
    expect((await screen.findByTestId("dev-access-create-error")).textContent).toBe(
      devAccessErrorText({ kind: "rate_limited" }, "create")
    );

    routes[`POST ${CREDENTIALS}`] = () => errorBody(null, 503, { "Retry-After": "7" });
    await submitWith();
    await waitFor(() =>
      expect(byId("dev-access-create-error").textContent).toBe(
        devAccessErrorText({ kind: "busy", retryAfterSeconds: 7 }, "create")
      )
    );
  });

  it("응답을 받지 못하면 만들어졌는지 알 수 없다고 말하고 목록을 확인하라고 한다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => {
      throw new TypeError("network down");
    };
    await mountReady();
    await submitWith();
    const banner = await screen.findByTestId("dev-access-create-error");
    expect(banner.textContent).toBe(devAccessErrorText({ kind: "network" }, "create"));
  });

  it("보내는 동안 칸은 비어 있고, 같은 요청이 두 번 나가지 않는다", async () => {
    let release: () => void = () => undefined;
    routes[`POST ${CREDENTIALS}`] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json(created(), 201));
      });
    await mountReady();
    await submitWith();

    const button = byId("dev-access-create");
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    // 비밀번호는 보내는 순간 칸에서 사라진다.
    expect(input("dev-access-password").value).toBe("");
    // 날고 있는 동안 두 번째 누름은 삼켜진다(비밀번호를 다시 쳐도 같다). 진행은 잠금이 아니다.
    type("dev-access-password", PASSWORD);
    fireEvent.click(button);
    expect(createCalls()).toHaveLength(1);
    expect(button.getAttribute("aria-disabled")).toBeNull();

    release();
    await screen.findByTestId("dev-access-reveal");
  });

  it("비밀번호는 요청이 날아간 뒤 캐시의 어떤 변수에도 남지 않는다", async () => {
    let release: () => void = () => undefined;
    routes[`POST ${CREDENTIALS}`] = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(json(created(), 201));
      });
    await mountReady();
    await submitWith();
    await waitFor(() => expect(byId("dev-access-create").getAttribute("aria-busy")).toBe("true"));

    const held = () =>
      JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.variables));
    expect(held()).not.toContain(PASSWORD);
    // 그래도 서버는 그 비밀번호를 받았다(본문에 실렸다).
    expect(createCalls()[0].body?.currentPassword).toBe(PASSWORD);

    release();
    await screen.findByTestId("dev-access-reveal");
    expect(held()).not.toContain(PASSWORD);
  });
});

describe("명령줄·AI 도구: 한 번만 보이는 화면", () => {
  it("만들면 값이 서고 초점이 그 카드로 간다", async () => {
    await createAndReveal();
    expect(secretsOnScreen()).toContain(TOKEN);
    expect(document.activeElement).toBe(byId("dev-access-secret"));
  });

  it("Esc로는 닫히지 않는다", async () => {
    await createAndReveal();
    await flushMacrotask();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await flushMacrotask();

    expect(maybe("dev-access-reveal")).not.toBeNull();
    expect(secretsOnScreen()).toContain(TOKEN);
  });

  it("바깥 클릭으로는 닫히지 않는다", async () => {
    await createAndReveal();
    // Radix가 바깥 클릭 귀를 다음 틱에 단다. 그 뒤에 눌러야 이 시험이 막지 못하는 코드를 잡는다.
    await flushMacrotask();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    await flushMacrotask();

    expect(maybe("dev-access-reveal")).not.toBeNull();
    expect(secretsOnScreen()).toContain(TOKEN);
  });

  it("초점이 다이얼로그 밖(설정 목차 쪽)으로 새면 값 카드로 되돌린다", async () => {
    await createAndReveal();
    // 바깥을 눌러 초점이 body로 떨어진 뒤 Tab이 뒤의 페이지로 가는 길이다(실브라우저에서 샜다).
    // 뒤 페이지의 입력 칸으로 초점을 보내 본다.
    act(() => {
      input("dev-access-name").focus();
    });
    expect(document.activeElement).toBe(byId("dev-access-secret"));
    act(() => {
      input("dev-access-password").focus();
    });
    expect(document.activeElement).toBe(byId("dev-access-secret"));
    // 안에서의 초점 이동은 막지 않는다.
    act(() => {
      byId("dev-command-tab-claude_code").focus();
    });
    expect(document.activeElement).toBe(byId("dev-command-tab-claude_code"));
  });

  it("값은 쿼리 캐시에 들어가지 않는다. 뮤테이션 결과 한 곳에만 있다", async () => {
    await createAndReveal();

    const queries = JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data));
    expect(queries).not.toContain(SECRET_TAIL);
    const mutations = JSON.stringify(
      client.getMutationCache().getAll().map((mutation) => mutation.state.data)
    );
    expect(mutations).toContain(SECRET_TAIL);
  });

  it("값을 보여 줄 때 붙는 이름은 값이 아니다(낭독에 값이 실리지 않는다)", async () => {
    await createAndReveal();
    const card = byId("dev-access-secret");
    expect(card.getAttribute("role")).toBe("group");
    expect(card.getAttribute("aria-label")).not.toContain(SECRET_TAIL);
    expect(card.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it("「저장했어요」가 유일한 출구이고, 누르면 화면 어디에도 값이 없고 목록이 새로 읽힌다", async () => {
    const row = wireCredential({ id: created().id, name: "Claude Code" });
    await createAndReveal();
    // 만든 연결은 이 목록 읽기부터 보인다.
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [row] });

    expect(screen.getAllByRole("button", { name: DEV_ONE_TIME_COPY.confirmLabel })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: DEV_ONE_TIME_COPY.confirmLabel }));

    await waitFor(() => expect(maybe("dev-access-reveal")).toBeNull());
    expect(secretsOnScreen()).not.toContain(SECRET_TAIL);
    expect(secretsOnScreen()).not.toContain("momo_dev_v1");
    // 캐시에도 없다: 뮤테이션 결과를 놓았고 사본까지 비웠다.
    expect(cacheDump()).not.toContain(SECRET_TAIL);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    // 새로 읽은 목록에 방금 만든 연결이 보인다.
    await screen.findByTestId(`dev-credential-row-${created().id}`);
    // 초점은 「연결 만들기」로 돌아온다. 폼은 처음 상태다.
    await waitFor(() => expect(document.activeElement).toBe(byId("dev-access-create")));
    expect(maybe("dev-access-announce")?.textContent).toContain("Claude Code");
    expect(maybe("dev-access-announce")?.textContent).not.toContain(SECRET_TAIL);
  });

  it("값이 떠 있는 채로 화면이 사라지면 캐시에도 값이 남지 않는다", async () => {
    await createAndReveal();
    expect(cacheDump()).toContain(SECRET_TAIL);

    cleanup();

    expect(cacheDump()).not.toContain(SECRET_TAIL);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(secretsOnScreen()).not.toContain(SECRET_TAIL);
  });

  it("「저장했어요」 뒤 폼은 처음 상태(읽기만, 기본 이름, 30일)로 돌아온다", async () => {
    routes[`POST ${CREDENTIALS}`] = () => json(created({ name: "달무리 노트북" }), 201);
    await mountReady();
    pick("dev-access-preset-read_write");
    type("dev-access-name", "달무리 노트북");
    await submitWith();
    await screen.findByTestId("dev-access-reveal");
    fireEvent.click(screen.getByRole("button", { name: DEV_ONE_TIME_COPY.confirmLabel }));
    await waitFor(() => expect(maybe("dev-access-reveal")).toBeNull());

    expect((document.getElementById("dev-access-preset-read") as HTMLInputElement).checked).toBe(true);
    expect(input("dev-access-name").value).toBe(devToolLabel("claude_code"));
    expect(input("dev-access-password").value).toBe("");
    expect(byId("dev-access-expiry").dataset.value).toBe("30");
  });

  it("값 옆에서 복사 단추는 이름에 값이 실리지 않고, 도구에 넣는 방법에는 값이 없다", async () => {
    await createAndReveal();
    for (const button of within(byId("dev-access-secret")).getAllByRole("button")) {
      expect(button.getAttribute("aria-label") ?? button.textContent).not.toContain(SECRET_TAIL);
    }
    const panel = byId("dev-command-panel");
    expect(panel.textContent).not.toContain(SECRET_TAIL);
  });
});

describe("명령줄·AI 도구: 도구별 명령 탭", () => {
  const SECRET_SHAPES = [/momo_dev_v1\./, /momo_devr_v1\./, /--header/, /(^|\s)-H\s/];

  function codeBlocks(): string[] {
    return [...byId("dev-command-panel").querySelectorAll("pre")].map((pre) => pre.textContent ?? "");
  }

  it("만든 사람이 고른 도구의 탭에서 시작하고, 탭을 바꾸면 그 도구의 조각이 선다", async () => {
    await createAndReveal();

    expect(byId("dev-command-panel").getAttribute("data-tool")).toBe("claude_code");
    expect(byId("dev-command-tab-claude_code").getAttribute("aria-selected")).toBe("true");
    expect(codeBlocks().join("\n")).toContain("mcpServers");

    fireEvent.click(byId("dev-command-tab-codex"));
    expect(byId("dev-command-panel").getAttribute("data-tool")).toBe("codex");
    expect(codeBlocks().join("\n")).toContain("bearer_token_env_var");

    fireEvent.click(byId("dev-command-tab-cli"));
    expect(byId("dev-command-panel").getAttribute("data-tool")).toBe("cli");
    expect(codeBlocks().join("\n")).toContain("curl");
    expect(codeBlocks().join("\n")).toContain(`/v1/workspaces/${WS}/dev-access/self`);
  });

  it("화살표 키가 탭을 옮긴다", async () => {
    await createAndReveal();
    const tab = byId("dev-command-tab-claude_code");
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    expect(byId("dev-command-panel").getAttribute("data-tool")).toBe("codex");
    expect(document.activeElement).toBe(byId("dev-command-tab-codex"));
  });

  it("지금은 환경 변수 참조 하나만 보이고, 값이 든 명령줄은 어느 탭에도 없다", async () => {
    await createAndReveal();
    for (const tool of ["claude_code", "codex", "cli"]) {
      fireEvent.click(byId(`dev-command-tab-${tool}`));
      const panel = byId("dev-command-panel");
      expect(panel.querySelectorAll('[data-testid^="dev-command-option-"]'), tool).toHaveLength(1);
      expect(maybe("dev-command-option-env"), tool).not.toBeNull();
      const text = codeBlocks().join("\n");
      for (const shape of SECRET_SHAPES) expect(text, `${tool} ${shape}`).not.toMatch(shape);
      for (const line of text.split("\n")) {
        const at = line.indexOf("Bearer ");
        if (at < 0) continue;
        // `Bearer` 뒤는 환경 변수 참조이거나, 같은 줄이 환경 변수를 인자로 넘기는 서식 자리표시자다.
        const rest = line.slice(at + "Bearer ".length);
        expect(rest.startsWith("${OORT_TOKEN}") || rest.startsWith("$OORT_TOKEN") || rest.startsWith("%s"), line).toBe(true);
        if (rest.startsWith("%s")) expect(line).toContain('"$OORT_TOKEN"');
      }
    }
  });

  it("각 코드 조각에 복사 단추가 있고 이름이 겹치지 않는다", async () => {
    await createAndReveal();
    const names = within(byId("dev-command-panel"))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names.length).toBe(codeBlocks().length);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("명령줄·AI 도구: 만들 수 있는가", () => {
  it.each([
    ["관리자만 켜진 스위치 앞의 멤버", { policy: "admins", canCreate: false }],
    ["꺼진 스위치", { policy: "off", canCreate: false }],
    ["멤버에게 열렸지만 이 계정은 만들 수 없는 경우(게스트)", { policy: "members", canCreate: false }],
  ] as const)("%s: 폼 없이 이유 한 문장이 선다", async (_label, overrides) => {
    routes[`GET ${ROOT}`] = () => json(policy(overrides));
    mount();

    const gate = await screen.findByTestId("dev-access-gate");
    const expected = devAccessGate({
      policy: overrides.policy,
      canCreate: overrides.canCreate,
      canManageAll: false,
    });
    expect(gate.textContent).toBe(expected.text);
    expect(gate.getAttribute("data-gate-state")).toBe(expected.state);
    expect(maybe("dev-access-create-form")).toBeNull();
    expect(maybe("dev-access-create")).toBeNull();
  });

  it("열려 있으면 폼이 서고, 누가 만들 수 있는지 한 문장이 카드 설명이다", async () => {
    routes[`GET ${ROOT}`] = () => json(policy({ policy: "members" }));
    await mountReady();
    expect(maybe("dev-access-gate")).toBeNull();
    expect(byId("dev-access-create-card").textContent).toContain(
      devAccessGate({ policy: "members", canCreate: true, canManageAll: false }).text
    );
  });

  it("권한 조회가 실패하면 만들기를 막고 다시 시도로 이어진다", async () => {
    routes[`GET ${ROOT}`] = () => errorBody(null, 503);
    mount();
    const banner = await screen.findByTestId("dev-access-policy-error");
    expect(banner.textContent).toContain(devAccessErrorText({ kind: "busy" }, "policy"));
    expect(maybe("dev-access-create-form")).toBeNull();

    routes[`GET ${ROOT}`] = () => json(policy());
    fireEvent.click(within(banner).getByRole("button"));
    await screen.findByTestId("dev-access-create-form");
    expect(maybe("dev-access-policy-error")).toBeNull();
  });

  it("권한을 받는 동안에는 폼도 이유도 없고 자리만 있다", async () => {
    routes[`GET ${ROOT}`] = () => new Promise<Response>(() => undefined);
    mount();
    expect(byId("dev-access-policy-loading")).not.toBeNull();
    expect(maybe("dev-access-create-form")).toBeNull();
    expect(maybe("dev-access-gate")).toBeNull();
  });

  it("스위치가 닫혀 있어도 이미 있는 내 연결은 목록에 서서 지울 수 있다", async () => {
    const row = wireCredential();
    routes[`GET ${ROOT}`] = () => json(policy({ policy: "off", canCreate: false }));
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [row] });
    mount();
    await screen.findByTestId(`dev-credential-row-${row.id}`);
    expect(maybe("dev-access-create-form")).toBeNull();
    expect(maybe("dev-credential-revoke")).not.toBeNull();
  });

  it("안내 카드는 코어가 말하는 사실 다섯을 그대로 보인다", async () => {
    mount();
    const notes = byId("dev-access-notes").textContent ?? "";
    for (const line of [
      DEV_NOTICES.passwordChangeEndsAll,
      DEV_NOTICES.logoutKeepsConnections,
      DEV_NOTICES.toolIsOnlyALabel,
      DEV_NOTICES.fixedAfterIssue,
      DEV_NOTICES.cardLimit,
    ]) {
      expect(notes).toContain(line);
    }
  });
});

describe("명령줄·AI 도구: 연결 목록", () => {
  const never = wireCredential({ id: "019f9b10-0000-7000-8000-0000000000c1", name: "달무리 노트북" });
  const used = wireCredential({
    id: "019f9b10-0000-7000-8000-0000000000c2",
    name: "Codex",
    tool: "codex",
    scopes: [...DEV_READ_WRITE_SCOPES],
    channelRestricted: true,
    lastUsedAtMs: NOW - 2 * 3_600_000,
  });
  const session = wireCredential({
    id: "019f9b10-0000-7000-8000-0000000000c3",
    name: "로그인 세션",
    kind: "session",
    tool: undefined,
    deviceName: "정하윤의 노트북",
    lastUsedAtMs: NOW - 60_000,
  });

  function rowOf(wire: Record<string, unknown>): HTMLElement {
    return byId(`dev-credential-row-${wire.id as string}`);
  }

  it("한 줄에 이름·도구·범위·마지막 사용·만료가 선다. 카드 줄에는 기기 칸이 없다", async () => {
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [never, used, session] });
    mount();
    await screen.findByTestId("dev-credentials-list");

    const model = (wire: Record<string, unknown>) =>
      devCredentialRow(parseDevCredential(wire), { now: Date.now() });

    // 카드 줄: 값을 지어내 채우지 않고 칸 자체가 없다. 종류도 보통(카드)이라 되풀이하지 않는다.
    for (const wire of [never, used]) {
      expect(within(rowOf(wire)).queryByTestId("dev-credential-device"), wire.name as string).toBeNull();
      expect(within(rowOf(wire)).queryByTestId("dev-credential-kind"), wire.name as string).toBeNull();
    }
    expect(within(rowOf(never)).getByTestId("dev-credential-name").textContent).toBe("달무리 노트북");
    expect(within(rowOf(never)).getByTestId("dev-credential-tool").textContent).toBe(devToolLabel("claude_code"));
    // 아직 안 쓴 줄은 그렇게 말한다.
    expect(within(rowOf(never)).getByTestId("dev-credential-last-used").textContent).toBe(
      model(never).lastUsedLabel
    );
    expect(model(never).neverUsed).toBe(true);
    expect(within(rowOf(used)).getByTestId("dev-credential-last-used").textContent).not.toBe(
      model(never).lastUsedLabel
    );
    // 범위 문장: 읽기 + 보내기에 고른 채널만.
    expect(within(rowOf(used)).getByTestId("dev-credential-scope").textContent).toBe(
      devScopeLabel(used.scopes as string[], true)
    );
    expect(within(rowOf(never)).getByTestId("dev-credential-scope").textContent).toBe(
      devScopeLabel(never.scopes as string[], false)
    );
    expect(within(rowOf(never)).getByTestId("dev-credential-expiry").textContent).toBe(
      model(never).expiryLabel
    );
  });

  it("로그인 세션 줄은 기기 이름을 보이고, 고른 도구가 없으니 도구 칸이 없다", async () => {
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [session] });
    mount();
    const row = await screen.findByTestId(`dev-credential-row-${session.id as string}`);
    expect(row.getAttribute("data-kind")).toBe("session");
    expect(within(row).getByTestId("dev-credential-device").textContent).toBe("정하윤의 노트북");
    expect(within(row).queryByTestId("dev-credential-tool")).toBeNull();
    expect(within(row).getByTestId("dev-credential-kind").textContent).toBe(
      devCredentialRow(parseDevCredential(session), { now: NOW }).kindLabel
    );
  });

  it("목록 상태: 받는 중, 오류와 다시 시도, 비었음", async () => {
    // 받는 중
    routes[`GET ${CREDENTIALS}`] = () => new Promise<Response>(() => undefined);
    const first = mount();
    expect(byId("dev-credentials-loading")).not.toBeNull();
    first.unmount();

    // 오류 → 다시 시도
    routes[`GET ${CREDENTIALS}`] = () => errorBody(null, 500);
    mount();
    const banner = await screen.findByTestId("dev-credentials-error");
    expect(banner.textContent).toContain(devAccessErrorText({ kind: "unknown" }, "list"));
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [] });
    fireEvent.click(within(banner).getByRole("button"));

    // 비었음: 한 줄과 행동 하나
    const empty = await screen.findByTestId("dev-credentials-empty");
    expect(empty).not.toBeNull();
    expect(maybe("dev-credentials-error")).toBeNull();
    fireEvent.click(byId("dev-credentials-start"));
    await waitFor(() => expect(document.activeElement).toBe(byId("dev-access-name")));
  });

  it("만들 수 없는 계정의 빈 목록에는 행동이 없다", async () => {
    routes[`GET ${ROOT}`] = () => json(policy({ policy: "off", canCreate: false }));
    mount();
    await screen.findByTestId("dev-credentials-empty");
    await screen.findByTestId("dev-access-gate");
    expect(maybe("dev-credentials-start")).toBeNull();
  });
});

describe("명령줄·AI 도구: 지우기", () => {
  const first = wireCredential({ id: "019f9b10-0000-7000-8000-0000000000d1", name: "달무리 노트북" });
  const second = wireCredential({
    id: "019f9b10-0000-7000-8000-0000000000d2",
    name: "Codex",
    tool: "codex",
  });

  const rowTestId = (wire: Record<string, unknown>) => `dev-credential-row-${wire.id as string}`;
  const trigger = (wire: Record<string, unknown>) =>
    within(byId(rowTestId(wire))).getByTestId("dev-credential-revoke");

  it("확인하기 전에는 서버에 아무것도 보내지 않고, 확인하면 그 연결만 지워진다", async () => {
    let remaining = [first, second];
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: remaining });
    routes[`DELETE ${CREDENTIALS}/${first.id as string}`] = () => {
      remaining = [second];
      return json({ id: first.id, kind: "card", revokedNow: true });
    };
    mount();
    await screen.findByTestId(rowTestId(first));

    fireEvent.click(trigger(first));
    // 묻는 중: 되돌릴 수 없고 그 도구가 바로 끊긴다고 말한다.
    const question = within(byId(rowTestId(first))).getByTestId("dev-credential-revoke-question");
    expect(question.textContent).toContain(DEV_NOTICES.revokeWarning);
    expect(revokeCalls()).toHaveLength(0);

    fireEvent.click(within(question).getByTestId("dev-credential-revoke-confirm"));
    await waitFor(() => expect(maybe(rowTestId(first))).toBeNull());
    expect(revokeCalls()).toHaveLength(1);
    expect(revokeCalls()[0].path).toBe(`${CREDENTIALS}/${first.id as string}`);
    // 남은 줄은 그대로다. 초점은 이웃 줄의 지우기로 간다.
    expect(maybe(rowTestId(second))).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger(second)));
    expect(byId("dev-credentials-removed").textContent).toContain("달무리 노트북");
    expect(byId("dev-credentials-removed").getAttribute("data-revoked-now")).toBe("true");
  });

  it("묻는 중 취소하면 아무것도 지워지지 않는다", async () => {
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [first] });
    mount();
    await screen.findByTestId(rowTestId(first));
    fireEvent.click(trigger(first));
    const buttons = within(
      within(byId(rowTestId(first))).getByTestId("dev-credential-revoke-question")
    ).getAllByRole("button");
    const cancel = buttons.find(
      (button) => button.getAttribute("data-testid") !== "dev-credential-revoke-confirm"
    );
    fireEvent.click(cancel as HTMLElement);
    expect(revokeCalls()).toHaveLength(0);
    expect(maybe(rowTestId(first))).not.toBeNull();
  });

  it("이미 없는 연결(404)은 그렇게 안내하고, 목록을 새로 읽어 줄을 치운다", async () => {
    let remaining = [first];
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: remaining });
    routes[`DELETE ${CREDENTIALS}/${first.id as string}`] = () => {
      remaining = [];
      return errorBody(null, 404);
    };
    mount();
    await screen.findByTestId(rowTestId(first));
    fireEvent.click(trigger(first));
    fireEvent.click(within(byId(rowTestId(first))).getByTestId("dev-credential-revoke-confirm"));

    const note = await screen.findByTestId("dev-credentials-gone");
    expect(note.textContent).toBe(devAccessErrorText({ kind: "not_found" }, "revoke"));
    await waitFor(() => expect(maybe(rowTestId(first))).toBeNull());
    expect(maybe("dev-credentials-revoke-error")).toBeNull();
  });

  it("그 밖의 실패는 줄을 지우지 않고 종류별 문장으로 말한다", async () => {
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [first] });
    routes[`DELETE ${CREDENTIALS}/${first.id as string}`] = () => errorBody(null, 429, { "Retry-After": "9" });
    mount();
    await screen.findByTestId(rowTestId(first));
    fireEvent.click(trigger(first));
    fireEvent.click(within(byId(rowTestId(first))).getByTestId("dev-credential-revoke-confirm"));

    const alert = await screen.findByTestId("dev-credentials-revoke-error");
    expect(alert.textContent).toBe(
      devAccessErrorText({ kind: "rate_limited", retryAfterSeconds: 9 }, "revoke")
    );
    expect(maybe(rowTestId(first))).not.toBeNull();
  });

  it("마지막 연결을 지우면 빈 문장으로 초점이 가고 빈 목록이 선다", async () => {
    let remaining = [first];
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: remaining });
    routes[`DELETE ${CREDENTIALS}/${first.id as string}`] = () => {
      remaining = [];
      return json({ id: first.id, kind: "card", revokedNow: false });
    };
    await mountReady();
    await screen.findByTestId(rowTestId(first));
    fireEvent.click(trigger(first));
    fireEvent.click(within(byId(rowTestId(first))).getByTestId("dev-credential-revoke-confirm"));
    await screen.findByTestId("dev-credentials-empty");
    // 이미 끝나 있던 연결이라는 사실도 그대로 말한다(`revokedNow:false`).
    expect(byId("dev-credentials-removed").getAttribute("data-revoked-now")).toBe("false");
  });
});

describe("명령줄·AI 도구: 관리자의 전체 보기", () => {
  const mine = wireCredential({ id: "019f9b10-0000-7000-8000-0000000000e1", name: "내 노트북" });
  const theirs = wireCredential({
    id: "019f9b10-0000-7000-8000-0000000000e2",
    name: "서연의 Codex",
    memberId: OTHER,
    tool: "codex",
  });
  const gone = wireCredential({
    id: "019f9b10-0000-7000-8000-0000000000e3",
    name: "나간 사람의 연결",
    memberId: GONE,
  });

  const listBy = (search: string) => (search.includes("scope=all") ? [mine, theirs, gone] : [mine]);

  beforeEach(() => {
    routes[`GET ${ROOT}`] = () => json(policy({ canManageAll: true }));
    routes[`GET ${CREDENTIALS}`] = (call) => json({ credentials: listBy(call.search) });
  });

  it("전환하면 전체를 읽고, 만든 사람 이름이 서고, 남의 줄에는 지우기가 없다", async () => {
    mount();
    await screen.findByTestId(`dev-credential-row-${mine.id as string}`);
    // 처음은 내 연결이다: 요청에 `scope=all`이 없고 남의 줄이 없다.
    expect(calls.some((call) => call.path === CREDENTIALS && call.search.includes("scope=all"))).toBe(false);
    expect(maybe(`dev-credential-row-${theirs.id as string}`)).toBeNull();

    choose("dev-credentials-scope-all");
    const other = await screen.findByTestId(`dev-credential-row-${theirs.id as string}`);
    expect(calls.some((call) => call.path === CREDENTIALS && call.search.includes("scope=all"))).toBe(true);

    expect(within(other).getByTestId("dev-credential-member").textContent).toBe(OTHER_NAME);
    expect(within(other).queryByTestId("dev-credential-revoke")).toBeNull();
    // 명부에 없는 사람은 지어낸 이름이 아니라 나간 멤버다.
    const left = byId(`dev-credential-row-${gone.id as string}`);
    expect(within(left).getByTestId("dev-credential-member").textContent).toBe(GONE_MEMBER_LABEL);
    expect(within(left).queryByTestId("dev-credential-revoke")).toBeNull();
    // 내 줄은 전체 보기에서도 지울 수 있다.
    const own = byId(`dev-credential-row-${mine.id as string}`);
    expect(within(own).getByTestId("dev-credential-member").textContent).toBe("나");
    expect(within(own).getByTestId("dev-credential-revoke")).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="dev-credential-revoke"]')).toHaveLength(1);

    // 다시 내 연결로 돌아오면 남의 줄이 사라진다.
    choose("dev-credentials-scope-mine");
    await waitFor(() => expect(maybe(`dev-credential-row-${theirs.id as string}`)).toBeNull());
  });

  it("관리자가 아니면 전환 자체가 없다", async () => {
    routes[`GET ${ROOT}`] = () => json(policy({ canManageAll: false }));
    mount();
    await screen.findByTestId(`dev-credential-row-${mine.id as string}`);
    expect(maybe("dev-credentials-scope")).toBeNull();
  });
});

describe("명령줄·AI 도구: 연결이 끊겼을 때", () => {
  it("만들기는 잠기고 사유가 연결되며, 눌러도 아무것도 보내지 않는다", async () => {
    await mountReady({ offline: true });
    const button = byId("dev-access-create");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reasonId = button.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId as string)).not.toBeNull();

    await submitWith();
    expect(createCalls()).toHaveLength(0);
    expect(maybe("dev-access-reveal")).toBeNull();
    // 칸은 비워지지 않는다(보내지 않았으니 지울 이유가 없다).
    expect(input("dev-access-password").value).toBe(PASSWORD);
  });

  it("지우기는 잠기고 사유가 연결되며, 눌러도 묻지 않는다", async () => {
    const row = wireCredential({ id: "019f9b10-0000-7000-8000-0000000000f1" });
    routes[`GET ${CREDENTIALS}`] = () => json({ credentials: [row] });
    mount({ offline: true });
    await screen.findByTestId(`dev-credential-row-${row.id as string}`);
    const revoke = byId("dev-credential-revoke");
    expect(revoke.getAttribute("aria-disabled")).toBe("true");
    const reasonId = revoke.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId as string)).not.toBeNull();
    fireEvent.click(revoke);
    expect(maybe("dev-credential-revoke-question")).toBeNull();
    expect(revokeCalls()).toHaveLength(0);
  });
});

describe("명령줄·AI 도구: 고른 채널", () => {
  it("내가 들어간 채널이 목록으로 서고, 고른 개수를 말한다", async () => {
    await mountReady();
    expect(maybe("dev-access-channels")).toBeNull();
    fireEvent.click(byId("dev-access-restrict"));
    await screen.findByTestId("dev-access-channels");
    expect(document.querySelectorAll('[data-testid="dev-access-channels-row"]')).toHaveLength(CHANNELS.length);
    const countBefore = byId("dev-access-channels-count").textContent;
    pick(`dev-access-channels-${CH_PRODUCT}`);
    expect(byId("dev-access-channels-count").textContent).not.toBe(countBefore);
  });

  it("들어간 채널이 없으면 고를 것이 없다고 말한다", async () => {
    routes[`GET /v1/workspaces/${WS}/channels`] = () => json({ channels: [] });
    await mountReady();
    fireEvent.click(byId("dev-access-restrict"));
    await screen.findByTestId("dev-access-channels-empty");
  });

  it("채널 목록을 못 받으면 다시 시도로 이어진다", async () => {
    routes[`GET /v1/workspaces/${WS}/channels`] = () => errorBody(null, 500);
    await mountReady();
    fireEvent.click(byId("dev-access-restrict"));
    const banner = await screen.findByTestId("dev-access-channels-error");
    routes[`GET /v1/workspaces/${WS}/channels`] = () => json({ channels: CHANNELS });
    fireEvent.click(within(banner).getByRole("button"));
    await screen.findByTestId("dev-access-channels");
  });
});
