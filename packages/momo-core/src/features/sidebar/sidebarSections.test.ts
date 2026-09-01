import { describe, expect, it } from "vitest";
import type { Channel } from "../../lib/api";
import {
  BASE_CHANNELS_SECTION_ID,
  BASE_DMS_SECTION_ID,
  canCreateSidebarSection,
  createSidebarSection,
  deleteSidebarSection,
  deriveSidebarSections,
  emptySidebarPrefs,
  nextSidebarSectionId,
  placeChannelInSection,
  renameSidebarSection,
  sectionIdForChannel,
  sidebarChannelRefCount,
  sidebarPrefsFromWire,
  sidebarPrefsToWire,
  sidebarSectionNameIssue,
  SIDEBAR_SECTION_MAX,
  SIDEBAR_SECTION_NAME_MAX,
  type SidebarPrefs,
} from "./sidebarSections";

function channel(id: string, name: string): Channel {
  return {
    id,
    workspaceId: "ws",
    kind: "public",
    name,
    muted: false,
  };
}

function dm(id: string): Channel {
  return { id, workspaceId: "ws", kind: "dm", muted: false };
}

const GENERAL = channel("11111111-1111-4111-8111-111111111111", "일반");
const RELEASE = channel("22222222-2222-4222-8222-222222222222", "출시");
const RANDOM = channel("33333333-3333-4333-8333-333333333333", "잡담");
const DM_ONE = dm("44444444-4444-4444-8444-444444444444");
/** 어느 채널도 가리키지 않는 id. 서버는 이것을 저장한다(ADR-0177 D3 관용 계약). */
const DEAD = "00000000-0000-4000-8000-0000deadbeef";

function prefsWith(
  sections: SidebarPrefs["sections"],
  extra: Partial<SidebarPrefs> = {}
): SidebarPrefs {
  return { ...emptySidebarPrefs(), sections, ...extra };
}

describe("payload 왕복", () => {
  it("빈 응답은 빈 v1 payload 다", () => {
    expect(sidebarPrefsFromWire({ prefs: { version: 1 } })).toEqual({
      version: 1,
      sections: [],
      starredChannelIds: [],
    });
  });

  it("서버가 준 것을 그대로 다시 보낼 수 있다", () => {
    const wire = {
      prefs: {
        version: 1,
        sections: [
          {
            id: "sec-1",
            name: "긴급 대응",
            order: 2,
            channelIds: [GENERAL.id],
          },
        ],
        starredChannelIds: [RELEASE.id],
        sectionSort: "manual",
      },
      updatedAtMs: 1_756_000_000_000,
    };
    const parsed = sidebarPrefsFromWire(wire);
    expect(parsed.sections[0].name).toBe("긴급 대응");
    expect(parsed.starredChannelIds).toEqual([RELEASE.id]);
    expect(parsed.sectionSort).toBe("manual");
    // updatedAtMs 는 payload 가 아니다. 되돌려 보내는 몸통에 섞이면 서버의
    // 폐쇄형 디코더가 422 로 거절한다.
    expect(sidebarPrefsToWire(parsed).prefs).toEqual(wire.prefs);
  });

  it("망가진 몸통은 던지지 않고 빈 값이 된다", () => {
    for (const junk of [null, undefined, 42, "nope", { prefs: "nope" }, {}]) {
      expect(sidebarPrefsFromWire(junk).sections).toEqual([]);
    }
    // 이름이나 id 가 없는 섹션은 그릴 수 없으므로 통째로 빠진다.
    expect(
      sidebarPrefsFromWire({
        prefs: { version: 1, sections: [{ id: "", name: "x" }, { id: "y" }] },
      }).sections
    ).toEqual([]);
  });

  it("BT-5 의 별표를 세는 자리는 서버가 세는 자리와 같다", () => {
    const prefs = prefsWith(
      [{ id: "sec-1", name: "가", order: 0, channelIds: [GENERAL.id, RELEASE.id] }],
      { starredChannelIds: [RANDOM.id] }
    );
    expect(sidebarChannelRefCount(prefs)).toBe(3);
  });
});

