// ADR-0201 증보 v2 H4·H5·H9-I9 (#3893): 도우미 답의 꼬리(찾아본 것 · 출처 · 모델 라벨).
import { describe, expect, it } from "vitest";
import { citationAccessibleName, parseTeamAiReplyMeta, teamAiReplyMetaFor } from "./teamAiReply";

describe("parseTeamAiReplyMeta", () => {
  it("옛 서버의 도우미 답(칸 없음)과 다른 에이전트의 글에는 아무 것도 없다", () => {
    expect(parseTeamAiReplyMeta({ source: "team_ai", run_id: "r1" })).toBeNull();
    expect(
      parseTeamAiReplyMeta({ tools_used: [{ name: "search_messages" }], model_label: "GPT" })
    ).toBeNull();
    expect(parseTeamAiReplyMeta(undefined)).toBeNull();
  });

  it("넘기는 줄에는 꼬리를 달지 않는다(자기 띠가 있다)", () => {
    expect(
      parseTeamAiReplyMeta({
        source: "team_ai",
        kind: "team_ai.delegate.v1",
        model_label: "Claude Sonnet 4.5",
      })
    ).toBeNull();
  });

  it("아는 도구만, 부른 순서대로, 겹치지 않게 한 줄로", () => {
    const meta = parseTeamAiReplyMeta({
      source: "team_ai",
      tools_used: [
        { name: "search_messages" },
        { name: "read_channel", channel: "마케팅" },
        { name: "search_messages" },
        { name: "drop_database" },
        "junk",
      ],
    });
    expect(meta?.toolsLine).toBe("찾아본 것: 메시지 검색 · #마케팅 읽기");
    // 모르는 도구 이름(원문 id)은 화면에 닿지 않는다.
    expect(meta?.toolsSpoken).not.toContain("drop_database");
  });

  it("넘치면 「외 N개」로 접고, 낭독은 전부 읽는다", () => {
    const meta = parseTeamAiReplyMeta({
      source: "team_ai",
      tools_used: [
        { name: "search_messages" },
        { name: "read_thread" },
        { name: "list_members" },
        { name: "list_agent_runs" },
        { name: "web_search" },
        { name: "list_plugins" },
      ],
    });
    expect(meta?.toolsLine).toBe(
      "찾아본 것: 메시지 검색 · 스레드 읽기 · 멤버 목록 · 에이전트 작업 기록 외 2개"
    );
    expect(meta?.toolsSpoken).toContain("웹 검색, 앱 목록");
  });

  it("출처는 http(s)만, 자격이 든 주소는 버리고, 제목이 없으면 호스트", () => {
    const meta = parseTeamAiReplyMeta({
      source: "team_ai",
      web_citations: [
        { url: "https://www.example.com/a", title: "  Rust 2026 로드맵\n" },
        { url: "javascript:alert(1)", title: "x" },
        // 호스트가 있는 http(s) 밖 스킴. 호스트 검사만으로는 안 걸린다(프로토콜 검사가 진다).
        { url: "ftp://files.example.com/a", title: "x" },
        { url: "file://server/share/a", title: "x" },
        { url: "https://user:pw@evil.test/", title: "x" },
        { url: "http://docs.rs/sqlx" },
        { url: "https://www.example.com/a", title: "중복" },
        { url: "not a url" },
      ],
    });
    expect(meta?.citations).toEqual([
      { url: "https://www.example.com/a", title: "Rust 2026 로드맵", host: "example.com" },
      { url: "http://docs.rs/sqlx", title: "docs.rs", host: "docs.rs" },
    ]);
    expect(citationAccessibleName(meta!.citations[0])).toBe(
      "Rust 2026 로드맵, example.com, 새 창에서 열기"
    );
  });

  it("모델 라벨은 「팀 AI · …」 칩이고 제어 문자는 지운다", () => {
    const meta = parseTeamAiReplyMeta({ source: "team_ai", model_label: "Claude‮ Sonnet 4.5" });
    expect(meta?.modelChip).toBe("팀 AI · Claude Sonnet 4.5");
    expect(meta?.toolsLine).toBeNull();
  });

  it("지워진 메시지에는 없다", () => {
    expect(
      teamAiReplyMetaFor({ state: "deleted", props: { source: "team_ai", model_label: "x" } })
    ).toBeNull();
  });
});
