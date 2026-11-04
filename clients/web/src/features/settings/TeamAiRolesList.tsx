import { useId } from "react";
import {
  TEAM_AI_ALWAYS_ON_BUNDLE,
  TEAM_AI_BUNDLES,
  type TeamAiBundle,
  type TeamAiRoles,
  type TeamAiSwitchableBundle,
} from "@momo/core/features/settings/teamAiRoles";
import { TEAM_AI_ROLE_COPY, teamAiRoleNoticeKey } from "@momo/core/features/settings/teamAiCopyKeys";
import { Switch } from "@/design/ui/switch";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// =============================================================================
// 도우미 역할 일곱 묶음의 스위치 목록 (ADR-0201 증보 v3 B3, #4945).
//
// 온보딩 단계(고른 값을 들고 있다가 「도우미 켜기」에서 한 번에 쓴다)와 설정 패널(누르는 즉시
// 저장한다)이 **같은 목록**을 그린다. 이 파일은 그리기만 한다: 켜짐 판정·기본값은 코어
// `teamAiRoles`, 문구는 사전 `teamAi.roles.*`, 저장은 부르는 쪽 몫이다.
//
// `chat_read`(대화·읽기)는 칸이 아니라 늘 켜져 있다: 잠긴 스위치와 「항상 켜져 있어요」로 보인다.
// 파일·기억은 켜면 부른 사람이 볼 수 있는 내용이 팀 AI 공급자로 가는 묶음이라, `rowNotices`가
// 참이면 그 행 아래에 고지를 늘 보인다(설정). 거짓이면 목록 밖에서 한 줄로 알린다(온보딩).
//
// 행은 따로 둔 컴포넌트다(`RoleRow`): 행마다 `useId`로 이름·설명·고지의 id를 받고, 시험 id는
// 머리글자와 묶음 id를 이어 짓는다.
// =============================================================================

function RoleRow({
  id,
  checked,
  disabled,
  rowNotice,
  testIdPrefix,
  onToggle,
}: {
  id: TeamAiBundle;
  checked: boolean;
  disabled: boolean;
  rowNotice: boolean;
  testIdPrefix: string;
  onToggle: (bundle: TeamAiSwitchableBundle, next: boolean) => void;
}) {
  const formatMessage = useFormatMessage();
  const nameId = useId();
  const hintId = useId();
  const noticeId = useId();
  const locked = id === TEAM_AI_ALWAYS_ON_BUNDLE;
  const copy = TEAM_AI_ROLE_COPY[id];
  const noticeKey = rowNotice ? teamAiRoleNoticeKey(id) : null;
  const describedBy = noticeKey === null ? hintId : `${hintId} ${noticeId}`;
  const rowTestId = `${testIdPrefix}-role-row-${id}`;
  const switchTestId = `${testIdPrefix}-role-${id}`;
  const noticeTestId = `${testIdPrefix}-role-notice-${id}`;
  const hint = formatMessage(copy.hint);
  return (
    <li
      className="flex min-w-0 items-start justify-between gap-3 border-b border-line py-3 last:border-b-0"
      data-testid={rowTestId}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span id={nameId} className="break-keep text-body font-semibold text-ink">
          {formatMessage(copy.name)}
        </span>
        <span id={hintId} className="break-keep text-meta text-ink-muted">
          {locked ? `${hint} ${formatMessage("teamAi.roles.alwaysOn")}` : hint}
        </span>
        {noticeKey === null ? null : (
          <span id={noticeId} className="break-keep text-meta text-ink-muted" data-testid={noticeTestId}>
            {formatMessage(noticeKey)}
          </span>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={locked || disabled}
        labelledBy={nameId}
        describedBy={describedBy}
        testId={switchTestId}
        onCheckedChange={(next) => {
          if (!locked) onToggle(id as TeamAiSwitchableBundle, next);
        }}
      />
    </li>
  );
}

export function TeamAiRolesList({
  roles,
  onToggle,
  disabled = false,
  busyBundle = null,
  rowNotices = false,
  testIdPrefix,
  labelledBy,
}: {
  roles: TeamAiRoles;
  onToggle: (bundle: TeamAiSwitchableBundle, next: boolean) => void;
  /** 오프라인이거나 저장 중이라 지금은 어느 묶음도 바꿀 수 없다. */
  disabled?: boolean;
  /** 저장 중인 묶음(그 행만 잠근다). */
  busyBundle?: TeamAiBundle | null;
  rowNotices?: boolean;
  testIdPrefix: string;
  /** 목록 머리글의 id(목록의 이름). */
  labelledBy?: string;
}) {
  const listTestId = `${testIdPrefix}-roles`;
  return (
    <ul className="flex min-w-0 flex-col" aria-labelledby={labelledBy} data-testid={listTestId}>
      {TEAM_AI_BUNDLES.map((id) => (
        <RoleRow
          key={id}
          id={id}
          checked={roles[id]}
          disabled={disabled || busyBundle === id}
          rowNotice={rowNotices}
          testIdPrefix={testIdPrefix}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}