describe("이름 검증", () => {
  it("빈 이름과 상한 초과를 서버와 같은 수로 잡는다", () => {
    expect(sidebarSectionNameIssue("  ")).toBe("empty");
    expect(sidebarSectionNameIssue("가".repeat(SIDEBAR_SECTION_NAME_MAX))).toBe(
      null
    );
    expect(
      sidebarSectionNameIssue("가".repeat(SIDEBAR_SECTION_NAME_MAX + 1))
    ).toBe("too-long");
  });

  it("상한은 바이트가 아니라 글자다", () => {
    const eighty = "가".repeat(SIDEBAR_SECTION_NAME_MAX);
    expect(eighty.length).toBe(SIDEBAR_SECTION_NAME_MAX);
    // UTF-8 로는 240 바이트. 바이트를 세는 구현이면 여기서 붉어진다.
    expect(new TextEncoder().encode(eighty).length).toBe(240);
    expect(sidebarSectionNameIssue(eighty)).toBe(null);
  });

  it("섹션 50개가 상한이다", () => {
    const full = prefsWith(
      Array.from({ length: SIDEBAR_SECTION_MAX }, (_, i) => ({
        id: `sec-${i + 1}`,
        name: `섹션 ${i + 1}`,
        order: i,
        channelIds: [],
      }))
    );
    expect(canCreateSidebarSection(full)).toBe(false);
    expect(canCreateSidebarSection(deleteSidebarSection(full, "sec-1"))).toBe(
      true
    );
  });
});

