// =============================================================================
// 설정 전면 페이지의 목차 (#1867 → #3578 S1).
//
// 12행, 세 그룹. 그룹은 권한이 아니라 **범위**다: 개인(나와 이 기기), 워크스페이스
// (이 워크스페이스 전체), 앱·연결(이 앱과 바깥으로 가는 문). 각 운영 패널의 403은
// 섹션이 서버에 물어 답한다. 범위는 페이지 머리의 `ScopeChip`이 사람에게 말한다.
//
// 합친 페이지는 옛 id를 **별칭**으로 받는다(`LEGACY_SECTION_ALIAS`). 옛 딥링크
// (`?section=account` 같은 서버 안내·팔레트·결과 카드가 건네는 주소)는 계속 닿아야 한다.
// 판정은 `resolveSettingsSection` 한 곳이다: 별칭을 푸는 쪽이 둘로 갈리면 그중
// 하나가 먼저 낡는다(design-review #2540 R2 M-R2-1과 같은 교훈).
// =============================================================================

import { isSurfaceProvided, type SurfaceId } from "@momo/core/features/capabilities/serverSurfaces";
import { aiExternalRowFromSettings } from "@momo/core/features/ai/aiHubModel";
import { isDesktop } from "@/lib/tauri";

export type SettingsSectionId =
  | "profile"
  | "appearance"
  | "notifications"
  | "shortcuts"
  | "devices"
  | "workspace"
  | "members"
  | "memory"
  | "usage"
  | "code"
  | "updates"
  | "ai";

export type SettingsGroupId = "개인" | "워크스페이스" | "앱·연결";

/** 페이지 머리 칩이 말하는 범위. 문장은 `SCOPE_LABELS`에 있다. */
export type SettingsScope =
  | "workspace-member"
  | "device"
  | "account-device"
  | "account"
  | "workspace"
  | "workspace-mixed"
  | "workspace-readable";

export const SCOPE_LABELS: Record<SettingsScope, string> = {
  "workspace-member": "이 워크스페이스에서 보여요",
  device: "이 기기에만 저장돼요",
  "account-device": "내 계정과 이 기기",
  account: "내 계정",
  workspace: "워크스페이스 전체",
  "workspace-mixed": "내 설정과 워크스페이스",
  "workspace-readable": "워크스페이스 · 누구나 볼 수 있어요",
};

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  label: string;
  group: SettingsGroupId;
  /** 페이지 머리 칩. 링크 행(`link`)은 칩이 없다. */
  scope?: SettingsScope;
  /**
   * 설정 안의 화면이 아니라 다른 화면으로 가는 행. 목차에서는 행으로 서되 눌러도
   * 설정 페이지가 바뀌지 않는다(끝 아이콘이 그 사실을 말한다). 옛 주소(`?section=ai`)
   * 로 들어오면 옛 화면이 열리고 이 행이 현재 위치로 표시된다.
   */
  link?: "ai-hub";
  /** Only in the desktop shell: a browser tab has no app bundle to update. */
  desktopOnly?: boolean;
  /** Hide the nav row unless this server surface is provided (#2166). */
  surface?: SurfaceId;
  /**
   * In the desktop shell the row stands whatever `surface` says (#2778 planner
   * decision; kept by S4 #3578): 「실행 호스트」 is the workspace's registry of hosts
   * and its default resume policy. Registering THIS Mac moved to 「기기」 (personal),
   * which is always on the desktop, so the row no longer hides a first door; it
   * stays so that a desktop member can still read the registry before any host is online.
   */
  desktopAlways?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: "profile", label: "프로필", group: "개인", scope: "workspace-member" },
  { id: "appearance", label: "모양", group: "개인", scope: "device" },
  { id: "notifications", label: "알림", group: "개인", scope: "account-device" },
  { id: "shortcuts", label: "단축키", group: "개인", scope: "device" },
  { id: "devices", label: "기기", group: "개인", scope: "account" },
  { id: "workspace", label: "워크스페이스", group: "워크스페이스", scope: "workspace" },
  { id: "members", label: "멤버와 초대", group: "워크스페이스", scope: "workspace" },
  // 팀 기억(ADR-0196 D9, #3165): 내 일시정지는 누구나, 팀 스위치는 관리자만 —
  // 권한은 섹션이 서버 답과 역할로 가른다. 서버가 싣지 않으면 목차에서 접힌다.
  {
    id: "memory",
    label: "기억",
    group: "워크스페이스",
    scope: "workspace-mixed",
    surface: "teamMemory",
  },
  { id: "usage", label: "사용량", group: "워크스페이스", scope: "workspace-readable" },
  {
    id: "code",
    label: "실행 호스트",
    group: "워크스페이스",
    scope: "workspace",
    surface: "work",
    desktopAlways: true,
  },
  { id: "updates", label: "업데이트", group: "앱·연결", scope: "device", desktopOnly: true },
  { id: "ai", label: "AI 허브", group: "앱·연결", link: "ai-hub" },
];

