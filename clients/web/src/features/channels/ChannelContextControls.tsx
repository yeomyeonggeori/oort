import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, MoreHorizontal, UserMinus, Users } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { normalizeChannelTopic } from "@momo/core/features/channels/model";
import {
  channelHeadCount,
  memberPanelGroupOf,
  memberPanelHeadingKey,
  memberPanelSections,
  memberPanelSnapshot,
  type MemberPanelGroup,
} from "@momo/core/features/channels/memberPanel";
import { canRemoveFromChannel } from "@momo/core/features/channels/memberRemove";
import type { ChannelAgentNow } from "@momo/core/features/agents/channelAgentNow";
import type { ElapsedParts } from "@momo/core/features/agents/runPhase";
import { mayActOnLiveness } from "@momo/core/features/agents/liveness";
import {
  statusDotTooltip,
  withOwnConnection,
} from "@momo/core/features/presence/statusDot";
import { useSession } from "@/app/session";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { AvatarStatus } from "@/features/presence/AvatarStatus";
import { AvatarWithPresence } from "@/features/presence/HumanPresence";
import { useHumanPresenceDot } from "@/features/presence/useHumanPresenceDot";
import { CustomStatusMark } from "@/features/sidebar/CustomStatusMark";
import { useCustomStatusView } from "@/features/sidebar/useCustomStatusView";
import { useDmStatusDot } from "@/features/sidebar/useDmStatusDot";
import { useChannelMemberNow, type ChannelMemberNow } from "./useChannelMemberNow";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  useRestoreFocusOnClose,
} from "@/design/ui/dialog";
import { Tooltip } from "@/design/ui/tooltip";
import { ConfirmStage } from "@/design/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { useInlineConfirm } from "@/design/ui/inlineConfirm";
import { Avatar } from "@/features/timeline/MessageRow";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import { cn } from "@/design/lib/cn";
import { BlockedReason } from "@/features/common/BlockedReason";
import { useRemoveChannelMember } from "./useRemoveChannelMember";

export type ChannelMemberListStatus = "loading" | "ready" | "failed";

// =============================================================================
// 채널 토픽 다이얼로그와 멤버 패널 (#1680 · #1865).
//
// 토픽은 헤더에 상시 서지 않는다. ⋮ 메뉴의 「주제 보기」가 이 다이얼로그를 연다.
// 서버 라우트 표에는 토픽을 갱신하는 경로가 없으므로 이 표면은 읽기만 한다. 빈
// 토픽에 「추가」를 그리면 반드시 막다른 길이 되기 때문에 메뉴 항목도 다이얼로그도
// 내놓지 않는다.
//
// 멤버 행은 이번 goal에서 동작하지 않는다. 프로필 카드 연결은 U-1 랜딩 뒤의 일이고,
// 미리 버튼처럼 그리면 죽은 컨트롤이 된다. 그래서 목록은 ul/li로 읽히고, 키보드는
// 실제 행동인 「멤버 추가」·「닫기」·실패 시 「다시 시도」만 순회한다. Dialog가
// 포커스 스코프, Esc, 바깥 닫기와 트리거 복귀를 맡는다.
//
// 두 다이얼로그 모두 DialogTrigger 없이 프로그래매틱하게 연다. 이 앱의 커스텀
// DialogContent는 opener를 받아 닫힐 때 포커스를 그 엘리먼트로 돌려주는데,
// DialogTrigger를 함께 쓰면 Radix 기본 onCloseAutoFocus가 그 위에 겹쳐 복귀가
// 어긋난다 — 정본 다이얼로그는 전부 프로그래매틱이다(dialog.tsx 머리말·
// MessageActions.tsx:312). DialogContent는 항상 렌더해 Radix가 열림/닫힘·포탈
// 마운트·close 시퀀스를 소유하게 둔다. 닫힘 복귀 자체는 useRestoreFocusOnClose가
// 같은 커밋에서 처리한다. Radix onCloseAutoFocus는 한 틱 늦다 (#1865 H-3).
// =============================================================================

export function ChannelTopicDialog({
  topic,
  open,
  onOpenChange,
  opener,
}: {
  topic: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: RefObject<HTMLElement | null>;
}) {
  const normalized = normalizeChannelTopic(topic);
  useRestoreFocusOnClose(open && normalized !== "", opener);
  if (normalized === "") return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener.current}
        className="gap-4 p-4"
        data-testid="channel-topic-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreDialogOpenerFocus(opener.current);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>채널 토픽</DialogTitle>
          <DialogDescription
            className="whitespace-pre-wrap break-words text-ink"
            data-testid="channel-topic-full"
          >
            {normalized}
          </DialogDescription>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="channel-topic-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// 멤버 줄의 「지금」 (#5686, ADR-0220 P4 ① 한 줄 상태 층).
