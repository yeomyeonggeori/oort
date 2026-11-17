import { useExpressions } from "@/features/expressions/context";
import { ComposerExpressionPreview } from "@/features/expressions/ComposerExpressionPreview";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  clearThreadDraft,
  readThreadDraft,
  THREAD_COMPOSER_SEED_EVENT,
  writeThreadDraft,
  type ThreadComposerSeed,
} from "@/features/chat/draftStore";
import { BEFORE_RELAUNCH_EVENT } from "@/features/updates/relaunchFlush";
import { sendThreadReply, type Channel } from "@momo/core/lib/api";
import {
  composerKeyIntent,
  isComposingEvent,
  type ComposerKeyIntent,
} from "@momo/core/features/chat/composerKeys";
import { InlineBanner } from "@/features/common/States";
import { replyFailureMessage } from "@momo/core/features/timeline/actionCopy";
import {
  bundleCarriesOptions,
  planSendBundle,
  type SendBundleMessage,
} from "@momo/core/features/expressions/sendBundle";
import type { Expression } from "@momo/core/features/expressions/types";
import { THREAD_COMPOSER_PLACEHOLDER } from "@momo/core/features/chat/composerCopy";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { mentionRoutingTarget, calledAgents } from "@momo/core/features/routing/mentionTargets";
import { composerAgentNotice } from "@momo/core/features/ai/aiMention";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
import { AttachmentTray } from "@/features/attachments/AttachmentTray";
import {
  acknowledgeNotices,
  addFiles,
  clearSurface,
  dropDraft,
  peekSent,
  retryDraft,
  surfaceKey,
  useAttachmentSurface,
} from "@/features/attachments/draftStore";
import { useComposerDropZone } from "@/features/attachments/useComposerDropZone";
import { ComposerAutocompleteList } from "@/features/chat/ComposerAutocompleteList";
import { useComposerAutocomplete } from "@/features/chat/useComposerAutocomplete";
import { useComposerEmoji } from "@/features/chat/useComposerEmoji";
import { useComposerFormat } from "@/features/chat/useComposerFormat";
import { ComposerFormatTray } from "@/features/chat/ComposerFormatTray";
import {
  COMPOSER_TEXTAREA_CLASS,
  ComposerCard,
  ComposerSend,
  ComposerTools,
} from "@/features/chat/ComposerCard";
import { ComposerLinkPreview } from "@/features/chat/ComposerLinkPreview";
import { useComposerLinkPreview } from "@/features/chat/useComposerLinkPreview";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
import {
  sendBlockCopy,
  sendBlockReason,
} from "@momo/core/features/attachments/model";
import { COMPOSER_MAX_ROWS, useAutoGrow } from "./useAutoGrow";
import { containsSecretKey } from "@momo/core/features/chat/secretKey";
import { SecretKeyBlockNotice } from "@/features/chat/SecretKeyBlockNotice";
import { hasLocalCardHost } from "@/features/chat/localCards";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import { useOffline } from "@/features/common/useOffline";
import { useComposerBlockedLine } from "@/features/common/blockedLines";
import { ScheduleDialog } from "@/features/scheduled/ScheduleDialog";
import { ScheduledBanner } from "@/features/scheduled/ScheduledBanner";
import { useComposerSchedule } from "@/features/scheduled/useComposerSchedule";

