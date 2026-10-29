/**
 * `momo/busy-lock-grammar` 가 서는 파일 (#4711). eslint.config.js 와 fixture 시험이 같은 목록을 읽는다.
 *
 * 옛 시험 셋(rawControlBusySplit · confirmBusySplit · settingsFieldsBusy)이 이름을 달아 재던 파일의
 * 합집합이다. 글롭으로 넓히지 않는다: 같은 디렉터리에 새 카드를 세우는 작업이 먼저 들어와야 하고,
 * 새 파일을 이 목록에 더하는 것은 그 파일의 PR 이 정한다. 목록에서 빼려면 fixture 시험의
 * ORIGINAL_SCOPE 도 함께 고쳐야 한다(조용히 줄어들지 못하게).
 */
export const BUSY_LOCK_GRAMMAR_FILES = [
  "src/features/settings/EventSubscriptionSection.tsx",
  "src/features/settings/AiLinkSection.tsx",
  "src/features/settings/AiLinkChain.tsx",
  "src/features/settings/WorkspaceSection.tsx",
  "src/features/settings/InviteSection.tsx",
  "src/features/settings/WebhookSection.tsx",
  "src/features/settings/LeaveWorkspaceRow.tsx",
  "src/features/settings/LinkedDevicesList.tsx",
  "src/features/settings/SettingsFields.tsx",
  "src/features/hostedAgents/HostedConnectionSection.tsx",
  "src/features/hostedAgents/DoorbellSection.tsx",
];

/** 규칙이 이름으로 겨누는 컴포넌트가 정의된 파일(`momo/busy-lock-primitives` 가 선다). */
export const BUSY_LOCK_PRIMITIVES_FILE = "src/features/settings/SettingsFields.tsx";