//
//   [얼굴●] grok  @grok
//           작업 중 · 설계 문서 읽는 중 [에이전트 보고] · 4분째 · +1
//   [얼굴●] 김도현  @dohyun
//           📅 회의 중
//
// 사람: 아바타 모서리 점(접속·자리 비움·방해 금지·접속 없음, 「사람」 화면과 같은 `AvatarWithPresence`)과 본인이
// 쓴 상태 글(`useCustomStatusView`: 기한이 지나면 안 보임). 자리 비움·방해 금지만 낱말로도 선다. 보고 있는 채널·
// 입력 중 같은 자동 활동은 싣지 않는다(owner 2026-11-12).
// 에이전트: 생존 점(DM 줄과 같은 `useDmStatusDot`)과, 이 채널에 안 끝난 run이 있으면 코어 `channelAgentNow`의 한
// 줄. 없으면 생존 낱말.
//
// **줄 높이는 상태와 무관하게 같다.** 두 줄 모두 높이가 자기 글자 역할의 줄 높이 하나로 고정이고(`h-lh`), 둘째 줄은
// 비어 있어도 선다. 글은 한 줄을 넘지 않는다(`truncate`). 그래서 run이 끝나고, 단계가 바뀌고, 상태 글이 생기거나 지워져도 아래 줄이 밀리지
// 않는다(`channelMemberPanel.browser.test.ts`가 잰다). 묶음은 열려 있는 동안 얼어 있다(`memberPanelSections`).
//
// 줄의 글은 보조기술에서 숨고, 같은 사실을 한 문장(`sr-only`)이 이어 말한다: 점·표지·숫자 조각이 낱낱이 읽히지 않게.
// 줄은 이번에도 눌리지 않는다(프로필 연결은 이 칸 밖이다).
// =============================================================================

const ROW_CLASS = "flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0";
/**
 * 둘째 줄. **높이가 줄 높이 하나로 고정**이다(`h-lh` = 이 줄 글자 역할의 줄 높이): 비어 있어도, 글꼴이 다른 글자(이모지·
 * 한글 대체 글꼴)가 와도, 작은 표지가 섞여도 같은 높이다. 넘친 글은 잘린다(`truncate`·`overflow-hidden`).
 * 높이를 글에 맡기면 WebKit은 대체 글꼴의 위아래 여백만큼 줄을 키운다(실측 17.1 → 17.95px, 브라우저 시험).
 */
const NOW_LINE_CLASS = "flex h-lh min-w-0 items-center gap-1 overflow-hidden text-meta text-ink-muted";
/** 첫 줄(이름·핸들). 같은 이유로 본문 줄 높이 하나로 고정이다. */
const IDENTITY_LINE_CLASS = "flex h-lh min-w-0 items-baseline gap-2 overflow-hidden text-body";

type Format = ReturnType<typeof useFormatMessage>;

function elapsedText(parts: ElapsedParts, formatMessage: Format): string {
  switch (parts.unit) {
    case "minute":
      return formatMessage("timeline.memberPanel.elapsedMinutes", { count: parts.count });
    case "hour":
      return formatMessage("timeline.memberPanel.elapsedHours", { count: parts.count });
    case "day":
      return formatMessage("timeline.memberPanel.elapsedDays", { count: parts.count });
  }
}

/** 에이전트 줄의 보조기술 문장 조각(보이는 조각과 같은 사실, 같은 차례). */
function agentNowSpoken(line: ChannelAgentNow, formatMessage: Format): string[] {
  const parts = [line.word];
  if (line.stage !== undefined) {
    parts.push(formatMessage("timeline.memberPanel.stageSpoken", { stage: line.stage }));
  } else if (line.request !== undefined) {
    parts.push(formatMessage("timeline.memberPanel.requestSpoken", { text: line.request }));
  }
  if (line.elapsed !== undefined) parts.push(elapsedText(line.elapsed, formatMessage));
  if (line.extra > 0) {
    parts.push(formatMessage("timeline.memberPanel.moreRunsSpoken", { count: line.extra }));
  }
  return parts;
}

function AgentNowLine({
  line,
  stale,
  formatMessage,
}: {
  line: ChannelAgentNow;
  /** 마지막으로 받은 때의 사실이다(끊김·다시 읽기 실패): 낱말을 확인된 것처럼 칠하지 않는다(레일의 끊긴 줄과 같은 이유). */
  stale: boolean;
  formatMessage: Format;
}) {
  return (
    <span
      className={NOW_LINE_CLASS}
      data-testid="channel-member-now"
      data-now="run"
      data-phase={line.phase}
      data-stale={stale ? "" : undefined}
    >
      <span className={cn("shrink-0", stale ? undefined : line.needsHuman ? "text-warn" : "text-ink")}>
        {line.word}
      </span>
      {line.stage !== undefined ? (
        <>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate" data-testid="channel-member-stage">
            {line.stage}
          </span>
          {/* 단계는 에이전트가 스스로 알린 글이다(ADR-0200 증보 7 ①): 표지가 곁에 서고 좁은 칸에서도 줄지 않는다. */}
          <span
            className="shrink-0 rounded-sm border border-line px-1 text-timestamp"
            data-testid="channel-member-agent-report"
          >
            {formatMessage("timeline.workRecord.sourceAgent")}
          </span>
        </>
      ) : line.request !== undefined ? (
        <>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate" data-testid="channel-member-request">
            {formatMessage("timeline.memberPanel.request", { text: line.request })}
          </span>
        </>
      ) : null}
      {line.elapsed !== undefined && (
        <>
          <span className="shrink-0">·</span>
          <span className="shrink-0" data-numeric data-testid="channel-member-elapsed">
            {elapsedText(line.elapsed, formatMessage)}
          </span>
        </>
      )}
      {line.extra > 0 && (
        <span className="shrink-0" data-numeric data-testid="channel-member-more">
          {formatMessage("timeline.memberPanel.moreRuns", { count: line.extra })}
        </span>
      )}
    </span>
  );
}

