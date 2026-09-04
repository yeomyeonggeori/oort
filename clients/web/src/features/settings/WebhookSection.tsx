import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useEscapeGuard, useEscapeLayer } from "@/design/ui/escapeLayer";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { channelLabel, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { resolveServerBaseUrl } from "@momo/core/features/settings/api";
import {
  createWebhookInstallation,
  revokeWebhookInstallation,
  rotateWebhookSecret,
} from "@momo/core/features/webhooks/api";
import {
  installationReceiveUrl,
  isWebhookOperatorDenied,
  normalizeWebhookLabel,
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
  SETTINGS_COLLAPSIBLE_CARD_CLASS,
  SETTINGS_COLLAPSIBLE_SUMMARY_CLASS,
  StatusChip,
  Subsection,
} from "./SettingsFields";
import {
  CREDENTIAL_MUTATION_SCOPE,
  purgeWebhookCredentials,
  webhookListQuery,
  webhookListQueryKey,
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
// ## 비밀값을 붙잡을 수 있는 것이 이 화면보다 오래 살지 않는다 (리뷰 B1 · R2)
//
// 이 자리에 두 번 틀린 문장이 있었다. 1차는 "섹션을 벗어나면 언마운트되며
// 비밀값도 함께 사라진다" — mutation 결과가 세션 수명 MutationCache 에 5분
// 남았다. 2차는 그 캐시를 닫고 "화면보다 오래 사는 것을 막는다"고 적었는데,
// 힙 스냅샷은 원문이 **여전히 5분을 살고 있다**고 답했다. 붙잡고 있던 것은
// 캐시에 담긴 본문이 아니라 캐시에 얹힌 **클로저**였다: 컴포넌트 안에서 만든
// 목록 쿼리의 `queryFn` 이 렌더 스코프를 통째로 캡처했고, 그 쿼리가 관찰자 0
// 이후 자기 gcTime 타이머에 붙잡혀 있었다.
//
// 그래서 지금 규율은 둘이고, 둘 다 ./webhookCredentialScope.ts 가 소유한다:
//   - 쿼리 옵션은 **모듈 스코프**에서 만든다(`webhookListQuery`). 이 컴포넌트는
//     쿼리 함수를 짓지 않는다 — 지으면 그 클로저가 이 렌더 스코프를 캡처한다.
//   - 이 표면의 mutation 셋은 전부 `CREDENTIAL_MUTATION_SCOPE`(gcTime 0 + 전용
//     키)를 달고, 언마운트에서 `purgeWebhookCredentials` 가 동기로 비운다.
//
// 이 문장들이 참인지는 파일 안에서 증명되지 않는다. 힙에서 잰다:
// `npm run build && npm run gate:webhook` — 카드가 떠 있는 동안 원문이 힙에
// 있고(측정이 볼 수 있다는 증명), 떠난 뒤에는 강제 GC 후 없다.
//
// ## Esc 는 이 화면의 것이 아니다 (리뷰 R2 신규 H)
//
// 되돌릴 수 없는 것 둘이 이 표면에 있다: 파괴 확인과, 서버가 원문을 보관하지
// 않는 발급 카드. 설정 셸의 Esc 는 라우트를 닫으므로, 확인 중의 Esc 도 카드가
// 떠 있는 중의 Esc 도 그 값을 아무 확인 없이 없앴다(실측). 이제 두 상태가 각각
// Esc 층을 잡는다 — 확인은 취소로 닫히고(확인 프롬프트의 표준 의미), 카드는
// **삼킨다**(다시 만들 수 없는 값 앞에서 Esc 의 올바른 뜻은 무반응이다).
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
  // 옵션이 모듈 스코프에서 오는 이유는 머리말에 있다: 여기서 `queryFn` 을 지으면
  // 그 클로저가 이 렌더 스코프(= `revealed` 가 사는 곳)를 캡처하고, 쿼리는
  // 관찰자가 떨어진 뒤에도 자기 gcTime 만큼 그것을 붙잡는다.
  const webhooks = useQuery(webhookListQuery(workspaceId));
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

  // 카드가 떠 있는 동안 Esc 는 아무 일도 하지 않는다 (R2 신규 H). 삼키지 않으면
  // 설정 셸이 그 Esc 로 라우트를 닫고, 서버가 보관하지 않는 값이 확인 한 번 없이
  // 사라진다. 나가는 길은 이 카드가 이미 이름으로 갖고 있다 — 「저장했습니다」.
  useEscapeGuard(revealed !== null);

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
        queryKey: webhookListQueryKey(workspaceId),
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
        queryKey: webhookListQueryKey(workspaceId),
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
    // 폐기는 비밀값을 실어 나르지 않는다. 그래도 같은 스코프를 다는 이유는
    // 아래 `onSuccess` 가 `revealed` 를 읽기 때문이다 — 이 콜백이 세션 수명
    // 캐시에 남으면 그 렌더 스코프가, 따라서 원문이 함께 남는다. 캐시가 붙잡는
    // 것은 본문만이 아니다(./webhookCredentialScope.ts 머리말).
    ...CREDENTIAL_MUTATION_SCOPE,
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
        queryKey: webhookListQueryKey(workspaceId),
      });
    },
    onError: (error) => setRowError(webhookFailureMessage("revoke", error)),
  });

  const busy = create.isPending || rotate.isPending || revoke.isPending;
  // 진행과 잠금은 다른 축이다 (#1486 회전 · #1541 · #1558 · #1559 회전 1).
  //
  // 이 폼은 `submitBlocked = offline || busy || 채널 없음` 한 식으로 그 둘을
  // 접고 있었다. `busy` 가 자기 `create.isPending` 을 포함하므로, **자기 발급이
  // 날고 있는 동안** 이 버튼은 「만드는 중」과 `aria-busy` 를 들면서 동시에
  // `aria-disabled` 와 `opacity-50` 을 걸었다 — #1558 이 정본 `SaveButton` 에서
  // 걷어낸 바로 그 프레임이, 그 파도가 지나간 자리 옆에서 별칭(`submitBlocked`)
  // 뒤에 숨어 살아남았다. 아래 `rotateLocked`/`revokeLocked` 와 같은 모양으로
  // 가른다: 잠그는 것은 오프라인·받을 채널 없음·**남의** 쓰기뿐이다.
  const creating = create.isPending;
  const noChannels = channelChoices.length === 0;
  const createLocked = offline || noChannels || (busy && !creating);
  // 지금 날고 있는 쓰기가 **어느 줄의 것**인가 (#1559). `busy` 는 섹션 전체의
  // 사실이라 그대로 줄에 넘기면 스무 줄이 함께 진행 낱말을 든다. 좁히는 열쇠는
  // 뮤테이션이 들고 있는 인자다 — #1502 가 삭제에, #1541 이 켜고 끄기에 쓴 것과
  // 같은 좁히기(`variables`).
  const rotatingId = rotate.isPending ? rotate.variables?.id : undefined;
  const revokingId = revoke.isPending ? revoke.variables?.id : undefined;
  const offlineReasonId = useId();
  const busyReasonId = useId();
  // 만들기의 사유 셋. 목록의 두 문장과 **다른 노드**인 이유는 문장이 다르기
  // 때문이다: 목록의 것은 「이어서 회전하거나 폐기할 수 있습니다」라고 끝나고,
  // 이 폼이 못 하는 일은 만들기다. 그리고 목록의 두 문장은 `rows.length > 0`
  // 에서만 서므로, 웹훅이 하나도 없는 빈 상태에서 그것을 가리키면 화면에 없는
  // id 를 가리키게 된다 — 이 표면의 주 CTA 가 무사유 회색으로 서 있던 자리가
  // 정확히 그 프레임이다 (design-review #1595 H2 · design-system §4).
  const createOfflineReasonId = useId();
  const createNoChannelReasonId = useId();
  const createBusyReasonId = useId();

  /**
   * 한 잠금에 한 문장 (#1542 규율). 오프라인이 먼저인 것은 이 파일의
   * `WebhookRow.lockReason` 이 이미 그렇게 정한 것과 같은 이유다 — 오프라인이면
   * 채널을 만드는 일도 앞선 쓰기도 어차피 도착하지 못하고, 한 파일의 같은 자리가
   * 다른 순서를 쓰면 다음 사람은 그 차이가 의도인지 알 수 없다. 자기 발급이 날고
   * 있는 동안에는 사유를 들지 않는다: 진행 중에 「왜 못 하는지」를 읽어 주면 지금
   * 그것을 하지 못한다는 뜻이 된다.
   */
  function createLockReason(): string | undefined {
    if (offline) return createOfflineReasonId;
    if (noChannels) return createNoChannelReasonId;
    return busy && !creating ? createBusyReasonId : undefined;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // aria-disabled 는 클릭도 Enter 도 막지 않는다(그것이 요점이다 - 포커스를
    // 잃지 않는다). 그래서 거절은 여기서 한다. 이름 칸에서 누른 Enter(암묵적
    // 제출)도 같은 발급을 내므로 가드는 `onClick` 이 아니라 폼이 진다.
    if (createLocked || creating) return;
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
        <Skeleton ready={false} rows={4} />
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
                rotating={rotatingId === installation.id}
                revoking={revokingId === installation.id}
                offline={offline}
                offlineReasonId={offlineReasonId}
                busyReasonId={busyReasonId}
                takeFocus={changedRowId === installation.id}
                onFocusTaken={() => setChangedRowId(null)}
                onRotate={() => rotate.mutate(installation)}
                onRevoke={() => revoke.mutate(installation)}
              />
            ))}
          </ul>
        )}

        {/* 잠긴 줄들이 가리키는 두 사유 (#1542 동형 · #1559). 같은 자리에 서고 한
            번에 하나만 그려진다 — 한 잠금에 두 이유를 대면 어느 쪽도 답이 아니다.

            줄 **안**이 아니라 목록 바로 아래인 것은 이 파일의 구조 때문이다:
            확인 프롬프트가 열리면 그 줄의 액션 스트립을 통째로 대체하므로(위
            docstring 의 리뷰 H1·H2), 문장을 스트립 안에 두면 누군가 묻기 시작하는
            순간 나머지 줄들의 `aria-describedby` 가 화면에 없는 id 를 가리키게
            된다 — 없는 문장을 가리키는 describedby 는 사유가 아니라 침묵이다.
            목록 밖에 한 번 쓰면 스무 줄이 같은 문장을 스무 번 되풀이하지도
            않는다. */}
        {rows.length > 0 && offline && (
          <p
            id={offlineReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="webhook-rows-offline"
          >
            {OFFLINE_ROW_REASON}
          </p>
        )}
        {rows.length > 0 && !offline && busy && (
          <p
            id={busyReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="webhook-rows-busy"
          >
            {BUSY_ROW_REASON}
          </p>
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

              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* 잠금은 오프라인·받을 채널 없음·**남의** 쓰기 셋이고, 셋 다
                    가리킬 문장을 갖는다. 자기 발급은 잠금이 아니라 진행이므로
                    낱말과 `aria-busy` 만 든다. */}
                <Button
                  type="submit"
                  size="sm"
                  aria-disabled={createLocked || undefined}
                  aria-busy={creating || undefined}
                  aria-describedby={createLockReason()}
                  className={cn(createLocked && "opacity-50")}
                  data-testid="webhook-create"
                >
                  {creating ? "만드는 중" : "웹훅 만들기"}
                </Button>
                {/* 한 번에 하나만 그려진다. 서는 조건은 `createLockReason` 이 그
                    id 를 고르는 조건과 같은 것이어야 하고, 그래야 가리키는 곳에
                    문장이 있다. */}
                {offline && (
                  <span
                    id={createOfflineReasonId}
                    className="break-keep text-meta text-ink-muted"
                    data-testid="webhook-create-offline"
                  >
                    {OFFLINE_CREATE_REASON}
                  </span>
                )}
                {!offline && noChannels && (
                  <span
                    id={createNoChannelReasonId}
                    className="break-keep text-meta text-ink-muted"
                    data-testid="webhook-create-no-channel"
                  >
                    {NO_CHANNEL_CREATE_REASON}
                  </span>
                )}
                {!offline && !noChannels && busy && !creating && (
                  <span
                    id={createBusyReasonId}
                    className="break-keep text-meta text-ink-muted"
                    data-testid="webhook-create-busy"
                  >
                    {BUSY_CREATE_REASON}
                  </span>
                )}
              </div>
            </div>
          </Subsection>
        </form>

        <IngressNotes />
      </div>
    </SectionShell>
  );
}

// --- 목록의 두 사유 (#1542 동형 · #1559) --------------------------------------

/** 뒷절의 동사 둘은 이 줄이 실제로 내놓는 두 행동 그대로다 — 회전과 폐기. */
const OFFLINE_ROW_REASON =
  "연결이 끊겨 지금은 회전하거나 폐기할 수 없습니다.";

/**
 * 낱말이 「회전」이나 「폐기」가 아니라 「누른 것」인 이유는 형제 표면
 * (`EventSubscriptionSection.BUSY_ROW_REASON`)이 적어 둔 것과 같다: 이 잠금을
 * 켜는 쓰기는 셋이고(만들기·회전·폐기) 그중 무엇이 날고 있는지 이 문장은 알지
 * 못한다. 아는 줄은 자기 낱말로 이미 말하고 있고, 이 문장은 **모르는 줄들**의
 * 것이다.
 */
const BUSY_ROW_REASON =
  "앞서 누른 것이 아직 끝나지 않았습니다. 그것이 끝나면 이어서 회전하거나 폐기할 수 있습니다.";

// --- 만들기의 세 사유 (#1559 회전 1 · design-review #1595 H2) ------------------
//
// 목록의 두 문장을 재사용하지 않는 이유 둘. (1) 뒷절의 동사가 다르다 — 목록은
// 회전과 폐기를, 이 폼은 만들기를 못 한다. (2) 목록의 두 문장은 `rows.length > 0`
// 에서만 서므로, 웹훅이 하나도 없는 프레임에서 가리키면 화면에 없는 id 가 된다.
// 그 프레임이 정확히 빈 상태이고, 빈 상태의 주 CTA 가 이 버튼이다.

/**
 * 발급은 큐에 쌓이지 않는다 — 이 클라이언트에 오프라인 큐(`networkMode` ·
 * `onlineManager`)는 존재하지 않고, 위 `submit` 은 `create.mutate()` 앞에서 하드
 * 리턴한다. 그러므로 「다시 연결되면 그대로 보내집니다」라고 약속하지 않는다:
 * 다시 연결된 뒤 이 사람이 한 번 더 눌러야 하고, 문장은 그 사실을 말한다
 * (`InviteSection.OFFLINE_CREATE_REASON` 이 같은 판정을 적는다).
 */
const OFFLINE_CREATE_REASON =
  "연결이 끊겨 지금은 웹훅을 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다.";

/**
 * 받을 채널이 없다는 사실은 위 `SelectField` 의 유일한 선택지가 이미 말하지만,
 * 그것은 고르는 목록의 빈 자리일 뿐 **버튼이 왜 회색인지**는 아니다. 그래서
 * 뒷문장이 다음 행동을 든다 — 사유는 막다른 길이 아니라 다음 한 걸음이다.
 */
const NO_CHANNEL_CREATE_REASON =
  "받을 수 있는 채널이 없어 아직 만들 수 없습니다. 채널을 하나 만든 뒤 여기로 돌아오세요.";

/** 낱말이 「누른 것」인 이유는 위 `BUSY_ROW_REASON` 과 같다. */
const BUSY_CREATE_REASON =
  "앞서 누른 것이 아직 끝나지 않았습니다. 그것이 끝나면 이어서 만들 수 있습니다.";

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
  rotating,
  revoking,
  offline,
  offlineReasonId,
  busyReasonId,
  takeFocus,
  onFocusTaken,
  onRotate,
  onRevoke,
}: {
  installation: WebhookInstallation;
  workspaceId: string;
  serverBaseUrl: string;
  channelName: string;
  /** 이 섹션의 어떤 쓰기든 날고 있다 — 목록 전체의 사실. */
  busy: boolean;
  /** 날고 있는 회전이 **이 줄의 것**인가. 진행 낱말은 이 줄만 든다. */
  rotating: boolean;
  /** 날고 있는 폐기가 **이 줄의 것**인가. */
  revoking: boolean;
  offline: boolean;
  /** 목록 아래에 한 번 쓰인 두 사유. 이 줄의 컨트롤은 가리키기만 한다. */
  offlineReasonId: string;
  busyReasonId: string;
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

  /** 취소와 Esc 는 같은 것을 한다: 묻기 전으로 돌아가고 포커스를 트리거에 돌려준다. */
  function cancelAsking() {
    returnTo.current = asking;
    setAsking(null);
  }

  // 확인 프롬프트가 열려 있는 동안 Esc 는 이 층의 것이다 (R2 신규 H). 층을
  // 잡지 않으면 설정 셸이 그 Esc 로 라우트를 닫는다 — 확인 프롬프트에서 Esc 의
  // 표준 의미는 취소이고, 하물며 그 확인이 지키던 것이 되돌릴 수 없는 폐기다.
  useEscapeLayer(asking !== null, cancelAsking);

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

  // 낱말은 한 곳에서 지어진다. 낭독되는 이름이 그 낱말을 따라 움직여야 하므로
  // (label-in-name, WCAG 2.5.3) 글자와 이름이 같은 값을 읽는다 — 형제 표면의
  // `toggleText` 와 같은 모양이다. 「회전」·「폐기」는 한자어 동작명사라 「명사 +
  // 중」이다 (#1501 정본).
  const rotateText = rotating ? "회전 중" : "비밀값 회전";
  const revokeText = revoking ? "폐기 중" : "폐기";

  // 잠금은 오프라인과 **남의 쓰기**뿐이다. 자기 쓰기가 날고 있는 컨트롤은 잠긴
  // 것이 아니라 진행 중이고, 그 사실은 낱말과 `aria-busy` 가 말한다 (#1486 회전 ·
  // #1541 · #1559).
  //
  // 줄이 아니라 **컨트롤**마다 재는 이유: 회전이 날고 있는 동안 같은 줄의 폐기는
  // 진행 중이 아니라 잠긴 것이다. 줄 단위로 재면 그 폐기가 열린 채 남아, 날고
  // 있는 회전 밑에서 같은 웹훅을 폐기하는 길이 그대로 열린다.
  const rotateLocked = offline || (busy && !rotating);
  const revokeLocked = offline || (busy && !revoking);
  // 확인 그룹의 확정은 자기 진행을 가질 수 없다: 쓰기를 내기 전에
  // `setAsking(null)` 이 이 그룹을 걷어낸다. 여기 `busy` 는 언제나 남의 쓰기다.
  const confirmLocked = offline || busy;

  /**
   * 한 잠금에 한 문장. 오프라인이 이기는 이유는 형제 표면과 같다: 오프라인이면
   * 앞선 쓰기도 어차피 도착하지 못한다. 자기 진행 중에는 사유를 들지 않는다 —
   * 진행 중에 「왜 못 하는지」를 읽어 주면 지금 그것을 하지 못한다는 뜻이 된다.
   */
  function lockReason(mine: boolean): string | undefined {
    if (offline) return offlineReasonId;
    return busy && !mine ? busyReasonId : undefined;
  }

  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0 focus-visible:focus-ring"
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
              {/* 이 확정은 자기 진행을 가질 수 없다: 쓰기를 내기 전에
                  `setAsking(null)` 이 이 그룹을 걷어낸다. 그래서 여기 `busy` 는
                  언제나 **남의 쓰기**이고, 잠그는 사실은 오프라인과 그것뿐이다.
                  취소는 잠기지 않는다: 되돌릴 수 없는 쪽만 남기고 나가는 길을
                  막으면 그것은 확인이 아니라 덫이다. */}
              <Button
                type="button"
                size="sm"
                variant={asking === "revoke" ? "destructive" : "outline"}
                aria-disabled={confirmLocked || undefined}
                aria-describedby={lockReason(false)}
                className={cn(confirmLocked && "opacity-50")}
                onClick={() => {
                  if (confirmLocked) return;
                  const kind = asking;
                  setAsking(null);
                  if (kind === "revoke") onRevoke();
                  else onRotate();
                }}
                // `-commit` 은 이름이 아니라 **옵트인**이다 (리뷰 R2 M5):
                // tokens.css 는 폰(<600px)에서 `-approve|-reject|-commit|-cancel`
                // 로 끝나는 testid 에 44px 최소 높이를 준다. 처음에는 `-confirm`
                // 이라고 지어 확정만 그 규칙 밖에 있었고, 그래서 한 확인 그룹
                // 안에서 되돌릴 수 없는 쪽이 28px, 취소가 44px 로 갈렸다.
                data-testid={`webhook-${asking}-${installation.id}-commit`}
              >
                {asking === "revoke" ? "폐기" : "회전"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                ref={cancelRef}
                onClick={cancelAsking}
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
            {/* 이 줄의 두 트리거는 #1541 이 지나갈 때 파일군 밖이었다 (#1559).
                native `disabled` 였던 동안 이 목록에서 회전 하나가 나가면 스무 줄이
                통째로 회색이 되고 tab order 에서 사라졌으며, 진행 중인 그 줄조차
                자기가 무엇을 하고 있는지 말하지 못했다 — 낱말도 `aria-busy` 도
                없었으므로. 이제 잠금은 오프라인과 남의 쓰기뿐이고, 자기 쓰기는
                낱말로 말한다.

                이름은 **줄을 지고 낱말을 따라 움직인다** (#1559 회전 1). 처음에는
                `aria-label` 을 아예 달지 않았다 — 이름을 고정하면 글자가 「회전
                중」이 된 뒤에도 이름이 「비밀값 회전」으로 남아 label-in-name(WCAG
                2.5.3)을 깨기 때문이고, 줄은 행 제목이 이미 진다고 보았다. 그
                제목은 그러나 이 버튼에 **연결되어 있지 않다**: 같은 줄의
                `CopyButton` 이 `subject` 로 푸는 문제가 여기서만 안 풀린 채,
                스무 줄이 「비밀값 회전」이라는 같은 이름의 탭 스톱 스무 개가 된다.
                2.5.3 이 요구하는 것은 보이는 글자를 **포함**하는 것뿐이므로,
                `${label} ${낱말}` 은 둘을 함께 만족한다 — 형제 `toggleText` 와 같이
                낱말이 한 곳에서 지어져 글자와 이름이 같은 값을 읽는다.

                폭도 상태를 따라 움직이지 않는다: 「비밀값 회전」 -> 「회전 중」은
                파괴적 형제(폐기)를 포인터 아래에서 밀어낸다. `--spacing-action-sm`
                이 tokens.css §4 에 있는 이유가 그 실패이고(MOMO-676 M-3), 96px 는
                이 짝의 가장 긴 낱말을 담는다. */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={rotateLocked || undefined}
              aria-busy={rotating || undefined}
              aria-describedby={lockReason(rotating)}
              aria-label={`${installation.label} ${rotateText}`}
              className={cn("min-w-action-sm", rotateLocked && "opacity-50")}
              onClick={() => {
                if (rotateLocked || rotating) return;
                setAsking("rotate");
              }}
              data-testid={`webhook-rotate-${installation.id}`}
            >
              {rotateText}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-disabled={revokeLocked || undefined}
              aria-busy={revoking || undefined}
              aria-describedby={lockReason(revoking)}
              aria-label={`${installation.label} ${revokeText}`}
              className={cn("min-w-action-sm", revokeLocked && "opacity-50")}
              onClick={() => {
                if (revokeLocked || revoking) return;
                setAsking("revoke");
              }}
              data-testid={`webhook-revoke-${installation.id}`}
            >
              {revokeText}
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
      className="flex min-w-0 flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:focus-ring"
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
      className={SETTINGS_COLLAPSIBLE_CARD_CLASS}
      data-testid="webhook-ingress-notes"
    >
      <summary className={SETTINGS_COLLAPSIBLE_SUMMARY_CLASS}>
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
