import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  createInvite,
  fetchWorkspace,
  listInvites,
  resolveServerBaseUrl,
  type CreatedInvite,
} from "@momo/core/features/settings/api";
import {
  buildInviteMailto,
  buildJoinLink,
  choiceLabel,
  errorMessage,
  formatDay,
  INVITE_EXPIRY_DAYS,
  INVITE_ROLES,
  inviteCardText,
  inviteStatus,
  isOperatorDenied,
  type InviteCardInput,
} from "@momo/core/features/settings/model";
import {
  ChoiceRadios,
  CopyButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
} from "./SettingsFields";

// =============================================================================
// 멤버와 초대 (R-1 §5, 온보딩 감사 W-O1/W-O5): issue an invite code and hand
// the new member a link that opens the app already pointed at this server.
//
// The link format is not invented here: docs/onboarding-deeplink.md is the
// contract that the macOS/iOS clients parse, so the assembly lives in model.ts
// beside its test. The raw code comes back exactly once (the server keeps only
// a hash), which is why the panel shows it as a one-time block with the paste
// card and a mail draft, not as a row that can be re-read later.
// =============================================================================

const DAY_MS = 86_400_000;

/**
 * 잠긴 발급이 가리키는 사유 (#1559, #1542 동형).
 *
 * 모듈 상수 id 인 이유는 `CHAIN_FULL_NOTE_ID` 와 같다: 이 패널에 이 폼은 하나뿐이라
 * `useId` 가 벌어 주는 유일성이 살 자리가 없고, 상수는 계약 테스트가 배선을
 * 문자열로 확인할 수 있게 한다.
 *
 * 뒷문장이 형제 표면(이벤트 구독 만들기)의 것을 그대로 베끼지 않는 이유: 그쪽
 * 문장은 다시 연결되면 누른 것이 알아서 나간다고 약속하는데, 이 발급은 큐에 쌓이지
 * 않는다. 다시 연결된 뒤 이 사람이 한 번 더 눌러야 하고, 문장은 그 사실을 말한다.
 */
const OFFLINE_NOTE_ID = "invite-create-offline-note";
const OFFLINE_CREATE_REASON =
  "연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다.";