export const SETTINGS_GROUPS: SettingsGroupId[] = ["개인", "워크스페이스", "앱·연결"];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "profile";

/**
 * 합쳐진 옛 구획 → 지금 있는 구획. S2~S5가 본문을 다시 짤 때까지 합친 페이지는
 * 옛 구획 본문을 그 아래에 이어 붙인다(`SettingsRoute`의 `MERGED_PAGES`).
 */
export const LEGACY_SECTION_ALIAS: Readonly<Record<string, SettingsSectionId>> = {
  account: "profile",
  "link-previews": "appearance",
  terminal: "shortcuts",
};

export type SettingsSectionResolution =
  | { kind: "section"; id: SettingsSectionId; alias: string | null }
  | { kind: "ai-hub"; path: string }
  | { kind: "unknown" };

/**
 * `?section=` 값이 무엇을 뜻하는지 푼다. 별칭은 합쳐진 페이지로, AI 허브로 옮겨 간
 * 옛 구획(`agents`·`plugins`·`webhooks`·`events`)은 그 허브 경로로 간다. `ai`는 목차에서는 허브로 가는 링크 행이지만 `?section=ai`는 옛 AI 연결 화면이 그대로 열린다(AiLinkSection, 그것을 부르는 게이트·캡처·되돌아오는 길이 많고 AI 허브 T3(ADR-0198)가 끝나면 걷는다). 목차에
 * 서는지(서버 표면·셸 종류)는 이 함수가 묻지 않는다 — `reachableSettingsSections`가 안다.
 */
export function resolveSettingsSection(raw: string | null | undefined): SettingsSectionResolution {
  if (raw === null || raw === undefined) return { kind: "unknown" };
  const moved = aiExternalRowFromSettings(raw)?.path;
  if (moved) return { kind: "ai-hub", path: moved };
  const alias = LEGACY_SECTION_ALIAS[raw];
  if (alias !== undefined) return { kind: "section", id: alias, alias: raw };
  if (SETTINGS_SECTIONS.some((item) => item.id === raw)) {
    return { kind: "section", id: raw as SettingsSectionId, alias: null };
  }
  return { kind: "unknown" };
}

/**
 * **이 빌드에서 실제로 도착할 수 있는** 섹션 (design-review #2540 R2 M-R2-1).
 *
 * `SETTINGS_SECTIONS` 는 원표이고, 화면에 서는 목록은 그보다 짧다: `updates` 는
 * 데스크톱 셸에만 있고(`desktopOnly`), `code` 는 서버가 그 표면을 실었을 때만
 * 있다(`surface`). `SettingsRoute` 는 그 **걸러진 목록**으로 `?section=` 을
 * 판정하고, 목록 밖 이름은 조용히 기본 섹션(프로필)으로 접는다.
 *
 * 그래서 원표를 읽고 「이 섹션은 있다」고 답하는 쪽은 전부 틀린다. 결과 카드가
 * 문을 세우고, 누르면 아무 말 없이 프로필에 도착한다. 판정을 여기 한 곳에 둔다.
 * `SettingsRoute` 가 자기 목록을 만들 때, 결과 카드가 문을 세울지 정할 때, 팔레트가
 * 행동 줄을 열지 정할 때 — 셋이 같은 함수를 부른다.
 *
 * 런타임 사실을 읽으므로(셸 종류·서버 표면) 상수가 아니라 함수다.
 */
export function reachableSettingsSections(
  // #2780: 작업 표면은 런타임(온라인 호스트) 판정이다. 훅을 부를 수 있는 쪽
  // (`SettingsRoute`)은 `useSurfaceProvidedPredicate()`를 넘기고, 훅 밖에서 묻는
  // 쪽은 정적 표로 답한다.
  provided: (surface: SurfaceId) => boolean = isSurfaceProvided
): SettingsSectionMeta[] {
  return SETTINGS_SECTIONS.filter(
    (item) =>
      (!item.desktopOnly || isDesktop()) &&
      (item.surface === undefined ||
        (item.desktopAlways === true && isDesktop()) ||
        provided(item.surface))
  );
}

/**
 * 이 빌드가 이 섹션 이름으로 도착할 수 있는가. 별칭은 그 별칭이 가리키는 페이지가
 * 서 있을 때, AI 허브로 옮겨 간 옛 이름은 라우트가 허브로 바꿔 보내므로 늘 참이다.
 */
export function isReachableSettingsSection(section: string): boolean {
  const resolved = resolveSettingsSection(section);
  if (resolved.kind === "ai-hub") return true;
  if (resolved.kind === "unknown") return false;
  return reachableSettingsSections().some((item) => item.id === resolved.id);
}
