import type { RefObject } from "react";
import { Button } from "@/design/ui/button";
import {
  buildInviteMailto,
  buildJoinLink,
  formatDay,
  inviteCardText,
  type InviteCardInput,
} from "@momo/core/features/settings/model";
import { resolveServerBaseUrl, type CreatedInvite } from "@momo/core/features/settings/api";
import { CopyButton, KeyValueRows } from "./SettingsFields";

// =============================================================================
// One-time issued-code card. Shared by settings › 멤버와 초대 and onboarding
// S2 so the copy, the link assembly, and the copy/mail actions cannot drift.
// The raw code is a prop; nothing here logs it.
// =============================================================================

export function IssuedInviteCard({
  issued,
  workspaceName,
  issuedRef,
}: {
  issued: CreatedInvite;
  workspaceName: string;
  issuedRef: RefObject<HTMLDivElement>;
}) {
  const serverBaseUrl = resolveServerBaseUrl();
  const card: InviteCardInput = {
    workspaceName,
    serverBaseUrl,
    code: issued.code,
    expiresAtMs: issued.invite.expiresAtMs,
    maxUses: issued.invite.maxUses,
  };
  const joinLink = buildJoinLink(serverBaseUrl, issued.code);

  return (
    <div
      ref={issuedRef}
      tabIndex={-1}
      className="flex flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:focus-ring"
      role="status"
      data-testid="invite-issued"
    >
      <p className="text-body text-ink">
        초대 링크를 만들었습니다. 코드는 이 화면에서만 볼 수 있으니 지금
        전달하세요.
      </p>

      <KeyValueRows
        rows={[
          {
            key: "딥링크",
            value: joinLink,
            numeric: true,
          },
          { key: "서버 주소", value: serverBaseUrl, numeric: true },
          { key: "초대 코드", value: issued.code, numeric: true },
          {
            key: "만료",
            value: `${formatDay(issued.invite.expiresAtMs)}, ${issued.invite.maxUses}명까지`,
            numeric: true,
          },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          value={joinLink}
          label="딥링크 복사"
          testId="invite-copy-link"
        />
        <CopyButton
          value={inviteCardText(card)}
          label="초대 카드 복사"
          testId="invite-copy-card"
        />
        <Button asChild variant="outline" size="sm">
          <a href={buildInviteMailto(card)}>메일 초안 열기</a>
        </Button>
      </div>

      <p className="text-meta text-ink-muted">
        받는 사람은 앱을 설치한 뒤 딥링크를 열면 서버 주소와 코드가 채워진
        상태로 참여 화면에 도착합니다.
      </p>
    </div>
  );
}
