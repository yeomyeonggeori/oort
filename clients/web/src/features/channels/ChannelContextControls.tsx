import { useEffect, useMemo, useRef, useState } from "react";
import { Users } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { normalizeChannelTopic } from "@momo/core/features/channels/model";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Avatar } from "@/features/timeline/MessageRow";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { cn } from "@/design/lib/cn";

export type ChannelMemberListStatus = "loading" | "ready" | "failed";

// =============================================================================
// 채널 헤더의 두 번째 문장과 멤버 패널 (#1680).
//
// 토픽은 채널 목록 응답에 이미 들어 있지만 이 클라이언트 어디에서도 그리지
// 않았다. 서버 라우트 표에는 토픽을 갱신하는 경로가 없으므로 이 표면은 읽기만
// 한다. 빈 토픽에 「추가」를 그리면 반드시 막다른 길이 되기 때문에 아무 컨트롤도
// 내놓지 않는다. 긴 토픽은 헤더에서는 한 줄로 줄이고, 같은 버튼이 여는 다이얼로그
// 안에서 280자 전체를 읽는다.
//
// 멤버 행은 이번 goal에서 동작하지 않는다. 프로필 카드 연결은 U-1 랜딩 뒤의 일이고,
// 미리 버튼처럼 그리면 죽은 컨트롤이 된다. 그래서 목록은 ul/li로 읽히고, 키보드는
// 실제 행동인 「멤버 추가」·「닫기」·실패 시 「다시 시도」만 순회한다. Dialog가
// 포커스 스코프, Esc, 바깥 닫기와 트리거 복귀를 맡는다.
//
// 두 다이얼로그 모두 DialogTrigger 없이 프로그래매틱하게 연다(트리거 button에
// onClick으로 setOpen). 이 앱의 커스텀 DialogContent는 opener를 받아 닫힐 때
// 포커스를 그 엘리먼트로 돌려주는데, DialogTrigger를 함께 쓰면 Radix 기본
// onCloseAutoFocus가 그 위에 겹쳐 복귀가 어긋난다 — 정본 다이얼로그는 전부
// 프로그래매틱이다(dialog.tsx 머리말·MessageActions.tsx:312). DialogContent는
// 항상 렌더해 Radix가 열림/닫힘·포탈 마운트·close 시퀀스를 소유하게 둔다.
// =============================================================================

export function ChannelTopicControl({ topic }: { topic?: string }) {
  const normalized = normalizeChannelTopic(topic ?? "");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  if (normalized === "") return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        title={normalized}
        aria-label={`토픽 전체 보기: ${normalized}`}
        data-testid="channel-topic"
        className={cn(
          "block min-w-0 max-w-full truncate rounded-sm text-left text-meta text-ink-muted",
          "hover:text-ink focus-visible:focus-ring"
        )}
      >
        {normalized}
      </button>
      <DialogContent
        opener={triggerRef.current}
        className="gap-4 p-4"
        data-testid="channel-topic-dialog"
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
            onClick={() => setOpen(false)}
            data-testid="channel-topic-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberSection({
  title,
  members,
}: {
  title: string;
  members: RosterMember[];
}) {
  if (members.length === 0) return null;
  return (
    <section className="flex flex-col" data-testid="channel-member-section">
      <h2 className="border-b border-line px-4 py-1 text-meta font-medium text-ink-muted">
        {title}
      </h2>
      <ul className="flex flex-col">
        {members.map((member) => (
          <li
            key={member.id}
            className="flex items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
            data-testid="channel-member-item"
            data-member-id={member.id}
            data-member-kind={member.kind}
          >
            <Avatar member={member} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                className={cn(
                  "truncate text-body font-semibold",
                  member.kind === "agent" ? "text-agent" : "text-ink"
                )}
              >
                {member.displayName}
              </span>
              <span className="truncate text-meta text-ink-muted">
                @{member.handle}
                {member.kind === "agent" ? " · 에이전트" : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function memberListLabel(status: ChannelMemberListStatus, count: number): string {
  if (status === "loading") return "채널 멤버 목록 불러오는 중";
  if (status === "failed") return "채널 멤버 목록을 불러오지 못했습니다";
  return `채널 멤버 ${count}명`;
}

export function ChannelMemberPanel({
  channelName,
  members,
  status,
  offline,
  onRetry,
  onAddMember,
}: {
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
  const label = memberListLabel(status, members.length);
  const groups = useMemo(
    () => ({
      people: members.filter((member) => member.kind === "human"),
      agents: members.filter((member) => member.kind === "agent"),
    }),
    [members]
  );

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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        data-testid="channel-member-count"
        data-roster-status={status}
        className={cn(
          "flex min-h-control-sm shrink-0 items-center gap-1 rounded-sm px-1 transition-colors",
          "text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        )}
      >
        <Users className="size-4" aria-hidden="true" />
        {status === "ready" && (
          <span data-numeric aria-label={`멤버 ${members.length}명`}>
            {members.length}
          </span>
        )}
      </button>
      <DialogContent
        opener={triggerRef.current}
        className="gap-0 overflow-hidden"
        data-testid="channel-member-panel"
        data-roster-status={status}
        aria-busy={status === "loading" || undefined}
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
            message="연결이 끊겼습니다. 마지막으로 받은 멤버 목록을 표시합니다."
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

        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="channel-member-list">
          {showLoading ? (
            <SkeletonRows rows={4} className="p-4" />
          ) : showEmpty ? (
            <EmptyInvite
              headline="이 채널에 멤버가 없습니다."
              detail="워크스페이스 멤버를 이 채널에 추가할 수 있습니다."
              actions={
                <Button size="sm" onClick={openAddMember}>
                  멤버 추가
                </Button>
              }
              testId="channel-member-empty"
            />
          ) : showList ? (
            <>
              <MemberSection title="사람" members={groups.people} />
              <MemberSection title="에이전트" members={groups.agents} />
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line p-4">
          {!showEmpty && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openAddMember}
              data-testid="channel-member-add"
            >
              멤버 추가
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            data-testid="channel-member-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
