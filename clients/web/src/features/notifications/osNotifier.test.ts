import { describe, expect, it, vi } from "vitest";
import { COALESCE_MS, createOsNotifier, summarize, type OsNotifyItem } from "./osNotifier";

const item = (kind: OsNotifyItem["kind"], label: string, body = `${label} 본문`): OsNotifyItem => ({
  kind,
  title: `${kind}:${label}`,
  body,
  label,
});

describe("osNotifier 묶음 (#3339)", () => {
  it("한 건은 그대로 나간다", () => {
    expect(summarize([item("approval", "김인턴")])).toEqual({ title: "approval:김인턴", body: "김인턴 본문" });
  });

  it("같은 종류 여러 건은 「승인 필요 3건」 하나로 쌓인다", () => {
    expect(summarize([item("approval", "김인턴"), item("approval", "김인턴"), item("approval", "민준")])).toEqual({
      title: "승인 필요 3건",
      body: "김인턴, 김인턴, 민준",
    });
  });

  it("이름은 셋까지, 나머지는 「외 n건」", () => {
    const items = ["a", "b", "c", "d", "e"].map((n) => item("mention", n));
    expect(summarize(items)).toEqual({ title: "멘션 5건", body: "a, b, c 외 2건" });
  });

  it("창 안의 같은 종류는 한 번만 보내고, 다른 종류는 따로 보낸다", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => true);
      const n = createOsNotifier({ send });
      n.offer(item("approval", "a"));
      n.offer(item("approval", "b"));
      n.offer(item("dm", "c"));
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(COALESCE_MS);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith("승인 필요 2건", "a, b", { kind: "approval" });
      expect(send).toHaveBeenCalledWith("dm:c", "c 본문", { kind: "dm" });
      // 창이 닫힌 뒤의 새 건은 새 묶음이다.
      n.offer(item("approval", "d"));
      vi.advanceTimersByTime(COALESCE_MS);
      expect(send).toHaveBeenLastCalledWith("approval:d", "d 본문", { kind: "approval" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush는 기다리는 묶음을 바로 보낸다", () => {
    const send = vi.fn(async () => true);
    const n = createOsNotifier({ send, setTimer: () => 0, clearTimer: () => undefined });
    n.offer(item("waiting", "1번 칸"));
    n.flush();
    expect(send).toHaveBeenCalledTimes(1);
    n.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
