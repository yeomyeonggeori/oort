import { describe, expect, it, vi } from "vitest";
import {
  CLOSE_NOTICE_STORAGE_KEY,
  closeNoticeDeps,
  createCloseNotice,
  type CloseNoticeDeps,
} from "./closeNotice";

// #5196: 「창을 닫아도 메뉴 막대에서 계속 알림을 받아요」는 처음 한 번만 — 보인 뒤에 센다. 이벤트가 겹쳐도 배너는 하나이고, 저장소가 말을
// 안 하면 매번 뜨는 대신 안 뜬다. (알림 권한·보인 뒤에 쓰는 순서는 `TrayStatus.test.tsx`가 화면 쪽에서 잰다.)

function deps(over: Partial<CloseNoticeDeps> = {}) {
  let seen = false;
  const made: CloseNoticeDeps = {
    seen: () => seen,
    markSeen: vi.fn(() => {
      seen = true;
    }),
    show: vi.fn(async () => true),
    ...over,
  };
  return made;
}

describe("창을 치웠다는 안내를 한 번만", () => {
  it("이벤트가 겹쳐도(치웠다 열었다 치움) 배너는 하나다", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = deps({
      show: vi.fn(async () => {
        await gate;
        return true;
      }),
    });
    const announce = createCloseNotice(d);
    const first = announce("text");
    const second = announce("text");
    release();
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(d.show).toHaveBeenCalledTimes(1);
    expect(d.markSeen).toHaveBeenCalledTimes(1);
    // 보인 뒤에는 다시 없다.
    expect(await announce("text")).toBe(false);
    expect(d.show).toHaveBeenCalledTimes(1);
  });

  // 실제 기본 구현(`closeNoticeDeps`)을 부른다: 안 뜨는 쪽으로 실패하는 것이 이 모듈의 약속이다.
  it("기본 저장소: 비어 있으면 아직, 쓰면 이미, 읽기가 던지면 이미 본 것으로 친다(던지지 않는다)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    expect(closeNoticeDeps.seen()).toBe(false);
    closeNoticeDeps.markSeen();
    expect(closeNoticeDeps.seen()).toBe(true);
    expect(store.get(CLOSE_NOTICE_STORAGE_KEY)).toBe("1");

    const blocked = () => {
      throw new Error("storage blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(closeNoticeDeps.seen()).toBe(true);
    expect(() => closeNoticeDeps.markSeen()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
