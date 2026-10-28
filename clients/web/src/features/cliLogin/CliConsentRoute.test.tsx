// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LoginResponse } from "@momo/core/lib/api";
import { installCoreHost, resetCoreHost, type SessionPort } from "@momo/core/runtime/host";
import {
  CLI_CONSENT_APPROVE_LABEL,
  CLI_CONSENT_CREDENTIAL_LIMIT,
  CLI_CONSENT_DENY_LABEL,
  CLI_CONSENT_DEVICE_MISSING,
  CLI_CONSENT_PASSWORD_LABEL,
  CLI_CONSENT_RETRY_ACTION,
  CLI_SCOPES,
  cliScopeSentences,
} from "@momo/core/features/cliLogin/consent";
import type { SessionRestoreStatus } from "@/app/session";
import { CliConsentRoute } from "./CliConsentRoute";

// =============================================================================
// oort CLI 로그인 동의 화면 (#4700): 사람이 보는 것(역할·레이블·상태 속성)과 서버로
// 나가는 요청, 그리고 돌아가는 곳만 본다. 서버와 브라우저 이동만 대신하고 코어의
// 파서·분류는 진짜를 쓴다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const REQUEST = "signed.envelope.value";
const ISSUER = "https%3A%2F%2Foort.dalmuri.example";
const CALLBACK = `http://127.0.0.1:24681/callback?code=one-time&state=st&iss=${ISSUER}`;
const DENIED = `http://127.0.0.1:24681/callback?error=access_denied&state=st&iss=${ISSUER}`;
const PREVIEW_PATH = `/v1/workspaces/${WS}/dev-access/authorization-requests/preview`;
const APPROVE_PATH = `/v1/workspaces/${WS}/dev-access/authorization-requests/approve`;
const DENY_PATH = `/v1/workspaces/${WS}/dev-access/authorization-requests/deny`;

const session: LoginResponse = {
  accessToken: "access",
  refreshToken: "refresh",
  member: {
    id: "00000000-0000-7000-8000-000000000101",
    workspaceId: WS,
    kind: "human",
    displayName: "이도현",
    handle: "dohyun",
  },
  realtimeWebSocketUrl: "wss://oort.test/connection/websocket",
};

function wirePreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientName: "oort CLI",
    clientId: "oort-cli",
    issuer: "https://oort.dalmuri.example",
    serverHost: "oort.dalmuri.example",
    workspaceId: WS,
    workspaceName: "달무리 스튜디오",
    memberDisplayName: "이도현",
    role: "owner",
    deviceName: "oort CLI · macOS",
    requestedScopes: [...CLI_SCOPES],
    canSend: true,
    expiresAtMs: Date.now() + 9 * 60_000,
    accessMinutes: 15,
    idleDays: 30,
    maxDays: 90,
    ...overrides,
  };
}

// ---- 서버와 브라우저 이동 ----------------------------------------------------

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
interface Recorded {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
}
type Handler = (request: Recorded) => Reply | Promise<Reply>;

const requests: Recorded[] = [];
let handlers: { preview: Handler; approve: Handler; deny: Handler };
let replace: ReturnType<typeof vi.fn>;

function error(status: number, code?: string, headers?: Record<string, string>): Reply {
  return {
    status,
    body: { error: { message: "server sentence", ...(code ? { code } : {}) } },
    ...(headers ? { headers } : {}),
  };
}

function installServer(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const record: Recorded = {
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      };
      requests.push(record);
      const handler = url.pathname.endsWith("/preview")
        ? handlers.preview
        : url.pathname.endsWith("/approve")
          ? handlers.approve
          : url.pathname.endsWith("/deny")
            ? handlers.deny
            : null;
      if (handler === null) return new Response(null, { status: 404 });
      const reply = await handler(record);
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "Content-Type": "application/json", ...reply.headers },
      });
    })
  );
}

function installHost(): void {
  const port: SessionPort = {
    getAccessToken: () => "access",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: port,
  });
}

