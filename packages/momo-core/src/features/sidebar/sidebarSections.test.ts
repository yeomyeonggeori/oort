import { describe, expect, it } from "vitest";
import type { Channel } from "../../lib/api";
import {
  BASE_CHANNELS_SECTION_ID,
  BASE_DMS_SECTION_ID,
  BASE_STARRED_SECTION_ID,
  canCreateSidebarSection,
  canMoveSidebarSection,
  channelStarToggleLabel,
  isChannelStarred,
  moveSidebarSection,
  reorderSidebarSection,
  sidebarSortMode,
  sidebarSortModeLabel,
  toggleStarredChannel,
  withSidebarSortMode,
  SIDEBAR_SORT_ALPHA,
  SIDEBAR_SORT_MANUAL,
  SIDEBAR_SORT_MODES,
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
  sectionDeleteConfirmBody,
  SECTION_DELETE_CONFIRM_TITLE,
  sidebarChannelRefCapMessage,
  sidebarEmptySectionHint,
  sidebarSectionCapMessage,
  sidebarSectionNameIssue,
  SIDEBAR_CHANNEL_REF_MAX,
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
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
      prefs,
      channels: [GENERAL, RELEASE],
      dms: [],
    });
    expect(rendered[1].channels).toEqual([RELEASE]);
    // 채널 목록을 잠깐 못 받아온 것과 채널이 사라진 것은 구분되지 않는다.
    // 그러니 배치는 살려 둔다 - 채널이 돌아오면 배치도 함께 돌아온다.
    expect(prefs.sections[0].channelIds).toContain(DEAD);
    const { sections: back } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({ prefs, channels: [], dms: [] });
    expect(rendered.map((s) => s.id)).toContain("sec-1");
    expect(rendered[1].channels).toEqual([]);
  });

  it("두 섹션이 같은 채널을 주장하면 앞선 섹션이 갖는다", () => {
    const prefs = prefsWith([
      { id: "second", name: "둘째", order: 5, channelIds: [GENERAL.id] },
      { id: "first", name: "첫째", order: 1, channelIds: [GENERAL.id] },
    ]);
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
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
    const { sections: rendered } = deriveSidebarSections({
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
      }).base.channels
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

    const { sections: rendered } = deriveSidebarSections({ prefs, channels, dms: [DM_ONE] });
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

// =============================================================================
// design-review #1932 R1 — 낱말의 계약
// =============================================================================

describe("낱말", () => {
  // M-1: 제목은 고정, 이름은 본문. 80자 이름이 제목에 들어가면 물음이 셋째 줄
  // 끝에 도착한다 — `ChannelLeaveConfirmDialog` 가 정확히 그 이유로 이렇게 한다.
  it("삭제 확인의 제목은 이름을 담지 않는다", () => {
    const long = "긴급대응".repeat(20);
    expect(SECTION_DELETE_CONFIRM_TITLE).not.toContain(long);
    expect([...SECTION_DELETE_CONFIRM_TITLE].length).toBeLessThan(20);
    // 그리고 본문이 이름과 **무엇이 사라지지 않는지**를 함께 진다.
    const body = sectionDeleteConfirmBody(long);
    expect(body).toContain(long);
    expect(body).toContain("채널 섹션으로 돌아가고");
    expect(body).toContain("나가지는 않습니다");
  });

  // M-3: 상한 셋 중 둘이 말이 없었다. 이제 셋 다 자기 수를 든다.
  it("상한 문장이 자기 수를 든다", () => {
    expect(sidebarSectionCapMessage()).toContain(String(SIDEBAR_SECTION_MAX));
    expect(sidebarChannelRefCapMessage()).toContain(
      String(SIDEBAR_CHANNEL_REF_MAX)
    );
  });

  // H-1: 터치에는 우클릭이 없다(BT-1 이 hover:none 에서 행 메뉴를 닫아 두었다).
  it("빈 섹션 문장이 표면마다 다르고, 없는 동작을 지시하지 않는다", () => {
    expect(sidebarEmptySectionHint(true)).toContain("우클릭");
    expect(sidebarEmptySectionHint(false)).not.toContain("우클릭");
    expect(sidebarEmptySectionHint(false)).not.toBe(
      sidebarEmptySectionHint(true)
    );
  });
});

// =============================================================================
// BT-5(#1933) — 별표 · 정렬 · 섹션 차례.
//
// 픽스처는 얕은 구현에 적대적이다: 별표를 여럿 걸고, 그중 하나는 커스텀 섹션이
// 이미 주장하고 있고, 하나는 죽은 id 이며, 이름은 정렬이 갈리는 조합(한글·라틴·
// 대소문자)으로 고른다.
// =============================================================================

const ALPHA = channel("55555555-5555-4555-8555-555555555555", "zebra");
const BETA = channel("66666666-6666-4666-8666-666666666666", "가나다");
const GAMMA = channel("77777777-7777-4777-8777-777777777777", "Apple");

describe("BT-5 별표", () => {
  it("붙였다 떼면 payload 가 정확히 제자리로 돌아온다", () => {
    const base = prefsWith([
      { id: "sec-1", name: "출시 준비", order: 0, channelIds: [RELEASE.id] },
    ]);
    const starred = toggleStarredChannel(base, RELEASE.id);
    expect(starred.starredChannelIds).toEqual([RELEASE.id]);
    // **배치는 그대로다.** 별표는 표식이지 이사가 아니다.
    expect(starred.sections[0].channelIds).toEqual([RELEASE.id]);
    expect(isChannelStarred(starred, RELEASE.id)).toBe(true);

    const unstarred = toggleStarredChannel(starred, RELEASE.id);
    expect(unstarred.starredChannelIds).toEqual([]);
    expect(unstarred).toEqual(base);
  });

  it("파생 섹션이 맨 위에 서고, 비면 목록에서 사라진다", () => {
    const none = deriveSidebarSections({
      prefs: emptySidebarPrefs(),
      channels: [GENERAL, RELEASE],
      dms: [],
    });
    expect(none.sections.map((s) => s.id)).toEqual([
      BASE_CHANNELS_SECTION_ID,
      BASE_DMS_SECTION_ID,
    ]);
    // 그릇 자체는 있다 — 표면이 「빈 섹션인가」를 다시 묻지 않아도 되도록.
    expect(none.starred.channels).toEqual([]);

    const some = deriveSidebarSections({
      prefs: prefsWith([], { starredChannelIds: [RELEASE.id] }),
      channels: [GENERAL, RELEASE],
      dms: [],
    });
    expect(some.sections.map((s) => s.id)).toEqual([
      BASE_STARRED_SECTION_ID,
      BASE_CHANNELS_SECTION_ID,
      BASE_DMS_SECTION_ID,
    ]);
    expect(some.sections[0].kind).toBe("starred");
  });

  it("별표가 먼저 가져가므로 한 채널이 두 번 그려지지 않는다", () => {
    const derived = deriveSidebarSections({
      prefs: prefsWith(
        [
          {
            id: "sec-1",
            name: "출시 준비",
            order: 0,
            channelIds: [RELEASE.id, RANDOM.id],
          },
        ],
        { starredChannelIds: [RELEASE.id, GENERAL.id, DEAD] }
      ),
      channels: [GENERAL, RELEASE, RANDOM],
      dms: [DM_ONE],
    });
    expect(derived.starred.channels.map((c) => c.id)).toEqual([
      RELEASE.id,
      GENERAL.id,
    ]);
    // 커스텀 섹션은 별표가 가져간 것을 잃고, 기본 「채널」에도 남지 않는다.
    expect(derived.custom[0].channels.map((c) => c.id)).toEqual([RANDOM.id]);
    expect(derived.base.channels).toEqual([]);
    const rendered = derived.sections.flatMap((s) => s.channels.map((c) => c.id));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("DM 은 별표 섹션으로 올라오지 않는다", () => {
    const derived = deriveSidebarSections({
      prefs: prefsWith([], { starredChannelIds: [DM_ONE.id] }),
      channels: [GENERAL],
      dms: [DM_ONE],
    });
    expect(derived.starred.channels).toEqual([]);
    expect(derived.dms.channels.map((c) => c.id)).toEqual([DM_ONE.id]);
  });

  it("별표도 채널 참조 상한에 함께 세어진다", () => {
    const prefs = prefsWith(
      [{ id: "sec-1", name: "가", order: 0, channelIds: [GENERAL.id] }],
      { starredChannelIds: [RELEASE.id, RANDOM.id] }
    );
    expect(sidebarChannelRefCount(prefs)).toBe(3);
  });

  it("낱말이 상태다", () => {
    expect(channelStarToggleLabel(false)).not.toBe(channelStarToggleLabel(true));
    expect(channelStarToggleLabel(true)).toContain("별표");
  });
});

describe("BT-5 정렬", () => {
  const CHANNELS = [ALPHA, BETA, GAMMA];

  it("두 값뿐이다 — Recent 는 자가 없어서 싣지 않았다", () => {
    // ADR-0177 D5 는 「A-Z/Recent」라 적었다. 축소의 근거는 `SIDEBAR_SORT_MODES`
    // 머리말에 있고(oort 의 `Channel` 에 마지막 활동 시각이 없다), 이 단정이
    // 그 판정을 잠근다 — 값을 늘리려면 근거를 먼저 고쳐야 한다.
    expect([...SIDEBAR_SORT_MODES]).toEqual([
      SIDEBAR_SORT_MANUAL,
      SIDEBAR_SORT_ALPHA,
    ]);
    expect(sidebarSortModeLabel(SIDEBAR_SORT_ALPHA)).toBe("가나다");
    expect(sidebarSortModeLabel(SIDEBAR_SORT_MANUAL)).toBe("사용자 지정");
  });

  it("모르는 낱말은 「사용자 지정」이다", () => {
    expect(sidebarSortMode(emptySidebarPrefs())).toBe(SIDEBAR_SORT_MANUAL);
    expect(
      sidebarSortMode({ ...emptySidebarPrefs(), sectionSort: "recent" })
    ).toBe(SIDEBAR_SORT_MANUAL);
  });

  it("「사용자 지정」은 칸을 지우고, 「가나다」만 적는다", () => {
    const alpha = withSidebarSortMode(emptySidebarPrefs(), SIDEBAR_SORT_ALPHA);
    expect(alpha.sectionSort).toBe(SIDEBAR_SORT_ALPHA);
    const manual = withSidebarSortMode(alpha, SIDEBAR_SORT_MANUAL);
    expect("sectionSort" in manual).toBe(false);
    expect(sidebarPrefsToWire(manual).prefs.sectionSort).toBeUndefined();
  });

  it("렌더 차례만 바꾸고 저장값은 그대로다", () => {
    const manual = prefsWith(
      [
        {
          id: "sec-1",
          name: "출시 준비",
          order: 0,
          channelIds: [ALPHA.id, BETA.id, GAMMA.id],
        },
      ],
      { starredChannelIds: [] }
    );
    const before = deriveSidebarSections({
      prefs: manual,
      channels: CHANNELS,
      dms: [],
    });
    expect(before.custom[0].channels.map((c) => c.name)).toEqual([
      "zebra",
      "가나다",
      "Apple",
    ]);

    const alpha = withSidebarSortMode(manual, SIDEBAR_SORT_ALPHA);
    const sorted = deriveSidebarSections({
      prefs: alpha,
      channels: CHANNELS,
      dms: [],
    });
    // 한글이 앞이다 — `localeCompare(…, "ko")` 의 collation 이고, 그래서 이
    // 항목의 이름이 「A-Z」가 아니라 「가나다」다. 코드유닛 비교였다면 라틴이
    // 먼저 서서 이름과 결과가 어긋났을 것이다.
    expect(sorted.custom[0].channels.map((c) => c.name)).toEqual([
      "가나다",
      "Apple",
      "zebra",
    ]);
    // **저장값 불변**: 사람이 만든 차례는 payload 에 그대로 있다.
    expect(alpha.sections[0].channelIds).toEqual([ALPHA.id, BETA.id, GAMMA.id]);

    // 되돌아오면 그 차례가 다시 화면이다.
    const back = deriveSidebarSections({
      prefs: withSidebarSortMode(alpha, SIDEBAR_SORT_MANUAL),
      channels: CHANNELS,
      dms: [],
    });
    expect(back.custom[0].channels.map((c) => c.name)).toEqual([
      "zebra",
      "가나다",
      "Apple",
    ]);
  });

  it("기본 「채널」과 「별표」도 같은 자를 쓰고, DM 은 서버 차례 그대로다", () => {
    const prefs = withSidebarSortMode(
      prefsWith([], { starredChannelIds: [ALPHA.id, GAMMA.id] }),
      SIDEBAR_SORT_ALPHA
    );
    const derived = deriveSidebarSections({
      prefs,
      channels: CHANNELS,
      dms: [DM_ONE, dm("88888888-8888-4888-8888-888888888888")],
    });
    expect(derived.starred.channels.map((c) => c.name)).toEqual([
      "Apple",
      "zebra",
    ]);
    expect(derived.base.channels.map((c) => c.name)).toEqual(["가나다"]);
    expect(derived.dms.channels.map((c) => c.id)).toEqual([
      DM_ONE.id,
      "88888888-8888-4888-8888-888888888888",
    ]);
  });
});

describe("BT-5 섹션 차례", () => {
  const THREE = prefsWith([
    { id: "sec-1", name: "가", order: 0, channelIds: [] },
    { id: "sec-2", name: "나", order: 1, channelIds: [] },
    { id: "sec-3", name: "다", order: 2, channelIds: [] },
  ]);

  function order(prefs: SidebarPrefs): string[] {
    return deriveSidebarSections({ prefs, channels: [], dms: [] }).custom.map(
      (s) => s.id
    );
  }

  it("위/아래 한 칸이 차례를 바꾸고 order 를 0부터 다시 매긴다", () => {
    const down = moveSidebarSection(THREE, "sec-1", 1);
    expect(order(down)).toEqual(["sec-2", "sec-1", "sec-3"]);
    expect(down.sections.map((s) => s.order).sort()).toEqual([0, 1, 2]);
    const up = moveSidebarSection(down, "sec-1", -1);
    expect(order(up)).toEqual(["sec-1", "sec-2", "sec-3"]);
  });

  it("끝에서는 갈 곳이 없고, 그 사실을 미리 말한다", () => {
    expect(canMoveSidebarSection(THREE, "sec-1", -1)).toBe(false);
    expect(canMoveSidebarSection(THREE, "sec-1", 1)).toBe(true);
    expect(canMoveSidebarSection(THREE, "sec-3", 1)).toBe(false);
    expect(canMoveSidebarSection(THREE, "없는-섹션", 1)).toBe(false);
    expect(moveSidebarSection(THREE, "sec-1", -1)).toEqual(THREE);
  });

  it("드롭은 상대 자리로 옮기고, 메뉴와 같은 결과에 닿는다", () => {
    // 끌어다 놓기: sec-3 을 sec-1 자리로.
    const dropped = reorderSidebarSection(THREE, "sec-3", "sec-1");
    expect(order(dropped)).toEqual(["sec-3", "sec-1", "sec-2"]);
    // 키보드: 「위로」 두 번. **같은 payload 에 닿아야 한다.**
    const byMenu = moveSidebarSection(
      moveSidebarSection(THREE, "sec-3", -1),
      "sec-3",
      -1
    );
    expect(order(byMenu)).toEqual(order(dropped));
    expect(byMenu.sections).toEqual(dropped.sections);
  });

  it("자기 자신 위로 떨어뜨리는 것은 아무 일도 아니다", () => {
    expect(reorderSidebarSection(THREE, "sec-2", "sec-2")).toEqual(THREE);
    expect(reorderSidebarSection(THREE, "sec-2", "없는-섹션")).toEqual(THREE);
  });

  it("상한(50) 경계에서도 차례가 흔들리지 않는다", () => {
    let prefs = emptySidebarPrefs();
    for (let i = 0; i < SIDEBAR_SECTION_MAX; i += 1) {
      prefs = createSidebarSection(prefs, `섹션 ${i}`);
    }
    expect(canCreateSidebarSection(prefs)).toBe(false);
    const last = `sec-${SIDEBAR_SECTION_MAX}`;
    const moved = reorderSidebarSection(prefs, last, "sec-1");
    expect(order(moved)[0]).toBe(last);
    expect(moved.sections).toHaveLength(SIDEBAR_SECTION_MAX);
    expect(moved.sections.map((s) => s.order).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SIDEBAR_SECTION_MAX }, (_, i) => i)
    );
  });
});
