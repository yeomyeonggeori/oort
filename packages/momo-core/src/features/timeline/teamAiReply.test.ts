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

// ---- 「쓴 앱」 꼬리 (ADR-0113 증보 2 E8·E10, #3950 U-S2) --------------------------------------
import {
  APPS_PERSONAL_NOTE,
  APPS_TAIL_SELF_REPORT,
  appsRunSiteOf,
  type AppsTailContext,
} from "./teamAiReply";

const GMAIL = { name: "Gmail", egressDomains: ["gmailmcp.googleapis.com"] };
const GITHUB = { name: "GitHub", egressDomains: ["api.githubcopilot.com"] };

function ctx(overrides: Partial<AppsTailContext> = {}): AppsTailContext {
  return {
    appsUsed: [{ pluginId: "gmail", tool: "search_threads", calls: 2 }],
    plugins: new Map([
      ["gmail", GMAIL],
      ["github", GITHUB],
    ]),
    onBehalfOf: "구민수",
    site: "hermes",
    audience: null,
    ...overrides,
  };
}

describe("쓴 앱 꼬리", () => {
  it("예시 줄을 그대로 만든다 — 앱·횟수 · 명의 · 연결 주소 · 실행 장소 · 자기 보고", () => {
    const meta = parseTeamAiReplyMeta({ source: "hermes_gateway", run_id: "r1" }, ctx());
    // 기본 꼬리는 한 줄이고 메시지마다 달라지는 사실(앱·횟수)만 싣는다. 나머지는 「자세히」 뒤.
    expect(meta?.appsLine).toBe("쓴 앱: Gmail 검색 2회");
    expect(meta?.appsDetails).toEqual([
      "Hermes에서 실행했어요.",
      "구민수 명의로 썼어요.",
      "연결: gmailmcp.googleapis.com",
      APPS_TAIL_SELF_REPORT,
    ]);
    expect(meta?.appsLine?.length).toBeLessThan(40);
    // 도구 줄·모델 칩은 도우미(team_ai) 답의 것이다.
    expect(meta?.toolsLine).toBeNull();
    expect(meta?.modelChip).toBeNull();
    expect(meta?.appsSpoken).toContain("쓴 앱");
  });

  it("보고가 없으면 줄 자체가 없다(영수증을 만들지 않는다)", () => {
    expect(
      parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ appsUsed: null }))
    ).toBeNull();
    expect(
      parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ appsUsed: [] }))
    ).toBeNull();
    // 컨텍스트가 아예 없는 호출(옛 호출처)도 변화 0.
    expect(parseTeamAiReplyMeta({ source: "hermes_gateway", run_id: "r" })).toBeNull();
  });

  it("모르는 조각은 짐작해서 채우지 않는다: 명의·실행 장소·앱 이름", () => {
    const meta = parseTeamAiReplyMeta(
      { source: "hermes_gateway" },
      ctx({ onBehalfOf: null, site: null, plugins: new Map() })
    );
    // 앱 목록에 없는 앱의 원문 id 는 사람에게 보이지 않는다.
    expect(meta?.appsLine).toBe("쓴 앱: 다른 앱 검색 2회");
    expect(meta?.appsLine).not.toContain("gmail");
    expect(meta?.appsDetails).toEqual([APPS_TAIL_SELF_REPORT]);
    expect(meta?.appsDetails.join()).not.toContain("명의");
    expect(meta?.appsLine).not.toContain("에서");
    expect(meta?.appsDetails.join()).not.toContain("실행했어요");
  });

  it("도구 이름이 섞이면 동사를 붙이지 않고 횟수만 합친다", () => {
    const meta = parseTeamAiReplyMeta(
      { source: "hermes_gateway" },
      ctx({
        appsUsed: [
          { pluginId: "gmail", tool: "search_threads", calls: 2 },
          { pluginId: "gmail", tool: "create_draft", calls: 1 },
          { pluginId: "github", tool: "list_issues", calls: 4 },
        ],
      })
    );
    expect(meta?.appsLine).toContain("Gmail 3회, GitHub 목록 4회");
    expect(meta?.appsLine).not.toContain("search_threads");
  });

  it("props 에 같은 모양이 실리면 그것도 읽는다(전방 호환), run 쪽이 먼저다", () => {
    const fromProps = parseTeamAiReplyMeta(
      {
        source: "hermes_gateway",
        appsUsed: [{ pluginId: "github", tool: "get_issue", calls: 1 }],
      },
      ctx({ appsUsed: null })
    );
    expect(fromProps?.appsLine).toContain("GitHub 읽기 1회");
    const both = parseTeamAiReplyMeta(
      {
        source: "hermes_gateway",
        appsUsed: [{ pluginId: "github", tool: "get_issue", calls: 1 }],
      },
      ctx()
    );
    expect(both?.appsLine).toContain("Gmail 검색 2회");
  });

  it("서버와 같은 닫힌 규칙: 모르는 키가 하나라도 있으면 보고 전체를 버린다", () => {
    for (const bad of [
      [{ pluginId: "gmail", tool: "search_threads", calls: 2, body: "메일 본문" }],
      [{ pluginId: "gmail", tool: "has space", calls: 2 }],
      [{ pluginId: "gmail", tool: "t", calls: 0 }],
      [{ pluginId: "gmail", tool: "t", calls: 1.5 }],
      [
        { pluginId: "gmail", tool: "t", calls: 1 },
        { pluginId: "gmail", tool: "t", calls: 2 },
      ],
    ]) {
      expect(
        parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ appsUsed: bad as never }))
      ).toBeNull();
    }
  });

  it("도우미(team_ai) 답에는 앱 줄이 서지 않는다 — 도우미는 앱 도구를 부르지 않는다(E7)", () => {
    const meta = parseTeamAiReplyMeta(
      { source: "team_ai", model_label: "Claude Sonnet 4.5" },
      ctx()
    );
    expect(meta?.appsLine).toBeNull();
    expect(meta?.modelChip).toBe("팀 AI · Claude Sonnet 4.5");
  });

  it("실행 장소는 메시지 표식으로 아는 곳만 말한다", () => {
    expect(appsRunSiteOf({ source: "hermes_gateway" })).toBe("hermes");
    expect(appsRunSiteOf({ source: "something_else" })).toBeNull();
    expect(appsRunSiteOf(undefined)).toBeNull();
  });

  it("채널 노출(E10): 채널이면 둘째 줄에 n명, DM(null)이면 없다", () => {
    expect(
      parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ audience: 12 }))?.exposureLine
    ).toBe("이 채널 12명에게 보여요");
    // 노출은 기본 꼬리 줄에 들어 있다(접지 않는다).
    expect(
      parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ audience: 12 }))?.appsLine
    ).toBe("쓴 앱: Gmail 검색 2회 · 이 채널 12명에게 보여요");
    for (const audience of [null, 0, -1, 1.5]) {
      expect(
        parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ audience: audience as never }))
          ?.exposureLine
      ).toBeNull();
    }
  });

  it("개인 앱을 채널에 올리면 「요약만」은 원칙이고 확인하지 못한다고 함께 말한다", () => {
    const personal = parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ audience: 5 }));
    expect(personal?.personalNote).toBe(APPS_PERSONAL_NOTE);
    // 한 줄을 늘리지 않게 「자세히」 뒤에 있고, 낭독은 접힌 것까지 읽는다.
    expect(personal?.appsDetails).toContain(APPS_PERSONAL_NOTE);
    expect(personal?.appsLine).not.toContain("요약만");
    expect(personal?.appsSpoken).toContain(APPS_PERSONAL_NOTE);
    expect(APPS_PERSONAL_NOTE).toContain("요약만");
    expect(APPS_PERSONAL_NOTE).toContain("확인하지 못해요");
    expect(APPS_PERSONAL_NOTE.length).toBeLessThan(48);
    // 강제처럼 쓰지 않는다.
    expect(APPS_PERSONAL_NOTE).not.toMatch(/막아|금지|보장/);
    // 개인 앱이 아니면(GitHub) 안내는 없고, DM 이면 둘 다 없다.
    const github = parseTeamAiReplyMeta(
      { source: "hermes_gateway" },
      ctx({ audience: 5, appsUsed: [{ pluginId: "github", tool: "get_issue", calls: 1 }] })
    );
    expect(github?.exposureLine).toBe("이 채널 5명에게 보여요");
    // 개인 앱이 아니면 기본 줄에 노출을 싣지 않고(되풀이 방지) 자세히 뒤로 접는다.
    expect(github?.appsLine).toBe("쓴 앱: GitHub 읽기 1회");
    expect(github?.appsDetails).toContain("이 채널 5명에게 보여요");
    expect(github?.personalNote).toBeNull();
    expect(
      parseTeamAiReplyMeta({ source: "hermes_gateway" }, ctx({ audience: null }))?.personalNote
    ).toBeNull();
  });

  it("공식 앱 id 가 점으로 이어진 모양이어도 개인 앱으로 판정한다", () => {
    const dotted = parseTeamAiReplyMeta(
      { source: "hermes_gateway" },
      ctx({
        audience: 5,
        appsUsed: [{ pluginId: "com.momo.plugins.gmail", tool: "search_threads", calls: 1 }],
        plugins: new Map([["com.momo.plugins.gmail", GMAIL]]),
      })
    );
    expect(dotted?.personalNote).toBe(APPS_PERSONAL_NOTE);
  });

  it("지워진 메시지에는 꼬리가 없다", () => {
    expect(
      teamAiReplyMetaFor({ props: { source: "hermes_gateway" }, state: "deleted" } as never, ctx())
    ).toBeNull();
  });
});
