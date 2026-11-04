import { describe, expect, it } from "vitest";
import { argumentSpecs, loadMessageCatalog, messageKeys } from "../../i18n";
import { createMessageCopy } from "../../testkit/i18n";
import { CONNECTION_KEYS } from "./copyKeys";
import type { ConnectionView } from "./model";
import { blockedKey, type BlockedFrame } from "./blockedReason";

// =============================================================================
// #5260: 막힌 자리의 한 문장은 **막은 원인**을 말한다. 두 가지를 잰다.
//   1. 사전: 모든 틀이 ko·en에서 두 원인의 문장을 모두 갖고, 서버에 닿지 못한 것을 「오프라인」이라 말하는 틀이 없다.
//      생성된 사전(컴파일된 메시지)을 실제로 풀어 읽는다 — 원본 JSON이 아니라 앱이 읽는 것을 잰다.
//   2. 규칙(`blockedKey`): 원인마다 고르는 키.
// 기대 문장은 사전의 값을 되풀이하지 않고 **성질**로 적는다(값을 되풀이하면 사전과 시험이 함께 틀려도 초록이다).
// =============================================================================

const blockedKeys = messageKeys.filter((key) => key.startsWith("blocked."));
const frames = [...new Set(blockedKeys.map((key) => key.split(".")[1] as string))].sort();

async function format(locale: "ko-KR" | "en-US"): Promise<Record<string, string>> {
  const copy = createMessageCopy({
    messageLocale: locale,
    catalog: await loadMessageCatalog(locale),
  }) as unknown as (key: string, values?: Record<string, unknown>) => string;
  return Object.fromEntries(
    blockedKeys.map((key) => {
      const spec = (argumentSpecs as unknown as Record<string, Record<string, string>>)[key] ?? {};
      // 값을 받는 틀(`{relativeTime}`)은 알아볼 수 있는 값을 넣어 푼다.
      const values = Object.fromEntries(Object.keys(spec).map((name) => [name, "3m"]));
      return [key, copy(key, values)];
    })
  );
}

describe("blocked.* 사전: 원인별 완결된 문장 틀", () => {
  it("틀이 충분하고 모든 키가 blocked.<틀>.(offline|serverUnreachable) 세 칸이다", () => {
    expect(frames.length).toBeGreaterThan(50);
    for (const key of blockedKeys) expect(key).toMatch(/^blocked\.[a-zA-Z0-9]+\.(offline|serverUnreachable)$/);
  });

  it("모든 틀이 두 원인(offline · serverUnreachable)의 문장을 모두 갖는다", () => {
    for (const frame of frames) {
      expect(blockedKeys, frame).toContain(`blocked.${frame}.offline`);
      expect(blockedKeys, frame).toContain(`blocked.${frame}.serverUnreachable`);
    }
  });

  it("ko: 기기 오프라인만 「오프라인」이라 말하고, 서버에 닿지 못함은 서버에 닿지 못했다고 말한다", async () => {
    const ko = await format("ko-KR");
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
      expect(offline, frame).toMatch(/[가-힣]/);
    }
  });

  it("en: 기기 오프라인만 offline이라 말하고, 서버에 닿지 못함은 서버에 닿지 못한다고 말한다", async () => {
    const en = await format("en-US");
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

  it("완결된 문장이다: 마침표로 끝나고 풀리지 않은 자리({ })가 남지 않는다", async () => {
    for (const locale of ["ko-KR", "en-US"] as const) {
      for (const [key, text] of Object.entries(await format(locale))) {
        expect(text, `${locale} ${key}`).not.toMatch(/[{}]/);
        expect(text.trim(), `${locale} ${key}`).toBe(text);
        expect(text, `${locale} ${key}`).toMatch(/[.!?]$/);
      }
    }
  });

  it("값을 받는 틀은 마지막 동기화 시각 하나만 받는다", () => {
    const withValues = blockedKeys.filter(
      (key) => Object.keys((argumentSpecs as unknown as Record<string, Record<string, string>>)[key] ?? {}).length > 0
    );
    expect(withValues.length).toBeGreaterThan(0);
    for (const key of withValues) {
      expect(Object.keys((argumentSpecs as unknown as Record<string, Record<string, string>>)[key] ?? {})).toEqual(["relativeTime"]);
    }
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

const FRAME = "changeIt" as BlockedFrame;

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
