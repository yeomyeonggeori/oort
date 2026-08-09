import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { channelLabel, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { resolveServerBaseUrl } from "@momo/core/features/settings/api";
import {
  createWebhookInstallation,
  listWebhookInstallations,
  revokeWebhookInstallation,
  rotateWebhookSecret,
} from "@momo/core/features/webhooks/api";
import {
  installationReceiveUrl,
  isWebhookOperatorDenied,
  normalizeWebhookLabel,
  parseInstallations,
  parseRevealedCredential,
  parseRevokedInstallation,
  resolveReceiveUrl,
  revealDetailRows,
  revealHeadline,
  revealWarning,
  revokeConfirmQuestion,
  rotateConfirmQuestion,
  SLACK_URL_RECOVERY_HINT,
  webhookCreatedLabel,
  webhookFailureMessage,
  webhookIngressNotes,
  webhookLabelIssue,
  webhookLabelIssueMessage,
  webhookModeName,
  webhookStatusChip,
  WEBHOOK_LABEL_MAX,
  WEBHOOK_MODES,
  WEBHOOK_ROTATE_OVERLAP_SECONDS,
  type RevealedWebhookCredential,
  type WebhookInstallation,
  type WebhookMode,
} from "@momo/core/features/webhooks/model";
import {
  ChoiceRadios,
  ConfirmButton,
  CopyButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  SelectField,
  StatusChip,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 웹훅 (#1202): 외부 서비스가 이 워크스페이스의 채널로 알림을 보내도록 수신
// 주소를 발급하고, 폐기하고, 비밀값을 회전한다.
//
// 이식 원본은 macOS의 MomoWebhookSettingsView / MomoWebhookModels / …RESTClient
// 세 파일이다. 가져온 것은 코드가 아니라 **규율**이다:
//
//   1. 비밀값은 발급 직후 이 화면에서 한 번만 보인다. 서버는 원문을 보관하지
//      않으므로 이 판이 유일한 기회이고, 그래서 발급 카드는 포커스를 받아 폴드
//      아래에서 조용히 사라지지 않는다(InviteSection이 같은 문제를 같은 방식으로
//      푼다 - 코드가 한 번만 돌아오는 그 카드).
//   2. 폐기는 되돌릴 수 없으므로 두 단계다. 한 번의 무방비 클릭으로 살아 있는
//      수신 주소가 죽는 일은 없다.
//   3. 권한은 서버가 판정한다. 목록 GET이 403이면 "누가 할 수 있는가"를 말하고,
//      역할을 클라이언트가 추측해서 폼을 미리 잠그지 않는다(설정 셸의 규약).
//
// mac이 시트로 하던 것을 웹은 인라인 카드로 한다. 모달은 이 셸의 어휘가 아니고,
// 섹션을 벗어나면 컴포넌트가 언마운트되며 비밀값이 함께 사라지는 편이 "네비게이션
// 잠금"보다 이 매체에서 더 정확한 보장이다.
//
// 계약 정본은 docs/api/openapi.yaml의 `webhooks` 태그다. 여기서 새로 만든 와이어는
// 없다.
// =============================================================================

/** 회전한 이전 비밀값이 만료되기까지. 스펙 기본값이자 mac이 쓰던 값. */
const ROTATE_OVERLAP = WEBHOOK_ROTATE_OVERLAP_SECONDS;

interface Revealed {
  credential: RevealedWebhookCredential;
  from: "create" | "rotate";
}

export function WebhookSection({
  workspaceId,
  memberId,
  offline,
}: {
  workspaceId: string;
  memberId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const webhooks = useQuery({
    queryKey: ["settings", "webhooks", workspaceId],
    queryFn: async () => parseInstallations(await listWebhookInstallations(workspaceId)),
    retry: false,
  });
  const { groups } = useChannels(workspaceId);
  const { directory } = useDirectory(workspaceId);

  const [channelId, setChannelId] = useState("");
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<WebhookMode>("native");
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  // 발급 카드는 폴드 아래에 렌더될 수 있는데, 그 카드가 비밀값을 볼 수 있는
  // 유일한 순간이다. 나타나는 즉시 포커스를 옮겨 시각·키보드 사용자 모두에게
  // 착지시킨다(InviteSection의 같은 처리와 같은 이유).
  const revealRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (revealed && revealRef.current) {
      revealRef.current.focus({ preventScroll: true });
      revealRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [revealed]);

  const channelChoices = useMemo(() => {
    const named = groups.channels.map((channel) => ({
      id: channel.id,
      label: `#${channelLabel(channel, directory, memberId)}`,
    }));
    const dms = groups.dms.map((channel) => ({
      id: channel.id,
      label: channelLabel(channel, directory, memberId),
    }));
    return [...named, ...dms];
  }, [groups.channels, groups.dms, directory, memberId]);

  // 고른 값이 없으면 첫 채널. 파생이라 효과가 필요 없고, 목록이 늦게 도착해도
  // "선택 없음"으로 굳지 않는다.
  const targetChannelId = channelId || channelChoices[0]?.id || "";

  const serverBaseUrl = resolveServerBaseUrl();

  const create = useMutation({
    mutationFn: async () => {
      const wire = await createWebhookInstallation(workspaceId, {
        channelId: targetChannelId,
        mode,
        label: normalizeWebhookLabel(label),
      });
      return parseRevealedCredential(wire, { channelId: targetChannelId, mode });
    },
    onSuccess: (credential) => {
      setRevealed({ credential, from: "create" });
      setActionError(null);
      setLabel("");
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    // 실패는 열려 있던 카드를 지우지 않는다. 아무것도 발급되지 않았으므로 앞선
    // 비밀값은 여전히 유효하고, 저장하지 못한 사람에게서 그것을 빼앗을 이유가 없다.
    onError: (error) => setActionError(webhookFailureMessage("create", error)),
  });

  const rotate = useMutation({
    // 한 번에 한 값만 화면에 둔다: 새 비밀값을 받으러 가는 순간, 앞선 카드는
    // 곧 대체될 값을 저장하라고 말하는 판이 된다.
    onMutate: () => setRevealed(null),
    mutationFn: async (installation: WebhookInstallation) => {
      const wire = await rotateWebhookSecret(
        workspaceId,
        installation.id,
        ROTATE_OVERLAP
      );
      return parseRevealedCredential(wire, { installationId: installation.id });
    },
    onSuccess: (credential) => {
      setRevealed({ credential, from: "rotate" });
      setActionError(null);
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    onError: (error) => setActionError(webhookFailureMessage("rotate", error)),
  });

  function forgetCredential() {
    setRevealed(null);
    // 상태에서 지우는 것만으로는 절반이다: react-query의 mutation 캐시가 같은
    // 객체를 들고 있으므로, 저장을 마쳤다는 신호는 두 사본을 함께 놓아야 한다.
    create.reset();
    rotate.reset();
  }

  const revoke = useMutation({
    mutationFn: async (installation: WebhookInstallation) =>
      parseRevokedInstallation(
        await revokeWebhookInstallation(workspaceId, installation.id),
        installation.id
      ),
    onSuccess: (installation) => {
      setActionError(null);
      // 폐기한 웹훅의 비밀값이 화면에 남아 있으면, 그 값은 이미 아무것도 열지
      // 못하는데 저장할 가치가 있는 것처럼 보인다.
      if (revealed?.credential.installation.id === installation.id) {
        forgetCredential();
      }
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    onError: (error) => setActionError(webhookFailureMessage("revoke", error)),
  });

  const busy = create.isPending || rotate.isPending || revoke.isPending;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const issue = webhookLabelIssue(label);
    if (issue) {
      setFormError(webhookLabelIssueMessage(issue));
      return;
    }
    if (!targetChannelId) {
      setFormError("받을 채널을 먼저 고르세요.");
      return;
    }
    setFormError(null);
    setActionError(null);
    setRevealed(null);
    create.mutate();
  }

  const lines = [
    "외부 서비스가 이 워크스페이스의 채널로 알림을 보내도록 수신 주소를 발급합니다.",
    "비밀값은 발급 직후 한 번만 보입니다. 서버는 원문을 보관하지 않습니다.",
  ];

  if (webhooks.isPending) {
    return (
      <SectionShell title="웹훅" lines={lines}>
        <SkeletonRows rows={4} />
      </SectionShell>
    );
  }

  if (webhooks.isError) {
    return (
      <SectionShell title="웹훅" lines={lines}>
        {isWebhookOperatorDenied(webhooks.error) ? (
          <OperatorNotice
            who="웹훅은 워크스페이스 오너나 관리자만 만들고 폐기할 수 있습니다."
            contact="수신 주소가 필요하면 워크스페이스 관리자에게 요청하세요."
          />
        ) : (
          <InlineBanner
            message={webhookFailureMessage("list", webhooks.error)}
            actionLabel="다시 시도"
            onAction={() => void webhooks.refetch()}
            testId="webhook-error"
          />
        )}
      </SectionShell>
    );
  }

  const rows = webhooks.data;

  return (
    <SectionShell title="웹훅" lines={lines}>
      <div className="flex min-w-0 flex-col gap-4" data-testid="webhook-section">
        {revealed && (
          <RevealCard
            innerRef={revealRef}
            revealed={revealed}
            serverBaseUrl={serverBaseUrl}
            onDone={forgetCredential}
          />
        )}

        {actionError && (
          <p className="break-keep text-meta text-danger" role="alert">
            {actionError}
          </p>
        )}

        {rows.length === 0 ? (
          <EmptyInvite
            headline="아직 만든 웹훅이 없습니다."
            detail="아래에서 받을 채널과 수신 방식을 정하면 수신 주소가 발급됩니다."
            className="px-0"
            testId="webhook-empty"
          />
        ) : (
          <ul
            className="flex flex-col rounded-md border border-line"
            data-testid="webhook-list"
          >
            {rows.map((installation) => (
              <WebhookRow
                key={installation.id}
                installation={installation}
                workspaceId={workspaceId}
                serverBaseUrl={serverBaseUrl}
                channelName={
                  channelChoices.find((choice) => choice.id === installation.channelId)
                    ?.label ?? "채널을 찾을 수 없음"
                }
                busy={busy}
                offline={offline}
                onRotate={() => rotate.mutate(installation)}
                onRevoke={() => revoke.mutate(installation)}
              />
            ))}
          </ul>
        )}

        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={submit}
          data-testid="webhook-create-form"
        >
          <Subsection
            title="웹훅 만들기"
            lines={["발급된 비밀값은 이 화면을 벗어나면 다시 볼 수 없습니다."]}
          >
            <div className="flex min-w-0 flex-col gap-3">
              <SelectField
                id="webhook-channel"
                label="받을 채널"
                value={targetChannelId}
                choices={
                  channelChoices.length > 0
                    ? channelChoices
                    : [{ id: "", label: "받을 수 있는 채널이 없습니다", disabled: true }]
                }
                onChange={setChannelId}
                disabled={create.isPending}
                testId="webhook-channel"
              />

              <Field
                label="이름"
                htmlFor="webhook-label"
                hint={`목록에서 이 웹훅을 구별하는 값입니다. ${WEBHOOK_LABEL_MAX}자까지.`}
                error={formError}
              >
                <Input
                  id="webhook-label"
                  name="label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="배포 알림 (GitHub Actions)"
                  className="w-full max-w-pane"
                  disabled={create.isPending}
                  data-testid="webhook-label"
                />
              </Field>

              <ChoiceRadios
                name="webhook-mode"
                legend="수신 방식"
                choices={WEBHOOK_MODES.map((choice) => ({ ...choice }))}
                value={mode}
                onChange={(next) => setMode(next as WebhookMode)}
                disabled={create.isPending}
                testId="webhook-mode"
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={offline || busy || channelChoices.length === 0}
                  data-testid="webhook-create"
                >
                  {create.isPending ? "만드는 중" : "웹훅 만들기"}
                </Button>
              </div>
            </div>
          </Subsection>
        </form>

        <IngressNotes />
      </div>
    </SectionShell>
  );
}

/**
 * 한 줄 = 한 웹훅. 행마다 상자를 두르지 않는다: 카드는 묶음을 뜻하고 여기서
 * 묶이는 것은 목록 전체다.
 */
function WebhookRow({
  installation,
  workspaceId,
  serverBaseUrl,
  channelName,
  busy,
  offline,
  onRotate,
  onRevoke,
}: {
  installation: WebhookInstallation;
  workspaceId: string;
  serverBaseUrl: string;
  channelName: string;
  busy: boolean;
  offline: boolean;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const status = webhookStatusChip(installation.status);
  const receiveUrl = installationReceiveUrl(
    installation,
    workspaceId,
    serverBaseUrl
  );
  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      data-testid="webhook-row"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-keep text-body font-medium text-ink">
          {installation.label}
        </span>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
        <span className="text-meta text-ink-muted">
          {webhookModeName(installation.mode)}
        </span>
        <span className="min-w-0 truncate text-meta text-ink-muted">
          {channelName}
        </span>
        <span className="text-meta text-ink-muted" data-numeric>
          {webhookCreatedLabel(installation.createdAtMs)}
        </span>
      </div>

      {installation.mode === "slack_compatible" &&
        installation.status === "active" && (
          <p className="break-keep text-meta text-ink-muted">
            {SLACK_URL_RECOVERY_HINT}
          </p>
        )}

      {installation.status === "active" && (
        <div className="flex flex-wrap items-center gap-2">
          {receiveUrl && (
            <CopyButton
              value={receiveUrl}
              label="수신 URL 복사"
              subject={installation.label}
              testId={`webhook-copy-${installation.id}`}
            />
          )}
          <ConfirmButton
            label="비밀값 회전"
            ariaLabel={`${installation.label} 비밀값 회전`}
            question={rotateConfirmQuestion()}
            confirmLabel="회전"
            confirmTone="secondary"
            disabled={busy || offline}
            onConfirm={onRotate}
            testId={`webhook-rotate-${installation.id}`}
          />
          <ConfirmButton
            label="폐기"
            ariaLabel={`${installation.label} 폐기`}
            question={revokeConfirmQuestion(installation.label)}
            confirmLabel="폐기"
            disabled={busy || offline}
            onConfirm={onRevoke}
            testId={`webhook-revoke-${installation.id}`}
          />
        </div>
      )}
    </li>
  );
}

/**
 * 한 번만 보이는 값.
 *
 * 서명 비밀과 수신 URL은 각자 이름표가 붙은 자기 블록을 갖는다. `revealDetailRows`
 * 가 돌려주는 일반 행 목록에는 둘 다 들어 있지 않고(코어 테스트가 그 부재를 단정),
 * 그래서 "행을 하나 더 추가"하는 습관만으로 비밀값이 일반 목록에 섞이지 않는다.
 */
function RevealCard({
  innerRef,
  revealed,
  serverBaseUrl,
  onDone,
}: {
  innerRef: React.MutableRefObject<HTMLDivElement | null>;
  revealed: Revealed;
  serverBaseUrl: string;
  onDone: () => void;
}) {
  const { credential, from } = revealed;
  const mode = credential.installation.mode;
  const receiveUrl = resolveReceiveUrl(credential.url, serverBaseUrl);
  return (
    <div
      ref={innerRef}
      tabIndex={-1}
      role="status"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid="webhook-revealed"
    >
      <p className="break-keep text-body font-medium text-ink">
        {revealHeadline(mode)}
      </p>
      <p className="break-keep text-body text-ink-muted">{revealWarning(mode)}</p>
      {from === "rotate" && (
        <p className="break-keep text-meta text-ink-muted">
          이전 비밀값은 아래 만료 시각까지 계속 받습니다. 보내는 쪽을 그 전에
          바꾸세요.
        </p>
      )}

      <KeyValueRows
        rows={[
          {
            key: "수신 URL",
            value: receiveUrl ?? "서버가 이 서버 주소로 해석되는 수신 URL을 주지 않았습니다.",
            numeric: receiveUrl !== null,
            prose: receiveUrl === null,
          },
        ]}
      />

      {credential.secret && (
        <KeyValueRows
          rows={[{ key: "서명 비밀", value: credential.secret, numeric: true }]}
        />
      )}

      <KeyValueRows rows={revealDetailRows(credential)} />

      <div className="flex flex-wrap items-center gap-2">
        {receiveUrl && (
          <CopyButton
            value={receiveUrl}
            label="수신 URL 복사"
            testId="webhook-copy-revealed-url"
          />
        )}
        {credential.secret && (
          <CopyButton
            value={credential.secret}
            label="서명 비밀 복사"
            testId="webhook-copy-secret"
          />
        )}
        <Button
          type="button"
          size="sm"
          onClick={onDone}
          data-testid="webhook-reveal-done"
        >
          저장했습니다
        </Button>
      </div>
    </div>
  );
}

/**
 * 전송이 실패할 때.
 *
 * 인바운드 웹훅에는 전송 시도 기록 리소스가 없다(openapi의 `webhooks` 태그에
 * 그런 경로가 없고, `deliveryFailureCount`는 이벤트 구독이라는 다른 표면의
 * 필드다). 그래서 없는 기록을 있는 것처럼 그리는 대신, 보낸 쪽이 실제로 받은
 * 거절 코드가 무엇을 뜻하는지를 여기서 말한다. 접어 두는 이유는 이것이 평소에
 * 필요 없는 참고 자료이고, 필요해지는 순간에는 바로 이 화면에 있기 때문이다.
 */
function IngressNotes() {
  return (
    <details
      className="min-w-0 rounded-md border border-line"
      data-testid="webhook-ingress-notes"
    >
      <summary className="cursor-pointer px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        전송이 실패할 때 무엇을 확인하나
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        <p className="break-keep text-meta text-ink-muted">
          받은 전송은 채널의 메시지로 남습니다. 거절된 전송은 보낸 쪽에 코드로만
          돌아가고, 이 화면에는 기록이 남지 않습니다.
        </p>
        {WEBHOOK_MODES.map((choice) => (
          <div key={choice.id} className="flex min-w-0 flex-col gap-1">
            <h4 className="text-meta font-medium text-ink">{choice.label}</h4>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {webhookIngressNotes(choice.id).map((note) => (
                <li key={note} className="break-keep text-meta text-ink-muted">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
