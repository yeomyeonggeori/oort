// 앱을 쓰다 막혔을 때의 문장 (plugins-v2-plan 2.5절, #3950 U-S2): 한 문장과 행동 하나.
import { describe, expect, it } from "vitest";
import { APPS_SCREEN_PATH, appNoticeFor, hasAppNotice, minutesSince, parseAppNotice, type AppNoticeEnv } from "./appNotice";

const PLUGINS = new Map([
  ["gmail", { name: "Gmail", egressDomains: ["gmailmcp.googleapis.com"] }],
  ["github", { name: "GitHub", egressDomains: ["api.githubcopilot.com"] }],
]);
const NOW = 10 * 60_000;
const web: AppNoticeEnv = { surface: "web", plugins: PLUGINS, nowMs: NOW };
const phone: AppNoticeEnv = { ...web, surface: "phone" };
const notice = (app_notice: unknown, env = web) => parseAppNotice({ app_notice }, env);

describe("막힘 문장 표", () => {
  it("실행 장소 꺼짐: 내 맥은 맥을 켜라는 문장, 행동은 없다", () => {
    expect(notice({ kind: "site_off", site: "mac" })).toMatchObject({
      sentence: "내 맥이 꺼져 있어서 못 했어요. 맥을 켜면 다시 해 볼게요.",
      action: null,
      progress: false,
    });
    expect(notice({ kind: "site_off", site: "hermes" })?.sentence).toBe(
      "Hermes가 꺼져 있어서 못 했어요."
    );
  });

  it("시간 초과: 「Hermes가 답하지 않아요.」", () => {
    expect(notice({ kind: "site_silent", site: "hermes" })?.sentence).toBe(
      "Hermes가 답하지 않아요."
    );
    expect(notice({ kind: "site_silent" })?.sentence).toBe("에이전트가 답하지 않아요.");
  });

  it("로그인 끊김: 내 맥은 「다시 로그인」 행동, Hermes 는 운영자 몫이라 행동이 없다", () => {
    expect(notice({ kind: "login_lost", plugin_id: "gmail", site: "mac" })).toMatchObject({
      sentence: "Gmail 로그인이 끊겼어요.",
      action: { kind: "apps", label: "다시 로그인" },
    });
    expect(notice({ kind: "login_lost", plugin_id: "gmail", site: "hermes" })).toMatchObject({
      sentence: "Gmail 로그인이 끊겼어요. 운영자가 다시 로그인해야 해요.",
      action: null,
    });
    // 실행 장소가 없는 문(Agent Port)은 누가 할 일인지 모른다: 문장만, 행동 없음.
    expect(notice({ kind: "login_lost", plugin_id: "gmail" })).toMatchObject({
      sentence: "Gmail 로그인이 끊겼어요.",
      action: null,
    });
    expect(notice({ kind: "login_lost", plugin_id: "gmail" }, phone)?.action).toBeNull();
    // 폰에는 로그인 창이 없다: 웹으로 보낸다.
    expect(notice({ kind: "login_lost", plugin_id: "gmail", site: "mac" }, phone)?.action).toEqual({
      kind: "web",
      label: "웹에서 열기",
    });
  });

  it("실행 중 회수: 멈췄고 한 일은 그대로", () => {
    expect(notice({ kind: "grant_revoked" })).toMatchObject({
      sentence: "실행 중에 허용이 회수돼서 여기서 멈췄어요. 이미 한 일은 그대로예요.",
      action: null,
    });
  });

  it("벤더 한도·바깥 연결 차단", () => {
    expect(notice({ kind: "rate_limited", plugin_id: "github" })?.sentence).toBe(
      "GitHub가 잠시 요청을 막았어요. 1분 뒤 다시 해 주세요."
    );
    expect(
      notice({ kind: "egress_blocked", plugin_id: "gmail", host: "gmailmcp.googleapis.com" })?.sentence
    ).toBe("에이전트가 gmailmcp.googleapis.com에 연결할 수 없어요.");
    // 앱 목록이 모르는 주소는 말하지 않는다(응답이 문장에 새지 않는다).
    expect(
      notice({ kind: "egress_blocked", plugin_id: "gmail", host: "evil.example.com" })?.sentence
    ).toBe("에이전트가 바깥에 연결할 수 없어요.");
  });

  it("허용 안 함: 웹은 「앱 열기」, 폰은 데스크탑·웹 안내 + 「웹에서 열기」 하나", () => {
    expect(notice({ kind: "not_allowed" })).toMatchObject({
      sentence: "먼저 내 사용을 허용해 주세요.",
      action: { kind: "apps", label: "앱 열기" },
    });
    expect(notice({ kind: "not_allowed" }, phone)).toMatchObject({
      sentence: "이 앱은 데스크탑이나 웹에서 허용해 주세요.",
      action: { kind: "web", label: "웹에서 열기" },
    });
    expect(APPS_SCREEN_PATH).toBe("/ai/external/apps");
  });

  it("진행 중: 「○○에서 하는 중 · n분째」, 시작을 모르면 분을 짐작하지 않는다", () => {
    expect(notice({ kind: "working", site: "mac", since_ms: NOW - 3 * 60_000 })).toMatchObject({
      sentence: "내 맥에서 하는 중 · 3분째",
      progress: true,
      action: null,
    });
    expect(notice({ kind: "working", site: "hermes" })?.sentence).toBe("Hermes에서 하는 중");
    expect(minutesSince(NOW, NOW)).toBe(1);
    expect(minutesSince(NOW + 5 * 60_000, NOW)).toBe(1);
  });

  it("앱 이름을 모르면 원문 id 대신 「이 앱」, 모르는 kind·모양은 null", () => {
    expect(notice({ kind: "login_lost", plugin_id: "no-such-app", site: "mac" })?.sentence).toBe(
      "이 앱 로그인이 끊겼어요."
    );
    for (const bad of [{ kind: "explode" }, { kind: 3 }, "site_off", null, undefined, []]) {
      expect(notice(bad)).toBeNull();
    }
    expect(parseAppNotice(undefined, web)).toBeNull();
    expect(parseAppNotice({}, web)).toBeNull();
  });

  it("행동은 많아야 하나, 문장은 한 개(값이 객체 하나)다", () => {
    const kinds = [
      "site_off", "site_silent", "login_lost", "grant_revoked",
      "rate_limited", "egress_blocked", "not_allowed", "working",
    ];
    for (const env of [web, phone]) {
      for (const kind of kinds) {
        const out = notice({ kind, plugin_id: "gmail", site: "mac" }, env);
        expect(out?.sentence).toBeTruthy();
        expect(out?.action === null || typeof out?.action.label === "string").toBe(true);
      }
    }
  });

  it("지워진 메시지에는 없다", () => {
    expect(
      appNoticeFor({ props: { app_notice: { kind: "grant_revoked" } }, state: "deleted" } as never, web)
    ).toBeNull();
  });

  it("system 행(정지·건너뜀 줄)에는 붙이지 않는다: 본문이 이미 말한다", () => {
    const props = { app_notice: { kind: "site_off", site: "mac" } };
    expect(appNoticeFor({ props, state: "sent", type: "system" } as never, web)).toBeNull();
    expect(hasAppNotice({ props, state: "sent", type: "system" } as never)).toBe(false);
    // 같은 칸이 에이전트 답(text)에는 선다.
    expect(appNoticeFor({ props, state: "sent", type: "text" } as never, web)).not.toBeNull();
    expect(hasAppNotice({ props, state: "sent", type: "text" } as never)).toBe(true);
  });
});
