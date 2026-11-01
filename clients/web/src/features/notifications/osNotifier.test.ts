import { describe, expect, it, vi } from "vitest";
import { COALESCE_MS, createOsNotifier, MIXED_ROUTE, routeFor, summarize, type OsNotifyItem } from "./osNotifier";

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

  it("스레드 답글(#4890)은 묶음 제목을 호출부가 정한다 — 이 모듈의 고정 표에 한글을 더하지 않는다", () => {
    const thread = (label: string): OsNotifyItem => ({
      ...item("thread-reply", label),
      summaryTitle: (count) => `스레드 답글 ${count}건`,
    });
    expect(summarize([thread("김인턴")])).toEqual({ title: "thread-reply:김인턴", body: "김인턴 본문" });
    expect(summarize([thread("김인턴"), thread("민준"), thread("민준")])).toEqual({
      title: "스레드 답글 3건",
      body: "김인턴, 민준, 민준",
    });
    // 제목을 안 준 호출은 던지지 않고 보낸 사람 이름으로 말한다.
    expect(summarize([item("thread-reply", "김인턴"), item("thread-reply", "민준")]).title).toBe(
      "thread-reply:김인턴 2건"
    );
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

  it("같은 스레드의 답글만 묶이면 누를 때 가장 늦은 답글의 그 스레드로 간다 — 스레드가 섞이면 예전처럼 멘션 인박스 (#5017)", () => {
    const reply = (label: string, messageId: string, rootId: string): OsNotifyItem => ({
      ...item("thread-reply", label),
      route: `/c/ch?msg=${messageId}&thread=${rootId.toLowerCase()}`,
      rootId,
    });
    const sameThread = [reply("김인턴", "m1", "R1"), reply("민준", "m2", "r1"), reply("김인턴", "m3", "R1")];
    expect(routeFor(sameThread)).toBe("/c/ch?msg=m3&thread=r1");
    // 한 건이거나 이미 한 곳을 가리키면 그곳이다(바뀌지 않는다).
    expect(routeFor([sameThread[0]!])).toBe("/c/ch?msg=m1&thread=r1");
    expect(routeFor([reply("a", "m1", "r1"), reply("a", "m1", "r1")])).toBe("/c/ch?msg=m1&thread=r1");
    expect(routeFor([reply("a", "m1", "r1"), reply("b", "m2", "r2")])).toBe(MIXED_ROUTE);
    // 스레드를 모르는 알림(멘션)은 같은 채널의 다른 카드여도 섞인 것이다.
    const mention = (card: string): OsNotifyItem => ({ ...item("mention", "a"), route: `/c/ch?msg=${card}` });
    expect(routeFor([mention("m1"), mention("m2")])).toBe(MIXED_ROUTE);
    // 길 하나라도 모르면(`route` 없음) 정하지 않는다.
    expect(routeFor([sameThread[0]!, { ...sameThread[1]!, route: undefined }])).toBeUndefined();

    // 알림 묶음을 거쳐 실제로 보내는 대상에 실린다.
    const send = vi.fn(async () => true);
    const n = createOsNotifier({ send, setTimer: () => 0, clearTimer: () => undefined });
    for (const one of sameThread) n.offer(one);
    n.flush();
    expect(send).toHaveBeenCalledWith("thread-reply:김인턴 3건", "김인턴, 민준, 김인턴", {
      kind: "thread-reply",
      route: "/c/ch?msg=m3&thread=r1",
    });
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
