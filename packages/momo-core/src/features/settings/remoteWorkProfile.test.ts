import { describe, expect, it } from "vitest";
import type { LocalHarnessProbe } from "../hostedAgents/detect";
import {
  chooseRemoteWork,
  remoteProfileCodeOf,
  remoteProfileRefusalSentence,
  remoteWorkOutcomeText,
  syncRemoteWork,
  type RemoteOpResult,
  type RemoteWorkDeps,
} from "./remoteWorkProfile";

/** 소켓 없이 순서만 보는 가짜. 호출을 그대로 기록한다. */
function fake(over: Partial<RemoteWorkDeps> & { statusAuth?: LocalHarnessProbe["auth"] } = {}) {
  const calls: string[] = [];
  const deps: RemoteWorkDeps = {
    async set(harness, label) {
      calls.push(`set ${harness} ${label ?? "null"}`);
      return { ok: true, reset: false };
    },
    async prepare(harness, label) {
      calls.push(`prepare ${harness} ${label}`);
      return { ok: true };
    },
    async status(harness, label) {
      calls.push(`status ${harness} ${label}`);
      return { id: harness, installed: true, auth: over.statusAuth ?? "logged_in" };
    },
    async signIn(harness, label) {
      calls.push(`signIn ${harness} ${label}`);
      return true;
    },
    ...over,
  };
  return { deps, calls };
}

const refuse = (code: string): RemoteOpResult<{ reset: boolean }> => ({ ok: false, code });

describe("원격 작업 계정 고르기: prepare → 상태 → (로그인) → set", () => {
  it("로그인돼 있으면 로그인 창 없이 set 하고 다른 하네스의 선택을 지운다", async () => {
    const { deps, calls } = fake();
    const outcome = await chooseRemoteWork({ harness: "claude", label: "회사" }, deps);
    expect(outcome).toEqual({ kind: "applied", reset: false });
    expect(calls).toEqual([
      "prepare claude 회사",
      "status claude 회사",
      "set claude 회사",
      "set codex null",
    ]);
  });

  it("로그인 필요하면 창을 열고, 연결된 뒤에만 set 한다", async () => {
    const { deps, calls } = fake({ statusAuth: "needs_login" });
    const outcome = await chooseRemoteWork({ harness: "codex", label: "개인" }, deps);
    expect(outcome.kind).toBe("applied");
    expect(calls.indexOf("signIn codex 개인")).toBeGreaterThan(calls.indexOf("status codex 개인"));
    expect(calls.indexOf("set codex 개인")).toBeGreaterThan(calls.indexOf("signIn codex 개인"));
  });

  it("로그인을 마치지 않고 닫으면 아무것도 저장하지 않는다", async () => {
    const { deps, calls } = fake({ statusAuth: "needs_login", signIn: async () => false });
    expect(await chooseRemoteWork({ harness: "claude", label: "회사" }, deps)).toEqual({ kind: "login_abandoned" });
    expect(calls.some((call) => call.startsWith("set "))).toBe(false);
  });

  it("상태를 모르면(unknown) 로그인된 것으로 치지 않는다", async () => {
    const { deps, calls } = fake({ statusAuth: "unknown" });
    await chooseRemoteWork({ harness: "claude", label: "회사" }, deps);
    expect(calls).toContain("signIn claude 회사");
  });

  it("거부 라벨마다 그대로 돌려주고, 기본 계정 폴백(라벨 없는 set)은 만들지 않는다(교차)", async () => {
    for (const code of ["profile_not_found", "profile_refused", "profile_login_required", "not_running"]) {
      for (const failing of ["prepare", "set"] as const) {
        const { deps, calls } = fake(
          failing === "prepare"
            ? { prepare: async () => ({ ok: false, code }) }
            : { set: async (harness, label) => (calls.push(`set ${harness} ${label ?? "null"}`), refuse(code)) }
        );
        const outcome = await chooseRemoteWork({ harness: "claude", label: "회사" }, deps);
        expect(outcome).toEqual({ kind: "refused", code });
        // 새 계정을 고르다 거부되면 「고르지 않음」으로 지우는 호출이 뒤따르지 않는다.
        expect(calls.filter((call) => call === "set claude null" || call === "set codex null")).toEqual([]);
      }
    }
  });

  it("고르지 않음은 두 하네스를 모두 지우고, 초기화 사실을 알린다", async () => {
    const { deps, calls } = fake({
      set: async (harness, label) => (calls.push(`set ${harness} ${label ?? "null"}`), { ok: true, reset: harness === "codex" }),
    });
    const outcome = await chooseRemoteWork(null, deps);
    expect(outcome).toEqual({ kind: "cleared", reset: true });
    expect(calls).toEqual(["set claude null", "set codex null"]);
    expect(remoteWorkOutcomeText(outcome)).toEqual({
      tone: "warn",
      text: "원격 작업 계정 선택이 초기화됐어요. 계정을 다시 골라 주세요.",
    });
  });
});