describe("파생", () => {
  it("배치가 없으면 오늘과 같은 두 섹션이다", () => {
    const rendered = deriveSidebarSections({
      prefs: emptySidebarPrefs(),
      channels: [GENERAL, RELEASE],
      dms: [DM_ONE],
    });
    expect(rendered.map((s) => s.id)).toEqual([
      BASE_CHANNELS_SECTION_ID,
      BASE_DMS_SECTION_ID,
    ]);
    expect(rendered[0].channels).toEqual([GENERAL, RELEASE]);
    expect(rendered[1].channels).toEqual([DM_ONE]);
  });

  it("커스텀 섹션은 기본 채널과 DM 사이에 선다", () => {
    const prefs = prefsWith([
      { id: "sec-1", name: "출시 준비", order: 0, channelIds: [RELEASE.id] },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [GENERAL, RELEASE],
      dms: [DM_ONE],
    });
    expect(rendered.map((s) => s.id)).toEqual([
      BASE_CHANNELS_SECTION_ID,
      "sec-1",
      BASE_DMS_SECTION_ID,
    ]);
    // 배치된 채널은 기본 섹션에서 빠진다. 두 번 그리면 사람은 채널이 둘인 줄 안다.
    expect(rendered[0].channels).toEqual([GENERAL]);
    expect(rendered[1].channels).toEqual([RELEASE]);
  });

  it("`order` 가 커스텀 섹션의 차례를 정한다", () => {
    const prefs = prefsWith([
      { id: "b", name: "나중", order: 9, channelIds: [] },
      { id: "a", name: "먼저", order: 1, channelIds: [] },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [],
      dms: [],
    });
    expect(rendered.map((s) => s.id)).toEqual([
      BASE_CHANNELS_SECTION_ID,
      "a",
      "b",
      BASE_DMS_SECTION_ID,
    ]);
  });

  // ADR-0177 D3 의 관용 계약이 클라에 남기는 일. 서버는 죽은 id 를 저장하므로
  // 거르는 자리는 여기 하나뿐이다.
  it("죽은 채널 id 는 없는 것처럼 그리되 payload 에서 지우지 않는다", () => {
    const prefs = prefsWith([
      {
        id: "sec-1",
        name: "지난 분기",
        order: 0,
        channelIds: [DEAD, RELEASE.id, DEAD],
      },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [GENERAL, RELEASE],
      dms: [],
    });
    expect(rendered[1].channels).toEqual([RELEASE]);
    // 채널 목록을 잠깐 못 받아온 것과 채널이 사라진 것은 구분되지 않는다.
    // 그러니 배치는 살려 둔다 - 채널이 돌아오면 배치도 함께 돌아온다.
    expect(prefs.sections[0].channelIds).toContain(DEAD);
    const back = deriveSidebarSections({
      prefs,
      channels: [GENERAL, RELEASE, channel(DEAD, "돌아온 채널")],
      dms: [],
    });
    expect(back[1].channels.map((c) => c.id)).toEqual([DEAD, RELEASE.id]);
  });

  it("살아 있는 채널이 하나도 안 도착한 동안에는 섹션이 비어 보이고 사라지지 않는다", () => {
    const prefs = prefsWith([
      { id: "sec-1", name: "출시 준비", order: 0, channelIds: [RELEASE.id] },
    ]);
    const rendered = deriveSidebarSections({ prefs, channels: [], dms: [] });
    expect(rendered.map((s) => s.id)).toContain("sec-1");
    expect(rendered[1].channels).toEqual([]);
  });

  it("두 섹션이 같은 채널을 주장하면 앞선 섹션이 갖는다", () => {
    const prefs = prefsWith([
      { id: "second", name: "둘째", order: 5, channelIds: [GENERAL.id] },
      { id: "first", name: "첫째", order: 1, channelIds: [GENERAL.id] },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [GENERAL],
      dms: [],
    });
    const holders = rendered.filter((s) =>
      s.channels.some((c) => c.id === GENERAL.id)
    );
    expect(holders.map((s) => s.id)).toEqual(["first"]);
  });

  it("DM 은 커스텀 섹션이 주장해도 DM 섹션에 남는다", () => {
    const prefs = prefsWith([
      { id: "sec-1", name: "사람들", order: 0, channelIds: [DM_ONE.id] },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [GENERAL],
      dms: [DM_ONE],
    });
    expect(rendered[1].channels).toEqual([]);
    expect(rendered[2].channels).toEqual([DM_ONE]);
  });

  it("채널 id 의 대소문자는 배치를 가르지 않는다", () => {
    const prefs = prefsWith([
      {
        id: "sec-1",
        name: "대문자",
        order: 0,
        channelIds: [GENERAL.id.toUpperCase()],
      },
    ]);
    const rendered = deriveSidebarSections({
      prefs,
      channels: [GENERAL],
      dms: [],
    });
    expect(rendered[1].channels).toEqual([GENERAL]);
    expect(sectionIdForChannel(prefs, GENERAL.id)).toBe("sec-1");
  });
});

