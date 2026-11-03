// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REMEMBERED_LOGIN_STORAGE_KEY, createWebRememberedLogin } from "./rememberedLogin";

// 「이메일 기억하기」(#4669)의 처음 값은 플랫폼이 정한다: 데스크탑(Tauri) 켬, 브라우저 끔.
// 처음 값은 **고른 적이 없을 때만** 쓰인다: 사람이 끈 것은 데스크탑에서도 꺼진 채로 남는다.

const envSlot = vi.hoisted(() => ({ tauri: false }));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    get IS_TAURI() {
      return envSlot.tauri;
    },
  };
});

const SERVER = "https://a.example.com";

beforeEach(() => {
  localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
});

afterEach(() => {
  localStorage.removeItem(REMEMBERED_LOGIN_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("웹·데스크탑 이메일 기억하기 저장소", () => {
  it("데스크탑은 켠 채, 브라우저는 끈 채 시작한다", () => {
    envSlot.tauri = true;
    expect(createWebRememberedLogin().isEnabled()).toBe(true);
    envSlot.tauri = false;
    expect(createWebRememberedLogin().isEnabled()).toBe(false);
    expect(createWebRememberedLogin({ defaultEnabled: true }).isEnabled()).toBe(true);
  });

  it("데스크탑에서 기본으로 켜진 채 기억하고, 사람이 끄면 저장소에서 지워지고 꺼진 채 남는다", () => {
    envSlot.tauri = true;
    const desktop = createWebRememberedLogin();
    expect(desktop.remember(SERVER, "me@example.com")).toEqual({ stored: true });
    expect(localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY)).toContain("me@example.com");
    desktop.setEnabled(false);
    expect(localStorage.getItem(REMEMBERED_LOGIN_STORAGE_KEY)).not.toContain("me@example.com");
    expect(createWebRememberedLogin().isEnabled()).toBe(false);
    expect(createWebRememberedLogin().recall(SERVER)).toBeNull();
  });

  it("저장소가 막혀 있어도 던지지 않는다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const store = createWebRememberedLogin({ defaultEnabled: true });
    expect(store.recall(SERVER)).toBeNull();
    expect(() => store.remember(SERVER, "me@example.com")).not.toThrow();
    expect(() => store.setEnabled(false)).not.toThrow();
  });
});
