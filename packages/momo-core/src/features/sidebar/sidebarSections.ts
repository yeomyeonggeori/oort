// =============================================================================
// 사이드바 섹션 — 멤버 소유 조직화의 파생 단일점 (ADR-0177 / BT-4 #1932).
//
// 와이어 계약: `docs/api/openapi.yaml` 의 `members/me/sidebar-prefs`(GET/PUT),
// `server-rust/bins/momo-server/src/routes/sidebar_prefs.rs`,
// `server/Migrations/084_member_sidebar_prefs.sql`.
//
// ## 왜 코어인가
//
// 사이드바는 웹과 폰 둘 다 그린다. 그런데 「이 채널이 어느 섹션에 속하는가」는
// 렌더가 아니라 **판정**이다: 죽은 채널 id 를 거르고, 두 섹션이 같은 채널을
// 주장하면 하나를 고르고, 아무 데도 배치되지 않은 채널을 기본 섹션에 귀속시킨다.
// 그 판정이 두 클라에 각각 있으면 같은 payload 가 기기마다 다른 사이드바를
// 그리고, 그것은 로밍을 하는 이유 자체를 없앤다(ADR-0177 D4 「파생 계산은
// momo-core 단일점 함수로」).
//
// 표면이 갖는 것은 그릇뿐이다. 이 파일은 React 도 DOM 도 fetch 도 모른다.
//
// ## 관용의 방향
//
// 서버는 형식·크기 상한만 보고 **채널 membership 은 보지 않는다**(D3). 그래서
// payload 에는 탈퇴·삭제된 채널 id 가 남아 있는 것이 정상이다. 거르는 자리는
// 여기 한 곳이고, 규칙은 하나다: **살아 있는 채널 목록에 없는 id 는 없는 것처럼
// 다룬다.** 지우지는 않는다 — 잠깐 못 받아온 채널 목록 때문에 사람이 만든 배치를
// 영구히 버리는 것이 훨씬 나쁘다. payload 는 다음 저장 때까지 그대로 살아 있고,
// 채널이 돌아오면 배치도 함께 돌아온다.
//
// ## 접기는 여기 없다
//
// ADR-0177 D4: 접힘은 기기 성향이라 클라 localStorage 가 정본이고, 구조만
// 로밍한다. `payload` 에 접힘을 넣지 말 것.
//
// ## 미해결 갈림 — 기본 섹션이 웹은 둘, 폰은 셋이다 (design-review #1932 M-2)
//
// 아래 `deriveSidebarSections` 는 기본 섹션을 「채널」·「DM」 **둘**로 못박는다.
// ADR-0177 D4 가 적은 것이 그 둘이기 때문이다. 그런데 폰은 이미
// `clients/mobile/src/features/sidebar/rows.ts` 에서 **셋**을 출하하고 있다 —
// 「채널 / 다이렉트 메시지 / 에이전트」. 에이전트 섹션은 그 파일이 자기 몫이라고
// 방어까지 해 둔 결정이고, 이 티켓(BT-4)의 범위는 웹이라 폰은 아직 이 함수를
// 소비하지 않는다. 그래서 **오늘은 결함이 아니다.**
//
// 이름을 붙여 두는 이유는 이 함수를 폰이 소비하는 날 갈라지기 때문이다: 지금
// 모양 그대로 소비하면 에이전트 섹션이 계약 밖으로 밀리고, 그러면 두 클라가 같은
// payload 에서 다른 사이드바를 그린다 — 이 파일 머리말이 스스로 「로밍을 하는
// 이유 자체를 없앤다」고 적은 그 실패다.
//
// **이 티켓은 동작을 바꾸지 않는다.** 고르는 것은 폰 티켓(또는 BT-5)의 일이고,
// 갈래는 셋이다: ①기본 섹션 목록을 입력으로 받는다(호출부가 자기 표면의 기본
// 섹션을 넘긴다) ②에이전트를 세 번째 기본 섹션으로 계약에 올린다(웹도 그리게
// 된다 — 웹은 에이전트를 전역 목적지 행으로 이미 갖고 있어 중복이다) ③폰이 이
// 함수를 커스텀 섹션에만 쓰고 기본 셋은 자기가 계속 조립한다. 각자 다시
// 판정하지 말고 이 문단을 근거로 한 번에 결정할 것.
// =============================================================================