// =============================================================================
// Writing a reply, from inside the thread (B11).
//
// The thread panel could read replies before this and not write them, which
// made 답글 a link to a transcript rather than an action. This is the other
// half.
//
// **The same write path as a channel send**, with `rootId` set — server
// `SendMessageRequest.rootId`, which is exactly how the mac client shares a
// work excerpt into a session thread. There is no reply endpoint and inventing
// one client-side would be a second write path into the same ledger.
//
// Deliberately simpler than the channel composer only where the action changes
// how an agent runs: no model/effort selector. Mention autocomplete, attachments
// and emoji are message contents, so both composers use the same surfaces. A
// reply that cannot name a member or carry the file it discusses is not a
// simpler reply; it is an incomplete one (#1688).
//
// ## 첨부는 그 목록에서 빠진다 (ADR-0151 D2 / #1202)
//
// 이 자리에는 "no attachments"가 함께 적혀 있었고, 그 판단은 **뒤집힌다.** 뒤집는
// 근거는 위 문단이 세운 기준 자체다: 여기 놓이는 컨트롤은 "읽기와 답하기 사이에
// 끼는 것"이면 안 된다. 그런데 첨부는 답의 **내용**이지 답의 설정이 아니다 —
// 멘션 자동완성이나 모델 선택기와 달리, 첨부 없이는 하려던 말을 아예 못 하는
// 경우가 있다("이 로그 보세요"의 그 로그). 스레드에서 파일을 붙이려면 채널로
// 나가서 맥락을 잃은 채 다시 써야 했고, 그것이 원래 문단이 막으려던 마찰보다 크다.
//
// 대가도 그만큼 작다. 클립 버튼 하나가 늘고, 트레이는 **첨부가 있을 때만** 선다.
// 아무것도 붙이지 않은 사람에게 이 표면은 이전과 픽셀 단위로 같다.
//
// 서버 계약은 이미 그것을 허용하고 있었다: `rootId`와 `attachmentIds`는 같은
// 전송 요청의 서로 무관한 두 필드이고, 스레드 답글이라고 다르게 취급하는 분기가
// 서버에 없다. 막고 있던 것은 화면뿐이었다(mac 도 같은 자리에서 막혀 있다 —
// `MessageThreadPanel.sendReply` 가 `attachmentIds` 를 안 싣는다).
// =============================================================================

/**
 * 이 키 뜻이 입력창 위 미리 보기(링크 카드 · 미리 본 이모티콘)를 닫는 Esc인가(`composerKeys.ts` 의 `preview-dismiss`). 낱말을 JSX 표현식 밖에 두는
 * 까닭: 직접 문구 장부는 JSX 안의 문자열을 문구로 세므로, 규칙의 이름이 장부에 문구로 오르지 않게 한다.
 */
const closesPreview = (intent: ComposerKeyIntent): boolean => intent === "preview-dismiss";

// =============================================================================
// 이모티콘을 고르면 입력창 위 미리 보기에 서고, 보내기 한 번에 [큰 그림 답글, 글 답글]이 같은 스레드로 간다 (#5487, 검증 7a H2).
//
// 채널 입력창(#5453)과 **같은 것을 같게** 한다: 큰 그림(이모티콘·GIF)은 글에 `:이름:`으로 들어가지 않고 입력창 위에 그림과 작은 ✕ 만 선다.
// 보이는 안내 글은 없다(예전의 「큰 그림으로 보내요 …」 줄은 두 입력창 어디에도 없다). 작은 이모지는 예전처럼 글 속 캐럿 자리에 들어간다.
// 사람이 `:이름:`만 손으로 쳐도 안내 글은 서지 않고, 큰 그림으로 나가는 것은 그대로다(글 본문이 `:이름:` 하나면 서버·타임라인이 큰 그림으로 그린다).
//
// 채널 입력창과 다른 것은 **보내는 길**뿐이다. 이 패널에는 보내는 중·실패 행이 없다(`useTimeline` 의 대기 목록이 없다). 그래서 코어 `planSendBundle`
// 이 정한 순서와 메시지마다 다른 멱등 열쇠를 그대로 쓰되, 둘째는 **첫째가 서버에 확정된 뒤에만** 보낸다(`sendInOrder`):
//   · 첫째가 실패하면 둘째는 나가지 않는다. 미리 보기·글·첨부는 입력창에 남고, 이유는 기존 실패 줄(`thread-composer-error`)에 선다.
//   · 첫째는 되고 둘째만 실패하면 그림은 이미 나갔으므로 미리 보기는 비고, 글·첨부는 남는다(다시 보내면 글만 나간다. 그림이 두 번 나가지 않는다).
// 열쇠는 보내기 시도마다 새로 만든다(아래 `submit` 의 기존 규칙 그대로).
// =============================================================================

