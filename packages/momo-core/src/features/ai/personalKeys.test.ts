import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { findLegacyTerms } from "./aiHubModel";
import {
  PERSONAL_KEYS_COPY,
  parsePersonalKey,
  parsePersonalKeyList,
  personalAgentDefaults,
  personalAgentHandleValid,
  personalKeyErrorMessage,
} from "./personalKeys";

const ROW = {
  id: "AAAAAAAA-0000-7000-8000-000000000001",
  ownerMemberId: "00000000-0000-7000-8000-000000000101",
  format: "anthropic",
  endpointLabel: "api.anthropic.com",
  label: "리서치용",
  status: "active",
  issuedBy: "00000000-0000-7000-8000-000000000102",
  issuedAtMs: 1_790_000_000_000,
};

describe("개인 키 읽기", () => {
  it("한 줄을 읽고 키처럼 생긴 필드는 가져오지 않는다", () => {
    const key = parsePersonalKey({ ...ROW, apiKey: "sk-should-never-be-read", bearer: "x", secret: "y" });
    expect(key).toMatchObject({ format: "anthropic", status: "active", label: "리서치용", revokedAtMs: null });
    expect(key?.id).toBe(ROW.id.toLowerCase());
    expect(JSON.stringify(key)).not.toContain("sk-should-never-be-read");
    expect(Object.keys(key ?? {})).toEqual([
      "id", "ownerMemberId", "format", "endpointLabel", "label", "status", "issuedAtMs", "revokedAtMs",
    ]);
  });

  it("모르는 모양은 버리고, 회수된 키는 회수 시각을 든다", () => {
    expect(parsePersonalKey({ ...ROW, status: "weird" })).toBeNull();
    expect(parsePersonalKey("x")).toBeNull();
    const list = parsePersonalKeyList({ keys: [{ ...ROW, status: "revoked", revokedAtMs: 5 }, { nope: 1 }] });
    expect(list).toHaveLength(1);
    expect(list[0].revokedAtMs).toBe(5);
    expect(parsePersonalKeyList({})).toEqual([]);
  });
});

describe("거절 문장", () => {
  it("서버 코드를 사람 말로 옮기고 키 값은 말하지 않는다", () => {
    const own = personalKeyErrorMessage(new ApiError(409, "x", "personal_key_owner_has_active_key"), "issue");
    expect(own).toContain("먼저 그 키를 회수");
    expect(personalKeyErrorMessage(new ApiError(409, "x", "personal_agent_exists"), "agent")).toContain("이미");
    expect(personalKeyErrorMessage(new ApiError(409, "x", "personal_key_revoked"), "agent")).toContain("회수된 키");
    expect(personalKeyErrorMessage(new ApiError(403, "x"), "agent")).toContain("게스트");
    expect(personalKeyErrorMessage(new ApiError(503, "x"), "issue")).toContain("서버 운영자");
    expect(personalKeyErrorMessage(new TypeError("net"), "issue")).toContain("다시 시도");
  });
});

describe("에이전트 처음 값", () => {
  it("표시 이름은 이름-회사, 핸들은 소유자 핸들에서 만든 합법 핸들", () => {
    const d = personalAgentDefaults({ memberName: "곽성재", memberHandle: "Seongjae.K", company: "Anthropic", format: "anthropic" });
    expect(d.displayName).toBe("곽성재-Anthropic");
    expect(d.handle).toBe("seongjae-k-claude");
    expect(personalAgentHandleValid(d.handle)).toBe(true);
    const hangul = personalAgentDefaults({ memberName: "성재", memberHandle: "성재", company: "OpenAI", format: "openai" });
    expect(personalAgentHandleValid(hangul.handle)).toBe(true);
    const long = personalAgentDefaults({ memberName: "a", memberHandle: "x".repeat(60), company: "OpenAI", format: "openai" });
    expect(long.handle.length).toBeLessThanOrEqual(32);
    expect(personalAgentHandleValid(long.handle)).toBe(true);
  });
});

describe("문구", () => {
  it("옛 말이 없고 em-dash가 없다", () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (typeof v === "function") strings.push((v as (...a: string[]) => string)("가", "나"));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(PERSONAL_KEYS_COPY);
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings) {
      expect(findLegacyTerms(s), s).toEqual([]);
      expect(s).not.toMatch(/[—–]/);
    }
  });
});