import { record, num, str, stringArrayField } from "../../lib/wire";
import type { Channel } from "../../lib/api";

// ---------------------------------------------------------------------------
// 계약 (서버 084 / routes/sidebar_prefs.rs 와 같은 수)
// ---------------------------------------------------------------------------

export const SIDEBAR_PREFS_VERSION = 1;
/** ADR-0177 D3. 서버가 51번째를 400 으로 돌려보낸다. */
export const SIDEBAR_SECTION_MAX = 50;
/** ADR-0177 D3. 바이트가 아니라 **글자** 수다. */
export const SIDEBAR_SECTION_NAME_MAX = 80;
/** ADR-0177 D3. 페이로드 전체 합(모든 섹션의 channelIds + 별표). */
export const SIDEBAR_CHANNEL_REF_MAX = 500;

// ---------------------------------------------------------------------------
// payload
// ---------------------------------------------------------------------------

export interface SidebarSectionPrefs {
  id: string;
  name: string;
  order: number;
  channelIds: string[];
}

export interface SidebarPrefs {
  version: number;
  sections: SidebarSectionPrefs[];
  /** BT-5(#1933)가 쓸 자리. BT-4 는 받아서 그대로 돌려보낸다(ADR-0177 D5). */
  starredChannelIds: string[];
  /** BT-5 의 A-Z / 최근 정렬. 값은 BT-5 가 정한다. */
  sectionSort?: string;
}

export const EMPTY_SIDEBAR_PREFS: SidebarPrefs = {
  version: SIDEBAR_PREFS_VERSION,
  sections: [],
  starredChannelIds: [],
};

/** 아직 저장한 적 없는 멤버가 읽는 값. 서버 GET 도 이것을 돌려준다. */
export function emptySidebarPrefs(): SidebarPrefs {
  return { ...EMPTY_SIDEBAR_PREFS, sections: [], starredChannelIds: [] };
}

/**
 * 와이어 → payload. **던지지 않는다.**
 *
 * 이 라우트는 새것이라 프록시나 구 서버가 200 에 다른 몸통을 실을 수 있고,
 * 그때 렌더 안에서 예외가 나면 사이드바 전체가 죽는다. 못 읽은 것은 빈 기본값과
 * 같게 다룬다 - 사람이 보는 것은 「섹션이 아직 없다」이고, 그것은 회복 가능한
 * 상태다(`chainModel.ts` 가 같은 판정을 한다).
 */
export function sidebarPrefsFromWire(value: unknown): SidebarPrefs {
  const envelope = record(value) ?? {};
  const body = record(envelope.prefs) ?? {};
  const rawSections = Array.isArray(body.sections) ? body.sections : [];
  const sections: SidebarSectionPrefs[] = [];
  for (const raw of rawSections) {
    const item = record(raw);
    if (!item) continue;
    const id = str(item, "id")?.trim() ?? "";
    const name = str(item, "name")?.trim() ?? "";
    if (id === "" || name === "") continue;
    sections.push({
      id,
      name,
      order: num(item, "order") ?? sections.length,
      channelIds: stringArrayField(item, "channelIds") ?? [],
    });
  }
  const sectionSort = str(body, "sectionSort")?.trim();
  return {
    version: num(body, "version") ?? SIDEBAR_PREFS_VERSION,
    sections,
    starredChannelIds: stringArrayField(body, "starredChannelIds") ?? [],
    ...(sectionSort !== undefined && sectionSort !== ""
      ? { sectionSort }
      : {}),
  };
}

/**
 * payload → PUT 몸통. 버전은 **언제나 이 클라의 것**을 적는다: 읽을 때는 서버가
 * 준 수를 관용적으로 받았지만, 쓸 때는 자기가 이해하는 모양만 쓴다.
 */
export function sidebarPrefsToWire(prefs: SidebarPrefs): {
  prefs: SidebarPrefs;
} {
  return {
    prefs: {
      version: SIDEBAR_PREFS_VERSION,
      sections: prefs.sections.map((section) => ({
        id: section.id,
        name: section.name,
        order: section.order,
        channelIds: [...section.channelIds],
      })),
      starredChannelIds: [...prefs.starredChannelIds],
      ...(prefs.sectionSort !== undefined
        ? { sectionSort: prefs.sectionSort }
        : {}),
    },
  };
}