export function InviteSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const invites = useQuery({
    queryKey: ["settings", "invites", workspaceId],
    queryFn: () => listInvites(workspaceId),
    retry: false,
  });
  const workspace = useQuery({
    queryKey: ["settings", "workspace", workspaceId],
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });

  const [role, setRole] = useState("member");
  const [maxUses, setMaxUses] = useState("1");
  const [days, setDays] = useState("7");
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<CreatedInvite | null>(null);
  // 3R High: 코드는 1회 노출인데 발급 카드가 폴드 아래 렌더될 수 있다.
  // 발급 즉시 카드로 포커스를 옮겨 시각·키보드 사용자 모두에게 착지시킨다.
  const issuedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (issued && issuedRef.current) {
      issuedRef.current.focus({ preventScroll: true });
      issuedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [issued]);

  const create = useMutation({
    mutationFn: () =>
      createInvite(workspaceId, {
        role,
        maxUses: Number(maxUses),
        expiresAtMs: Date.now() + Number(days) * DAY_MS,
      }),
    onSuccess: (result) => {
      setIssued(result);
      void client.invalidateQueries({
        queryKey: ["settings", "invites", workspaceId],
      });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // `aria-disabled` 는 클릭도 Enter 도 막지 않으므로(초점을 잃지 않는 것이
    // 요점이다) 거절은 여기서 한다. 사용 횟수 칸에서 누른 Enter(암묵적 제출)도
    // 같은 발급을 내므로 `onClick` 이 아니라 폼이 가드를 진다 (#1559).
    if (offline || create.isPending) return;
    const uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1 || uses > 10_000) {
      setFormError("사용 횟수는 1에서 10000 사이의 정수여야 합니다.");
      return;
    }
    setFormError(null);
    setIssued(null);
    create.mutate();
  }

  const lines = [
    "초대 링크를 발급해 사람을 이 워크스페이스로 부릅니다.",
    "코드는 발급 직후 한 번만 보입니다. 서버는 해시만 보관합니다.",
  ];

  if (invites.isPending) {
    return (
      <SectionShell title="멤버와 초대" lines={lines}>
        <SkeletonRows rows={4} />
      </SectionShell>
    );
  }

  if (invites.isError) {
    return (
      <SectionShell title="멤버와 초대" lines={lines}>
        {isOperatorDenied(invites.error) ? (
          <OperatorNotice
            who="초대 링크는 워크스페이스 오너나 관리자만 발급할 수 있습니다."
            contact="초대가 필요하면 워크스페이스 관리자에게 문의하세요."
          />
        ) : (
          <InlineBanner
            message={errorMessage(invites.error)}
            actionLabel="다시 시도"
            onAction={() => void invites.refetch()}
            testId="invite-error"
          />
        )}
      </SectionShell>
    );
  }

  const rows = invites.data;
  const serverBaseUrl = resolveServerBaseUrl();
  const card: InviteCardInput | null = issued
    ? {
        workspaceName: workspace.data?.name ?? "oort",
        serverBaseUrl,
        code: issued.code,
        expiresAtMs: issued.invite.expiresAtMs,
        maxUses: issued.invite.maxUses,
      }
    : null;

  return (
    <SectionShell title="멤버와 초대" lines={lines}>
      {rows.length === 0 ? (
        <EmptyInvite
          headline="아직 발급한 초대 링크가 없습니다."
          detail="아래에서 역할과 사용 횟수를 정하고 링크를 만드세요."
          testId="invite-empty"
        />
      ) : (
        <ul
          className="flex flex-col rounded-md border border-line"
          data-testid="invite-list"
        >
          {rows.map((invite) => {
            const status = inviteStatus(invite);
            return (
              <li
                key={invite.id}
                className="flex flex-wrap items-center gap-2 border-b border-line p-3 last:border-b-0"
              >
                <span className="font-mono text-body text-ink" data-numeric>
                  {invite.codePreview}
                </span>
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
                <span className="text-meta text-ink-muted">
                  {choiceLabel(INVITE_ROLES, invite.role)}
                </span>
                <span className="text-meta text-ink-muted" data-numeric>
                  {invite.usedCount}/{invite.maxUses}명 사용
                </span>
                <span className="text-meta text-ink-muted" data-numeric>
                  {formatDay(invite.expiresAtMs)}까지
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={submit}
        data-testid="invite-create-form"
      >
        <ChoiceRadios
          name="invite-role"
          legend="역할"
          choices={INVITE_ROLES}
          value={role}
          onChange={setRole}
          disabled={create.isPending}
        />

        <Field
          label="사용 횟수"
          htmlFor="invite-max-uses"
          hint="이 링크로 참여할 수 있는 사람 수입니다."
        >
          {/* A count is not a URL: it gets the named narrow pane, not the
              full form width. max-w rather than a flat width so a window
              narrower than the pane shrinks the field instead of pushing a
              sideways scroll into the settings body (MOMO-610). */}
          <Input
            id="invite-max-uses"
            name="maxUses"
            type="number"
            min={1}
            max={10000}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            className="w-full max-w-pane"
          />
        </Field>

        <ChoiceRadios
          name="invite-expiry"
          legend="유효 기간"
          choices={INVITE_EXPIRY_DAYS.map((d) => ({
            id: String(d),
            label: `${d}일`,
            detail: `${formatDay(Date.now() + d * DAY_MS)}까지 쓸 수 있습니다.`,
          }))}
          value={days}
          onChange={setDays}
          disabled={create.isPending}
        />

        {formError && (
          <p className="text-meta text-danger" role="alert">
            {formError}
          </p>
        )}
        {create.isError && (
          <p className="text-meta text-danger" role="alert">
            {errorMessage(create.error)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* 진행과 잠금은 다른 축이다 (#1486 회전 · #1541 · #1559). 이 자리는
              그 문법의 어느 쪽도 갖고 있지 않았다: 낱말은 바뀌는데 `aria-busy` 가
              없어 낭독은 「초대 링크 만들기」에 머물렀고, native `disabled` 가
              진행 프레임에서까지 버튼을 흐리고 tab order 에서 뺐다.
              잠그는 사실은 오프라인 하나이고, 진행은 낱말과 `aria-busy` 가 진다.
              가드는 폼이 진다(위 `submit`). */}
          <Button
            type="submit"
            size="sm"
            aria-disabled={offline || undefined}
            aria-busy={create.isPending || undefined}
            aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}
            className={cn(offline && "opacity-50")}
            data-testid="invite-create"
          >
            {create.isPending ? "만드는 중" : "초대 링크 만들기"}
          </Button>
          {/* 잠긴 컨트롤은 사유를 든다 (#1542 · design-review #1557 M). 회색이
              혼자 서면 「당신에게는 권한이 없다」로 읽히는데, 이 사람은 발급할 수
              있고 지금 rail 이 내려가 있을 뿐이다. 형제 표면(이벤트 구독 만들기)이
              같은 사실에 대해 쓰는 문장을 그대로 쓴다 — 같은 잠금, 같은 문장. */}
          {offline && (
            <span
              id={OFFLINE_NOTE_ID}
              className="break-keep text-meta text-ink-muted"
              data-testid="invite-create-offline"
            >
              {OFFLINE_CREATE_REASON}
            </span>
          )}
        </div>
      </form>

      {card && issued && (
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
                value: buildJoinLink(serverBaseUrl, issued.code),
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
              value={buildJoinLink(serverBaseUrl, issued.code)}
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
      )}
    </SectionShell>
  );
}