function RowIdentity({ member }: { member: RosterMember }) {
  return (
    <span className={IDENTITY_LINE_CLASS}>
      <span
        className={cn(
          "min-w-0 truncate font-semibold",
          member.kind === "agent" ? "text-agent" : "text-ink"
        )}
      >
        {member.displayName}
      </span>
      {/* 이름이 먼저다: 핸들은 남는 자리만 받고(`flex-1` = 기준 폭 0), 글 칸이 20rem보다 좁으면(폰 폭) 통째로 접는다 —
          「@…」 같은 조각을 세우지 않는다. 핸들은 낭독 문장에 그대로 있다. */}
      <span className="min-w-0 flex-1 truncate text-meta text-ink-muted @max-xs:hidden">@{member.handle}</span>
    </span>
  );
}

/** 줄의 「채널에서 내보내기」를 부르는 손. 줄 끝 ⋯ 이 자기 자신을 넘겨 확인 단계가 닫힌 뒤 초점이 돌아올 곳이 된다. */
/** 영수증 문장을 이름 앞·이름·이름 뒤로 가른 것. 문장은 사전이 지고(`timeline.memberPanel.removed`), 이름 자리만 표지로 두고 쪼갠다. */
interface RemovedReceipt {
  before: string;
  name: string;
  after: string;
}

const RECEIPT_NAME_MARK = "\u0000";

function removedReceipt(formatMessage: Format, name: string): RemovedReceipt {
  const [before = "", after = ""] = formatMessage("timeline.memberPanel.removed", { name: RECEIPT_NAME_MARK }).split(
    RECEIPT_NAME_MARK
  );
  return { before, name, after };
}

type RemoveRequest = (member: RosterMember, opener: HTMLElement | null) => void;

/**
 * 줄 끝 ⋯ 메뉴(#5778). 권한이 있을 때만 선다(`canRemoveFromChannel` — 서버 사다리의 거울): 권한이 없는 사람에게는 단추도
 * 메뉴 줄도 없다. 단추는 줄 높이를 바꾸지 않는 크기다(`size-control-sm` 28 < 두 줄 글의 높이; 600px 미만에서는 `tap-target` 44 로 자라되 위·아래 -8px 여백으로 줄에 내는 키는 28 그대로다 — 안 그러면 ⋯ 이 있는 줄만 60 이 되어 줄 높이가 사람마다 갈린다(#5686). 눌리는 상자 44 는 줄 56 안에 든다, #5818 검수 M6). 행동은 지금 하나뿐이지만
 * 줄 메뉴(#5777)와 같은 문법으로 둔다 — 아이콘 + 낱말, 위험색.
 */