function openAt(search: string): void {
  replace = vi.fn();
  // jsdom 은 location.replace 를 구현하지 않는다. 이 주소에 서 있는 것으로 읽히게 하고
  // 이동만 가로챈다.
  const url = new URL(`https://oort.test/oauth/cli${search}`);
  vi.stubGlobal("location", {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    replace,
    assign: vi.fn(),
    reload: vi.fn(),
  });
}

beforeEach(() => {
  requests.length = 0;
  handlers = {
    preview: () => ({ body: wirePreview() }),
    approve: () => ({ body: { redirectTo: CALLBACK } }),
    deny: () => ({ body: { redirectTo: DENIED } }),
  };
  installHost();
  installServer();
  openAt(`?request=${REQUEST}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCoreHost();
});

function mountRoute(opts: {
  status?: SessionRestoreStatus;
  session?: LoginResponse | null;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLoggedIn = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CliConsentRoute
        status={opts.status ?? "signed-in"}
        session={opts.session === undefined ? session : opts.session}
        onLoggedIn={onLoggedIn}
      />
    </QueryClientProvider>
  );
  return { onLoggedIn };
}

async function form(): Promise<HTMLElement> {
  return screen.findByTestId("cli-consent-form");
}

function passwordInput(): HTMLInputElement {
  return screen.getByLabelText(CLI_CONSENT_PASSWORD_LABEL) as HTMLInputElement;
}

function approveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: CLI_CONSENT_APPROVE_LABEL });
}

function denyButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: CLI_CONSENT_DENY_LABEL });
}

function typePassword(value: string): void {
  fireEvent.change(passwordInput(), { target: { value } });
}

function radio(value: string): HTMLInputElement {
  const found = screen
    .getAllByRole("radio")
    .find((node) => (node as HTMLInputElement).value === value);
  if (!found) throw new Error(`radio ${value}`);
  return found as HTMLInputElement;
}

function posts(path: string): Recorded[] {
  return requests.filter((request) => request.method === "POST" && request.path === path);
}

async function approveWith(password: string): Promise<void> {
  await form();
  typePassword(password);
  fireEvent.click(approveButton());
}

describe("동의 화면: 보여 주는 것", () => {
  it("대조할 사실을 서버가 준 대로 보여 주고 첫 포커스는 제목이다", async () => {
    mountRoute();
    const root = await form();
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    for (const fact of [
      "oort CLI",
      "oort.dalmuri.example",
      "oort CLI · macOS",
      "달무리 스튜디오",
      "이도현",
    ]) {
      expect(root.textContent).toContain(fact);
    }
    expect(screen.getByTestId("cli-consent-device-note")).toBeTruthy();
    const input = passwordInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    // 첫 포커스는 제목이다(비밀번호 칸으로 주면 긴 폼이 아래로 스크롤돼 대조할 사실이 밀린다).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
    expect(requests[0]?.search).toBe(`?request=${REQUEST}`);
    expect(requests[0]?.path).toBe(PREVIEW_PATH);
  });

  it("기기 이름을 보내지 않았으면 그렇게 말하고, 이름이 있든 없든 그 값이 보증이 아니라고 붙인다", async () => {
    handlers.preview = () => ({ body: wirePreview({ deviceName: null }) });
    mountRoute();
    const root = await form();
    expect(root.textContent).toContain(CLI_CONSENT_DEVICE_MISSING);
    expect(screen.getByTestId("cli-consent-device-note")).toBeTruthy();
  });

  it("방향 문자로 모양을 속인 기기 이름은 걷어낸 모양으로만 그린다", async () => {
    handlers.preview = () => ({ body: wirePreview({ deviceName: "ci‮gnirps" }) });
    mountRoute();
    const root = await form();
    expect(root.textContent).toContain("cignirps");
    expect(root.textContent).not.toContain("‮");
  });

  it("읽기만이 기본이고, 허용하기 전에는 비밀번호가 비어 있어 허용이 눌리지 않는다", async () => {
    mountRoute();
    await form();
    expect(radio("read").checked).toBe(true);
    expect(radio("read-send").checked).toBe(false);
    expect(approveButton().getAttribute("aria-disabled")).toBe("true");
    expect(denyButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(approveButton());
    expect(posts(APPROVE_PATH)).toHaveLength(0);
    typePassword("pw");
    expect(approveButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("보내기가 요청에 없으면 읽기와 보내기는 이유와 함께 막혀 고를 수 없다", async () => {
    handlers.preview = () => ({
      body: wirePreview({
        requestedScopes: ["dev:identity", "dev:channels:read", "dev:messages:read"],
        canSend: false,
      }),
    });
    mountRoute();
    await form();
    const send = radio("read-send");
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(send);
    expect(radio("read").checked).toBe(true);
    expect(send.checked).toBe(false);
  });

  it("프리셋 설명은 이 요청이 담은 범위만 풀어쓴다", async () => {
    handlers.preview = () => ({
      body: wirePreview({
        requestedScopes: ["dev:identity", "dev:channels:read", "dev:messages:write"],
      }),
    });
    mountRoute();
    await form();
    const described = (value: string): string => {
      const ids = (radio(value).getAttribute("aria-describedby") ?? "").split(" ");
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    };
    const [identity, channels, messages, write, inbox] = cliScopeSentences([...CLI_SCOPES]);
    // 읽기만: 요청 ∩ 읽기. 요청에 없는 것(메시지 읽기·받은 편지함)과 쓰기는 없다.
    for (const line of [identity, channels]) expect(described("read")).toContain(line);
    for (const line of [messages, inbox, write]) expect(described("read")).not.toContain(line);
    // 읽기와 보내기: 요청 전체(요청에 없는 것은 여기에도 없다).
    for (const line of [identity, channels, write]) expect(described("read-send")).toContain(line);
    for (const line of [messages, inbox]) expect(described("read-send")).not.toContain(line);
  });
});

describe("동의 화면: 허용과 거절", () => {
  it("읽기만 허용은 approvedScopes 없이 현재 비밀번호와 요청을 보내고 콜백으로 replace 한다", async () => {
    mountRoute();
    await approveWith("correct horse");
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH)).toHaveLength(1);
    const body = posts(APPROVE_PATH)[0]?.body;
    expect(body).toEqual({ request: REQUEST, currentPassword: "correct horse" });
    expect(body && "approvedScopes" in body).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(CALLBACK);
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
  });

  it("읽기와 보내기를 고르면 요청 범위 전체를 싣는다", async () => {
    mountRoute();
    await form();
    fireEvent.click(radio("read-send"));
    typePassword("pw");
    fireEvent.click(approveButton());
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH)[0]?.body?.approvedScopes).toEqual([...CLI_SCOPES]);
  });

  it("폼 제출(Enter)도 허용이고, 비밀번호가 비어 있으면 요청을 만들지 않는다", async () => {
    mountRoute();
    const root = await form();
    fireEvent.submit(root);
    expect(posts(APPROVE_PATH)).toHaveLength(0);
    typePassword("pw");
    fireEvent.submit(root);
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH)).toHaveLength(1);
  });

  it("요청이 떠 있는 동안 두 번 눌러도 결정은 하나만 나간다", async () => {
    let release: (reply: Reply) => void = () => undefined;
    handlers.approve = () => new Promise<Reply>((resolve) => (release = resolve));
    mountRoute();
    await form();
    typePassword("pw");
    // 한 틱 안에 겹쳐 닿는 활성화다(Enter 자동 반복, 클릭과 제출). 첫 활성화가 상태를
    // 바꿔도 아직 렌더되지 않아, 화면 상태만으로는 두 번째를 못 막는다.
    const approve = approveButton();
    const root = screen.getByTestId("cli-consent-form");
    act(() => {
      fireEvent.click(approve);
      fireEvent.click(approve);
      fireEvent.submit(root);
      fireEvent.submit(root);
      fireEvent.click(denyButton());
    });
    await waitFor(() =>
      expect(screen.getByTestId("cli-consent-approve").getAttribute("aria-busy")).toBe("true")
    );
    // 렌더된 뒤에 닿는 눌림도 같다.
    fireEvent.click(approve);
    fireEvent.click(denyButton());
    release({ body: { redirectTo: CALLBACK } });
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH)).toHaveLength(1);
    expect(posts(DENY_PATH)).toHaveLength(0);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("결정이 끝난 뒤에는 어떤 눌림도 새 요청을 만들지 않는다", async () => {
    handlers.approve = () => error(409, "dev_login_already_decided");
    mountRoute();
    await approveWith("pw");
    await screen.findByTestId("cli-consent-terminal");
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
    expect(posts(APPROVE_PATH)).toHaveLength(1);
    expect(posts(DENY_PATH)).toHaveLength(0);
  });

  it("거절은 비밀번호 없이 요청 봉투만 보내고 error 콜백으로 replace 한다", async () => {
    mountRoute();
    await form();
    fireEvent.click(denyButton());
    await screen.findByTestId("cli-consent-returning");
    expect(posts(DENY_PATH)[0]?.body).toEqual({ request: REQUEST });
    expect(posts(APPROVE_PATH)).toHaveLength(0);
    expect(replace).toHaveBeenCalledWith(DENIED);
  });

  it("틀린 비밀번호는 폼에 남아 칸을 비우고 초점과 aria-invalid 로 다시 받는다", async () => {
    let attempts = 0;
    handlers.approve = () => {
      attempts += 1;
      return attempts === 1
        ? error(403, "current_password_incorrect")
        : { body: { redirectTo: CALLBACK } };
    };
    mountRoute();
    await approveWith("wrong");
    await waitFor(() => expect(passwordInput().getAttribute("aria-invalid")).toBe("true"));
    expect(passwordInput().value).toBe("");
    expect(document.activeElement).toBe(passwordInput());
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("cli-consent-form")).toBeTruthy();

    typePassword("right");
    expect(passwordInput().getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(approveButton());
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH).map((request) => request.body?.currentPassword)).toEqual([
      "wrong",
      "right",
    ]);
    expect(replace).toHaveBeenCalledWith(CALLBACK);
  });
});

describe("동의 화면: 돌아갈 곳 방어", () => {
  it.each([
    ["다른 호스트", "https://evil.test/callback?code=x&state=st"],
    ["localhost", "http://localhost:24681/callback?code=x&state=st"],
    ["IPv6 루프백", "http://[::1]:24681/callback?code=x&state=st"],
    ["다른 경로", "http://127.0.0.1:24681/steal?code=x&state=st"],
    ["계정 정보", "http://evil@127.0.0.1:24681/callback?code=x&state=st"],
  ])("허용 응답의 돌아갈 곳이 %s 이면 따라가지 않고 종료한다", async (_name, redirectTo) => {
    handlers.approve = () => ({ body: { redirectTo } });
    mountRoute();
    await approveWith("pw");
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe("redirect-refused");
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
    expect(screen.queryByTestId("cli-consent-returning")).toBeNull();
  });

  it("거절 응답의 돌아갈 곳도 같은 검사를 거친다", async () => {
    handlers.deny = () => ({ body: { redirectTo: "https://evil.test/callback?error=x" } });
    mountRoute();
    await form();
    fireEvent.click(denyButton());
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe("redirect-refused");
    expect(replace).not.toHaveBeenCalled();
  });

  it("읽을 수 없는 결정 응답도 다시 시도시키지 않고 종료한다", async () => {
    handlers.approve = () => ({ body: { notRedirect: true } });
    mountRoute();
    await approveWith("pw");
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe("redirect-refused");
    expect(replace).not.toHaveBeenCalled();
    expect(posts(APPROVE_PATH)).toHaveLength(1);
  });
});

describe("동의 화면: 서버의 거절", () => {
  it.each([
    [404, "dev_login_request_not_found", "not-found"],
    [409, "dev_login_already_decided", "already-decided"],
    [403, "dev_access_denied", "access-denied"],
    [403, "current_password_unavailable", "password-unavailable"],
  ])("결정 시점의 %i %s 는 종료 화면 %s 이고 허용 버튼이 남지 않는다", async (status, code, terminalKind) => {
    handlers.approve = () => error(status, code);
    mountRoute();
    await approveWith("pw");
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe(terminalKind);
    expect(screen.queryByRole("button", { name: CLI_CONSENT_APPROVE_LABEL })).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(posts(APPROVE_PATH)).toHaveLength(1);
  });

  it("로그인 기기 한도는 폼 위 안내이고, 비밀번호는 남아 다시 누를 수 있다", async () => {
    let attempts = 0;
    handlers.approve = () => {
      attempts += 1;
      return attempts === 1 ? error(409, "dev_credential_limit") : { body: { redirectTo: CALLBACK } };
    };
    mountRoute();
    await approveWith("pw");
    const banner = await screen.findByTestId("cli-consent-failure");
    expect(banner.textContent).toContain(CLI_CONSENT_CREDENTIAL_LIMIT);
    expect(screen.getByTestId("cli-consent-form")).toBeTruthy();
    expect(passwordInput().value).toBe("pw");
    fireEvent.click(approveButton());
    await screen.findByTestId("cli-consent-returning");
    expect(posts(APPROVE_PATH)).toHaveLength(2);
  });

  it("429 는 서버가 알려 준 남은 초를 말하고 폼에 남는다", async () => {
    handlers.approve = () => error(429, undefined, { "Retry-After": "42" });
    mountRoute();
    await approveWith("pw");
    const banner = await screen.findByTestId("cli-consent-failure");
    expect(banner.textContent).toContain("42");
    expect(screen.getByTestId("cli-consent-form")).toBeTruthy();
  });

  it("503 도 기다릴 시간을 말하고, 없으면 일반 문구로 말한다", async () => {
    handlers.approve = () => error(503, undefined, { "Retry-After": "3" });
    mountRoute();
    await approveWith("pw");
    expect((await screen.findByTestId("cli-consent-failure")).textContent).toContain("3");
    cleanup();

    handlers.approve = () => error(503);
    mountRoute();
    await approveWith("pw");
    const banner = await screen.findByTestId("cli-consent-failure");
    expect(banner.textContent).not.toMatch(/\d/);
  });

  it("네트워크가 닿지 않으면 폼에 남아 다시 시도할 수 있다", async () => {
    let attempts = 0;
    handlers.approve = () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return { body: { redirectTo: CALLBACK } };
    };
    mountRoute();
    await approveWith("pw");
    await screen.findByTestId("cli-consent-failure");
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(approveButton());
    await screen.findByTestId("cli-consent-returning");
    expect(replace).toHaveBeenCalledWith(CALLBACK);
  });

  it("거절을 저장하지 못해도 폼에 남고, 거절은 다시 누를 수 있다", async () => {
    let attempts = 0;
    handlers.deny = () => {
      attempts += 1;
      return attempts === 1 ? error(500) : { body: { redirectTo: DENIED } };
    };
    mountRoute();
    await form();
    fireEvent.click(denyButton());
    await screen.findByTestId("cli-consent-failure");
    fireEvent.click(denyButton());
    await screen.findByTestId("cli-consent-returning");
    expect(replace).toHaveBeenCalledWith(DENIED);
  });
});

describe("동의 화면: 불러오기와 종료", () => {
  it("불러오는 동안은 로딩이고 폼이 없다", async () => {
    let release: (reply: Reply) => void = () => undefined;
    handlers.preview = () => new Promise<Reply>((resolve) => (release = resolve));
    mountRoute();
    expect(await screen.findByTestId("cli-consent-loading")).toBeTruthy();
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
    release({ body: wirePreview() });
    await form();
    expect(screen.queryByTestId("cli-consent-loading")).toBeNull();
  });

  it("복원 중이면 요청을 보내지 않고 로딩만 그린다", async () => {
    mountRoute({ status: "restoring", session: null });
    expect(await screen.findByTestId("cli-consent-loading")).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it("요청 값이 없는 주소는 서버에 묻지 않고 종료한다", async () => {
    openAt("");
    mountRoute();
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe("not-found");
    expect(requests).toHaveLength(0);
  });

  it.each([
    [404, "dev_login_request_not_found", "not-found"],
    [403, "dev_access_denied", "access-denied"],
    [409, "dev_login_already_decided", "already-decided"],
  ])("preview 의 %i %s 는 종료 화면 %s 이다", async (status, code, terminalKind) => {
    handlers.preview = () => error(status, code);
    mountRoute();
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe(terminalKind);
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
  });

  it("만료된 요청에는 허용 버튼을 세우지 않는다", async () => {
    handlers.preview = () => ({ body: wirePreview({ expiresAtMs: Date.now() - 1_000 }) });
    mountRoute();
    const terminal = await screen.findByTestId("cli-consent-terminal");
    expect(terminal.getAttribute("data-terminal")).toBe("expired");
    expect(screen.queryByRole("button", { name: CLI_CONSENT_APPROVE_LABEL })).toBeNull();
  });

  it("일시 오류는 다시 시도 배너이고, 다시 시도하면 폼이 선다", async () => {
    let attempts = 0;
    handlers.preview = () => {
      attempts += 1;
      return attempts === 1 ? error(503, undefined, { "Retry-After": "2" }) : { body: wirePreview() };
    };
    mountRoute();
    const banner = await screen.findByTestId("cli-consent-preview-error");
    expect(banner.textContent).toContain("2");
    fireEvent.click(screen.getByRole("button", { name: CLI_CONSENT_RETRY_ACTION }));
    await form();
    expect(requests.filter((request) => request.path === PREVIEW_PATH)).toHaveLength(2);
  });

  it("오프라인에서 열면 로딩에 멈추지 않고 닿지 못했다고 말하며, 다시 시도할 수 있다", async () => {
    let attempts = 0;
    handlers.preview = () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return { body: wirePreview() };
    };
    mountRoute();
    await screen.findByTestId("cli-consent-preview-error");
    expect(screen.queryByTestId("cli-consent-loading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: CLI_CONSENT_RETRY_ACTION }));
    await form();
  });

  it("오프라인이면 안내를 세우고 허용과 거절이 요청을 만들지 않는다", async () => {
    mountRoute();
    await form();
    typePassword("pw");
    fireEvent(window, new Event("offline"));
    await screen.findByTestId("cli-consent-offline");
    expect(approveButton().getAttribute("aria-disabled")).toBe("true");
    expect(denyButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(approveButton());
    fireEvent.click(denyButton());
    expect(posts(APPROVE_PATH)).toHaveLength(0);
    expect(posts(DENY_PATH)).toHaveLength(0);
  });
});

describe("동의 화면: 세션", () => {
  it("로그아웃 상태면 요청을 보내지 않고 로그인 화면을 세운다", async () => {
    mountRoute({ status: "anonymous", session: null });
    expect(await screen.findByTestId("cli-consent-signin")).toBeTruthy();
    expect(requests).toHaveLength(0);
  });

  it("결정 도중 401 이면 다시 로그인 화면으로 되돌린다", async () => {
    handlers.approve = () => error(401);
    mountRoute();
    await approveWith("pw");
    expect(await screen.findByTestId("cli-consent-signin")).toBeTruthy();
    expect(screen.queryByTestId("cli-consent-form")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("preview 의 401 도 다시 로그인 화면으로 되돌린다", async () => {
    handlers.preview = () => error(401);
    mountRoute();
    expect(await screen.findByTestId("cli-consent-signin")).toBeTruthy();
    expect(screen.queryByTestId("cli-consent-preview-error")).toBeNull();
  });
});
