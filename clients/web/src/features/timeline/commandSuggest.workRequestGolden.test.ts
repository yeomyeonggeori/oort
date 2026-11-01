// #4972 S9: 서버 골든 벡터(`docs/api/command-suggest-work-request-open.golden.json`)와 코어의 라벨 표·
// 파서가 한 벌인지 잰다. 골든은 repo 문서라 코어 순수 게이트가 읽을 수 없어(`packages/momo-core/src` 밖)
// 웹 시험이 맡는다(`commandSuggest.settingsOpenGolden.test.ts`와 같다). 사전(ko-KR)의 라벨 세 줄도 같은
// 표를 따라야 해서 여기서 함께 잰다 — 카드는 사전 글자를 그리고 서버는 표 글자를 보내기 때문이다.

import { describe, expect, it } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  COMMAND_SUGGEST_PROP_KEY,
  commandSuggestCard,
  workRequestOpenLabel,
} from "@momo/core/features/timeline/commandSuggest";
import { createAppLocale } from "@/i18n/localeStore";
import golden from "../../../../../docs/api/command-suggest-work-request-open.golden.json";

const HUMAN = golden.for_member_id_placeholder;
const AGENT = "019f9a01-0000-7000-8000-000000000401";

function member(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
  return {
    id, workspaceId: "w", kind, status: "active", displayName, handle,
    channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([
  member(HUMAN, "human", "곽성재", "sj"),
  member(AGENT, "agent", "hermes", "hermes"),
]);

describe("work.request.open 서버 골든 ↔ 코어 파서·라벨 표", () => {
  it("골든 5 케이스가 전부 ok 카드이고 args·라벨이 서버가 보낸 그대로다", () => {
    expect(golden.cases.map((c) => c.name)).toEqual([
      "prompt-only", "claude", "codex", "multi-line", "crlf-and-padding",
    ]);
    for (const golden_case of golden.cases) {
      const envelope = golden_case.props["momo.command_suggest"];
      const message = {
        id: "m1", channelId: "c1", seq: 1, hlcTs: 0, hlcCount: 0, authorMemberId: AGENT,
        type: "text", body: "b", state: "sent", createdAtMs: 0,
        props: { [COMMAND_SUGGEST_PROP_KEY]: envelope },
      } as unknown as Message;
      const card = commandSuggestCard(message, directory);
      expect(card?.shape, golden_case.name).toBe("ok");
      const args = envelope.args as { harness?: "claude" | "codex"; prompt: string };
      expect(card?.workRequest, golden_case.name).toEqual({
        harness: args.harness ?? null,
        prompt: args.prompt,
      });
      expect(workRequestOpenLabel(card!.workRequest!.harness), golden_case.name).toBe(envelope.label);
    }
  });

  it("서버가 정리한 글(CRLF→LF, 양끝 공백 없음)이 카드에 그대로 오고, 날것은 골든 입력에만 있다", () => {
    const raw = golden.cases.find((c) => c.name === "crlf-and-padding")!;
    expect(JSON.stringify(raw.arguments.args)).toContain("\\r\\n");
    expect(JSON.stringify(raw.props)).not.toContain("\\r");
    const kept = (raw.props["momo.command_suggest"].args as { prompt: string }).prompt;
    expect(kept).toBe(kept.trim());
  });

  it("ko-KR 사전의 라벨 세 줄이 서버 표와 같은 글자다", async () => {
    const locale = await createAppLocale(
      {
        readPreference: () => "ko-KR",
        writePreference: () => {},
        readDevice: () => ({ languages: ["ko-KR"], timeZone: "Asia/Seoul" }),
      },
      { applyLang: () => {} }
    );
    const say = locale.service.formatMessage;
    expect(say("timeline.workRequest.labelAny")).toBe(workRequestOpenLabel(null));
    expect(say("timeline.workRequest.labelClaude")).toBe(workRequestOpenLabel("claude"));
    expect(say("timeline.workRequest.labelCodex")).toBe(workRequestOpenLabel("codex"));
  });
});
