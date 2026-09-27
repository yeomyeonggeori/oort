import { describe, expect, it } from "vitest";
import { containsSecretKey } from "./secretKey";

// =============================================================================
// 키 모양 판정의 정규식을 고정한다 (#2942 GC-1, brief §3.4).
//
// **픽스처에 키 모양 리터럴을 두지 않는다.** GitHub push protection과 비밀값
// 스캐너가 진짜 키로 읽고 push를 막거나 경보를 낸다. 모든 가짜 키는 아래
// 결정적 생성기가 실행 중에 만든다 — 파일에는 접두와 길이만 적힌다.
// =============================================================================

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";

/** 결정적 의사난수 꼬리. 같은 seed는 같은 글자를 낸다. */
function noise(length: number, seed: number, alphabet = ALPHABET): string {
  let state = seed;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += alphabet[(state >>> 16) % alphabet.length];
  }
  return out;
}

const join = (...parts: string[]) => parts.join("");

/** 발급 형식을 흉내 낸 가짜 키들(접두는 조각으로 이어 붙인다). */
const FAKE = {
  openaiLegacy: join("s", "k-", noise(48, 1)),
  openaiProject: join("s", "k-", "proj-", noise(64, 2), "_", noise(40, 3)),
  anthropic: join("s", "k-", "ant-", "api03-", noise(40, 4), "-", noise(40, 5), "AA"),
  openrouter: join("s", "k-", "or-", "v1-", noise(64, 6, HEX)),
  xai: join("x", "ai-", noise(80, 7)),
};

describe("정탐 — 발급 형식의 키는 막는다", () => {
  for (const [name, key] of Object.entries(FAKE)) {
    it(`${name} 단독`, () => {
      expect(containsSecretKey(key)).toBe(true);
    });
    it(`${name} 문장 안`, () => {
      expect(containsSecretKey(`이 키 쓰면 돼요 ${key} 감사합니다`)).toBe(true);
    });
  }

  it("슬래시 인자로 붙여도 막는다(`/연결 sk-…`는 인자가 아니다)", () => {
    expect(containsSecretKey(`/연결 ${FAKE.openaiProject}`)).toBe(true);
  });

  it("줄 맨 앞·따옴표·괄호·등호 뒤에서도 막는다", () => {
    expect(containsSecretKey(`"${FAKE.anthropic}"`)).toBe(true);
    expect(containsSecretKey(`(${FAKE.xai})`)).toBe(true);
    expect(containsSecretKey(`OPENAI_API_KEY=${FAKE.openaiLegacy}`)).toBe(true);
    expect(containsSecretKey(`첫 줄\n${FAKE.openrouter}`)).toBe(true);
  });

  it("코드 블록·URL 안이라도 키 모양이면 막는다(채널에 덜 남지 않는다)", () => {
    expect(containsSecretKey("```\nexport KEY=" + FAKE.openaiLegacy + "\n```")).toBe(true);
    expect(
      containsSecretKey(`https://api.example.com/v1?key=${FAKE.openrouter}`)
    ).toBe(true);
  });
});

describe("오탐 — 키가 아닌 글은 보낸다", () => {
  const plain = [
    // 평범한 문장
    "sk-learn 말고 scikit-learn으로 설치하세요",
    "xai-grok-2-1212 모델로 바꿔 볼까요?",
    "sk- 로 시작하는 건 OpenAI 키예요. 채팅에 붙이지 마세요",
    "task-sk-20260927-release-checklist 확인 부탁",
    "desk-a1b2c3d4e5f6g7h8i9j0k1l2 자리 예약",
    "sk-proj-roadmap-2026-q4-planning-notes 문서 링크 드려요",
    "/연결 claude",
    "/ai 이거 왜 안 돼요?",
    // 코드 블록
    "```sh\npip install scikit-learn sk-video\nexport OPENAI_API_KEY=$(op read op://team/openai)\n```",
    "`const prefix = \"sk-ant-\"; if (key.startsWith(prefix)) throw new Error()`",
    "```ts\nconst KEY_PREFIXES = [\"sk-\", \"sk-or-\", \"xai-\"];\n```",
    // URL
    "https://github.com/openai/sk-learn-examples-for-beginners",
    "https://docs.x.ai/docs/xai-sdk-python-quickstart-guide 참고",
    "https://openrouter.ai/keys 에서 sk-or- 키를 새로 만드세요",
    "https://example.com/c/0199aaaa-0000-7000-8000-000000000001",
  ];
  for (const text of plain) {
    it(JSON.stringify(text).slice(0, 60), () => {
      expect(containsSecretKey(text)).toBe(false);
    });
  }

  it("짧은 꼬리(20자 미만)는 키가 아니다", () => {
    expect(containsSecretKey(join("s", "k-", noise(19, 9)))).toBe(false);
  });
});
