import { describe, expect, it } from "vitest";
import type { GithubManifestStart } from "@momo/core/features/github/model";
import {
  buildGithubHandoffUrl,
  GITHUB_APP_CALLBACK_PATH,
  GITHUB_HANDOFF_MAX_URL_LENGTH,
  GITHUB_HANDOFF_PATH,
  isGithubHandoffPath,
  readGithubHandoff,
} from "./handoff";

// 데스크탑이 시스템 브라우저로 넘기는 주소의 계약(#4220). 비밀(1회용 state)은 조각에만 있고,
// 받는 쪽은 이 서버 것이 아닌 매니페스트를 거절한다.

const ORIGIN = "https://oort.yeomyeonggeori.test";
const STATE = `00000000-0000-7000-8000-000000000001.${"8f3a".repeat(16)}`;
const ORG_URL = `https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=${STATE}`;
const USER_URL = `https://github.com/settings/apps/new?state=${STATE}`;

function manifest(origin = ORIGIN): Record<string, unknown> {
  return {
    name: "oort-oort-yeomyeonggeori-test",
    url: origin,
    hook_attributes: { url: `${origin}/v1/integrations/github/webhook`, active: true },
    redirect_url: `${origin}${GITHUB_APP_CALLBACK_PATH}`,
    setup_url: `${origin}/v1/integrations/github/setup`,
    description:
      "oort가 저장소의 PR·이슈·체크·push·release 소식을 채널로 받아 와요. 코드 읽기 권한(contents: read)은 push·release 알림을 받으려고 요청하고, oort 서버는 알림을 위해 코드를 읽지 않아요.",
    public: false,
    request_oauth_on_install: false,
    default_events: ["pull_request", "pull_request_review", "issues", "issue_comment", "check_suite", "push", "release"],
    default_permissions: { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" },
  };
}

function start(over: Partial<GithubManifestStart> = {}): GithubManifestStart {
  return { registrationUrl: ORG_URL, manifest: manifest(), expiresInSeconds: 3600, ...over };
}

/** 구현의 인코더를 쓰지 않는 독립 인코더: 받는 쪽 시험이 보내는 쪽 버그를 같이 상속하지 않게. */
function hashOf(payload: unknown): string {
  return `#${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, u: ORG_URL, m: manifest(), e: 3600, ...over };
}

function builtUrl(over: Partial<GithubManifestStart> = {}): string {
  const built = buildGithubHandoffUrl(start(over));
  if (!built.ok) throw new Error(`build failed: ${built.reason}`);
  return built.url;
}

describe("핸드오프 주소: state 는 쿼리가 아니라 조각에만 있다", () => {
  it("쿼리스트링이 비어 있고 등록 주소·state 의 원문이 조각 밖 어디에도 없다", () => {
    const url = builtUrl();
    const parsed = new URL(url);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe(GITHUB_HANDOFF_PATH);
    // 이 두 줄이 「state 를 쿼리로 흘리면 빨개지는」 사보타주 대상이다.
    expect(parsed.search).toBe("");
    expect(url.split("#")[0]).not.toContain(STATE);
    expect(url).not.toContain("state=");
    expect(url).not.toContain(encodeURIComponent(STATE));
    // 조각은 있다: 그 안에 실려 간다.
    expect(parsed.hash.length).toBeGreaterThan(100);
  });

  it("보낸 것을 받는 쪽이 그대로 읽는다(등록 주소·매니페스트·만료)", () => {
    const url = builtUrl();
    const read = readGithubHandoff(new URL(url).hash, ORIGIN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.handoff.registrationUrl).toBe(ORG_URL);
    expect(JSON.parse(read.handoff.manifestJson)).toEqual(manifest());
    expect(read.handoff.expiresInSeconds).toBe(3600);
    expect(read.handoff.target).toEqual({ kind: "organization", login: "yeomyeonggeori" });
    expect(read.handoff.host).toBe("oort.yeomyeonggeori.test");
    expect(read.handoff.appName).toBe("oort-oort-yeomyeonggeori-test");
  });

  it("개인 계정 등록도 읽는다", () => {
    const read = readGithubHandoff(new URL(builtUrl({ registrationUrl: USER_URL })).hash, ORIGIN);
    expect(read.ok && read.handoff.target).toEqual({ kind: "user" });
  });

  it("오리진은 접속한 주소가 아니라 매니페스트의 콜백 오리진이다", () => {
    const other = "https://team.example.com";
    const url = builtUrl({ manifest: manifest(other) });
    expect(new URL(url).origin).toBe(other);
    expect(readGithubHandoff(new URL(url).hash, other).ok).toBe(true);
  });

  it("한국어 설명이 든 매니페스트도 UTF-8 로 한 바퀴 돈다", () => {
    const read = readGithubHandoff(new URL(builtUrl()).hash, ORIGIN);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.handoff.manifestJson).description).toContain("소식을 채널로 받아 와요");
  });
});

describe("핸드오프 주소: opener 한도 안에 든다", () => {
  it("철도 기본 주소와 39자 조직 이름에서도 한도보다 한참 짧다", () => {
    const origin = "https://oort-production-1a2b3c4d5e.up.railway.app";
    const url = builtUrl({
      registrationUrl: `https://github.com/organizations/${"a".repeat(39)}/settings/apps/new?state=${STATE}`,
      manifest: manifest(origin),
    });
    expect(url.length).toBeLessThan(1700);
    expect(url.length).toBeLessThanOrEqual(GITHUB_HANDOFF_MAX_URL_LENGTH);
  });

  it("공개 주소가 한도를 넘게 길면 열지 않고 이유를 length 로 돌려준다", () => {
    const origin = `https://${"long-subdomain-".repeat(7)}team.example.com`;
    const built = buildGithubHandoffUrl(start({ manifest: manifest(origin) }));
    expect(built).toEqual({ ok: false, reason: "length" });
  });

  it("한도는 데스크탑 opener 의 MAX_URL_LEN 과 같다", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rust = readFileSync(
      resolve(__dirname, "../../../../desktop/src-tauri/src/opener.rs"),
      "utf8"
    );
    const limit = /const MAX_URL_LEN: usize = ([0-9_]+);/.exec(rust)?.[1];
    expect(Number((limit ?? "").replace(/_/g, ""))).toBe(GITHUB_HANDOFF_MAX_URL_LENGTH);
  });

  it("opener 가 거르는 문자(& 따옴표 공백 따위)는 주소에 없다", () => {
    const url = builtUrl();
    expect(url).toMatch(/^https:\/\/[A-Za-z0-9.:-]+\/github\/handoff#[A-Za-z0-9_-]+$/);
  });

  it("셸의 거름 목록(opener.rs)이 이 주소의 어떤 글자도 거르지 않고, 조각 글자 #도 거르지 않는다", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rust = readFileSync(resolve(__dirname, "../../../../desktop/src-tauri/src/opener.rs"), "utf8");
    const list = /const SHELL_METACHARACTERS: \[char; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1] ?? "";
    // 목록을 못 읽으면 시험이 아무것도 재지 못한다: 읽었다는 것부터 단정한다.
    const blocked = [...list.matchAll(/'(\\.|[^'\\])'/g)].map((m) => (m[1].startsWith("\\") ? m[1].slice(1) : m[1]));
    expect(blocked.length).toBeGreaterThanOrEqual(7);
    const url = builtUrl();
    for (const char of new Set(url)) {
      expect(blocked, `opener 가 거르는 글자 ${JSON.stringify(char)}`).not.toContain(char);
    }
    expect(blocked).not.toContain("#");
    // https 만 연다.
    expect(rust).toContain('url.starts_with("https://")');
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("핸드오프 주소: 보낼 수 없는 매니페스트는 만들지 않는다", () => {
  it("콜백 주소가 없거나 https 가 아니면 origin 이다", () => {
    const { redirect_url: _dropped, ...without } = manifest();
    expect(buildGithubHandoffUrl(start({ manifest: without }))).toEqual({ ok: false, reason: "origin" });
    expect(
      buildGithubHandoffUrl(start({ manifest: { ...manifest(), redirect_url: `http://oort.test${GITHUB_APP_CALLBACK_PATH}` } }))
    ).toEqual({ ok: false, reason: "origin" });
  });

  it("받는 쪽이 거절할 모양(콜백 경로가 다르다)은 shape 다", () => {
    const bent = { ...manifest(), redirect_url: `${ORIGIN}/elsewhere` };
    expect(buildGithubHandoffUrl(start({ manifest: bent }))).toEqual({ ok: false, reason: "shape" });
  });
});

describe("핸드오프 읽기: 거절은 폼을 만들기 전에 한다", () => {
  const refusalOf = (hash: string, origin = ORIGIN) => {
    const read = readGithubHandoff(hash, origin);
    return read.ok ? "ok" : read.refusal;
  };

  it("조각이 없으면 empty 다(이미 지웠거나 그냥 열었다)", () => {
    expect(refusalOf("")).toBe("empty");
    expect(refusalOf("#")).toBe("empty");
  });

  it("base64url·JSON·버전이 아니면 unreadable 이다", () => {
    expect(refusalOf("#%%%")).toBe("unreadable");
    expect(refusalOf("#a")).toBe("unreadable");
    expect(refusalOf(`#${Buffer.from("not json").toString("base64url")}`)).toBe("unreadable");
    expect(refusalOf(hashOf([1, 2]))).toBe("unreadable");
    expect(refusalOf(hashOf(payload({ v: 2 })))).toBe("unreadable");
    expect(refusalOf(`#${"A".repeat(5000)}`)).toBe("unreadable");
  });

  it.each([
    ["다른 호스트", `https://evil.example/settings/apps/new?state=${STATE}`],
    ["호스트 접두 속임", `https://github.com.evil.example/settings/apps/new?state=${STATE}`],
    ["http", `http://github.com/settings/apps/new?state=${STATE}`],
    ["포트", `https://github.com:8443/settings/apps/new?state=${STATE}`],
    ["계정 정보", `https://x:y@github.com/settings/apps/new?state=${STATE}`],
    ["다른 경로", `https://github.com/login?state=${STATE}`],
    ["경로 덧붙임", `https://github.com/settings/apps/new/extra?state=${STATE}`],
    ["조직 경로가 깊다", `https://github.com/organizations/a/b/settings/apps/new?state=${STATE}`],
    ["양끝 하이픈 조직", `https://github.com/organizations/-bad-/settings/apps/new?state=${STATE}`],
    ["state 없음", "https://github.com/settings/apps/new"],
    ["빈 state", "https://github.com/settings/apps/new?state="],
    ["쿼리 덧붙임", `https://github.com/settings/apps/new?state=${STATE}&redirect_uri=https://evil.example`],
    ["다른 쿼리", "https://github.com/settings/apps/new?other=1"],
    ["조각", `https://github.com/settings/apps/new?state=${STATE}#x`],
    ["문자열 아님", 42],
  ])("등록 주소가 GitHub 앱 만들기 경로가 아니면(%s) registration 이다", (_name, u) => {
    expect(refusalOf(hashOf(payload({ u })))).toBe("registration");
  });

  it("매니페스트가 객체가 아니면 manifest 다", () => {
    expect(refusalOf(hashOf(payload({ m: "x" })))).toBe("manifest");
    expect(refusalOf(hashOf(payload({ m: [manifest()] })))).toBe("manifest");
    expect(refusalOf(hashOf(payload({ m: null })))).toBe("manifest");
  });

  it("GitHub 의 변환 코드가 이 서버가 아닌 곳으로 가는 매니페스트는 foreign 이다", () => {
    const elsewhere = "https://collector.evil.example";
    // 이 줄들이 「오리진 검사를 지우면 빨개지는」 사보타주 대상이다.
    expect(refusalOf(hashOf(payload({ m: manifest(elsewhere) })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: `${elsewhere}${GITHUB_APP_CALLBACK_PATH}` } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: `${ORIGIN}/other/callback` } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: `${ORIGIN}${GITHUB_APP_CALLBACK_PATH}?x=1` } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: undefined } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: 7 } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: "http://oort.yeomyeonggeori.test/v1/integrations/github/app/callback" } })))).toBe("foreign");
  });

  it("수신·설정·앱 주소가 낯선 오리진이어도 foreign 이다", () => {
    expect(
      refusalOf(hashOf(payload({ m: { ...manifest(), hook_attributes: { url: "https://collector.evil.example/hook", active: true } } })))
    ).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), setup_url: "https://collector.evil.example/setup" } })))).toBe("foreign");
    expect(refusalOf(hashOf(payload({ m: { ...manifest(), url: "https://collector.evil.example" } })))).toBe("foreign");
    expect(
      refusalOf(hashOf(payload({ m: { ...manifest(), redirect_url: `https://x:y@oort.yeomyeonggeori.test${GITHUB_APP_CALLBACK_PATH}` } })))
    ).toBe("foreign");
  });

  it("페이지 오리진과 다르면 정직한 매니페스트도 거절한다", () => {
    expect(refusalOf(hashOf(payload()), "https://other.example")).toBe("foreign");
  });

  it("만료 시각은 1분~24시간으로 고른다", () => {
    const seconds = (e: unknown) => {
      const read = readGithubHandoff(hashOf(payload({ e })), ORIGIN);
      return read.ok ? read.handoff.expiresInSeconds : -1;
    };
    expect(seconds(3600)).toBe(3600);
    expect(seconds(5)).toBe(60);
    expect(seconds(10 ** 9)).toBe(86_400);
    expect(seconds("x")).toBe(3600);
    expect(seconds(undefined)).toBe(3600);
  });

  it("거절 값은 조각의 원문을 담지 않는다", () => {
    const read = readGithubHandoff(hashOf(payload({ m: manifest("https://collector.evil.example") })), ORIGIN);
    expect(JSON.stringify(read)).not.toContain(STATE);
    expect(JSON.stringify(read)).not.toContain("evil");
  });
});

describe("핸드오프 경로", () => {
  it("실제 pathname 이다(HashRouter 의 해시가 아니다)", () => {
    expect(GITHUB_HANDOFF_PATH.startsWith("/")).toBe(true);
    expect(GITHUB_HANDOFF_PATH).not.toContain("#");
    expect(isGithubHandoffPath("/github/handoff")).toBe(true);
    expect(isGithubHandoffPath("/github/handoff/")).toBe(true);
    expect(isGithubHandoffPath("/github/handoff/x")).toBe(false);
    expect(isGithubHandoffPath("/")).toBe(false);
    expect(isGithubHandoffPath("/github")).toBe(false);
  });
});