describe("저장된 선택을 이 맥에 다시 넘긴다(표를 열 때)", () => {
  it("로그인 창 없이 set 만 하고, 거부는 라벨로 돌려준다", async () => {
    const { deps, calls } = fake();
    expect(await syncRemoteWork({ harness: "claude", label: "회사" }, deps)).toEqual({ kind: "applied", reset: false });
    expect(calls).toEqual(["set claude 회사", "set codex null"]);
    const gone = fake({ set: async () => refuse("profile_not_found") });
    expect(await syncRemoteWork({ harness: "claude", label: "회사" }, gone.deps)).toEqual({
      kind: "refused",
      code: "profile_not_found",
    });
  });
});

describe("거부 라벨 문장", () => {
  it("세 라벨은 해요체 문장이고 다른 계정으로 대신 시작하지 않는다고 말한다", () => {
    expect(remoteProfileRefusalSentence("profile_not_found")).toBe(
      "이 맥에 원격 작업용 계정 폴더가 없어요. 계정을 다시 골라 로그인해 주세요. 다른 계정으로 대신 시작하지 않아요."
    );
    expect(remoteProfileRefusalSentence("profile_refused")).toBe(
      "원격 작업용 계정 폴더가 바뀌었거나 안전하지 않아 쓰지 않았어요. 계정을 다시 골라 로그인해 주세요. 다른 계정으로 대신 시작하지 않아요."
    );
    expect(remoteProfileRefusalSentence("profile_login_required")).toBe(
      "원격 작업용 계정이 로그인돼 있지 않아요. 계정을 다시 골라 로그인해 주세요. 다른 계정으로 대신 시작하지 않아요."
    );
  });

  it("모든 코드가 서로 다른 문장이고, 코드 원문은 화면에 새지 않는다", () => {
    const codes = [
      "profile_not_found",
      "profile_refused",
      "profile_login_required",
      "invalid_label",
      "profiles_unavailable",
      "not_running",
      "unknown_op",
      "unsupported_platform",
      "socket_unavailable",
    ];
    const sentences = codes.map(remoteProfileRefusalSentence);
    expect(new Set(sentences).size).toBe(codes.length);
    for (const [index, sentence] of sentences.entries()) {
      expect(sentence).not.toContain(codes[index]);
      expect(sentence).toMatch(/[요다]\.?$/);
    }
  });

  it("셸이 준 값은 닫힌 코드로만 받는다", () => {
    expect(remoteProfileCodeOf("profile_refused")).toBe("profile_refused");
    expect(remoteProfileCodeOf("Error: /Users/x/secret")).toBe("unknown");
    expect(remoteProfileCodeOf(new Error("x"))).toBe("unknown");
    expect(remoteProfileCodeOf(undefined)).toBe("unknown");
  });
});
