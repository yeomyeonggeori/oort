import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { devAccessError } from "@momo/core/features/auth/devAccess";
import {
  DEV_NOTICES,
  devAccessErrorText,
  devAccessGate,
} from "@momo/core/features/auth/devAccessModel";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { DevAccessCreateForm } from "./DevAccessCreateForm";
import { DevAccessList } from "./DevAccessList";
import { devAccessPolicyQuery } from "./devAccessQuery";
import { SettingsSection } from "./shell/SettingsSection";
import { CardBody } from "./workTierPolicy";

// Reading this as: settings for internal team users on web+Tauri,
// density 6/10, motion 2/10.

// =============================================================================
// 설정 › 명령줄·AI 도구 (#4663, ADR-0216). 터미널과 Claude Code·Codex 같은 도구가 내 계정으로
// oort를 읽고 쓰게 하는 연결 값(개발자 토큰)을 만들고 지우는 화면이다. 카드 셋: 안내, 새 연결
// 만들기, 연결 목록. 문구의 사실(비밀번호를 바꾸면 모든 연결이 끊긴다, 로그아웃은 연결을 끊지
// 않는다, 도구는 고른 값일 뿐이다)과 오류 문장은 코어(`devAccessModel`)의 것이다. 폰이 같은
// 문장을 읽는다.
//
// 만들기의 문은 서버가 정한다: `GET …/dev-access`의 `canCreate`가 폼을 세우고, `canManageAll`이
// 목록의 「전체」 보기를 연다. 스위치가 이 역할을 받지 않으면 폼 없이 이유 한 문장이 선다.
// 목록은 문과 무관하게 선다: 스위치가 닫혀도 이미 있는 연결은 지울 수 있어야 한다.
// =============================================================================

const INTRO =
  "터미널이나 Claude Code, Codex 같은 도구가 내 계정으로 oort를 읽고 쓸 수 있게 연결을 만들어요. 연결마다 값이 한 번만 보여요.";

/** 안내 카드에 서는 코어의 사실들. `revokeWarning`은 지우기 확인 문장이라 목록 쪽에 선다. */
const NOTICE_LINES: readonly string[] = [
  DEV_NOTICES.passwordChangeEndsAll,
  DEV_NOTICES.logoutKeepsConnections,
  DEV_NOTICES.toolIsOnlyALabel,
  DEV_NOTICES.fixedAfterIssue,
  DEV_NOTICES.cardLimit,
];

const NAME_FIELD_ID = "dev-access-name";

export function DevAccessSection({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  const policy = useQuery(devAccessPolicyQuery(workspaceId));
  // 만든 직후 스크린리더에 알린다. 이름만 담고 값은 절대 담지 않는다.
  const [announce, setAnnounce] = useState("");
  const onSaved = useCallback((name: string) => {
    setAnnounce(`${name} 연결을 만들었어요. 아래 목록에서 볼 수 있어요.`);
  }, []);

  const gate = policy.isSuccess ? devAccessGate(policy.data) : null;
  const canStart = gate?.state === "open";

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="dev-access-page">
      <SettingsSection title="연결 안내" description={INTRO} testId="dev-access-notes">
        <CardBody>
          <ul className="flex list-outside list-disc flex-col gap-1 ps-4">
            {NOTICE_LINES.map((line) => (
              <li key={line} className="break-keep text-body text-ink-muted">
                {line}
              </li>
            ))}
          </ul>
        </CardBody>
      </SettingsSection>

      {policy.isPending && (
        <SettingsSection title="새 연결 만들기" testId="dev-access-create-card">
          <CardBody>
            <div role="status" data-testid="dev-access-policy-loading">
              <span className="sr-only">연결 권한을 불러오고 있어요.</span>
              <Skeleton ready={false} rows={2} className="p-0" />
            </div>
          </CardBody>
        </SettingsSection>
      )}

      {policy.isError && (
        <SettingsSection title="새 연결 만들기" testId="dev-access-create-card">
          <CardBody>
            <InlineBanner
              message={devAccessErrorText(devAccessError(policy.error), "policy")}
              actionLabel="다시 시도"
              onAction={() => void policy.refetch()}
              className="px-0"
              separator={false}
              testId="dev-access-policy-error"
            />
          </CardBody>
        </SettingsSection>
      )}

      {gate !== null && gate.state !== "open" && (
        <SettingsSection title="새 연결 만들기" testId="dev-access-create-card">
          <CardBody>
            <p
              className="break-keep text-body text-ink"
              role="status"
              data-testid="dev-access-gate"
              data-gate-state={gate.state}
            >
              {gate.text}
            </p>
          </CardBody>
        </SettingsSection>
      )}

      {gate !== null && gate.state === "open" && (
        <DevAccessCreateForm
          workspaceId={workspaceId}
          memberId={memberId}
          offline={offline}
          gateText={gate.text}
          nameFieldId={NAME_FIELD_ID}
          onSaved={onSaved}
        />
      )}

      <DevAccessList
        workspaceId={workspaceId}
        memberId={memberId}
        offline={offline}
        canManageAll={policy.isSuccess && policy.data.canManageAll}
        onStartCreate={
          canStart
            ? () => document.getElementById(NAME_FIELD_ID)?.focus({ preventScroll: false })
            : undefined
        }
      />

      <p className="sr-only" role="status" data-testid="dev-access-announce">
        {announce}
      </p>
    </div>
  );
}