/** 서버가 세는 그 수. 저장 전에 여기서 먼저 세어 400 을 왕복 없이 막는다. */
export function sidebarChannelRefCount(prefs: SidebarPrefs): number {
  return prefs.sections.reduce(
    (total, section) => total + section.channelIds.length,
    prefs.starredChannelIds.length
  );
}

// ---------------------------------------------------------------------------
// 낱말
// ---------------------------------------------------------------------------

/** 기본 섹션 두 종. 삭제도 이름변경도 되지 않는다(ADR-0177 D4). */
export const BASE_CHANNELS_SECTION_ID = "channels";
export const BASE_DMS_SECTION_ID = "dms";
export const BASE_CHANNELS_SECTION_TITLE = "채널";
export const BASE_DMS_SECTION_TITLE = "다이렉트 메시지";

export const SECTION_CREATE_TITLE = "새 섹션 만들기";
export const SECTION_RENAME_LABEL = "이름 바꾸기";
export const SECTION_RENAME_TITLE = "섹션 이름 바꾸기";
export const SECTION_DELETE_LABEL = "섹션 삭제";
export const SECTION_NAME_FIELD_LABEL = "섹션 이름";
export const SECTION_NAME_PLACEHOLDER = "예: 출시 준비";
export const SECTION_DELETE_CONFIRM_LABEL = "삭제";

/**
 * 삭제 확인의 **제목은 고정 문장**이고 이름은 본문이 진다.
 *
 * design-review #1932 M-1: 처음에는 제목이 `${name} 섹션을 삭제할까요?` 였고,
 * 80자(상한) 한글 이름에서 제목이 세 줄이 되며 정작 물음이 셋째 줄 끝에
 * 도착했다. 이 파일이 문법을 빌려 왔다고 적은 `ChannelLeaveConfirmDialog` 가
 * 반대로 한다 — 제목은 `CHANNEL_LEAVE_CONFIRM_TITLE` 고정, 가변 이름은
 * `channelLeaveConfirmBody` 가 진다. 같은 자리에 같은 규칙을 쓴다.
 */
export const SECTION_DELETE_CONFIRM_TITLE = "이 섹션을 삭제할까요?";

/** 삭제는 채널을 지우지 않는다. 그 사실을 확인 자리에서 말해야 한다. */
export function sectionDeleteConfirmBody(name: string): string {
  return `${name} 섹션이 사이드바에서 사라집니다. 이 섹션의 채널은 채널 섹션으로 돌아가고, 채널에서 나가지는 않습니다.`;
}

/** 행 메뉴의 배치 무리 이름. */
export const SECTION_MOVE_GROUP_LABEL = "섹션으로 이동";

/**
 * 빈 섹션이 하는 말 — **표면마다 다르다** (design-review #1932 H-1).
 *
 * 하나뿐이던 문장은 "채널 행을 우클릭해…" 였고, 그 동작은 터치 표면에 존재하지
 * 않는다(BT-1 이 서랍 스크롤과의 충돌 때문에 행 컨텍스트 메뉴를 `hover: none`
 * 에서 의도적으로 닫아 두었다). 화면이 없는 동작을 지시하고 있었다.
 *
 * 두 문장인 이유는 두 표면이 실제로 다른 것을 가졌기 때문이다. 낱말을 흐려서
 * 하나로 만드는 길도 있었지만, 그러면 포인터 쪽이 **어떻게** 옮기는지를 잃는다.
 */
export function sidebarEmptySectionHint(pointerCanHover: boolean): string {
  return pointerCanHover
    ? "채널 행을 우클릭해 이 섹션으로 옮길 수 있습니다."
    : "이 섹션은 비어 있습니다. 채널은 넓은 화면에서 옮길 수 있습니다.";
}
/** 배치를 풀고 기본 섹션으로 되돌리는 항목. */
export const SECTION_MOVE_TO_BASE_LABEL = "채널 섹션으로";