function MemberRowMenu({
  member,
  onRemove,
  formatMessage,
}: {
  member: RosterMember;
  onRemove: RemoveRequest;
  formatMessage: Format;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 「채널에서 내보내기」를 고르면 확인 단계가 서고 그 단계가 초점을 「취소」로 옮긴다. 메뉴가 아직 떠 있는 동안 단계를 세우면
  // 메뉴의 초점 가두기가 그 초점을 되돌리고, 닫히며 ⋯(단계 아래에 가려진 `invisible` 자리)로 돌려 초점이 몸 밖으로 떨어진다.
  // 그래서 메뉴가 **다 닫힌 뒤에** 단계를 세우고, 그때는 ⋯ 로 되돌리지 않는다(패널의 「멤버 추가」가 패널을 먼저 닫는 것과 같은 이유).
  const opensStage = useRef(false);
  const label = formatMessage("timeline.memberPanel.rowActions", { name: member.displayName });
  return (
    <DropdownMenu>
      <Tooltip label={label} side="bottom" align="end">
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            className="tap-target -my-2 size-control-sm shrink-0 text-ink-muted"
            aria-label={label}
            data-testid="channel-member-row-menu"
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (!opensStage.current) return;
          opensStage.current = false;
          event.preventDefault();
          onRemove(member, triggerRef.current);
        }}
      >
        <DropdownMenuItem
          tone="danger"
          onSelect={() => {
            opensStage.current = true;
          }}
          data-testid="channel-member-remove"
        >
          <UserMinus aria-hidden="true" className="size-4 shrink-0" />
          {formatMessage("timeline.memberPanel.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HumanMemberRow({
  member,
  group,
  onRemove,
  formatMessage,
}: {
  member: RosterMember;
  group: MemberPanelGroup;
  /** 있으면 줄 끝 ⋯ 이 선다(보는 사람이 이 사람을 내보낼 수 있을 때만). */
  onRemove?: RemoveRequest;
  formatMessage: Format;
}) {
  const dot = useHumanPresenceDot(member);
  const { visible: custom, accessible } = useCustomStatusView(member);
  // 자리 비움·방해 금지는 사람이 스스로 정한 상태라 낱말로도 선다. 접속 중·접속 없음은 묶음 머리가 이미 말한다.
  const declared = dot !== null && (dot.tone === "warn" || dot.tone === "danger") ? dot : null;
  const spoken = [member.displayName, `@${member.handle}`, dot?.label, accessible].filter(
    (part): part is string => part !== undefined && part !== null && part !== ""
  );
  return (
    <li
      className={ROW_CLASS}
      data-testid="channel-member-item"
      data-member-id={member.id}
      data-member-kind={member.kind}
      data-member-group={group}
    >
      <AvatarWithPresence member={member}>
        <Avatar member={member} />
      </AvatarWithPresence>
      <span className="@container flex min-w-0 flex-1 flex-col" aria-hidden="true">
        <RowIdentity member={member} />
        <span className={NOW_LINE_CLASS} data-testid="channel-member-now" data-now={custom ? "status" : declared ? "presence" : "none"}>
          {custom ? (
            <CustomStatusMark status={custom} className="min-w-0" />
          ) : declared ? (
            <span className={cn("min-w-0 truncate", declared.tone === "danger" ? "text-danger" : "text-warn")}>
              {declared.label}
            </span>
          ) : null}
        </span>
      </span>
      <span className="sr-only">{spoken.join(", ")}</span>
      {onRemove ? <MemberRowMenu member={member} onRemove={onRemove} formatMessage={formatMessage} /> : null}
    </li>
  );
}

function AgentMemberRow({
  member,
  group,
  line,
  stale,
  mayAct,
  nowMs,
  formatMessage,
}: {
  member: RosterMember;
  group: MemberPanelGroup;
  line: ChannelAgentNow | undefined;
  stale: boolean;
  mayAct: boolean;
  nowMs: number;
  formatMessage: Format;
}) {
  // 생존 점은 DM 줄과 같은 훅이다(같은 쿼리 키: 사이드바가 이미 읽은 에이전트는 다시 묻지 않는다).
  const dot = useDmStatusDot(member, mayAct, nowMs);
  const spoken = [
    member.displayName,
    `@${member.handle}`,
    formatMessage("timeline.memberPanel.agentKind"),
    ...(line !== undefined ? agentNowSpoken(line, formatMessage) : dot !== null ? [dot.label] : []),
  ];
  return (
    <li
      className={ROW_CLASS}
      data-testid="channel-member-item"
      data-member-id={member.id}
      data-member-kind={member.kind}
      data-member-group={group}
    >
      <AvatarStatus
        face={32}
        tone={dot?.tone ?? null}
        kind="agent"
        dotTestId="agent-liveness-dot"
        data-testid="avatar-with-liveness"
        data-status-tone={dot?.tone}
        title={dot ? statusDotTooltip(dot) : undefined}
      >
        <Avatar member={member} />
      </AvatarStatus>
      <span className="@container flex min-w-0 flex-1 flex-col" aria-hidden="true">
        <RowIdentity member={member} />
        {line !== undefined ? (
          <AgentNowLine line={line} stale={stale} formatMessage={formatMessage} />
        ) : (
          <span className={NOW_LINE_CLASS} data-testid="channel-member-now" data-now={dot ? "liveness" : "none"}>
            {dot ? <span className="min-w-0 truncate">{dot.label}</span> : null}
          </span>
        )}
      </span>
      <span className="sr-only">{spoken.join(", ")}</span>
    </li>
  );
}

/**
 * 패널 목록(열려 있을 때만 선다: Dialog 안이라 닫히면 사라지고, 그때 「지금」 읽기도 멈춘다).
 *
 * 묶음은 첫 읽기가 끝난 뒤(또는 기다림 상한 뒤) **한 번** 정하고 열려 있는 동안 그대로다. 보는 사람이 없는 순간
 * (창이 가려짐)에는 다시 정한다: 그때 줄이 옮겨 가도 아무도 밀리는 것을 보지 않는다.
 */
function ChannelMemberList({
  members,
  now,
  formatMessage,
  onRemove,
}: {
  members: RosterMember[];
  now: ChannelMemberNow;
  formatMessage: Format;
  onRemove: RemoveRequest;
}) {
  const { session, connStatus, workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const viewerRole = memberFor(directory, session.member.id)?.role;
  const mayAct = mayActOnLiveness(viewerRole);
  const connected = connStatus === "connected";
  // 일하는 에이전트: 받아 둔 「지금」 답(같은 채널을 최근에 열었음)이나 레일 신호가 아는 run. 둘 다 없으면 에이전트는
  // 한 묶음(「에이전트 N」)이다 — 패널은 「지금」 읽기를 기다리지 않는다(수리 1회차, 검수 H1).
  const groupOf = (member: RosterMember): MemberPanelGroup => {
    const id = member.id.toLowerCase();
    return memberPanelGroupOf(
      withOwnConnection(member, session.member.id, connected),
      now.lines.has(id) || now.railWorking.has(id)
    );
  };

  // 묶음은 열 때 **첫 프레임에** 한 번 정한다. 읽기가 돌아와도 열려 있는 동안에는 다시 짜지 않고(줄 안의 글만 채운다),
  // 다음에 열 때나 보는 사람이 없는 순간(창이 가려짐)에 다시 정한다.
  const frozen = useRef<ReadonlyMap<string, MemberPanelGroup> | null>(null);
  const [, regroup] = useState(0);
  if (frozen.current === null) frozen.current = memberPanelSnapshot(members, groupOf);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      frozen.current = null;
      regroup((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const sections = memberPanelSections(members, groupOf, frozen.current);
  const hasWorking = sections.some((section) => section.group === "working");
  return (
    <>
      {sections.map((section) => (
        <section
          key={section.group}
          className="flex flex-col"
          data-testid="channel-member-section"
          data-group={section.group}
        >
          <h2 className="border-b border-line px-4 py-1 text-meta font-medium text-ink-muted">
            {formatMessage(memberPanelHeadingKey(section.group, hasWorking), {
              count: section.members.length,
            })}
          </h2>
          <ul className="flex flex-col">
            {section.members.map((member) =>
              member.kind === "agent" ? (
                <AgentMemberRow
                  key={member.id}
                  member={member}
                  group={section.group}
                  line={now.lines.get(member.id.toLowerCase())}
                  stale={now.stale}
                  mayAct={mayAct}
                  nowMs={now.nowMs}
                  formatMessage={formatMessage}
                />
              ) : (
                <HumanMemberRow
                  key={member.id}
                  member={member}
                  group={section.group}
                  onRemove={canRemoveFromChannel(viewerRole, session.member.id, member) ? onRemove : undefined}
                  formatMessage={formatMessage}
                />
              )
            )}
          </ul>
        </section>
      ))}
    </>
  );
}

/**
 * 목록과 발치. Dialog 안이라 **열려 있을 때만** 선다: 닫히면 「지금」 읽기·시계·생존 읽기가 모두 멈춘다.
 * 「지금」 읽기가 실패하면(네트워크·5xx) 발치 왼쪽에 한 줄로 말한다: 목록 위에 띠를 세우면 줄이 밀린다.
 */
function ChannelMemberPanelBody({
  channelId,
  members,
  showLoading,
  showEmpty,
  offline,
  onAddMember,
  onClose,
  onRemove,
  receipt,
  listRef,
}: {
  channelId: string;
  members: RosterMember[];
  showLoading: boolean;
  showEmpty: boolean;
  offline: boolean;
  onAddMember: () => void;
  onClose: () => void;
  onRemove: RemoveRequest;
  /** 방금 내보낸 사람의 한 줄 영수증(`useInlineConfirm`, 1.6초). 없으면 null. 이름만 말줄임하고 서술어는 늘 보인다. */
  receipt: RemovedReceipt | null;
  listRef: RefObject<HTMLDivElement>;
}) {
  const formatMessage = useFormatMessage();
  const showList = members.length > 0;
  // 에이전트 멤버가 없으면(사람만·빈 채널) 「지금」을 읽지 않는다. 읽어도 줄은 기다리지 않는다(명부의 줄이 첫 프레임부터).
  const hasAgent = members.some((member) => member.kind === "agent");
  const now = useChannelMemberNow(channelId, hasAgent, { offline });
  return (
    <>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto focus-visible:focus-ring"
        data-testid="channel-member-list"
        // 목록은 길어질 수 있고 줄은 눌리지 않는다: 키보드로 굴릴 수 있게 목록 자체가 초점을 받는다. 다만 열 때의 첫
        // 초점은 이 PR 전처럼 목록 밖의 첫 행동이다(`firstActionFocus`, 검수 M3).
        {...(showList
          ? { tabIndex: 0, role: "region", "aria-label": formatMessage("timeline.memberPanel.listLabel") }
          : {})}
      >
        {showLoading ? (
          <Skeleton ready={false} rows={4} className="p-4" />
        ) : showEmpty ? (
          <EmptyInvite
            headline="이 채널에 멤버가 없습니다."
            detail="워크스페이스 멤버를 이 채널에 추가할 수 있습니다."
            actions={
              <Button size="sm" onClick={onAddMember}>
                멤버 추가
              </Button>
            }
            testId="channel-member-empty"
          />
        ) : showList ? (
          <ChannelMemberList members={members} now={now} formatMessage={formatMessage} onRemove={onRemove} />
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        {/* 내보낸 뒤의 한 줄 영수증(#5778, 토스트 금지). 낭독 영역이 미리 등록되도록 늘 서 있고, 비어 있을 때는 눈에 안 보이고
            자리도 차지하지 않는다(`sr-only`). 서 있는 1.6초 동안은 「지금」 읽기 실패 줄의 자리를 빌린다 — 발치는 한 줄이다. */}
        <p
          role="status"
          className={cn(
            receipt ? "mr-auto flex h-control-sm min-w-0 items-center gap-1 text-meta text-ink-muted" : "sr-only"
          )}
          data-testid="channel-member-removed"
        >
          {receipt ? (
            <>
              <Check aria-hidden="true" className="size-4 shrink-0" />
              {/* 문장 전체가 한 `truncate` 칸이면 긴 이름에서 끝(「내보냈어요」)이 먼저 잘려 행동이 사라진다(#5818 검수 M5). 이름만
                  말줄임하고 앞뒤 낱말은 줄지 않는다. 세 조각이 붙어 있어 낭독(`role=status`)은 전체 문장 한 번이다. */}
              <span className="flex min-w-0 items-baseline">
                {receipt.before !== "" ? <span className="shrink-0 whitespace-pre">{receipt.before}</span> : null}
                <span className="min-w-0 truncate" data-testid="channel-member-removed-name">{receipt.name}</span>
                {receipt.after !== "" ? <span className="shrink-0 whitespace-pre">{receipt.after}</span> : null}
              </span>
            </>
          ) : null}
        </p>
        {hasAgent && now.read === "failed" && receipt === null && (
          <p
            className="mr-auto flex h-control-sm min-w-0 items-center gap-2 text-meta text-ink-muted"
            data-testid="channel-member-now-failed"
            title={formatMessage("timeline.memberPanel.nowFailed")}
          >
            {/* 발치는 한 줄로 고정이다(실패가 떠도 줄이 두 줄이 되어 패널이 커지지 않게, #5701). 보이는 글은 폭에 따라 세
                단계다(#5711): 512px 이상 긴 글, 375~511px 대상을 말하는 중간 글, 375px 미만 짧은 글(이 폭에서는 대상 없이
                실패만 말한다). 모두 말줄임 없이 들어가는 폭에서만 고른다. 각 글은 `truncate`가 보임 클래스와 같은 요소에 있어
                큰 글자에서도 줄바꿈이 없다. 낭독은 폭과 무관하게 전체 문장 한 번이다: 보이는 글은 `aria-hidden`, 전체 문장은
                `sr-only` 한 곳(`title`에도 같은 문장). */}
            <span className="sr-only" data-testid="channel-member-now-failed-sr">{formatMessage("timeline.memberPanel.nowFailed")}</span>
            <span aria-hidden="true" className="min-w-0 truncate member-now-failed-short" data-testid="channel-member-now-failed-reason">{formatMessage("timeline.memberPanel.nowFailedShort")}</span>
            <span aria-hidden="true" className="min-w-0 truncate member-now-failed-mid" data-testid="channel-member-now-failed-reason">{formatMessage("timeline.memberPanel.nowFailedMid")}</span>
            <span aria-hidden="true" className="min-w-0 truncate member-now-failed-long" data-testid="channel-member-now-failed-reason">{formatMessage("timeline.memberPanel.nowFailed")}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-w-full shrink-0"
              onClick={now.retry}
              data-testid="channel-member-now-retry"
            >
              <span className="min-w-0 truncate">{formatMessage("timeline.memberPanel.nowRetry")}</span>
            </Button>
          </p>
        )}
        {!showEmpty && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAddMember}
            data-testid="channel-member-add"
          >
            멤버 추가
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onClose}
          data-testid="channel-member-close"
        >
          닫기
        </Button>
      </div>
    </>
  );
}

/**
 * 열 때의 첫 초점: 이 PR 전과 같은 자리 — 목록 밖의 첫 행동(실패 띠의 「다시 시도」, 빈 목록의 「멤버 추가」, 발치의
 * 「멤버 추가」, 「닫기」 차례). 목록 칸은 초점을 받을 수 있지만(키보드로 굴리기) 첫 초점은 아니다: WebKit은 기본 설정에서
 * Tab이 단추를 건너뛰어, 목록이 첫 초점이면 「멤버 추가」에 키보드로 닿는 길이 없다(검수 M3).
 */
function firstActionFocus(event: Event) {
  const content = event.currentTarget;
  if (!(content instanceof HTMLElement)) return;
  const first = [
    ...content.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])"),
  ].find(
    (element) =>
      // 「지금」 읽기 실패 줄의 「다시 불러오기」는 첫 초점이 아니다: 다시 읽기가 실패한 채 다시 열어도 첫 초점은 「멤버 추가」(#5701).
      element.closest('[data-testid="channel-member-now-failed"]') === null &&
      (element.closest('[data-testid="channel-member-list"]') === null || element.closest('[data-testid="channel-member-empty"]') !== null)
  );
  if (first === undefined) return;
  event.preventDefault();
  first.focus();
}

function memberListLabel(status: ChannelMemberListStatus, count: number): string {
  if (status === "loading") return "채널 멤버 목록 불러오는 중";
  if (status === "failed") return "채널 멤버 목록을 불러오지 못했습니다";
  return `채널 멤버 ${count}명`;
}

/** 확인 단계가 지금 서 있는가·도는가·내리는 길. 패널(`DialogContent`)의 Esc·바깥 누름이 읽는다. */
interface RemoveStageControl {
  up: boolean;
  pending: boolean;
  cancel: () => void;
}

/**
 * 목록·발치와 「채널에서 내보내기」 확인 단계(#5778). Dialog 안이라 **열려 있을 때만** 선다: 내보내기 상태(세션·명부 캐시를
 * 쓰는 훅)는 닫힌 머리 단추에 붙지 않고, 닫히면 단계도 함께 사라진다(다음에 열 때 목록부터).
 *
 * 확인은 두 번째 대화상자가 아니라 **표면 안의 단계**다(`ConfirmStage`, 디자인 시스템 §3.4 — 표면 위에 표면을 세우면 뒤
 * 스크림이 앞 표면 아래에 깔린다). 단계는 목록·발치를 **덮어** 선다(#5780 프로필 창과 같은 틀): 둘이 한 격자 칸에 겹치고, 목록은
 * 단계가 서 있는 동안 자리만 지킨다(`invisible` — 보이지도, 초점이 닿지도, 읽히지도 않는다). 그래서 창 높이가 뛰지 않는다.
 */
function ChannelMemberPanelFrame({
  channelId,
  channelName,
  members,
  showLoading,
  showEmpty,
  offline,
  onAddMember,
  onClose,
  stageControl,
}: {
  channelId: string;
  channelName: string;
  members: RosterMember[];
  showLoading: boolean;
  showEmpty: boolean;
  offline: boolean;
  onAddMember: () => void;
  onClose: () => void;
  stageControl: { current: RemoveStageControl };
}) {
  const formatMessage = useFormatMessage();
  const [removing, setRemoving] = useState<{ member: RosterMember; opener: HTMLElement | null } | null>(null);
  const removal = useRemoveChannelMember(channelId);
  const receipt = useInlineConfirm();
  const [removedName, setRemovedName] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 단계가 내려간 뒤 초점이 갈 곳: 취소면 단계를 연 ⋯, 성공이면(그 줄은 사라졌다) 목록 칸.
  const focusAfterStage = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (removing !== null || focusAfterStage.current === null) return;
    const target = focusAfterStage.current;
    focusAfterStage.current = null;
    (target.isConnected ? target : listRef.current)?.focus({ preventScroll: true });
  }, [removing]);

  const requestRemove = (member: RosterMember, opener: HTMLElement | null) => {
    removal.clearError();
    setRemoving({ member, opener });
  };
  // 취소·Esc 는 한 가드를 지난다: 요청이 나갔으면 취소는 아무것도 되돌리지 못하니 단계는 그대로 서서 결과를 기다린다.
  const cancelRemove = () => {
    if (removal.pending || removing === null) return;
    focusAfterStage.current = removing.opener;
    setRemoving(null);
    removal.clearError();
  };
  const confirmRemove = () => {
    if (removing === null) return;
    const { member } = removing;
    void removal.remove(member.id).then((ok) => {
      if (!ok) return;
      focusAfterStage.current = listRef.current;
      setRemovedName(member.displayName);
      receipt.confirm();
      setRemoving(null);
    });
  };
  const stageUp = removing !== null;
  stageControl.current = { up: stageUp, pending: removal.pending, cancel: cancelRemove };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1" data-testid="channel-member-frame">
      <div
        className={cn("col-start-1 row-start-1 flex min-h-0 flex-col", stageUp && "invisible")}
        aria-hidden={stageUp || undefined}
      >
        <ChannelMemberPanelBody
          channelId={channelId}
          members={members}
          showLoading={showLoading}
          showEmpty={showEmpty}
          offline={offline}
          onAddMember={onAddMember}
          onClose={onClose}
          onRemove={requestRemove}
          receipt={
            receipt.confirmed && removedName !== null ? removedReceipt(formatMessage, removedName) : null
          }
          listRef={listRef}
        />
      </div>
      {removing !== null ? (
        <ConfirmStage
          testId="channel-member-remove-stage"
          className="col-start-1 row-start-1"
          tone="destructive"
          subject={
            <div className="flex min-w-0 items-center gap-2" data-testid="channel-member-remove-subject">
              <Avatar member={removing.member} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body font-semibold text-ink">{removing.member.displayName}</span>
                <span className="truncate text-meta text-ink-muted">@{removing.member.handle}</span>
              </span>
            </div>
          }
          title={formatMessage("timeline.memberPanel.removeTitle", { name: removing.member.displayName })}
          description={formatMessage("timeline.memberPanel.removeBody", {
            channel: channelName,
            name: removing.member.displayName,
          })}
          confirmLabel={formatMessage("timeline.memberPanel.removeConfirm")}
          busyLabel={formatMessage("timeline.memberPanel.removeBusy")}
          cancelLabel={formatMessage("timeline.memberPanel.removeCancel")}
          busy={removal.pending}
          error={removal.error}
          lockedReason={offline ? <BlockedReason frame="doThis" /> : undefined}
          onCancel={cancelRemove}
          onConfirm={confirmRemove}
        />
      ) : null}
    </div>
  );
}