describe("변경", () => {
  it("만들고, 이름을 바꾸고, 지운다", () => {
    let prefs = createSidebarSection(emptySidebarPrefs(), "  출시 준비  ");
    expect(prefs.sections).toHaveLength(1);
    expect(prefs.sections[0].id).toBe("sec-1");
    expect(prefs.sections[0].name).toBe("출시 준비");

    prefs = createSidebarSection(prefs, "읽은 것");
    expect(prefs.sections.map((s) => s.id)).toEqual(["sec-1", "sec-2"]);
    expect(prefs.sections[1].order).toBe(1);

    prefs = renameSidebarSection(prefs, "sec-1", " 출시 ");
    expect(prefs.sections[0].name).toBe("출시");

    prefs = deleteSidebarSection(prefs, "sec-1");
    expect(prefs.sections.map((s) => s.id)).toEqual(["sec-2"]);
    // 다음 id 는 살아 있는 최대치 다음이라 지운 id 를 되쓰지 않는다.
    expect(nextSidebarSectionId(prefs)).toBe("sec-3");
  });

  it("섹션을 지우면 그 채널은 기본 섹션으로 돌아온다", () => {
    const prefs = placeChannelInSection(
      createSidebarSection(emptySidebarPrefs(), "출시 준비"),
      RELEASE.id,
      "sec-1"
    );
    const after = deleteSidebarSection(prefs, "sec-1");
    const rendered = deriveSidebarSections({
      prefs: after,
      channels: [GENERAL, RELEASE],
      dms: [],
    });
    expect(rendered).toHaveLength(2);
    expect(rendered[0].channels).toEqual([GENERAL, RELEASE]);
  });

  it("옮기기는 복사가 아니다", () => {
    let prefs = createSidebarSection(emptySidebarPrefs(), "가");
    prefs = createSidebarSection(prefs, "나");
    prefs = placeChannelInSection(prefs, GENERAL.id, "sec-1");
    expect(sectionIdForChannel(prefs, GENERAL.id)).toBe("sec-1");

    prefs = placeChannelInSection(prefs, GENERAL.id, "sec-2");
    expect(prefs.sections[0].channelIds).toEqual([]);
    expect(prefs.sections[1].channelIds).toEqual([GENERAL.id]);
    expect(sectionIdForChannel(prefs, GENERAL.id)).toBe("sec-2");
  });

  it("null 로 옮기면 배치가 풀린다", () => {
    const placed = placeChannelInSection(
      createSidebarSection(emptySidebarPrefs(), "가"),
      GENERAL.id,
      "sec-1"
    );
    const released = placeChannelInSection(placed, GENERAL.id, null);
    expect(sectionIdForChannel(released, GENERAL.id)).toBe(null);
    expect(
      deriveSidebarSections({
        prefs: released,
        channels: [GENERAL],
        dms: [],
      })[0].channels
    ).toEqual([GENERAL]);
  });

  it("입력 payload 를 건드리지 않는다", () => {
    const before = createSidebarSection(emptySidebarPrefs(), "가");
    const snapshot = JSON.stringify(before);
    placeChannelInSection(before, GENERAL.id, "sec-1");
    renameSidebarSection(before, "sec-1", "나");
    deleteSidebarSection(before, "sec-1");
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

// 여러 섹션 + 긴 한글 이름 + 죽은 id 를 한 payload 에 몰아 넣어, 짧은 픽스처가
// 가려 줄 규칙이 없게 한다.
describe("실전 크기 payload", () => {
  it("여덟 섹션이 순서와 소속을 지킨다", () => {
    const channels = Array.from({ length: 24 }, (_, i) =>
      channel(
        `${String(i + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
        `채널 ${i + 1}`
      )
    );
    let prefs = emptySidebarPrefs();
    for (let s = 0; s < 8; s += 1) {
      prefs = createSidebarSection(
        prefs,
        `${"긴급대응".repeat(19)}${s}` // 76자 + 한 자리 = 77자
      );
    }
    for (let i = 0; i < 16; i += 1) {
      prefs = placeChannelInSection(
        prefs,
        channels[i].id,
        `sec-${(i % 8) + 1}`
      );
    }
    prefs = placeChannelInSection(prefs, DEAD, "sec-3");

    const rendered = deriveSidebarSections({ prefs, channels, dms: [DM_ONE] });
    expect(rendered).toHaveLength(10);
    expect(rendered[0].id).toBe(BASE_CHANNELS_SECTION_ID);
    // 배치되지 않은 여덟 개만 기본 섹션에 남는다.
    expect(rendered[0].channels).toHaveLength(8);
    for (let s = 0; s < 8; s += 1) {
      expect(rendered[s + 1].id).toBe(`sec-${s + 1}`);
      expect(rendered[s + 1].channels).toHaveLength(2);
      expect([...rendered[s + 1].title].length).toBe(77);
    }
    // 죽은 id 는 세 번째 섹션의 개수를 늘리지 않았다.
    expect(rendered[3].channels.map((c) => c.id)).not.toContain(DEAD);
    expect(rendered[9].id).toBe(BASE_DMS_SECTION_ID);

    // 한 채널이 두 번 그려지지 않는다.
    const drawn = rendered.flatMap((s) => s.channels.map((c) => c.id));
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn).toHaveLength(channels.length + 1);
  });
});