export const SIDEBAR_PREFS_SAVE_FAILURE =
  "섹션 변경을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/**
 * 부트스트랩 GET 이 실패했을 때 (design-review #1932 B-1).
 *
 * 이 문장이 없던 동안 화면은 「섹션이 아직 없다」와 「배치를 못 읽었다」를 똑같이
 * 그렸고, PUT 이 통째 교체라서 그 상태의 편집 하나가 다른 기기에서 만든 섹션
 * 전부를 지웠다. **빈 값과 「모른다」는 같은 것이 아니다** — 문장이 그 둘을 가른다.
 */
//
// 한 문장이고 짧다. 이 배너는 240px 사이드바 열 **안**에 서고 그 안에서 다시
// 「다시 시도」와 폭을 나눈다 - 두 문장짜리 첫 판은 실캡처에서 한 줄에 한 낱말씩
// 여덟 줄이 됐다. 형제 배너("채널을 불러오지 못했습니다.")와 같은 길이로 맞춘다.
// 「그래서 지금 무엇을 못 하는가」는 문장이 아니라 **문이 없는 것**이 말한다.
// 낱말이 「섹션」인 것도 그 자리 때문이다: 바로 아래 형제 배너가 「채널을…」이라
// 말하므로 둘이 나란히 서도 무엇이 실패했는지 갈린다. 이 기능의 다른 모든 문장이
// 쓰는 낱말이기도 하다(새 섹션 · 섹션 이름 · 섹션 삭제 · 섹션으로 이동).
export const SIDEBAR_PREFS_LOAD_FAILURE = "섹션을 불러오지 못했습니다.";
export const SIDEBAR_PREFS_LOAD_RETRY_LABEL = "다시 시도";

/**
 * 섹션 상한에 닿았을 때 (design-review #1932 M-3).
 *
 * 문을 지우지 않고 **비활성으로 남기고 사유를 든다**: 사라진 문과 아직 못 찾은
 * 문을 사람은 구분하지 못한다. 이 문장이 그 컨트롤의 접근가능 이름이 된다.
 */
export function sidebarSectionCapMessage(): string {
  return `섹션은 ${SIDEBAR_SECTION_MAX}개까지 만들 수 있습니다.`;
}

/**
 * 채널 참조 상한을 넘겼을 때 (design-review #1932 M-3).
 *
 * `sidebarChannelRefCount` 는 「저장 전에 여기서 먼저 세어 400 을 왕복 없이
 * 막는다」고 적어 두고 호출부가 없었다. 이제 `useSidebarPrefs` 가 모든 편집에
 * 이것을 걸고, 넘긴 편집은 **적용되지 않는다** — 적용한 뒤 저장이 실패하고
 * 롤백되면 사람은 무엇이 한계였는지 끝내 듣지 못한다.
 */
export function sidebarChannelRefCapMessage(): string {
  return `한 사이드바에 담을 수 있는 채널은 ${SIDEBAR_CHANNEL_REF_MAX}개까지입니다.`;
}

export type SidebarSectionNameIssue = "empty" | "too-long";

/** 서버가 400 으로 돌려보낼 것을 왕복 전에 같은 말로 잡는다. */
export function sidebarSectionNameIssue(
  raw: string
): SidebarSectionNameIssue | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty";
  if ([...trimmed].length > SIDEBAR_SECTION_NAME_MAX) return "too-long";
  return null;
}

export function sidebarSectionNameIssueMessage(
  issue: SidebarSectionNameIssue
): string {
  return issue === "empty"
    ? "섹션 이름을 입력해 주세요."
    : `섹션 이름은 ${SIDEBAR_SECTION_NAME_MAX}자까지입니다.`;
}

/** 상한에 닿았으면 「새 섹션」을 내놓지 않는다. 눌러서 400 을 받는 문은 문이 아니다. */
export function canCreateSidebarSection(prefs: SidebarPrefs): boolean {
  return prefs.sections.length < SIDEBAR_SECTION_MAX;
}

// ---------------------------------------------------------------------------
// 파생
// ---------------------------------------------------------------------------

export type SidebarSectionKind = "channels" | "dms" | "custom";

export interface RenderedSidebarSection {
  id: string;
  kind: SidebarSectionKind;
  title: string;
  channels: Channel[];
}

