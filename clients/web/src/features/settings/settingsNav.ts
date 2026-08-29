// =============================================================================
// 설정 전면 페이지의 섹션 목록 (#1867). 그룹 라벨만 신설하고 기존 섹션
// 명칭·상대 순서는 유지한다. 프로필이 개인 그룹 최상단에 앉는다.
//
// 그룹은 권한이 아니라 범위다. 각 운영 패널의 403은 섹션이 서버에 물어 답한다.
// =============================================================================

export type SettingsSectionId =
  | "profile"
  | "account"
  | "appearance"
  | "link-previews"
  | "notifications"
  | "updates"
  | "ai"
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
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "profile", label: "프로필", group: "개인" },
  { id: "account", label: "계정", group: "개인" },
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
  { id: "code", label: "코드 실행 호스트", group: "연결" },
  { id: "usage", label: "사용량", group: "연결" },
  // 웹훅은 앱 바로 뒤에 선다: 둘 다 "바깥과 무엇을 주고받는가"이고, 이 순서가
  // 곧 그 이웃 관계다. 멤버와 초대 앞인 것은 사람이 아니라 시스템을 들이는
  // 표면이기 때문이다.
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
