import { describe, expect, it } from "vitest";
import type { GitReadResult, GitValue } from "./gitRead";
import {
  MAX_STAGES,
  S1_HARNESSES,
  S1_STATES,
  STAGE_LABEL,
  cleanLabel,
  createShareCollector,
  noopShareSender,
  parsePrUrl,
  titleActivity,
  type ShareSender,
  type ShareSummaryS1,
} from "./shareSummary";

function rig(opts: { minIntervalMs?: number; activityIntervalMs?: number } = {}) {
  let t = 1_000_000;
  const sent: ShareSummaryS1[] = [];
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const sender: ShareSender = { send: (s) => void sent.push(s) };
  const c = createShareCollector({
    harness: "claude",
    sender,
    now: () => t,
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    ...opts,
  });
  const advance = (ms: number) => {
    t += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= t) {
        timer.live = false;
        timer.fn();
      }
    }
  };
  return { c, sent, advance };
}

const ok = (value: GitValue): GitReadResult => ({ outcome: "ok", value });

const S1_KEYS = ["branch", "diff", "harness", "lastActivityAt", "prUrl", "repo", "stages", "state"];
const DIFF_KEYS = ["added", "ahead", "behind", "deleted", "files", "uncommitted"];

describe("S1 요약은 S1 필드만 만든다 (#2861)", () => {
  it("필드 집합이 정확히 S1이다", () => {
    const { c } = rig();
    const s = c.snapshot();
    expect(Object.keys(s).sort()).toEqual(S1_KEYS);
    expect(Object.keys(s.diff).sort()).toEqual(DIFF_KEYS);
    expect(s.state).toBe("idle");
    expect(S1_HARNESSES).toContain(s.harness);
  });

  it("git 숫자·하네스 신호·PR URL이 한 요약에 모인다", () => {
    const { c } = rig();
    c.onLifecycle("running");
    c.onSignal("working");
    c.onGit({
      g1: ok({ kind: "repo", name: "oort" }),
      g2: ok({ kind: "branch", name: "feat/2861" }),
      g4: ok({ kind: "aheadBehind", ahead: 3, behind: 1 }),
      g7: ok({
        kind: "diff",
        files: [{ path: "secret/customer-acme.ts", added: 5, deleted: 2, binary: false }],
        totals: { files: 1, added: 5, deleted: 2, binary: 0 },
      }),
      g8: ok({ kind: "status", modified: 2, added: 1, deleted: 0, untracked: 4 }),
    });
    c.onPrUrl("https://github.com/yeomyeonggeori/oort/pull/2861");
    const s = c.snapshot();
    expect(s).toMatchObject({
      repo: "oort",
      branch: "feat/2861",
      harness: "claude",
      state: "running",
      prUrl: "https://github.com/yeomyeonggeori/oort/pull/2861",
      diff: { added: 5, deleted: 2, files: 1, ahead: 3, behind: 1, uncommitted: 7 },
    });
    expect(s.stages).toEqual([STAGE_LABEL.started, STAGE_LABEL.working]);
    expect(JSON.stringify(s)).not.toContain("customer-acme");
  });

  it("git을 모르면 숫자는 null이다(0으로 꾸미지 않는다)", () => {
    const { c } = rig();
    c.onGit({ g4: { outcome: "noUpstream" }, g7: { outcome: "noUpstream" }, g8: { outcome: "unknown" } });
    expect(c.snapshot().diff).toEqual({ added: null, deleted: null, files: null, ahead: null, behind: null, uncommitted: null });
  });

  it("파생 상태는 칸 판정(derivePaneStatus)을 따른다", () => {
    const { c } = rig();
    c.onLifecycle("running");
    c.onSignal("waiting-permission");
    expect(c.snapshot().state).toBe("waiting");
    c.onSignal("turn-done");
    expect(c.snapshot().state).toBe("done");
    c.onLifecycle("exited", 1);
    expect(c.snapshot().state).toBe("stopped");
    expect(S1_STATES).toContain(c.snapshot().state);
  });

  it("단계 표지는 12개까지, 같은 표지가 이어지면 합친다", () => {
    const { c } = rig();
    for (let i = 0; i < 40; i++) {
      c.onSignal("working");
      c.onSignal("turn-done");
    }
    const s = c.snapshot();
    expect(s.stages.length).toBe(MAX_STAGES);
    expect(s.stages.every((x) => x.length <= 80)).toBe(true);
  });
});

