import { describe, expect, it } from "vitest";
import { classifyEntry, pickEntryToken, type EntryDecision } from "./entryInput";

// D0 한 칸 판별 표 (#2808 Acceptance): oort:// 링크, https 링크, 맨 도메인,
// 스킴 유무, 끝 슬래시, 포트, 대소문자, 공백·붙여 넣기 잡음.

const CODE = "Ab3-_xYz0123456789abcdefghij01"; // 30자 base64url
const TOKEN = "A".repeat(20) + "b-_" + "9".repeat(20); // 43자

const TABLE: readonly [label: string, input: string, expected: EntryDecision["kind"], extra?: Record<string, string>][] = [
  // --- 초대 링크 → D1′
  ["oort:// 초대", `oort://join?server=https%3A%2F%2Fteam.example.com&code=${CODE}`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["momo:// 옛 스킴 초대", `momo://join?code=${CODE}&server=https%3A%2F%2Fteam.example.com`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["대문자 스킴 초대", `OORT://join?server=https%3A%2F%2Fteam.example.com&code=${CODE}`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["https 웹 초대 (?code=)", `https://team.example.com/?code=${CODE}`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["https 웹 초대 (해시 쿼리)", `https://team.example.com/#/?code=${CODE}`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["https 웹 초대 (?join= 감싼 링크)", `https://team.example.com/?join=${encodeURIComponent(`oort://join?server=https%3A%2F%2Fother.example.com&code=${CODE}`)}`, "invite", { serverUrl: "https://other.example.com", inviteCode: CODE }],
  ["초대 코드만", CODE, "invite", { serverUrl: "", inviteCode: CODE }],
  ["초대 카드 문단 통째로", `여명거리 워크스페이스에 초대합니다.\n\n1. oort 앱을 설치하고 아래 링크를 엽니다.\n   oort://join?server=https%3A%2F%2Fteam.example.com&code=${CODE}\n\n2. 링크가 앱에서 열리지 않으면 직접 입력하세요.\n   서버 주소: https://team.example.com\n   초대 코드: ${CODE}`, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  ["꺾쇠·따옴표로 감싼 초대", `  "<oort://join?server=https%3A%2F%2Fteam.example.com&code=${CODE}>"  `, "invite", { serverUrl: "https://team.example.com", inviteCode: CODE }],
  // --- claim 링크 → D1″ (#2811)
  ["https claim", `https://team.example.com/claim/${TOKEN}`, "claim", { origin: "https://team.example.com", token: TOKEN }],
  ["http claim 포트·끝 슬래시", `http://localhost:28080/claim/${TOKEN}/`, "claim", { origin: "http://localhost:28080", token: TOKEN }],
  ["대문자 경로 머리 claim", `https://Team.Example.com/CLAIM/${TOKEN}`, "claim", { origin: "https://team.example.com", token: TOKEN }],
  ["문장에 섞인 claim", `이 주소를 여세요: https://team.example.com/claim/${TOKEN}.`, "claim", { origin: "https://team.example.com", token: TOKEN }],
  ["잘린 claim", "https://team.example.com/claim/abc", "invalid"],
  ["oort://claim (계약 전)", `oort://claim/${TOKEN}`, "invalid"],
  // --- 서버 주소 → D1
  ["맨 도메인", "team.example.com", "server", { base: "https://team.example.com" }],
  ["https 도메인", "https://team.example.com", "server", { base: "https://team.example.com" }],
  ["끝 슬래시", "https://team.example.com/", "server", { base: "https://team.example.com" }],
  ["포트", "team.example.com:28000", "server", { base: "https://team.example.com:28000" }],
  ["http + IP + 포트", "http://10.0.0.5:8080/", "server", { base: "http://10.0.0.5:8080" }],
  ["대소문자", "HTTPS://Team.Example.COM", "server", { base: "https://team.example.com" }],
  ["경로 접두", "https://team.example.com/momo/", "server", { base: "https://team.example.com/momo" }],
  ["localhost", "localhost:8080", "server", { base: "https://localhost:8080" }],
  ["앞뒤 공백·줄바꿈", "  \n team.example.com \t\n", "server", { base: "https://team.example.com" }],
  ["폭 없는 공백", "​team.example.com﻿", "server", { base: "https://team.example.com" }],
  ["oort://join 서버만", "oort://join?server=https%3A%2F%2Fteam.example.com", "server", { base: "https://team.example.com" }],
  // --- 그 밖 → 당황 + 합니다체
  ["빈 칸", "   ", "empty"],
  ["낱말 하나", "hello", "invalid"],
  ["한국어 문장", "우리 팀 서버", "invalid"],
  ["ftp 스킴", "ftp://team.example.com", "invalid"],
  ["기기 연결 링크", `oort://link?server=https%3A%2F%2Fteam.example.com&token=${TOKEN}`, "invalid"],
  ["짧은 코드 모양", "Ab3-_x", "invalid"],
];

describe("D0 한 칸 판별 표 (#2808)", () => {
  it.each(TABLE)("%s", (_label, input, kind, extra) => {
    const decision = classifyEntry(input);
    expect(decision.kind).toBe(kind);
    if (extra) expect(decision).toMatchObject(extra);
    if (decision.kind === "invalid") {
      // 폼 오류는 합니다체이고 다음 행동을 말한다(ADR-0193 D11).
      expect(decision.message).toMatch(/니다\./);
      expect(decision.message).not.toMatch(/—|–/);
    }
  });

  it("covers every branch the issue names", () => {
    const kinds = new Set(TABLE.map(([, input]) => classifyEntry(input).kind));
    expect([...kinds].sort()).toEqual(["claim", "empty", "invalid", "invite", "server"]);
  });

  it("never echoes an invite code or claim token into an error sentence", () => {
    for (const input of [`https://team.example.com/claim/${TOKEN.slice(0, 20)}`, `oort://claim/${TOKEN}`]) {
      const decision = classifyEntry(input);
      expect(decision.kind).toBe("invalid");
      if (decision.kind === "invalid") {
        expect(decision.message).not.toContain(TOKEN.slice(0, 20));
      }
    }
  });

  it("picks the invite link out of a card that also lists the bare server", () => {
    expect(
      pickEntryToken(`서버 주소: https://team.example.com\n링크: oort://join?code=${CODE}`)
    ).toBe(`oort://join?code=${CODE}`);
  });
});
