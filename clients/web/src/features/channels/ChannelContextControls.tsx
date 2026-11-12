import { useEffect, useRef, useState, type RefObject } from "react";
import { Users } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { normalizeChannelTopic } from "@momo/core/features/channels/model";
import {
  memberPanelGroupOf,
  memberPanelHeadingKey,
  memberPanelSections,
  memberPanelSnapshot,
  type MemberPanelGroup,
} from "@momo/core/features/channels/memberPanel";
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
import { AvatarWithPresence, PresenceBadgeDot } from "@/features/presence/HumanPresence";
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
import { Avatar } from "@/features/timeline/MessageRow";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import { cn } from "@/design/lib/cn";
import { BlockedReason } from "@/features/common/BlockedReason";

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

function HumanMemberRow({ member, group }: { member: RosterMember; group: MemberPanelGroup }) {
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
      <span
        className="relative inline-flex shrink-0"
        data-testid="avatar-with-liveness"
        data-status-tone={dot?.tone}
        title={dot ? statusDotTooltip(dot) : undefined}
      >
        <Avatar member={member} />
        <PresenceBadgeDot dot={dot} testId="agent-liveness-dot" />
      </span>
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
}: {
  members: RosterMember[];
  now: ChannelMemberNow;
  formatMessage: Format;
}) {
  const { session, connStatus, workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const mayAct = mayActOnLiveness(memberFor(directory, session.member.id)?.role);
  const connected = connStatus === "connected";
  const groupOf = (member: RosterMember): MemberPanelGroup =>
    memberPanelGroupOf(
      withOwnConnection(member, session.member.id, connected),
      now.lines.has(member.id.toLowerCase())
    );

  const frozen = useRef<ReadonlyMap<string, MemberPanelGroup> | null>(null);
  const [, regroup] = useState(0);
  if (frozen.current === null && now.settled) frozen.current = memberPanelSnapshot(members, groupOf);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      frozen.current = null;
      regroup((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (frozen.current === null) {
    // 첫 읽기를 기다리는 짧은 동안(상한 `SNAPSHOT_WAIT_MS`): 묶음을 정하기 전에 줄을 세우면 곧 다른 묶음으로 뛴다.
    return <Skeleton ready={false} rows={Math.min(Math.max(members.length, 1), 6)} className="p-4" />;
  }
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
                <HumanMemberRow key={member.id} member={member} group={section.group} />
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
}: {
  channelId: string;
  members: RosterMember[];
  showLoading: boolean;
  showEmpty: boolean;
  offline: boolean;
  onAddMember: () => void;
  onClose: () => void;
}) {
  const formatMessage = useFormatMessage();
  const showList = members.length > 0;
  // 연 순간부터 읽는다(명부가 아직 오는 중이어도): 명부가 닿을 때 「지금」도 이미 와 있어 묶음을 바로 정한다.
  const now = useChannelMemberNow(channelId, true, { offline });
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto focus-visible:focus-ring"
        data-testid="channel-member-list"
        // 목록은 길어질 수 있고 줄은 눌리지 않는다: 키보드로 굴릴 수 있게 목록 자체가 초점을 받는다.
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
          <ChannelMemberList members={members} now={now} formatMessage={formatMessage} />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line p-4">
        {showList && now.read === "failed" && (
          <p className="mr-auto flex min-w-0 items-center gap-2 text-meta text-ink-muted" data-testid="channel-member-now-failed">
            <span className="min-w-0">{formatMessage("timeline.memberPanel.nowFailed")}</span>
            <Button type="button" variant="ghost" size="sm" onClick={now.retry} data-testid="channel-member-now-retry">
              {formatMessage("timeline.memberPanel.nowRetry")}
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

function memberListLabel(status: ChannelMemberListStatus, count: number): string {
  if (status === "loading") return "채널 멤버 목록 불러오는 중";
  if (status === "failed") return "채널 멤버 목록을 불러오지 못했습니다";
  return `채널 멤버 ${count}명`;
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
  const label = memberListLabel(status, members.length);

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
            <span data-numeric aria-label={`멤버 ${members.length}명`}>
              {members.length}
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
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreDialogOpenerFocus(triggerRef.current);
        }}
      >
        <div className="flex flex-col gap-1 border-b border-line p-4">
          <DialogTitle>채널 멤버</DialogTitle>
          <DialogDescription>
            {status === "ready"
              ? `${channelName} 채널의 멤버 ${members.length}명입니다.`
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

        <ChannelMemberPanelBody
          channelId={channelId}
          members={members}
          showLoading={showLoading}
          showEmpty={showEmpty}
          offline={offline}
          onAddMember={openAddMember}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