describe("red proof: 출력 파싱 경로가 없다 (ADR-0190 D4-b, Q3)", () => {
  const CANARY = [
    "sk-ant-api03-CANARY",
    "ghp_CANARYTOKEN",
    "fix: acme-corp 고객 환불 (commit subject)",
    "Allow this command? (y/n)",
    "permission_prompt",
    "/Users/me/secret-repo",
  ];

  it("수집기의 입구는 타입 있는 신호뿐이고 출력을 받는 메서드가 없다", () => {
    const { c } = rig();
    expect(Object.keys(c).sort()).toEqual(
      ["dispose", "onGit", "onLifecycle", "onPrUrl", "onSignal", "onTitle", "setSharing", "snapshot"].sort()
    );
  });

  it("출력 모양 문자열을 모든 문자열 입구에 넣어도 요약에 남지 않는다", () => {
    const { c } = rig();
    c.onLifecycle("running");
    const baseline = JSON.stringify(c.snapshot());
    for (const text of CANARY) {
      c.onTitle(text); // 제목: 점 모양이 아니면 아무 일도 없다
      c.onPrUrl(text); // 형식 밖 PR URL은 버린다
      c.onGit({ g1: { outcome: "unknown" } });
      // 토큰이 섞인 경로형 저장소 이름·브랜치는 정제된다(경로 구분자 거부)
      c.onGit({ g1: ok({ kind: "repo", name: text }) });
    }
    const after = JSON.stringify(c.snapshot());
    for (const text of CANARY) expect(after).not.toContain(text);
    expect(JSON.parse(after).stages).toEqual(JSON.parse(baseline).stages);
    expect(JSON.parse(after).prUrl).toBeNull();
  });

  it("작업 중 점 제목이 작업 내용을 달고 와도 글은 어디에도 남지 않는다", () => {
    const { c } = rig();
    for (const text of CANARY) c.onTitle(`◐ ${text}`);
    const s = JSON.stringify(c.snapshot());
    for (const text of CANARY) expect(s).not.toContain(text);
    expect(c.snapshot().stages).toEqual([STAGE_LABEL["title-working"]]);
    expect(titleActivity("✳ Claude Code")).toBeNull();
    expect(titleActivity("◑ x")).toBe("working");
    expect(titleActivity(null)).toBeNull();
  });

  it("보내는 본문에도 출력 모양 글이 없다", () => {
    const { c, sent } = rig();
    c.setSharing(true);
    for (const text of CANARY) c.onTitle(`◓ ${text}`);
    c.onGit({ g2: ok({ kind: "branch", name: "main" }) });
    const body = JSON.stringify(sent);
    for (const text of CANARY) expect(body).not.toContain(text);
  });

  it("표지 글은 닫힌 표에서만 온다", () => {
    const { c } = rig();
    c.onSignal("waiting-permission");
    c.onTitle("◐ whatever");
    c.onLifecycle("exited", 0);
    const allowed = new Set(Object.values(STAGE_LABEL));
    for (const stage of c.snapshot().stages) expect(allowed.has(stage)).toBe(true);
  });
});

