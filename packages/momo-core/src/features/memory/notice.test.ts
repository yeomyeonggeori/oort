import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import type { MemoryNotice } from "./model";
import {
  MEMORY_NOTICE_NEVER_COPY,
  MEMORY_NOTICE_NEVER_UNKNOWN,
  MEMORY_NOTICE_SENDS_COPY,
  MEMORY_NOTICE_SENDS_UNKNOWN,
  MEMORY_RESET_CONFIRM_WORD,
  memoryNoticeView,
  memoryResetConfirmed,
  memoryResetFailure,
} from "./presentation";

const ALL_SENDS = [
  "channel_message_text",
  "author_display_name",
  "agent_dm_message_text",
  "digest_text",
  "memory_item_text",
  "topic_summary_input",
] as const;
const ALL_NEVER = [
  "human_direct_messages",
  "attachments",
  "deleted_messages",
  "excluded_channels",
  "paused_members_dms",
] as const;

function notice(over: Partial<MemoryNotice> = {}): MemoryNotice {
  return {
    enabled: true,
    paused: false,
    sending: true,
    resetEpoch: 2,
    summary: {
      configured: true,
      provider: { name: "OpenAI", host: "api.openai.com" },
      modelId: "gpt-5.4-mini",
    },
    embeddings: { model: "multilingual-e5-small", location: "local", sentToProvider: false },
    sends: [...ALL_SENDS],
    neverSends: [...ALL_NEVER],
    ...over,
  };
}

describe("팀 고지 문구 (#3212)", () => {
  it("알려진 코드는 전부 해요체 문장 하나로 옮긴다", () => {
    const view = memoryNoticeView(notice());
    expect(view.sends).toEqual(ALL_SENDS.map((code) => MEMORY_NOTICE_SENDS_COPY[code]));
    expect(view.neverSends).toEqual(ALL_NEVER.map((code) => MEMORY_NOTICE_NEVER_COPY[code]));
    for (const line of [...view.sends, ...view.neverSends]) {
      expect(line).toMatch(/요\.$/);
      expect(line).not.toMatch(/_/);
    }
  });

  it("모르는 코드는 원문을 드러내지 않고 일반 문장 하나로 보인다", () => {
    const view = memoryNoticeView(
      notice({ sends: ["channel_message_text", "from_the_future", "another_new_code"], neverSends: ["mystery"] })
    );
    expect(view.sends).toEqual([MEMORY_NOTICE_SENDS_COPY.channel_message_text, MEMORY_NOTICE_SENDS_UNKNOWN]);
    expect(view.neverSends).toEqual([MEMORY_NOTICE_NEVER_UNKNOWN]);
    expect(JSON.stringify(view)).not.toContain("from_the_future");
    expect(JSON.stringify(view)).not.toContain("mystery");
  });

  it("Object 프로토타입 이름(constructor, toString)도 모르는 코드로 다룬다", () => {
    const view = memoryNoticeView(notice({ sends: ["constructor", "toString", "__proto__"], neverSends: [] }));
    expect(view.sends).toEqual([MEMORY_NOTICE_SENDS_UNKNOWN]);
  });

  it("제공자·호스트·모델을 그대로 말하고, 게스트의 「사용자 지정」은 호스트 없이 말한다", () => {
    expect(memoryNoticeView(notice()).provider).toBe("OpenAI (api.openai.com)");
    expect(memoryNoticeView(notice()).model).toBe("gpt-5.4-mini");
    const guest = memoryNoticeView(
      notice({ summary: { configured: true, provider: { name: "사용자 지정" } } })
    );
    expect(guest.provider).toBe("사용자 지정");
    expect(guest.model).toBe("제공자의 기본 모델");
  });

  it("임베딩은 서버 안에서만 만든다고 말한다", () => {
    expect(memoryNoticeView(notice()).embeddings).toContain("multilingual-e5-small");
    expect(memoryNoticeView(notice()).embeddings).toContain("밖으로 보내지 않아요");
  });

  it("요약 AI가 없거나 꺼졌거나 멈춘 동안은 아무것도 보내지 않는다고 말하고, 없으면 보내는 목록도 비운다", () => {
    const none = memoryNoticeView(notice({ sending: false, summary: { configured: false } }));
    expect(none.status).toContain("아무것도 보내지 않아요");
    expect(none.sends).toEqual([]);
    expect(none.sending).toBe(false);
    expect(memoryNoticeView(notice({ enabled: false, sending: false })).status).toContain("꺼져 있어서");
    expect(memoryNoticeView(notice({ paused: true, sending: false })).status).toContain("잠시 멈춰");
    const on = memoryNoticeView(notice());
    expect(on.status).toContain("지금 켜져 있어요");
    expect(on.sending).toBe(true);
  });
});

describe("기억 초기화 문구 (#3212)", () => {
  it("입력 확인은 정확한 낱말(NFC·앞뒤 공백 허용)만 통과시킨다", () => {
    expect(memoryResetConfirmed(MEMORY_RESET_CONFIRM_WORD)).toBe(true);
    expect(memoryResetConfirmed(`  ${MEMORY_RESET_CONFIRM_WORD} `)).toBe(true);
    expect(memoryResetConfirmed(MEMORY_RESET_CONFIRM_WORD.normalize("NFD"))).toBe(true);
    for (const wrong of ["", "초기", "초기화해", "reset", "초기 화"]) {
      expect(memoryResetConfirmed(wrong)).toBe(false);
    }
  });

  it("상태 코드를 종류로 가른다: 403 관리자만, 409 이미 초기화, 503 바쁨", () => {
    expect(memoryResetFailure(new ApiError(403, "forbidden")).kind).toBe("forbidden");
    const stale = memoryResetFailure(new ApiError(409, "stale"));
    expect(stale.kind).toBe("stale");
    expect(stale.message).toContain("아무것도 지우지 않았어요");
    const busy = memoryResetFailure(new ApiError(503, "memory_reset_busy"));
    expect(busy.kind).toBe("busy");
    expect(busy.message).toContain("다시 시도");
    expect(memoryResetFailure(new ApiError(404, "x")).kind).toBe("absent");
    expect(memoryResetFailure(new ApiError(401, "x")).kind).toBe("unauthorized");
    expect(memoryResetFailure(new ApiError(500, "x")).kind).toBe("error");
    expect(memoryResetFailure(new Error("network")).kind).toBe("error");
  });

  it("상태 숫자는 문장에 새지 않는다", () => {
    for (const status of [403, 409, 503, 500, 404, 401]) {
      expect(memoryResetFailure(new ApiError(status, "x")).message).not.toContain(String(status));
    }
  });
});
