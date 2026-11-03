import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTION_KEYS } from "./copyKeys";
import type { ConnectionView } from "./model";
import { blockedKey, type BlockedFrame } from "./blockedReason";
import { messageKeys } from "../../i18n/generated/messages";

// =============================================================================
// #5260: 막힌 자리의 한 문장은 **막은 원인**을 말한다. 두 가지를 잰다.
//   1. 사전: 모든 틀이 ko·en에서 두 원인의 문장을 모두 갖고, 서버에 닿지 못한 것을 「오프라인」이라 말하는 틀이 없다.
//   2. 규칙(`blockedKey`): 원인마다 고르는 키.
// 기대 문장은 사전의 값을 되풀이하지 않고 **성질**로 적는다(값을 되풀이하면 사전과 시험이 함께 틀려도 초록이다).
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOGS = join(HERE, "../../i18n/catalogs");

function readBlocked(locale: "ko-KR" | "en-US"): Record<string, string> {
  return JSON.parse(readFileSync(join(CATALOGS, locale, "blocked.json"), "utf8")) as Record<string, string>;
}

const ko = readBlocked("ko-KR");
const en = readBlocked("en-US");

const frames = [...new Set(Object.keys(ko).map((key) => key.split(".")[1] as string))].sort();

describe("blocked.* 사전: 원인별 완결된 문장 틀", () => {
  it("틀이 하나 이상이고 ko·en의 키 집합이 같다", () => {
    expect(frames.length).toBeGreaterThan(20);
    expect(Object.keys(en).sort()).toEqual(Object.keys(ko).sort());
  });

  it("모든 틀이 두 원인(offline · serverUnreachable)의 문장을 모두 갖는다", () => {
    for (const frame of frames) {
      expect(Object.keys(ko), frame).toContain(`blocked.${frame}.offline`);
      expect(Object.keys(ko), frame).toContain(`blocked.${frame}.serverUnreachable`);
    }
    // 키는 세 칸(blocked.<틀>.<원인>)이고 원인은 둘뿐이다.
    for (const key of Object.keys(ko)) {
      expect(key).toMatch(/^blocked\.[a-zA-Z0-9]+\.(offline|serverUnreachable)$/);
    }
  });

  it("ko: 기기 오프라인만 「오프라인」이라 말하고, 서버에 닿지 못함은 서버에 닿지 못했다고 말한다", () => {
    for (const frame of frames) {
      const offline = ko[`blocked.${frame}.offline`] as string;
      const server = ko[`blocked.${frame}.serverUnreachable`] as string;
      expect(offline, frame).toContain("오프라인");
      expect(server, frame).toContain("서버에 닿지 못");
      // 이 칸이 고친 거짓말: 서버에 닿지 못했는데 오프라인이라고 하지 않는다.
      expect(server, frame).not.toContain("오프라인");
      // 원인을 가리지 않던 옛 머리는 어느 문장에도 남지 않는다.
      expect(offline, frame).not.toContain("연결이 끊");
      expect(server, frame).not.toContain("연결이 끊");
    }
  });

  it("en: 기기 오프라인만 offline이라 말하고, 서버에 닿지 못함은 서버에 닿지 못한다고 말한다", () => {
    for (const frame of frames) {
      const offline = en[`blocked.${frame}.offline`] as string;
      const server = en[`blocked.${frame}.serverUnreachable`] as string;
      expect(offline, frame).toMatch(/offline/i);
      expect(server, frame).toMatch(/reach the server/i);
      expect(server, frame).not.toMatch(/offline/i);
      // 영어는 한글을 들고 있지 않다.
      expect(offline, frame).not.toMatch(/[가-힣]/);
      expect(server, frame).not.toMatch(/[가-힣]/);
    }
  });

  it("값(인자)을 받지 않는 완결된 문장이다: 조각을 이어 붙이는 틀이 아니다", () => {
    for (const text of [...Object.values(ko), ...Object.values(en)]) {
      expect(text).not.toMatch(/[{}]/);
      expect(text.trim()).toBe(text);
      expect(text).toMatch(/[.!?]$/);
    }
  });

  it("모든 blocked.* 키가 생성된 메시지 키 표에 있다(i18n:generate를 돌렸다)", () => {
    const generated = messageKeys.filter((key) => key.startsWith("blocked."));
    expect([...generated].sort()).toEqual(Object.keys(ko).sort());
    // 다른 feature 파일이 이 파일의 키를 가로채지 않는다.
    const features = readdirSync(join(CATALOGS, "ko-KR")).filter((file) => file === "blocked.json");
    expect(features).toEqual(["blocked.json"]);
  });
});

// ---- 규칙 ----------------------------------------------------------------------

function view(over: Partial<ConnectionView>): ConnectionView {
  return {
    phase: "ok",
    cause: null,
    canSend: true,
    canUpload: true,
    canDecide: true,
    copy: null,
    composerNote: null,
    approvalNote: null,
    action: null,
    nextChangeAt: null,
    ...over,
  };
}

const FRAME = frames[0] as BlockedFrame;

describe("blockedKey: 원인마다 고르는 키", () => {
  it("기기 오프라인 → offline 틀", () => {
    expect(blockedKey(FRAME, view({ phase: "down", cause: "deviceOffline", canSend: false }))).toBe(`blocked.${FRAME}.offline`);
  });

  it("서버에 닿지 못함 → serverUnreachable 틀(오프라인 틀이 아니다)", () => {
    expect(blockedKey(FRAME, view({ phase: "down", cause: "serverUnreachable", canSend: false }))).toBe(
      `blocked.${FRAME}.serverUnreachable`
    );
  });

  it("로그인 만료 → 원인을 지어내지 않고 만료 문장", () => {
    expect(blockedKey(FRAME, view({ phase: "expired", canSend: false }))).toBe(CONNECTION_KEYS.sessionExpired);
  });

  it("모델이 없는 자리(셸 밖·단위 시험)에서 막혔다고 한 호출은 기기 오프라인(브라우저)이다", () => {
    expect(blockedKey(FRAME, null)).toBe(`blocked.${FRAME}.offline`);
  });
});
