import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
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
  UNRESOLVABLE_RECEIVE_URL_NOTICE,
  webhookCreatedLabel,
  webhookFailureMessage,
  webhookIngressNotes,
  webhookLabelIssue,
  webhookLabelIssueMessage,
  webhookModeName,
  webhookRevokedLabel,
  webhookStatusChip,
  WEBHOOK_DELIVERY_RECORD_NOTE,
  WEBHOOK_INGRESS_NOTES_LABEL,
  WEBHOOK_LABEL_MAX,
  WEBHOOK_MODES,
  WEBHOOK_ROTATE_OVERLAP_SECONDS,
  type RevealedWebhookCredential,
  type WebhookInstallation,
  type WebhookMode,
} from "@momo/core/features/webhooks/model";
import {
  ChoiceRadios,
  CopyButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  SelectField,
  StatusChip,
  Subsection,
} from "./SettingsFields";
import {
  CREDENTIAL_MUTATION_SCOPE,
  purgeWebhookCredentials,
} from "./webhookCredentialScope";

// =============================================================================
// 웹훅 (#1202): 외부 서비스가 이 워크스페이스의 채널로 알림을 보내도록 수신
// 주소를 발급하고, 폐기하고, 비밀값을 회전한다.
//
// 이식 원본은 macOS의 MomoWebhookSettingsView / MomoWebhookModels / …RESTClient
// 세 파일이다. 가져온 것은 코드가 아니라 **규율**이다:
//
//   1. 비밀값은 발급 직후 이 화면에서 한 번만 보인다. 서버는 원문을 보관하지
//      않으므로 이 판이 유일한 기회이고, 그래서 발급 카드는 포커스를 받아 폴드
//      아래에서 조용히 사라지지 않는다.
//   2. 폐기는 되돌릴 수 없으므로 두 단계다. 한 번의 무방비 클릭으로 살아 있는
//      수신 주소가 죽는 일은 없다.
//   3. 권한은 서버가 판정한다. 목록 GET이 403이면 "누가 할 수 있는가"를 말하고,
//      역할을 클라이언트가 추측해서 폼을 미리 잠그지 않는다.
//
// mac이 시트로 하던 것을 웹은 인라인 카드로 한다. 모달은 이 셸의 어휘가 아니다.
//
// ## 비밀값의 수명은 컴포넌트가 **명시적으로** 끝낸다 (리뷰 B1)
//
// 이 자리에는 원래 "섹션을 벗어나면 언마운트되며 비밀값도 함께 사라진다"고
// 적혀 있었고, 그 문장이 모달을 쓰지 않은 근거였다. **틀렸다.** React 상태는
// 사라지지만 mutation 결과는 세션 수명의 MutationCache 에 남고, 기본 gcTime 은
// 브라우저에서 5분이다(실측 300000ms). 「저장했습니다」 없이 떠난 사람은 원문을
// 메모리에 남긴 채 떠났다.
//
// 그래서 지금은 언마운트가 보장이 아니라 **트리거**다: 아래 정리 효과가
// `purgeWebhookCredentials` 로 캐시를 동기적으로 비우고, 두 mutation 은
// `CREDENTIAL_MUTATION_SCOPE`(gcTime 0 + 전용 키)를 달아 그 규율의 대상임을
// 선언한다. 근거와 red proof 는 ./webhookCredentialScope.ts 와 그 테스트에.
//
// 계약 정본은 docs/api/openapi.yaml의 `webhooks` 태그다. 새로 만든 와이어는 없다.
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
  const [labelError, setLabelError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  /** 폐기 직후 그 행으로 포커스를 보낸다: 바뀐 것을 읽어 주는 자리가 그 행이다. */
  const [changedRowId, setChangedRowId] = useState<string | null>(null);

  // 발급 카드는 폴드 아래에 렌더될 수 있는데, 그 카드가 비밀값을 볼 수 있는
  // 유일한 순간이다. 나타나는 즉시 포커스를 옮겨 시각·키보드 사용자 모두에게
  // 착지시킨다.
  const revealRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (revealed && revealRef.current) {
      revealRef.current.focus({ preventScroll: true });
      revealRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [revealed]);

  // B1: 언마운트(섹션 전환·설정 닫기·라우트 이탈)에서 캐시에 남은 원문을 비운다.
  // 「저장했습니다」를 누르지 않고 떠나는 경로가 정확히 이것이고, 그 경로에만
  // 보장이 없었다.
  useEffect(() => () => void purgeWebhookCredentials(client), [client]);

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
    ...CREDENTIAL_MUTATION_SCOPE,
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
      setCreateError(null);
      setLabel("");
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    // 실패는 열려 있던 카드를 지우지 않는다. 아무것도 발급되지 않았으므로 앞선
    // 비밀값은 여전히 유효하고, 저장하지 못한 사람에게서 그것을 빼앗을 이유가 없다.
    onError: (error) => setCreateError(webhookFailureMessage("create", error)),
  });

  const rotate = useMutation({
    ...CREDENTIAL_MUTATION_SCOPE,
    // 한 번에 한 값만 화면에 둔다: 새 비밀값을 받으러 가는 순간, 앞선 카드는
    // 곧 대체될 값을 저장하라고 말하는 판이 된다. 지우는 것은 화면만이 아니다.
    onMutate: () => {
      setRevealed(null);
      purgeWebhookCredentials(client);
    },
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
      setRowError(null);
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    onError: (error) => setRowError(webhookFailureMessage("rotate", error)),
  });

  /** 저장을 마쳤다는 신호. 상태와 캐시 두 사본을 함께 놓고 포커스를 돌려준다. */
  function forgetCredential() {
    const from = revealed?.from;
    const installationId = revealed?.credential.installation.id;
    setRevealed(null);
    purgeWebhookCredentials(client);
    // 온 길로 돌려보낸다: 회전은 그 행의 트리거로, 발급은 다음 발급을 시작할
    // 이름 칸으로. 카드가 사라진 자리에 포커스를 버리면 <body> 로 떨어진다.
    if (from === "rotate" && installationId) {
      const trigger = document.querySelector<HTMLElement>(
        `[data-testid="webhook-rotate-${installationId}"]`
      );
      if (trigger) {
        trigger.focus();
        return;
      }
    }
    labelRef.current?.focus();
  }

  const revoke = useMutation({
    mutationFn: async (installation: WebhookInstallation) =>
      parseRevokedInstallation(
        await revokeWebhookInstallation(workspaceId, installation.id),
        installation.id
      ),
    onSuccess: (installation) => {
      setRowError(null);
      // 폐기한 웹훅의 비밀값이 화면에 남아 있으면, 그 값은 이미 아무것도 열지
      // 못하는데 저장할 가치가 있는 것처럼 보인다.
      if (revealed?.credential.installation.id === installation.id) {
        setRevealed(null);
        purgeWebhookCredentials(client);
      }
      setChangedRowId(installation.id);
      void client.invalidateQueries({
        queryKey: ["settings", "webhooks", workspaceId],
      });
    },
    onError: (error) => setRowError(webhookFailureMessage("revoke", error)),
  });

  const busy = create.isPending || rotate.isPending || revoke.isPending;
  const submitBlocked = offline || busy || channelChoices.length === 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // aria-disabled 는 클릭을 막지 않는다(그것이 요점이다 - 포커스를 잃지 않는다).
    // 그래서 거절은 여기서 한다.
    if (submitBlocked) return;
    const issue = webhookLabelIssue(label);
    if (issue) {
      setLabelError(webhookLabelIssueMessage(issue));
      labelRef.current?.focus();
      return;
    }
    if (!targetChannelId) {
      setCreateError("받을 채널을 먼저 고르세요.");
      return;
    }
    setLabelError(null);
    setCreateError(null);
    setRevealed(null);
    purgeWebhookCredentials(client);
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

        {rowError && (
          <p className="break-keep text-meta text-danger" role="alert">
            {rowError}
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
                takeFocus={changedRowId === installation.id}
                onFocusTaken={() => setChangedRowId(null)}
                onRotate={() => rotate.mutate(installation)}
                onRevoke={() => revoke.mutate(installation)}
              />
            ))}
          </ul>
        )}

        {/* 이 표면에 전송 기록이 없다는 사실은 접힌 자리에 두지 않는다 (리뷰 H4).
            목록 바로 아래인 것은, 「이 웹훅이 조용한데」라고 생각하는 사람의 눈이
            그 순간 목록에 있기 때문이다. */}
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="webhook-delivery-record-note"
        >
          {WEBHOOK_DELIVERY_RECORD_NOTE}
        </p>

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
              {/* 발급이 도는 동안 `disabled` 를 쓰지 않는다: 포커스를 가진 컨트롤이
                  disabled 가 되면 포커스가 <body> 로 떨어져, 키보드 사용자가 저장
                  때마다 패널 꼭대기로 튕긴다(SettingsFields 의 SaveButton 주석이
                  같은 실패를 기록해 두었다). 대신 진행 중임을 말한다. */}
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
                busy={create.isPending}
                testId="webhook-channel"
              />

              <Field
                label="이름"
                htmlFor="webhook-label"
                hint={`목록에서 이 웹훅을 구별하는 값입니다. ${WEBHOOK_LABEL_MAX}자까지.`}
                error={labelError}
              >
                <Input
                  id="webhook-label"
                  name="label"
                  ref={labelRef}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="배포 알림 (GitHub Actions)"
                  className="w-full max-w-pane"
                  data-testid="webhook-label"
                />
              </Field>

              <ChoiceRadios
                name="webhook-mode"
                legend="수신 방식"
                choices={WEBHOOK_MODES.map((choice) => ({ ...choice }))}
                value={mode}
                onChange={(next) => setMode(next as WebhookMode)}
                busy={create.isPending}
                testId="webhook-mode"
              />

              {/* 실패는 그것을 만든 컨트롤 옆에서 말한다 (리뷰 M3). 패널 꼭대기의
                  한 줄은, 폼 바닥에서 버튼을 누른 사람이 보지 못하는 자리다. */}
              {createError && (
                <p className="break-keep text-meta text-danger" role="alert">
                  {createError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  aria-disabled={submitBlocked || undefined}
                  aria-busy={create.isPending || undefined}
                  className={cn(submitBlocked && "opacity-50")}
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
 *
 * ## 확인 프롬프트는 액션 스트립 **밖**에 산다 (리뷰 H1·H2)
 *
 * 처음에는 공용 `ConfirmButton` 을 행의 `flex-wrap` 안에 그대로 두 개 놓았다.
 * 1280 에서 실측한 결과가 이 구조를 못 쓰게 만든다: 질문(432px 스팬)이 무관한
 * [수신 URL 복사] 오른쪽에 끼고, [폐기]가 줄바꿈되어 질문 **바로 아래** 앉아
 * 질문의 세 번째 답처럼 읽혔다. 그 프레임에서는 회전의 긍정 버튼이 폐기보다
 * 약한 경계(1.32:1 vs 3.59:1)를 갖는 것도 함께 드러난다.
 *
 * 그래서 묻는 동안에는 스트립 자체를 프롬프트가 **대체한다**. 질문은 자기 줄을
 * 갖고, 그 아래에는 그 질문의 답 둘만 있다. 긍정 버튼은 폐기면 --danger-fill,
 * 회전이면 `outline`(--line-strong, tokens.css:33 이 컨트롤에 요구하는 3:1)이다.
 * 위계는 채움으로 말하고, 경계는 어느 쪽에서도 포기하지 않는다.
 */
function WebhookRow({
  installation,
  workspaceId,
  serverBaseUrl,
  channelName,
  busy,
  offline,
  takeFocus,
  onFocusTaken,
  onRotate,
  onRevoke,
}: {
  installation: WebhookInstallation;
  workspaceId: string;
  serverBaseUrl: string;
  channelName: string;
  busy: boolean;
  offline: boolean;
  /** 이 행이 방금 바뀌었다. 포커스가 여기 착지해 새 상태를 읽어 준다. */
  takeFocus: boolean;
  onFocusTaken: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}) {
  const [asking, setAsking] = useState<null | "rotate" | "revoke">(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLLIElement | null>(null);
  const returnTo = useRef<"rotate" | "revoke" | null>(null);

  // 물음이 열리면 포커스가 그 안으로 들어간다. 그래야 그룹 이름(= 질문 전문)이
  // 낭독된다 - 이름만 붙이고 포커스를 <body> 에 두면 2단계 가드가 스크린리더에
  // 존재하지 않는 것과 같다. 착지 지점은 취소다: 되돌릴 수 없는 쪽의 기본 답이
  // Enter 한 번으로 실행되는 것이어서는 안 된다.
  useEffect(() => {
    if (asking) {
      cancelRef.current?.focus();
      return;
    }
    if (returnTo.current) {
      document
        .querySelector<HTMLElement>(
          `[data-testid="webhook-${returnTo.current}-${installation.id}"]`
        )
        ?.focus();
      returnTo.current = null;
    }
  }, [asking, installation.id]);

  useEffect(() => {
    if (takeFocus) {
      rowRef.current?.focus({ preventScroll: true });
      onFocusTaken();
    }
  }, [takeFocus, onFocusTaken]);

  const status = webhookStatusChip(installation.status);
  const receiveUrl = installationReceiveUrl(
    installation,
    workspaceId,
    serverBaseUrl
  );
  const question =
    asking === "revoke"
      ? revokeConfirmQuestion(installation.label)
      : rotateConfirmQuestion(installation.label);

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
          {installation.status === "revoked"
            ? webhookRevokedLabel(installation.updatedAtMs)
            : webhookCreatedLabel(installation.createdAtMs)}
        </span>
      </div>

      {installation.mode === "slack_compatible" &&
        installation.status === "active" && (
          <p className="break-keep text-meta text-ink-muted">
            {SLACK_URL_RECOVERY_HINT}
          </p>
        )}

      {installation.status === "active" &&
        (asking ? (
          <div
            role="group"
            aria-label={question}
            className="flex min-w-0 flex-col gap-2 rounded-sm border border-line bg-surface-hover p-3"
            data-testid={`webhook-ask-${installation.id}`}
          >
            <p className="break-keep text-body text-ink">{question}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={asking === "revoke" ? "destructive" : "outline"}
                disabled={busy}
                onClick={() => {
                  const kind = asking;
                  setAsking(null);
                  if (kind === "revoke") onRevoke();
                  else onRotate();
                }}
                data-testid={`webhook-${asking}-${installation.id}-confirm`}
              >
                {asking === "revoke" ? "폐기" : "회전"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                ref={cancelRef}
                onClick={() => {
                  returnTo.current = asking;
                  setAsking(null);
                }}
                data-testid={`webhook-${asking}-${installation.id}-cancel`}
              >
                취소
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {receiveUrl && (
              <CopyButton
                value={receiveUrl}
                label="수신 URL 복사"
                subject={installation.label}
                testId={`webhook-copy-${installation.id}`}
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || offline}
              onClick={() => setAsking("rotate")}
              data-testid={`webhook-rotate-${installation.id}`}
            >
              비밀값 회전
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || offline}
              onClick={() => setAsking("revoke")}
              data-testid={`webhook-revoke-${installation.id}`}
            >
              폐기
            </Button>
          </div>
        ))}
    </li>
  );
}

/**
 * 한 번만 보이는 값.
 *
 * 서명 비밀과 수신 URL은 각자 이름표가 붙은 자기 블록을 갖는다. `revealDetailRows`
 * 가 돌려주는 일반 행 목록에는 둘 다 들어 있지 않고(코어 테스트가 그 부재를 단정),
 * 그래서 "행을 하나 더 추가"하는 습관만으로 비밀값이 일반 목록에 섞이지 않는다.
 *
 * `role="status"` 가 아니라 이름 붙은 `group` 인 이유 (리뷰 M2): status 는 암묵적
 * live region 이라 카드가 뜨는 순간 33자 비밀값이 **자동으로 낭독된다.** 값이
 * 도착했다는 사실과 그 값이 어디 있는지를 알리는 데 값 자체를 읽을 필요는 없다.
 * 포커스가 이 컨테이너로 들어오면 이름(= 저장하라는 지시)이 낭독되고, 비밀값은
 * 사용자가 그 줄로 이동할 때 읽힌다.
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
      role="group"
      aria-label={revealHeadline(mode)}
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
            value: receiveUrl ?? UNRESOLVABLE_RECEIVE_URL_NOTICE,
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
 * 보낸 쪽이 받은 거절 코드.
 *
 * 인바운드 웹훅에는 전송 시도 기록 리소스가 없다(openapi의 `webhooks` 태그에
 * 그런 경로가 없고, `deliveryFailureCount`는 이벤트 구독이라는 다른 표면의
 * 필드다). 그 사실 자체는 위쪽 평문이 말하고, 여기에는 참고표만 남는다.
 * 접어 두는 이유는 이것이 평소에 필요 없는 자료이고, 필요해지는 순간에는 바로
 * 이 화면에 있기 때문이다.
 *
 * 모드 이름을 `h4` 가 아니라 굵은 문단으로 두는 이유 (리뷰 N2): `summary` 는
 * 제목이 아니므로 h4 는 존재하지 않는 h3 아래 중첩을 문서 구조에 주장하게 된다.
 * 이 둘은 목록의 이름표이지 문서의 절이 아니다.
 */
function IngressNotes() {
  return (
    <details
      className="min-w-0 rounded-md border border-line"
      data-testid="webhook-ingress-notes"
    >
      <summary className="cursor-pointer px-3 py-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        {WEBHOOK_INGRESS_NOTES_LABEL}
      </summary>
      <div className="flex flex-col gap-3 border-t border-line p-3">
        {WEBHOOK_MODES.map((choice) => (
          <div key={choice.id} className="flex min-w-0 flex-col gap-1">
            <p className="text-meta font-medium text-ink">{choice.label}</p>
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
