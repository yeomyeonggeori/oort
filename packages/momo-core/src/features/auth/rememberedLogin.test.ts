import { describe, expect, it } from "vitest";
import {
  REMEMBERED_SERVERS_MAX,
  createRememberedLoginStore,
  judgeRememberableEmail,
  type RememberedLoginPort,
} from "./rememberedLogin";

// 저장소 한 칸을 흉내 내는 가짜. `raw()`로 **저장소에 실제로 적힌 글자**를 본다: 「지웠다」는
// 단정이 API의 대답이 아니라 저장된 값으로 서게 하려는 것이다.
function memoryPort(initial: string | null = null): RememberedLoginPort & { raw(): string | null } {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    raw: () => value,
  };
}

const A = "https://a.example.com";
const B = "https://b.example.com";

describe("judgeRememberableEmail", () => {
  it("이메일 모양이면 앞뒤 공백을 뗀 글자를 돌려준다", () => {
    for (const [raw, email] of [
      ["me@example.com", "me@example.com"],
      ["  Dohyun.Lee+oort@Team.Example.co.kr \n", "Dohyun.Lee+oort@Team.Example.co.kr"],
      ["momo_kim@example.com", "momo_kim@example.com"],
      ["지민@예시.한국", "지민@예시.한국"],
    ] as const) {
      expect(judgeRememberableEmail(raw)).toEqual({ ok: true, email });
    }
  });

  it("비밀번호 모양은 거부한다: `@`가 없거나, `@` 뒤가 점 없는 한 낱말이다", () => {
    for (const password of ["Tr0ub4dor&3", "correct horse battery staple", "P@ssw0rd!", "Admin@2024", "hunter2@", "@hunter2.io"]) {
      const verdict = judgeRememberableEmail(password);
      expect(verdict.ok, password).toBe(false);
    }
    expect(judgeRememberableEmail("P@ssw0rd!")).toEqual({ ok: false, reason: "not-an-email" });
    expect(judgeRememberableEmail("a b@example.com")).toEqual({ ok: false, reason: "not-an-email" });
    expect(judgeRememberableEmail("")).toEqual({ ok: false, reason: "empty" });
    expect(judgeRememberableEmail("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("토큰 모양은 거부한다 — 이메일 모양 검사만으로는 지나가는 것까지", () => {
    const jwt = "eyJfakehdr.eyJfakepld.fakesig";
    const opaque = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2";
    for (const token of [
      jwt,
      `${jwt}@evil.example.com`,
      "momo_dev_v1.AAAA.BBBB",
      "momo_agent_v1_secretvalue@host.example.com",
      "oort_runner_abc@host.example.com",
      "Bearer abcdef0123456789",
      "ghp_abcdefgh12345678@users.example.com",
      `${opaque}@example.com`,
    ]) {
      expect(judgeRememberableEmail(token), token).toEqual({ ok: false, reason: "token-shaped" });
    }
  });
});

describe("createRememberedLoginStore", () => {
  it("서버마다 따로 기억하고, 다른 서버에는 채우지 않는다", () => {
    const store = createRememberedLoginStore(memoryPort(), { defaultEnabled: true });
    expect(store.remember(A, "a@example.com")).toEqual({ stored: true });
    expect(store.remember(B, " b@example.com ")).toEqual({ stored: true });
    expect(store.recall(A)).toBe("a@example.com");
    expect(store.recall(B)).toBe("b@example.com");
    expect(store.recall("https://c.example.com")).toBeNull();
    // 같은 서버의 다른 쓰기(끝 슬래시·대소문자 호스트)는 같은 칸이다. 서버가 하나이므로 덮어쓴다.
    store.remember("HTTPS://A.example.com/", "again@example.com");
    expect(store.recall(A)).toBe("again@example.com");
  });

  it("서버는 최근 다섯 곳까지만 남긴다", () => {
    const store = createRememberedLoginStore(memoryPort(), { defaultEnabled: true });
    const bases = Array.from({ length: REMEMBERED_SERVERS_MAX + 1 }, (_, i) => `https://s${i}.example.com`);
    bases.forEach((base, i) => store.remember(base, `u${i}@example.com`));
    expect(store.recall(bases[0]!)).toBeNull();
    expect(store.recall(bases[1]!)).toBe("u1@example.com");
    expect(store.recall(bases[REMEMBERED_SERVERS_MAX]!)).toBe(`u${REMEMBERED_SERVERS_MAX}@example.com`);
  });

  it("이메일 모양이 아니면 저장하지 않고, 이미 있는 값도 건드리지 않는다", () => {
    const port = memoryPort();
    const store = createRememberedLoginStore(port, { defaultEnabled: true });
    store.remember(A, "keep@example.com");
    const before = port.raw();
    expect(store.remember(A, "P@ssw0rd!")).toEqual({ stored: false, reason: "not-an-email" });
    expect(store.remember(A, "eyJfakehdr.eyJfakepld.fakesig@evil.example.com")).toEqual({
      stored: false,
      reason: "token-shaped",
    });
    expect(store.remember("", "x@example.com")).toEqual({ stored: false, reason: "no-server" });
    expect(port.raw()).toBe(before);
    expect(port.raw()).not.toContain("ssw0rd");
    expect(store.recall(A)).toBe("keep@example.com");
  });

  it("끄면 저장소에서 이메일이 그 자리에서 사라지고, 꺼진 채로 남는다", () => {
    const port = memoryPort();
    const store = createRememberedLoginStore(port, { defaultEnabled: true });
    store.remember(A, "a@example.com");
    store.remember(B, "b@example.com");
    expect(port.raw()).toContain("a@example.com");

    store.setEnabled(false);
    // 저장소의 글자 자체에서 사라졌다(API가 null을 돌려주는 것과 다른 증거).
    expect(port.raw()).not.toContain("example.com");
    expect(store.isEnabled()).toBe(false);
    expect(store.recall(A)).toBeNull();
    // 꺼진 동안은 저장하지 않는다.
    expect(store.remember(A, "late@example.com")).toEqual({ stored: false, reason: "off" });
    expect(port.raw()).not.toContain("late@example.com");

    // 재실행: 같은 저장소를 새 store가 읽는다. 「끔」은 기본값(켬)을 이긴다.
    const relaunched = createRememberedLoginStore(port, { defaultEnabled: true });
    expect(relaunched.isEnabled()).toBe(false);
    expect(relaunched.recall(A)).toBeNull();

    // 다시 켜면 그 뒤의 로그인부터 기억한다. 지운 것은 돌아오지 않는다.
    relaunched.setEnabled(true);
    expect(relaunched.recall(A)).toBeNull();
    relaunched.remember(A, "new@example.com");
    expect(relaunched.recall(A)).toBe("new@example.com");
  });

  it("고른 적이 없을 때만 플랫폼 기본을 따른다", () => {
    expect(createRememberedLoginStore(memoryPort(), { defaultEnabled: true }).isEnabled()).toBe(true);
    expect(createRememberedLoginStore(memoryPort(), { defaultEnabled: false }).isEnabled()).toBe(false);
    // 웹(기본 끔)에서 사람이 켠 것은 재실행 뒤에도 켬이다.
    const port = memoryPort();
    createRememberedLoginStore(port, { defaultEnabled: false }).setEnabled(true);
    expect(createRememberedLoginStore(port, { defaultEnabled: false }).isEnabled()).toBe(true);
    // 폰·데스크탑(기본 켬)에서 사람이 끈 것은 재실행 뒤에도 끔이다.
    const phone = memoryPort();
    createRememberedLoginStore(phone, { defaultEnabled: true }).setEnabled(false);
    expect(createRememberedLoginStore(phone, { defaultEnabled: true }).isEnabled()).toBe(false);
  });

  it("저장소에서 읽을 때 다시 검증한다: 틀린 칸은 버리고, 꺼져 있으면 있어도 읽지 않는다", () => {
    const tampered = JSON.stringify({
      v: 1,
      enabled: true,
      entries: [
        [A, "ok@example.com"],
        [B, "P@ssw0rd!"],
        ["https://c.example.com", "eyJfakehdr.eyJfakepld.fakesig@evil.example.com"],
        ["not a server", "x@example.com"],
        [A, "dup@example.com"],
        [42, "n@example.com"],
      ],
    });
    const store = createRememberedLoginStore(memoryPort(tampered), { defaultEnabled: false });
    expect(store.recall(A)).toBe("ok@example.com");
    expect(store.recall(B)).toBeNull();
    expect(store.recall("https://c.example.com")).toBeNull();

    const off = JSON.stringify({ v: 1, enabled: false, entries: [[A, "ok@example.com"]] });
    expect(createRememberedLoginStore(memoryPort(off), { defaultEnabled: true }).recall(A)).toBeNull();

    for (const broken of ["{", "[]", "null", '{"v":2,"entries":[]}', '{"v":1,"entries":"x"}']) {
      const guarded = createRememberedLoginStore(memoryPort(broken), { defaultEnabled: true });
      expect(guarded.recall(A), broken).toBeNull();
      expect(guarded.isEnabled(), broken).toBe(true);
    }
  });

  it("저장소가 던져도 로그인 화면으로 새지 않는다", () => {
    const hostile: RememberedLoginPort = {
      read: () => {
        throw new Error("blocked");
      },
      write: () => {
        throw new Error("blocked");
      },
    };
    const store = createRememberedLoginStore(hostile, { defaultEnabled: true });
    expect(store.recall(A)).toBeNull();
    expect(store.isEnabled()).toBe(true);
    expect(() => store.remember(A, "a@example.com")).not.toThrow();
    expect(() => store.setEnabled(false)).not.toThrow();
  });
});
