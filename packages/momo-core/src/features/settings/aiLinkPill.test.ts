import { describe, expect, it } from "vitest";
import type { ProviderLink, ProviderLinkTest } from "./api";
import { harnessPillView, isLegacyTeamLink, linkPill } from "./aiLinkPill";

const LINK: ProviderLink = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.example.com/v1",
  endpointLabel: "api.example.com",
  bearerConfigured: true,
  bearerLast4: "a4f2",
  availability: "live",
  keyConfigured: true,
  diagnostics: [],
};

const probe = (ok: boolean): ProviderLinkTest => ({
  schema: "momo.provider_link.test.v0",
  ok,
  source: "database",
  mode: "external-hermes",
  endpointLabel: "api.example.com",
  checkedAtMs: 1,
});

const legacy = { ...LINK, credentialKind: "oauth-openai" } as ProviderLink;

describe("linkPill (#2941): 팀 연결 줄의 판정표", () => {
  const rows: Array<[string, Parameters<typeof linkPill>[0], string, string]> = [
    ["오프라인이 모든 것을 이긴다", { link: LINK, offline: true, probe: probe(false), checking: true }, "mute", "확인할 수 없음"],
    ["내부용 연결은 읽기 전용", { link: legacy, offline: false, probe: probe(true) }, "mute", "읽기 전용"],
    ["확인이 도는 중", { link: LINK, offline: false, probe: probe(false), checking: true }, "run", "확인 중…"],
    ["확인 성공", { link: LINK, offline: false, probe: probe(true) }, "ok", "확인됨"],
    ["확인 실패", { link: LINK, offline: false, probe: probe(false) }, "bad", "확인 실패"],
    // #2880: 서버가 부르지 않은 확인은 실패가 아니다.
    ["확인 전(probe_not_run)", { link: LINK, offline: false, probe: { ...probe(false), reason: "probe_not_run" } }, "mute", "확인 전"],
    ["저장된 키, 실제 provider", { link: LINK, offline: false, probe: null }, "ok", "연결됨"],
    ["저장된 키, 모의", { link: { ...LINK, availability: "mock" }, offline: false, probe: null }, "mute", "모의 응답"],
    ["주소만 있고 키 없음", { link: { ...LINK, keyConfigured: false }, offline: false, probe: null }, "warn", "자격증명 없음"],
    ["아무것도 없음", { link: { ...LINK, configured: false, keyConfigured: false }, offline: false, probe: null }, "mute", "연결 안 됨"],
  ];
  it.each(rows)("%s", (_name, input, tone, text) => {
    expect(linkPill(input)).toEqual({ tone, text });
  });

  it("내부용 판정은 와이어의 credentialKind만 읽는다", () => {
    expect(isLegacyTeamLink(legacy)).toBe(true);
    expect(isLegacyTeamLink({ ...LINK, credentialKind: "bearer" } as ProviderLink)).toBe(false);
    expect(isLegacyTeamLink(LINK)).toBe(false);
  });
});

describe("harnessPillView (#2941): 구독 줄의 색과 낱말", () => {
  it("다섯 알약이 모두 낱말과 색을 갖는다", () => {
    expect(harnessPillView("ready")).toEqual({ tone: "ok", text: "준비됨" });
    expect(harnessPillView("login")).toEqual({ tone: "warn", text: "로그인 필요" });
    expect(harnessPillView("recheck")).toEqual({ tone: "warn", text: "다시 확인" });
    expect(harnessPillView("checking")).toEqual({ tone: "run", text: "확인 중…" });
    expect(harnessPillView("install")).toEqual({ tone: "mute", text: "설치 필요" });
  });
});