export function ChannelMemberPanel({
  channelId,
  channelName,
  members,
  status,
  offline,
  onRetry,
  onAddMember,
}: {
  channelId: string;
  channelName: string;
  members: RosterMember[];
  status: ChannelMemberListStatus;
  offline: boolean;
  onRetry: () => void;
  onAddMember: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const addAfterClose = useRef(false);
  const [open, setOpen] = useState(false);
  useRestoreFocusOnClose(open, triggerRef);
  // 머리 수는 활성 멤버만(#5781): 정지된 사람은 패널 맨 아래 「정지됨」 묶음에 따로 선다.
  const headCount = channelHeadCount(members);
  const label = memberListLabel(status, headCount);
  // 안의 확인 단계(#5778)가 매 그림마다 적어 두는 지금. 닫혀 있으면 단계도 없다.
  const stageControl = useRef<RemoveStageControl>({ up: false, pending: false, cancel: () => undefined });

  // 두 Radix focus scope를 같은 커밋에서 교체하면 닫히는 패널의 포커스 복귀가
  // 새 다이얼로그의 auto-focus를 뒤에서 덮을 수 있다. 먼저 이 패널을 완전히
  // 닫고, 그 다음 effect에서 셸 소유 다이얼로그를 연다.
  useEffect(() => {
    if (open || !addAfterClose.current) return;
    addAfterClose.current = false;
    onAddMember();
  }, [open, onAddMember]);

  const openAddMember = () => {
    addAfterClose.current = true;
    setOpen(false);
  };

  const showList = members.length > 0;
  const showLoading = status === "loading" && !showList;
  const showFailure = status === "failed" && !offline;
  const showEmpty = status === "ready" && !showList;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* 머리 단추의 툴팁은 디자인 시스템 `Tooltip`이다(#4591). 네이티브 `title`은 두지 않는다: 같은 말이 두 번 뜬다. */}
      <Tooltip label={label} side="bottom">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          data-testid="channel-member-count"
          data-roster-status={status}
          className={channelHeaderControlClass({ wide: true })}
        >
          <Users className="size-4" aria-hidden="true" />
          {status === "ready" && (
            <span data-numeric aria-label={`멤버 ${headCount}명`}>
              {headCount}
            </span>
          )}
        </button>
      </Tooltip>
      <DialogContent
        opener={triggerRef.current}
        className="gap-0 overflow-hidden"
        data-testid="channel-member-panel"
        data-roster-status={status}
        aria-busy={status === "loading" || undefined}
        onOpenAutoFocus={firstActionFocus}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreDialogOpenerFocus(triggerRef.current);
        }}
        // Esc 는 가장 위 층의 것이다(§3.4): 확인 단계가 서 있으면 단계만 내린다(요청이 도는 동안은 아무 일 없다).
        onEscapeKeyDown={(event) => {
          if (!stageControl.current.up) return;
          event.preventDefault();
          stageControl.current.cancel();
        }}
        onInteractOutside={(event) => {
          if (stageControl.current.pending) event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-1 border-b border-line p-4">
          <DialogTitle>채널 멤버</DialogTitle>
          <DialogDescription>
            {status === "ready"
              ? `${channelName} 채널의 멤버 ${headCount}명입니다.`
              : `${channelName} 채널의 멤버 목록을 확인합니다.`}
          </DialogDescription>
        </div>

        {offline && (
          <InlineBanner
            tone="neutral"
            message={<BlockedReason frame="memberListStale" />}
            testId="channel-member-offline"
          />
        )}
        {showFailure && (
          <InlineBanner
            message="멤버 목록을 불러오지 못했습니다. 다시 시도하세요."
            actionLabel="다시 시도"
            onAction={onRetry}
            testId="channel-member-failed"
          />
        )}

        <ChannelMemberPanelFrame
          channelId={channelId}
          channelName={channelName}
          members={members}
          showLoading={showLoading}
          showEmpty={showEmpty}
          offline={offline}
          onAddMember={openAddMember}
          onClose={() => setOpen(false)}
          stageControl={stageControl}
        />
      </DialogContent>
    </Dialog>
  );
}
