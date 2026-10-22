// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_APP_CALLBACK_PATH, GITHUB_HANDOFF_PATH } from "./handoff";
import { GithubHandoffPage } from "./GithubHandoffPage";

// 시스템 브라우저가 여는 공개 핸드오프 페이지(#4220): 조각을 읽자마자 주소창에서 지우고, 이 서버의
// 것이 아닌 매니페스트는 폼 없이 거절하며, 어디에도 state 를 남기지 않는다.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATE = `00000000-0000-7000-8000-000000000001.${"c4d9".repeat(16)}`;
const ORG_URL = `https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=${STATE}`;
const USER_URL = `https://github.com/settings/apps/new?state=${STATE}`;

// jsdom 의 오리진(`http://localhost:3000`)이 곧 이 페이지가 선 서버다.
function manifest(origin = window.location.origin): Record<string, unknown> {
  return {
    name: "oort-oort-yeomyeonggeori-test",
    url: origin,
    hook_attributes: { url: `${origin}/v1/integrations/github/webhook`, active: true },
    redirect_url: `${origin}${GITHUB_APP_CALLBACK_PATH}`,
    setup_url: `${origin}/v1/integrations/github/setup`,
    description: "oort가 저장소의 PR·이슈·체크 소식을 채널로 받아 와요.",
    public: false,
    default_permissions: { metadata: "read", contents: "read" },
  };
}

function hashFor(payload: Record<string, unknown>): string {
  return `#${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

const goodHash = (over: Record<string, unknown> = {}) => hashFor({ v: 1, u: ORG_URL, m: manifest(), e: 3600, ...over });

interface Submitted {
  action: string;
  method: string;
  manifest: string;
  rel: string;
}
let submitted: Submitted[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  submitted = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push({
      action: this.getAttribute("action") ?? "",
      method: this.getAttribute("method") ?? "",
      manifest: (this.elements.namedItem("manifest") as HTMLInputElement | null)?.value ?? "",
      rel: this.getAttribute("rel") ?? "",
    });
  });
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, name).mockImplementation(() => undefined));
  }
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  consoleSpies.length = 0;
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
});

function mountAt(hash: string, search = ""): HTMLElement {
  window.history.replaceState(null, "", `${GITHUB_HANDOFF_PATH}${search}${hash}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(GithubHandoffPage)));
  return host;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("GitHub 앱 만들기 핸드오프 페이지: 조각은 읽는 즉시 주소창에서 지운다", () => {
  it("마운트 뒤 주소에는 조각도 쿼리도 없고 기록 항목은 늘지 않는다", () => {
    const lengthBefore = window.history.length;
    mountAt(goodHash());
    // 이 단정이 「조각을 지우지 않으면 빨개지는」 사보타주 대상이다.
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe(GITHUB_HANDOFF_PATH);
    expect(window.location.href).not.toContain(STATE);
    expect(window.location.href).not.toContain("#");
    // 새 항목을 만들지 않고 지금 항목을 덮어쓴다.
    expect(window.history.length).toBe(lengthBefore);
  });

  it("거절하는 주소에서도 조각을 지운다", () => {
    mountAt(goodHash({ m: manifest("https://collector.evil.example") }));
    expect(window.location.hash).toBe("");
    expect(q("github-handoff-form")).toBeNull();
  });

  it("원래 쿼리와 기록 상태는 그대로 둔다", () => {
    window.history.replaceState({ keep: 1 }, "", "/");
    window.history.replaceState({ keep: 1 }, "", `${GITHUB_HANDOFF_PATH}?utm=1${goodHash()}`);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(createElement(GithubHandoffPage)));
    expect(window.location.search).toBe("?utm=1");
    expect(window.location.hash).toBe("");
    expect(window.history.state).toEqual({ keep: 1 });
  });
});

describe("GitHub 앱 만들기 핸드오프 페이지: state 는 어디에도 남지 않는다", () => {
  it("저장소·쿠키·콘솔·보이는 글자에 state 도 조각도 없다", () => {
    const hash = goodHash();
    const payload = hash.slice(1);
    const el = mountAt(hash);
    const everything = () =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
        logs: consoleSpies.flatMap((spy) => spy.mock.calls),
        text: el.textContent,
        title: document.title,
        url: window.location.href,
      });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(everything()).not.toContain(STATE);
    expect(everything()).not.toContain(payload);
  });
});

