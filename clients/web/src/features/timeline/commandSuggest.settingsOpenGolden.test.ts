// U-S6 #3940: 서버 골든 벡터(`docs/api/command-suggest-settings-open.golden.json`, #3939)와
// 코어의 section 표·라벨 표가 한 벌인지 잰다. 골든은 repo 문서라 코어 순수 게이트가 읽을 수
// 없어(`packages/momo-core/src` 밖), 웹 시험이 맡는다(`MessageRow.gc8Golden.test.tsx`와 같다).

import { describe, expect, it } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  COMMAND_SUGGEST_PROP_KEY,
  SETTINGS_OPEN_SECTIONS,
  commandSuggestCard,
  settingsOpenLabel,
} from "@momo/core/features/timeline/commandSuggest";
import golden from "../../../../../docs/api/command-suggest-settings-open.golden.json";

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

describe("settings.open 서버 골든 ↔ 코어 표", () => {
  it("골든 12 케이스가 section 표와 같은 순서이고 전부 ok 카드·같은 라벨이다", () => {
    expect(golden.cases.map((c) => c.name)).toEqual([...SETTINGS_OPEN_SECTIONS]);
    for (const golden_case of golden.cases) {
      const envelope = golden_case.props["momo.command_suggest"];
      const message = {
        id: "m1", channelId: "c1", seq: 1, hlcTs: 0, hlcCount: 0, authorMemberId: AGENT,
        type: "text", body: "b", state: "sent", createdAtMs: 0,
        props: { [COMMAND_SUGGEST_PROP_KEY]: envelope },
      } as unknown as Message;
      const card = commandSuggestCard(message, directory);
      expect(card?.shape, golden_case.name).toBe("ok");
      expect(card?.section, golden_case.name).toBe(golden_case.name);
      expect(settingsOpenLabel(card!.section!), golden_case.name).toBe(envelope.label);
    }
  });
});