/**
 * 파생의 결과. 배열 하나가 아니라 **이름 붙은 셋 + 렌더 차례**다.
 *
 * design-review #1932 N-2: 웹은 `sections.find(s => s.kind === "channels")` 에
 * `as RenderedSidebarSection` 을 붙여 「언제나 있다」는 계약을 캐스트로 주장하고
 * 있었다. 캐스트는 그 계약이 깨지는 날을 `undefined.title` 런타임 예외로 바꾸고,
 * 사이드바는 셸 전체가 딸린 트리다. 계약이 참이면 **타입이 그렇게 말하면 된다** —
 * 그러면 호출부에 단정이 남지 않고, 깨질 때 깨지는 곳은 이 함수 안이다.
 */
export interface DerivedSidebarSections {
  /** 그릴 차례 그대로: 기본 「채널」 → 커스텀 → 「다이렉트 메시지」. */
  sections: RenderedSidebarSection[];
  /** 기본 「채널」. 삭제도 이름변경도 되지 않는다(D4). */
  base: RenderedSidebarSection;
  /** 커스텀 섹션들, `order` 차례. */
  custom: RenderedSidebarSection[];
  /** 기본 「다이렉트 메시지」. */
  dms: RenderedSidebarSection;
}

function idKey(id: string): string {
  return id.trim().toLowerCase();
}

function orderedSections(prefs: SidebarPrefs): SidebarSectionPrefs[] {
  // `order` 가 정본이고, 같은 수끼리는 payload 순서가 가른다. `sort` 는 안정
  // 정렬이므로 두 규칙이 한 줄에 들어간다.
  return [...prefs.sections].sort((a, b) => a.order - b.order);
}

/**
 * payload + 살아 있는 채널 목록 → 그릴 섹션 배열.
 *
 * 순서는 **기본 「채널」 → 커스텀 → 「다이렉트 메시지」** 다. 커스텀을 맨 위로
 * 올리는 선택지도 있었지만, 그러면 섹션을 하나 만드는 순간 목록의 대부분(아직
 * 배치되지 않은 채널들)이 아래로 밀린다. 기본 섹션이 자리를 지키면 새 섹션은
 * 목록에 **더해지는** 것으로 읽히고, 그것이 실제로 일어난 일이다.
 *
 * ## 겹침
 *
 * 한 채널이 두 섹션에 적혀 있으면 **앞선 섹션**이 갖는다. payload 는 사람이 만든
 * 것이 아니라 클라가 쓴 것이므로 겹침은 버그의 흔적인데, 그 버그가 한 채널을 두
 * 번 그리는 것으로 나타나면 사람은 자기가 채널을 두 개 가진 줄 안다.
 *
 * ## DM
 *
 * DM 은 커스텀 섹션에 들어가지 않는다(ADR-0177 D4 의 기본 섹션 두 종). payload 에
 * DM id 가 적혀 있어도 무시하고 「다이렉트 메시지」에 남긴다 - 배치할 문을 UI 가
 * 열지 않으므로 여기 오는 것은 구 클라나 손으로 쓴 payload 뿐이다.
 */
export function deriveSidebarSections(input: {
  prefs: SidebarPrefs;
  /** 살아 있는 비-DM 채널, 서버 순서 그대로. */
  channels: readonly Channel[];
  /** 살아 있는 DM. */
  dms: readonly Channel[];
}): DerivedSidebarSections {
  const byId = new Map<string, Channel>();
  for (const channel of input.channels) byId.set(idKey(channel.id), channel);

  const claimed = new Set<string>();
  const custom: RenderedSidebarSection[] = [];
  for (const section of orderedSections(input.prefs)) {
    const channels: Channel[] = [];
    for (const rawId of section.channelIds) {
      const key = idKey(rawId);
      // 죽은 id(목록에 없음) · 이미 앞 섹션이 가져간 id · DM id 는 전부 여기서
      // 조용히 빠진다. payload 는 건드리지 않는다.
      if (claimed.has(key)) continue;
      const channel = byId.get(key);
      if (!channel) continue;
      claimed.add(key);
      channels.push(channel);
    }
    custom.push({
      id: section.id,
      kind: "custom",
      title: section.name,
      channels,
    });
  }

  const base: RenderedSidebarSection = {
    id: BASE_CHANNELS_SECTION_ID,
    kind: "channels",
    title: BASE_CHANNELS_SECTION_TITLE,
    channels: input.channels.filter(
      (channel) => !claimed.has(idKey(channel.id))
    ),
  };
  const dms: RenderedSidebarSection = {
    id: BASE_DMS_SECTION_ID,
    kind: "dms",
    title: BASE_DMS_SECTION_TITLE,
    channels: [...input.dms],
  };
  return { sections: [base, ...custom, dms], base, custom, dms };
}