describe("정제", () => {
  it("제어 문자·ANSI·양방향 서식을 지우고 상한으로 자른다", () => {
    expect(cleanLabel("a\u001b[31mb‮c\u0007", 10)).toBe("a[31mbc");
    expect(cleanLabel("   ", 10)).toBeNull();
    expect(cleanLabel(12, 10)).toBeNull();
    expect(cleanLabel("가".repeat(300), 200)?.length).toBe(200);
  });

  it("저장소 이름에 경로 구분자가 있으면 버린다", () => {
    const { c } = rig();
    c.onGit({ g1: ok({ kind: "repo", name: "/Users/me/oort" }) });
    expect(c.snapshot().repo).toBeNull();
    c.onGit({ g1: ok({ kind: "repo", name: "oort" }) });
    expect(c.snapshot().repo).toBe("oort");
  });

  it("PR URL은 https + /pull/<번호>만, 자격 증명·질의·조각은 거부", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/12")).toBe("https://github.com/a/b/pull/12");
    for (const bad of [
      "http://github.com/a/b/pull/12",
      "https://x:tok@github.com/a/b/pull/12",
      "https://github.com/a/b/pull/12?token=abc",
      "https://github.com/a/b/pull/12#c",
      "https://github.com/a/b/issues/12",
      "https://github.com/a/b/pull/12/files",
      "https://github.com/a/b/pull/12\nhttps://evil",
      "javascript:alert(1)",
      "",
      null,
      5,
    ]) {
      expect(parsePrUrl(bad)).toBeNull();
    }
  });
});

describe("공유 꺼짐 기본값과 합치기·간격 제한", () => {
  it("공유를 켜기 전에는 아무것도 보내지 않는다", () => {
    const { c, sent, advance } = rig();
    c.onSignal("working");
    advance(600_000);
    expect(sent).toEqual([]);
  });

  it("켜면 현재 요약을 한 번 보내고, 끄면 보류 중인 갱신을 버린다", () => {
    const { c, sent, advance } = rig();
    c.onSignal("working");
    c.setSharing(true);
    expect(sent.length).toBe(1);
    c.onSignal("turn-done");
    expect(sent.length).toBe(1); // 간격 안: 보류
    c.setSharing(false);
    advance(60_000);
    expect(sent.length).toBe(1);
  });

  it("간격 안의 변화는 하나로 합쳐 마지막 모양을 한 번 보낸다", () => {
    const { c, sent, advance } = rig({ minIntervalMs: 5_000 });
    c.onLifecycle("running");
    c.setSharing(true);
    expect(sent.length).toBe(1);
    for (let i = 0; i < 50; i++) {
      c.onSignal(i % 2 === 0 ? "working" : "waiting-permission");
      advance(10);
    }
    expect(sent.length).toBe(1);
    advance(5_000);
    expect(sent.length).toBe(2);
    expect(sent[1]!.state).toBe("waiting");
  });

  it("모양이 같고 활동 시각만 바뀌면 느린 간격으로만 보낸다", () => {
    const { c, sent, advance } = rig({ minIntervalMs: 1_000, activityIntervalMs: 60_000 });
    c.onLifecycle("running");
    c.setSharing(true);
    c.onTitle("◐ a"); // 새 표지 → 모양 바뀜
    advance(1_000);
    const n = sent.length;
    for (let i = 0; i < 30; i++) {
      advance(1_000);
      c.onTitle("◐ b"); // 같은 표지: 모양은 그대로, 시각만
    }
    expect(sent.length).toBe(n);
    advance(60_000);
    c.onTitle("◐ c");
    expect(sent.length).toBe(n + 1);
  });

  it("보내기가 던져도 수집은 계속된다", () => {
    let t = 0;
    const c = createShareCollector({
      harness: "codex",
      now: () => (t += 10_000),
      sender: {
        send: () => {
          throw new Error("boom");
        },
      },
    });
    c.setSharing(true);
    expect(() => c.onSignal("working")).not.toThrow();
    expect(c.snapshot().state).toBe("idle");
  });

  it("기본 보내기는 아무 일도 하지 않는다", () => {
    expect(noopShareSender.send(rig().c.snapshot())).toBeUndefined();
  });
});
