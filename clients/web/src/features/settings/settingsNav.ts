// =============================================================================
// 설정 전면 페이지의 섹션 목록 (#1867). 그룹 라벨만 신설하고 기존 섹션
// 명칭과 **그룹 내** 상대 순서는 유지한다. 프로필이 개인 그룹 최상단에 앉는다.
// 그룹을 가르면 전역 순서는 바뀐다 — 웹훅이 멤버와 초대보다 앞에 서지 않는다.
//
// 그룹은 권한이 아니라 범위다. 각 운영 패널의 403은 섹션이 서버에 물어 답한다.
// =============================================================================

import { isSurfaceProvided, type SurfaceId } from "@momo/core/features/capabilities/serverSurfaces";
import { isDesktop } from "@/lib/tauri";

export type SettingsSectionId =
  | "profile"
  | "account"
  | "devices"
  | "appearance"
  | "link-previews"
  | "notifications"
  | "updates"
  | "ai"
  | "agents"
  | "code"
  | "workspace"
  | "plugins"
  | "events"
  | "usage"
  | "webhooks"
  | "members";

export type SettingsGroupId = "개인" | "워크스페이스" | "연결";

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  group: SettingsGroupId;
  /** Only in the desktop shell: a browser tab has no app bundle to update. */
  desktopOnly?: boolean;
  /** Hide the nav row unless this server surface is provided (#2166). */
  surface?: SurfaceId;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "profile", label: "프로필", group: "개인" },
  { id: "account", label: "계정", group: "개인" },
  { id: "devices", label: "기기", group: "개인" },
  // 테마는 이 기기에만 저장되는 선택이라 워크스페이스가 아니라 개인에 속한다
  // (src/design/theme.ts). 계정 바로 아래인 것은 순서가 곧 빈도이기 때문이다.
  { id: "appearance", label: "테마", group: "개인" },
  { id: "link-previews", label: "링크 미리보기", group: "개인" },
  { id: "notifications", label: "알림 규칙", group: "개인" },
  { id: "updates", label: "업데이트", group: "개인", desktopOnly: true },
  { id: "workspace", label: "워크스페이스", group: "워크스페이스" },
  { id: "plugins", label: "앱", group: "워크스페이스" },
  { id: "members", label: "멤버와 초대", group: "워크스페이스" },
  { id: "ai", label: "AI 연결", group: "연결" },
  { id: "agents", label: "에이전트 자격", group: "연결" },
  { id: "code", label: "코드 실행 호스트", group: "연결", surface: "work" },
  { id: "usage", label: "사용량", group: "연결" },
  // 연결 그룹 안에서의 상대 순서: 사용량 다음, 이벤트 구독 앞. 전역으로
  // 「앱 바로 뒤」나 「멤버와 초대 앞」이 아니다 — 그 두 섹션은 다른 그룹이다.
  { id: "webhooks", label: "웹훅", group: "연결" },
  // 마지막인 것은 빈도 순서다 (#1202): 한 번 붙이고 나면 다시 열 일이 드물고,
  // 여는 사람은 오너나 관리자뿐이다. 이름이 '외부 전송'이 아니라 '이벤트 구독'인
  // 것은 서버가 그 이름으로 부르기 때문이다 (openapi event-subscriptions).
  { id: "events", label: "이벤트 구독", group: "연결" },
];

export const SETTINGS_GROUPS: SettingsGroupId[] = [
  "개인",
  "워크스페이스",
  "연결",
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "profile";

/**
 * **이 빌드에서 실제로 도착할 수 있는** 섹션 (design-review #2540 R2 M-R2-1).
 *
 * `SETTINGS_SECTIONS` 는 원표이고, 화면에 서는 목록은 그보다 짧다: `updates` 는
 * 데스크톱 셸에만 있고(`desktopOnly`), `code` 는 서버가 그 표면을 실었을 때만
 * 있다(`surface`). `SettingsRoute` 는 그 **걸러진 목록**으로 `?section=` 을
 * 판정하고, 목록 밖 이름은 조용히 기본 섹션(프로필)으로 접는다.
 *
 * 그래서 원표를 읽고 「이 섹션은 있다」고 답하는 쪽은 전부 틀린다. R1 H1 이
 * 닫은 결함(`?section=invites`)과 **같은 결함**이 `updates`·`code` 로 한 겹 더
 * 남아 있었다: 결과 카드가 문을 세우고, 누르면 아무 말 없이 프로필에 도착한다.
 *
 * 판정을 여기 한 곳에 둔다. `SettingsRoute` 가 자기 목록을 만들 때, 결과 카드가
 * 문을 세울지 정할 때, 팔레트가 행동 줄을 열지 정할 때 — 셋이 같은 함수를
 * 부른다. 세 곳이 각자 필터를 적으면 그중 하나가 먼저 낡는다.
 *
 * 런타임 사실을 읽으므로(셸 종류·서버 표면) 상수가 아니라 함수다.
 */
export function reachableSettingsSections(): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter(
    (item) =>
      (!item.desktopOnly || isDesktop()) &&
      (item.surface === undefined || isSurfaceProvided(item.surface))
  );
}

/** 이 빌드가 이 섹션 이름으로 도착할 수 있는가. */
export function isReachableSettingsSection(section: string): boolean {
  return reachableSettingsSections().some((item) => item.id === section);
}
