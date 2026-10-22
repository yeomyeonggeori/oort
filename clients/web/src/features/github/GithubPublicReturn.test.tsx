// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { GithubPublicReturn } from "./GithubPublicReturn";

// 로그인 안 된 브라우저의 착지(#4220): 결과 한 문장과 「oort 앱으로 돌아가세요」. 닫힌 단어 집합,
// 비밀 없음, 단어는 주소창에서 지운다.

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

function mountAt(search: string, returned: { kind: "app" | "install"; word: string }): HTMLElement {
  window.history.replaceState(null, "", `/${search}`);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(GithubPublicReturn, { returned })));
  return host;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("로그인 안 된 브라우저의 GitHub 착지", () => {
  it("앱 등록이 끝났다는 문장과 「oort 앱으로 돌아가세요」를 말한다", () => {
    const el = mountAt("?githubApp=created", { kind: "app", word: "created" });
    expect(q("github-public-return-title")?.textContent).toBe(
      "GitHub 앱을 만들었어요. 이제 워크스페이스마다 연결할 수 있어요."
    );
    // 이 단정이 「돌아가라는 말을 지우면 빨개지는」 사보타주 대상이다.
    expect(q("github-public-return-back")?.textContent).toBe("oort 앱으로 돌아가세요.");
    expect(q("github-public-return-body")?.getAttribute("data-return-tone")).toBe("ok");
    expect(el.textContent).toContain("이 창은 닫아도 돼요.");
  });

  it("설치가 끝난 단어도 같은 문으로 말한다", () => {
    mountAt("?githubInstall=linked", { kind: "install", word: "linked" });
    expect(q("github-public-return-title")?.textContent).toBe("GitHub 계정이 이 워크스페이스에 연결됐어요.");
    expect(q("github-public-return-back")?.textContent).toBe("oort 앱으로 돌아가세요.");
  });

  it("막힌 단어는 이유와 다음 걸음을 같이 말하고 톤이 stop 이다", () => {
    const el = mountAt("?githubApp=state_invalid", { kind: "app", word: "state_invalid" });
    expect(q("github-public-return-title")?.textContent).toBe("등록 시간이 지났거나 이미 쓴 등록이에요.");
    expect(el.textContent).toContain("「GitHub 앱 만들기」를 다시 눌러 주세요.");
    expect(q("github-public-return-body")?.getAttribute("data-return-tone")).toBe("stop");
    expect(q("github-public-return-back")?.textContent).toBe("oort 앱으로 돌아가세요.");
  });

  it("아직 한 걸음 남은 단어는 wait 이다", () => {
    mountAt("?githubInstall=requested", { kind: "install", word: "requested" });
    expect(q("github-public-return-body")?.getAttribute("data-return-tone")).toBe("wait");
  });

  it("단어는 읽는 즉시 주소창에서 지우고 나머지 쿼리는 둔다", () => {
    mountAt("?githubApp=created&keep=1", { kind: "app", word: "created" });
    // 이 단정이 「단어를 안 지우면 빨개지는」 사보타주 대상이다. 새로고침이 같은 말을 되풀이하지 않는다.
    expect(window.location.search).toBe("?keep=1");
    expect(new URLSearchParams(window.location.search).get("githubApp")).toBeNull();
  });

  it("모르는 단어는 아무것도 그리지 않는다(주소의 값을 화면에 올리지 않는다)", () => {
    const el = mountAt("?githubApp=%3Cscript%3Ealert(1)", { kind: "app", word: "<script>alert(1)" });
    expect(el.textContent).toBe("");
    expect(q("github-public-return")).toBeNull();
  });

  it("비밀을 담을 자리가 없다: 단어 말고 주소의 어떤 값도 화면과 속성에 없다", () => {
    const el = mountAt("?githubApp=created&code=SECRET_CODE&state=SECRET_STATE", { kind: "app", word: "created" });
    expect(el.innerHTML).not.toContain("SECRET");
  });

  it("같은 브라우저에서 로그인하려는 사람을 위한 길을 하나 남긴다", () => {
    mountAt("?githubApp=created", { kind: "app", word: "created" });
    const link = q("github-public-return-login") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/");
    expect(link.textContent).toBe("이 브라우저에서 로그인");
  });
});