export function ThreadComposer({
  workspaceId,
  channelId,
  rootId,
  directory,
  channels,
  onSent,
  followHint,
}: {
  workspaceId: string;
  channelId: string;
  rootId: string;
  directory: Directory;
  /** `#` 자동완성의 후보 (#1930). 채널 컴포저와 같은 스토어, 같은 규율. */
  channels: Channel[];
  /** Refetch the thread; the reply also arrives on the realtime rail. */
  onSent: () => void;
  /** 처음 답하는 사람에게 입력창 곁에 한 줄로 알릴 말(#5017). 세울지는 호스트가 정한다(`followOnReplyHint`). 없으면 줄이 없다. */
  followHint?: string;
}) {
  const { store: expressionStore, cache: expressionCache } = useExpressions();
  // 미리 본 큰 그림은 **이 스레드의 것**이다. 패널은 스레드를 옮겨도 다시 올라오지 않으므로(`key="thread-panel"`) 고른 자리(scope)를 같이 적어 두고,
  // 다른 스레드를 보는 동안에는 없는 것으로 읽는다. 옮긴 뒤 되돌아와도 옛 미리 보기가 다시 서지 않게 아래 효과가 비운다.
  const scope = `${workspaceId}:${channelId}:${rootId}`;
  const [picked, setPicked] = useState<{ scope: string; expression: Expression } | null>(null);
  const pendingExpression = picked !== null && picked.scope === scope ? picked.expression : null;
  useEffect(() => {
    if (picked !== null && picked.scope !== scope) setPicked(null);
  }, [picked, scope]);
  // 고를 때 활성이었으므로, 지금도 같은 상태인 등록이 보관함에 있으면 살아 있는 것이다(숨김·삭제로 바뀌었으면 없다). 최신 객체를 보낸다.
  const livePending =
    pendingExpression === null
      ? null
      : (expressionCache.items.find((entry) => entry.id === pendingExpression.id && entry.status === pendingExpression.status) ?? null);
  const expressionGone = pendingExpression !== null && livePending === null;
  const [draft, setDraft] = useState(() => readThreadDraft(workspaceId, rootId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 키 모양을 보고 전송을 막은 횟수 (#2942 GC-1). 채널 컴포저와 같은 문이다.
  const [secretBlocks, setSecretBlocks] = useState(0);
  const secretBlocked = secretBlocks > 0;
  // 키 차단 줄의 첫 문장은 막은 길이 정한다(보내기는 「보내지 않았어요」, 예약은 「예약하지 않았어요」).
  const [secretVia, setSecretVia] = useState<"send" | "schedule">("send");
  // 이 입력창에는 오프라인 판정이 없었다(채널 입력창만 읽었다). 예약을 달면서 같은 훅을 연결한다: 보내기와 ▾가
  // 같은 판정으로 함께 흐려지고, 채널 입력창과 같은 오프라인 줄이 안내 블록에 선다(예약 UI 명세 0.4·1.9).
  const offline = useOffline();
  // 막았을 때 위 한 줄과 보내기 단추의 설명이 말하는 문장(#5239): 막은 원인에 따라 연결 상태 모델이 고른다(채널 입력창과 같은 훅).
  const blockedLine = useComposerBlockedLine();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  /** ✕·Esc: 미리 본 그림을 치운다. 눌린 버튼이 사라지므로 포커스는 입력창이 받는다. */
  const dismissExpressionPreview = () => {
    setPicked(null);
    ref.current?.focus();
  };
  const justComposedRef = useRef(false);
  const isMobile = useIsMobileShell();
  const viewer = useSession().session.member;
  // 못 부르는(남의 구독·개인 키) 또는 쉬는(Claude 문의 중) 에이전트를 부르는 글이면 한 줄 (AIH-9).
  const agentNotice = useMemo(
    () => composerAgentNotice(calledAgents(mentionRoutingTarget(draft, directory.members)), viewer.id),
    [draft, directory.members, viewer.id]
  );
  const autocomplete = useComposerAutocomplete({
    value: draft,
    members: directory.members,
    viewerHumanId: viewer.id,
    channels,
    inputRef: ref,
    onValueChange: (next) => {
      setDraft(next);
      setSecretBlocks(0);
    },
    // `/` 명령은 넘기지 않는다: 로컬 카드는 채널 타임라인 꼬리에 붙고(brief
    // §3.2) 이 패널에는 그 자리가 없다. 그래서 여기서 `/`는 평문이다.
  });
  const emoji = useComposerEmoji({
    value: draft,
    inputRef: ref,
    onValueChange: autocomplete.replaceValue,
  });
  const format = useComposerFormat({
    value: draft,
    inputRef: ref,
    autocompleteVisible: autocomplete.visible,
    onValueChange: autocomplete.replaceValue,
    enabled: !sending,
    surfaceKey: `${workspaceId}:${channelId}:${rootId}`,
  });

  // 링크를 넣고 멈추면 입력창 위에 카드가 뜬다(#5016, 채널 입력창과 같은 훅·같은 카드). 보내면 같은 채널의
  // 답글로 나가므로 물을 채널은 이 스레드가 선 채널이다. 오프라인에서는 묻지 않고, 풀리면 이어서 묻는다.
  const linkPreview = useComposerLinkPreview({
    workspaceId,
    channelId,
    threadRootId: rootId,
    text: draft,
    paused: offline,
  });
  /** ✕·Esc: 이번 답글은 미리보기 없이 보낸다. 눌린 버튼이 사라지므로 포커스는 입력창이 받는다. */
  const dismissLinkPreview = () => {
    linkPreview.dismiss();
    ref.current?.focus();
  };

  // 트레이는 **이 스레드의 것**이다. 채널 컴포저와 열쇠가 다르므로, 스레드에 붙인
  // 파일이 패널을 닫는 순간 채널 입력창에 나타나는 일이 없다.
  const trayKey = surfaceKey(workspaceId, channelId, rootId);

  // 이 스레드 안의 제안 카드가 「운영자에게 부탁하기」로 멘션을 심는다(#2948).
  // 쓰던 답은 덮지 않는다(채널 컴포저의 `seedComposerText`와 같은 규칙).
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // 앱이 업데이트로 스스로 다시 실행하기 직전, 쓰던 답글을 저장소로 내린다(#3904).
  // 스레드 입력창은 입력마다 저장하지 않으므로 이 한 번이 유일한 보호다.
  useEffect(() => {
    const flush = () => {
      try {
        writeThreadDraft(workspaceId, rootId, draftRef.current, Date.now(), channelId);
      } catch {
        /* 저장소가 막힌 환경에서도 다시 실행은 막지 않는다. */
      }
    };
    window.addEventListener(BEFORE_RELAUNCH_EVENT, flush);
    return () => window.removeEventListener(BEFORE_RELAUNCH_EVENT, flush);
  }, [workspaceId, rootId, channelId]);
  useEffect(() => {
    const onSeed = (event: Event) => {
      const detail = (event as CustomEvent<ThreadComposerSeed>).detail;
      if (!detail || detail.rootId.toLowerCase() !== rootId.toLowerCase()) return;
      detail.result.mounted = true;
      if (draftRef.current.trim() !== "") return;
      detail.result.accepted = true;
      setDraft(detail.text);
      ref.current?.focus();
    };
    window.addEventListener(THREAD_COMPOSER_SEED_EVENT, onSeed);
    return () => window.removeEventListener(THREAD_COMPOSER_SEED_EVENT, onSeed);
  }, [rootId]);
  const tray = useAttachmentSurface(trayKey);
  const attachTarget = useMemo(
    () => ({ workspaceId, channelId }),
    [workspaceId, channelId]
  );
  const onFiles = (files: File[], batch?: { folders?: number }) =>
    addFiles(trayKey, attachTarget, files, batch);
  const drop = useComposerDropZone(onFiles);
  const attachBlock = sendBlockReason(tray.drafts);
  const attachBlockCopy = sendBlockCopy(tray.drafts);

  // 답글도 한 줄로 끝나지 않는다. 메인 컴포저가 1행에서 6행까지 자라는 것과 같은
  // 규칙이다 (R2 M4) — 다른 것은 이 창이 320px 패널 안에 있어서 접히는 줄이 더
  // 빨리 생긴다는 점뿐이다.
  useAutoGrow(ref, draft, { minRows: 1, maxRows: COMPOSER_MAX_ROWS });

  // 파일만 보내는 답글도 답글이다. 채널 컴포저와 같은 규칙을 같은 함수로 판정한다. 그림만 있는 답글도 답글이다(글이 비어도 미리 본 그림이 나간다).
  // 미리 본 그림이 그 사이 숨겨졌거나 지워졌으면(`expressionGone`) 보내지 않는다 - 몰래 그림만 빼고 보내지 않고, 미리 보기가 한 문장으로 말한다.
  const canSend =
    !sending &&
    !offline &&
    attachBlock === null &&
    !expressionGone &&
    (draft.trim().length > 0 || tray.drafts.length > 0 || livePending !== null);

  // ── 예약해서 보내기 (ADR-0208, #4215) ────────────────────────────────────────
  //
  // 채널 입력창과 같은 훅이다. 이 호스트에는 보이는 3초 상태줄 자리가 없어서(액션 행은 도구 단추 묶음과 보내기뿐이고
  // 위의 `p-3` 블록은 조건부로 생기고 지워지는 줄들이다) 확인은 ③ 지속 배너가 맡고, 낭독은 늘 붙어 있는 안 보이는
  // `role="status"` 노드가 읽는다. 예약에 `rootId`가 실린다. 예약은 **서버가 201을 준 뒤에만** 비운다.
  const schedule = useComposerSchedule({
    surface: "thread",
    workspaceId,
    channelId,
    rootId,
    text: draft,
    readText: () => draftRef.current,
    trayKey,
    drafts: tray.drafts,
    offline,
    commandDraft: false,
    personalCall: false,
    quoting: false,
    routingSet: false,
    hostBusy: sending,
    focusInput: () => ref.current?.focus(),
    onScheduled: ({ textUnchanged }) => {
      if (!textUnchanged) return;
      clearThreadDraft(workspaceId, rootId);
      draftRef.current = "";
      setDraft("");
      autocomplete.close();
      format.dismiss();
    },
    onSecretKey: () => {
      setSecretVia("schedule");
      setSecretBlocks((count) => count + 1);
    },
  });
  const showsSchedule = schedule.gate.entry === "shown";
  // 힌트 줄은 입력창에 묶어 읽는다. 키 차단 안내가 서 있으면 그쪽이 먼저다(막힌 이유가 더 급하다).
  const followHintId = followHint === undefined ? undefined : "thread-composer-follow-hint";

  /**
   * 정한 순서대로 한 통씩 보낸다. 둘째는 첫째가 서버에 확정된 **뒤에만** 나간다(`await`). 어느 통이 실패하든 거기서 멈추고 이유를 기존 실패 줄에 둔다.
   * 보내기 옵션(첨부·링크 미리보기 끄기)은 마지막 통(글)이 나른다 - 코어 `bundleCarriesOptions`. 표현만 보내면 그 하나가 마지막이다.
   */
  const sendInOrder = async (messages: readonly SendBundleMessage[], attachmentIds: string[]) => {
    try {
      for (const [index, message] of messages.entries()) {
        const carries = bundleCarriesOptions(messages, index);
        let replyId: string;
        try {
          // A fresh idempotency key per attempt, like the channel send: a retry after a failure is a new send, not a replay of one that may already have
          // landed. 키는 통마다 다르다(`planSendBundle` 이 정한다): 같은 키를 나누면 둘째가 첫째로 접혀 글이 조용히 사라진다.
          const reply = await sendThreadReply(workspaceId, channelId, rootId, message.clientMsgId, message.body, {
            ...(carries ? { attachmentIds } : {}),
            // ✕로 끈 채 보낸다(켠 때만 키가 간다). 값은 이 렌더의 것이고, 실패하면 글이 남아 ✕도 남으므로 다시
            // 보내도 같은 선택이다. 성공하면 글이 비어 저절로 풀린다.
            ...(carries && linkPreview.suppressed ? { suppressUnfurl: true } : {}),
          });
          replyId = reply.id;
        } catch (cause: unknown) {
          setError(replyFailureMessage(cause));
          return;
        }
        expressionStore?.recordSuccess(message.body, replyId);
        if (index < messages.length - 1) {
          // 앞 통(큰 그림)은 나갔다: 미리 보기는 비우고(다시 보내면 글만 나간다), 글·첨부는 뒤 통이 끝날 때까지 입력창에 남긴다.
          setPicked(null);
          onSent();
        }
      }
      clearThreadDraft(workspaceId, rootId);
      setDraft("");
      setPicked(null);
      autocomplete.close();
      format.dismiss();
      clearSurface(trayKey);
      onSent();
      ref.current?.focus();
    } finally {
      setSending(false);
    }
  };

  const submit = () => {
    // 예약 요청이 나는 동안은 보내기도 잠긴다: 같은 글이 답글과 예약으로 둘 다 나가면 안 된다.
    if (!canSend || schedule.busy) return;
    // 키는 답글로도 보내지 않는다. 글은 남겨 두고 이유를 말한다.
    if (containsSecretKey(draft)) {
      setSecretVia("send");
      setSecretBlocks((count) => count + 1);
      return;
    }
    // 트레이는 **성공한 뒤에** 비운다. 채널 컴포저와 다른 점이 여기다: 그쪽은
    // 실패한 전송이 타임라인에 「전송 실패 · 다시 보내기」 행으로 남아 첨부를
    // 계속 들고 있지만, 이 표면에는 그런 행이 없다. 먼저 비우면 실패한 답글의
    // 파일이 사라지고 사람은 같은 파일을 다시 찾아 붙여야 한다.
    const sent = peekSent(trayKey);
    // 표현이 있으면 [큰 그림, 글] 둘, 없으면 글 하나다(예전과 같은 요청). `canSend` 가 사라진 표현·빈 답글을 이미 막았으므로 거절은 방어선이다.
    const plan = planSendBundle({
      expression: livePending,
      text: draft.trim(),
      hasAttachments: sent.attachmentIds.length > 0,
      newId: () => crypto.randomUUID(),
    });
    if (!plan.ok) return;
    setSending(true);
    setError(null);
    void sendInOrder(plan.messages, sent.attachmentIds);
  };

  return (
    <div
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      data-dragging={drop.dragging ? "" : undefined}
      className={cn(
        // 채널 입력창과 같은 독이다(`composer-dock`): 폰 폭(<600)은 위 경계선 한 줄이 셸의 마지막 줄이고, 넓은 창에서는 선 없이 카드가 뜬다.
        // 위 경계선이 항상 있던 예전 판이 카드 테두리와 겹쳐 「보더가 둘」로 보였다(#5324). 패널의 좌우 여백은 아래 `p-3` 이 쥔다 — 독의
        // `> form` 인셋(24)과 후보 목록의 `left-6` 규칙은 자식이 `<form>` 일 때만 닿으므로 이 `div` 에는 닿지 않고, 목록은 자기 `left-0` 을 쓴다.
        "composer-dock safe-area-bottom",
        drop.dragging && "bg-accent-soft"
      )}
      data-composer-shell=""
      data-testid="thread-composer"
    >
      {/* 보내기 전 링크 미리보기(#5016): 입력 그릇 위, 그릇 밖의 한 줄이다. 줄은 그릇 밖이라
          ✕가 답글을 보내지 않고, 그릇을 눌러 캐럿을 돌려주는 규칙에 카드 링크가 섞이지 않는다. 채널 입력창과 한
          화면에 서므로 시험 열쇠는 `thread-composer-` 를 앞에 단다. 첨부 줄(#5200)은 이 줄이 아니라 그릇 **안**이다. */}
      <ComposerLinkPreview
        cards={linkPreview.cards}
        suppressed={linkPreview.suppressed}
        onDismiss={dismissLinkPreview}
        testId="thread-composer-link-preview"
      />
      {/* 미리 본 이모티콘(#5487): 채널 입력창과 같은 자리·같은 부품이다(링크 카드 바로 아래, 입력 그릇 위의 한 줄). 그림과 작은 ✕ 뿐이고 보이는 글이 없다.
          채널 입력창과 한 화면에 서므로 시험 열쇠는 `thread-composer-` 를 앞에 단다. */}
      {pendingExpression !== null && (
        <ComposerExpressionPreview
          expression={livePending ?? pendingExpression}
          gone={expressionGone}
          onCancel={dismissExpressionPreview}
          testId="thread-composer-expression-preview"
        />
      )}
      <div className="p-3">
        {/* 이 스레드의 예약 배너(UI 명세 1.6 (b), 1.1): 이 호스트의 확인은 ③ 지속 배너가 맡는다. 「이 스레드에 예약된
            메시지 1개」가 생기거나 숫자가 오르는 것이 확인이고, 보내지 못한 예약이 있으면 실패 어조 한 줄이 대신 선다. */}
        <ScheduledBanner
          place={schedule.place}
          word={schedule.bannerWord}
          className="mb-2"
          testId="thread-composer-scheduled-banner"
        />
        {/* 늘 붙어 있는 안 보이는 낭독 노드(`PaletteStatus` 모양, 높이 0): 확인과 막힌 이유를 읽는다. 조건부로 처음
            생기는 `role="status"`는 낭독이 보장되지 않아서 노드를 늘 둔다. */}
        <div role="status" className="sr-only" data-testid="thread-composer-status">
          {schedule.statusText}
        </div>
        {offline && (
          <p
            role="status"
            className="px-3 pb-2 text-meta text-warn break-keep"
            data-testid="thread-composer-offline"
          >
            {blockedLine}
          </p>
        )}
        {error && (
          <InlineBanner
            message={error}
            separator={false}
            testId="thread-composer-error"
          />
        )}
        {secretBlocked && (
          <SecretKeyBlockNotice
            key={secretBlocks}
            id="thread-composer-secret-block"
            testId="thread-composer-secret-block"
            cardAvailable={hasLocalCardHost(channelId)}
            surface="thread"
            {...(secretVia === "schedule" ? { lead: SCHEDULED_COPY.secretKey.lead } : {})}
          />
        )}
        {agentNotice !== null && (
          <p role="status" className="px-3 pb-2 text-meta text-warn" data-testid="thread-composer-agent-notice">
            {agentNotice}
          </p>
        )}
        <div className="relative">
          <ComposerAutocompleteList
            id={`thread-${autocomplete.slug}-list`}
            kind={autocomplete.kind}
            candidates={autocomplete.candidates}
            highlight={autocomplete.highlight}
            onChoose={autocomplete.choose}
            testId={`thread-${autocomplete.slug}-list`}
            optionTestId={`thread-${autocomplete.slug}-option`}
            status={autocomplete.status}
            offline={autocomplete.offline}
            onRetry={autocomplete.retryCatalog}
            className="left-0"
          />
          <ComposerCard
            testIdPrefix="thread-composer"
            inputRef={ref}
            warn={secretBlocked}
            sending={sending}
            tools={
              <ComposerTools
                testIdPrefix="thread-composer"
                onPickFiles={onFiles}
                attachDisabled={sending}
                toolsDisabled={sending}
                settledWhenDisabled
                onInsertMention={autocomplete.insertTrigger}
                onOpenEmoji={(opener) => {
                  autocomplete.close();
                  emoji.openPicker(opener);
                }}
                format={{
                  available: format.available,
                  open: format.open,
                  hasText: draft.trim().length > 0,
                  onPress: format.openForSelection,
                }}
              />
            }
            send={
              <ComposerSend
                testIdPrefix="thread-composer"
                type="button"
                onClick={submit}
                disabled={!canSend}
                busy={schedule.busy}
                // 전송 중에는 그릇의 opacity가 상태를 진다. 빈 초안처럼 그릇은 정상인 판에서는 버튼 자신이 채널 컴포저와 같은 50%로 흐려진다.
                settledWhenDisabled={sending}
                label="답글 보내기"
                title={offline ? blockedLine : (attachBlockCopy ?? "답글 보내기")}
                showsSchedule={showsSchedule}
                schedule={schedule.menuProps}
              />
            }
          >
            {/* 첨부 줄(ADR-0151 D2, #5200): 채널 입력창과 같은 컴포넌트가 그릇 **안**, 글 칸 위에 선다. 카드를 뺀 뒤
                초점은 옆 카드나 이 글 칸으로 간다. */}
            <AttachmentTray
              drafts={tray.drafts}
              rejected={tray.rejected}
              folders={tray.folders}
              onRemove={(localId) => dropDraft(trayKey, localId)}
              onRetry={(localId) => retryDraft(trayKey, attachTarget, localId)}
              onClear={() => clearSurface(trayKey)}
              onAcknowledgeNotices={() => acknowledgeNotices(trayKey)}
              returnFocus={() => ref.current?.focus()}
            />
            <textarea
              ref={ref}
              value={draft}
              disabled={sending}
              // 공유 문구는 아직 「답글 쓰기」만 말한다. C-1 코어 파도와 충돌하지
              // 않도록 이 goal은 코어 문장을 건드리지 않고, 실제 @ 동작만 웹과 폰에
              // 맞춘다. 다음 코어 카피 정리에서 광고 절을 한 벌로 올릴 수 있다.
              placeholder={THREAD_COMPOSER_PLACEHOLDER}
              aria-label={THREAD_COMPOSER_PLACEHOLDER}
              aria-describedby={
                secretBlocked ? "thread-composer-secret-block" : followHintId
              }
              aria-autocomplete="list"
              aria-expanded={autocomplete.visible}
              aria-controls={
                autocomplete.visible ? `thread-${autocomplete.slug}-list` : undefined
              }
              aria-activedescendant={
                autocomplete.visible
                  ? `thread-${autocomplete.slug}-list-option-${autocomplete.highlight}`
                  : undefined
              }
              data-testid="thread-composer-input"
              onChange={(event) =>
                autocomplete.onTextChange(
                  event.target.value,
                  event.target.selectionStart ?? 0
                )
              }
              onSelect={(event) => {
                autocomplete.setCaret(
                  (event.target as HTMLTextAreaElement).selectionStart ?? 0
                );
                format.onSelect();
              }}
              onPaste={drop.onPaste}
              onCompositionStart={() => {
                justComposedRef.current = false;
              }}
              onCompositionEnd={() => {
                justComposedRef.current = true;
              }}
              onKeyUp={() => {
                justComposedRef.current = false;
                format.onSelect();
              }}
              onBlur={(event) => {
                justComposedRef.current = false;
                format.onBlur(event);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                if (event.key !== "Enter" && event.key !== "Tab") {
                  justComposedRef.current = false;
                }
                if (format.handleKeyDown(event)) {
                  event.preventDefault();
                  return;
                }
                const intent = composerKeyIntent(
                  {
                    key: event.key,
                    shiftKey: event.shiftKey,
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    altKey: event.altKey,
                    composing: isComposingEvent(event.nativeEvent),
                  },
                  {
                    mentionsOpen: autocomplete.visible,
                    justComposed: justComposedRef.current,
                    enterSends: !isMobile,
                    // 입력창 위에 지울 것이 있다: 링크 카드(저절로 떴다) 또는 미리 본 이모티콘(일부러 골랐다). Esc 는 링크 카드 → 이모티콘 차례로 하나씩 치운다.
                    previewOpen: linkPreview.cards.length > 0 || pendingExpression !== null,
                  }
                );
                if (autocomplete.handleIntent(intent)) {
                  event.preventDefault();
                  return;
                }
                if (closesPreview(intent)) {
                  // 멘션 목록 다음이다(`composerKeys.ts`가 순서와 이유를 적는다). ✕와 같은 선택이다. 링크 카드가 먼저, 없으면 미리 본 이모티콘이다.
                  event.preventDefault();
                  if (linkPreview.cards.length > 0) dismissLinkPreview();
                  else dismissExpressionPreview();
                  return;
                }
                if (intent !== "send") return;
                event.preventDefault();
                submit();
              }}
              // 포커스 표시는 한 컨트롤인 바깥 그릇이 진다(글 칸의 옷은 채널 입력창과 한 벌이다).
              className={COMPOSER_TEXTAREA_CLASS}
            />
          </ComposerCard>
        </div>
        {followHint !== undefined && (
          <p
            id={followHintId}
            className="px-3 pt-2 text-meta text-ink-muted"
            data-testid="thread-composer-follow-hint"
          >
            {followHint}
          </p>
        )}
      </div>
      <ComposerFormatTray
        open={format.open}
        value={draft}
        selectionEpoch={format.selectionEpoch}
        inputRef={ref}
        trayRef={format.trayRef}
        onApply={format.apply}
        onDismiss={format.dismiss}
        testIdPrefix="thread-composer-format"
      />
      <EmojiPickerDialog
        open={emoji.open}
        onOpenChange={emoji.setOpen}
        onPick={emoji.pick}
        opener={emoji.opener}
        anchor={emoji.anchor}
        purpose="insert"
        testId="thread-composer-emoji-picker"
        // 큰 그림(이모티콘·GIF)은 글에 `:이름:`으로 넣지 않고 입력창 위 미리 보기에 올린다. 작은 이모지는 계속 `onPick` 으로 캐럿 자리에 들어간다.
        onPickExpression={(expression) => setPicked({ scope, expression })}
      />
      <ScheduleDialog {...schedule.dialogProps} />
    </div>
  );
}