describe("GitHub 앱 만들기 핸드오프 페이지: GitHub 로 POST", () => {
  it("읽은 즉시 등록 주소로 매니페스트를 정확히 한 번 POST 한다", () => {
    mountAt(goodHash());
    expect(submitted).toHaveLength(1);
    expect(submitted[0].method).toBe("post");
    expect(submitted[0].action).toBe(ORG_URL);
    expect(JSON.parse(submitted[0].manifest)).toEqual(manifest());
    // GitHub 에 이 페이지 주소를 알리지 않는다.
    expect(submitted[0].rel).toContain("noreferrer");
  });

  it("다시 그려도 다시 쏘지 않는다", () => {
    mountAt(goodHash());
    act(() => root?.render(createElement(GithubHandoffPage)));
    act(() => root?.render(createElement(GithubHandoffPage)));
    expect(submitted).toHaveLength(1);
  });

  it("자동 제출이 막히는 환경을 위한 수동 버튼이 같은 폼에 있다", () => {
    mountAt(goodHash());
    const form = q("github-handoff-form") as HTMLFormElement;
    const button = q("github-handoff-submit") as HTMLButtonElement;
    expect(button.type).toBe("submit");
    expect(button.closest("form")).toBe(form);
    expect(button.textContent).toBe("GitHub에서 앱 만들기");
    expect(form.getAttribute("action")).toBe(ORG_URL);
    expect((form.elements.namedItem("manifest") as HTMLInputElement).type).toBe("hidden");
  });

  it("행선지와 받는 서버와 시한을 사람 눈앞에 둔다", () => {
    const el = mountAt(goodHash());
    expect(el.textContent).toContain("yeomyeonggeori 조직");
    expect(el.textContent).toContain(window.location.host);
    expect(el.textContent).toContain("oort-oort-yeomyeonggeori-test");
    expect(el.textContent).toContain("60분 안에 마쳐야 해요");
    expect(q("github-handoff-title")?.textContent).toBe("GitHub 앱 만들기 화면으로 이동해요.");
  });

  it("개인 계정이면 「내 GitHub 계정」이라고 말한다", () => {
    const el = mountAt(goodHash({ u: USER_URL }));
    expect(el.textContent).toContain("내 GitHub 계정");
    expect(submitted[0].action).toBe(USER_URL);
  });
});

describe("GitHub 앱 만들기 핸드오프 페이지: 믿을 수 없는 조각은 폼을 만들지 않는다", () => {
  it.each([
    ["조각 없음", "", "이 주소는 한 번만 열 수 있어요."],
    ["깨진 조각", "#%%%", "이 주소를 읽지 못했어요."],
    ["JSON 아님", `#${Buffer.from("not json").toString("base64url")}`, "이 주소를 읽지 못했어요."],
    ["GitHub 가 아닌 등록 주소", goodHash({ u: `https://evil.example/settings/apps/new?state=${STATE}` }), "이 주소를 읽지 못했어요."],
    ["남의 서버 매니페스트", goodHash({ m: manifest("https://collector.evil.example") }), "이 서버에서 만든 주소가 아니에요."],
    [
      "콜백이 다른 곳으로 가는 매니페스트",
      goodHash({ m: { ...manifest(), redirect_url: "https://collector.evil.example/cb" } }),
      "이 서버에서 만든 주소가 아니에요.",
    ],
  ])("%s", (_name, hash, line) => {
    const el = mountAt(hash);
    // 이 단정들이 「오리진 검사를 지우면 빨개지는」 사보타주 대상이다.
    expect(q("github-handoff-form")).toBeNull();
    expect(submitted).toHaveLength(0);
    expect(q("github-handoff-title")?.textContent).toBe(line);
    expect(el.textContent).toContain("oort 앱에서 「GitHub 앱 만들기」를 다시 눌러 주세요.");
    // 거절하는 쪽도 조각의 어떤 값도 되풀이하지 않는다.
    expect(el.textContent).not.toContain("evil");
    expect(el.textContent).not.toContain(STATE);
  });

  it("거절 때 GitHub 로는 아무것도 보내지 않았다고 말한다", () => {
    const el = mountAt(goodHash({ m: manifest("https://collector.evil.example") }));
    expect(el.textContent).toContain("GitHub로는 아무것도 보내지 않았어요.");
  });
});