/** 이 채널이 지금 어느 커스텀 섹션에 있는가. 없으면 `null`(기본 섹션). */
export function sectionIdForChannel(
  prefs: SidebarPrefs,
  channelId: string
): string | null {
  const key = idKey(channelId);
  for (const section of orderedSections(prefs)) {
    if (section.channelIds.some((id) => idKey(id) === key)) return section.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 변경 (전부 순수 - 새 payload 를 돌려주고 입력을 건드리지 않는다)
// ---------------------------------------------------------------------------

/**
 * 다음 섹션 id. **무작위가 아니라 결정적**이다.
 *
 * 코어에는 `crypto` 도 `Math.random` 도 두지 않는다(purity + 시험 가능성). 기존
 * id 중 `sec-<수>` 꼴의 최대 수 다음을 쓰고, 그래서 같은 payload 에서 같은 id 가
 * 나온다. id 는 payload 안에서만 뜻이 있으므로 전역 유일성은 필요 없다.
 */
export function nextSidebarSectionId(prefs: SidebarPrefs): string {
  let max = 0;
  for (const section of prefs.sections) {
    const match = /^sec-(\d+)$/.exec(section.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `sec-${max + 1}`;
}

/** 새 섹션을 맨 뒤에 붙인다. 이름은 이미 검증됐다고 본다(호출부가 `sidebarSectionNameIssue`). */
export function createSidebarSection(
  prefs: SidebarPrefs,
  name: string,
  id: string = nextSidebarSectionId(prefs)
): SidebarPrefs {
  const order =
    prefs.sections.reduce((max, section) => Math.max(max, section.order), -1) +
    1;
  return {
    ...prefs,
    sections: [
      ...prefs.sections,
      { id, name: name.trim(), order, channelIds: [] },
    ],
  };
}

export function renameSidebarSection(
  prefs: SidebarPrefs,
  id: string,
  name: string
): SidebarPrefs {
  return {
    ...prefs,
    sections: prefs.sections.map((section) =>
      section.id === id ? { ...section, name: name.trim() } : section
    ),
  };
}

/**
 * 섹션을 지운다. 그 안의 채널은 **어디로도 옮기지 않는다** - 배치가 사라지면
 * `deriveSidebarSections` 가 자동으로 기본 「채널」에 귀속시킨다. 채널을 명시적으로
 * 다른 섹션에 옮겨 적으면 두 곳에 같은 규칙이 생긴다.
 */
export function deleteSidebarSection(
  prefs: SidebarPrefs,
  id: string
): SidebarPrefs {
  return {
    ...prefs,
    sections: prefs.sections.filter((section) => section.id !== id),
  };
}

/**
 * 채널을 한 섹션으로 옮긴다. `sectionId === null` 이면 배치를 풀어 기본 「채널」로
 * 되돌린다.
 *
 * 어느 경우든 **먼저 모든 섹션에서 뺀 다음** 넣는다: 옮기기는 복사가 아니고,
 * 이전 자리를 남기면 위 겹침 규칙이 조용히 그 채널을 원래 자리에 붙들어 둔다.
 */
export function placeChannelInSection(
  prefs: SidebarPrefs,
  channelId: string,
  sectionId: string | null
): SidebarPrefs {
  const key = idKey(channelId);
  const detached = prefs.sections.map((section) => ({
    ...section,
    channelIds: section.channelIds.filter((id) => idKey(id) !== key),
  }));
  if (sectionId === null) return { ...prefs, sections: detached };
  return {
    ...prefs,
    sections: detached.map((section) =>
      section.id === sectionId
        ? { ...section, channelIds: [...section.channelIds, channelId] }
        : section
    ),
  };
}
