import { useCallback, useState, type ReactNode } from "react";
import type { RosterMember } from "@momo/core/lib/api";
import {
  dmAvailability,
  roleLabel,
  statusLabel,
} from "@momo/core/features/directory/model";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { useOpenAgentProfile } from "@/features/routing/useAgentProfile";
import { Avatar } from "@/features/timeline/MessageRow";
import {
  memberFor,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { useOpenDm } from "./useOpenDm";
import {
  OpenMemberProfileContext,
  type OpenMemberProfile,
} from "./memberProfileContext";
import { memberProfileViewState } from "./memberProfileModel";

interface MemberProfileTarget {
  memberId: string;
  opener: HTMLElement | null;
}

function ProfileSkeleton() {
  return (
    <div
      className="flex flex-col gap-4 p-4"
      data-testid="member-profile-loading"
    >
      <p className="sr-only" role="status">
        멤버 프로필을 불러오는 중입니다.
      </p>
      <div className="flex items-center gap-3" aria-hidden="true">
        <span className="size-8 rounded-full bg-surface-hover" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-4 w-pane-sm rounded-sm bg-surface-hover" />
          <span className="h-4 w-32 rounded-sm bg-surface-hover" />
        </span>
      </div>
      <div className="flex flex-col gap-2" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <span
            key={row}
            className="h-control rounded-sm bg-surface-hover"
          />
        ))}
      </div>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2">
      <dt className="w-24 shrink-0 text-meta text-ink-muted">{term}</dt>
      <dd className="min-w-0 flex-1 text-body text-ink">{children}</dd>
    </div>
  );
}

function ReadyProfile({
  member,
  directory,
  close,
}: {
  member: RosterMember;
  directory: Directory;
  close: () => void;
}) {
  const { session, connStatus } = useSession();
  const { pendingMemberId, error, openDm } = useOpenDm();
  const openAgentProfile = useOpenAgentProfile();
  const owner =
    member.kind === "agent"
      ? memberFor(directory, member.ownerHumanId)
      : null;
  const role = roleLabel(member);
  const status = statusLabel(member) ?? "활성";
  const availability = dmAvailability(member, session.member.id);
  const offline = connStatus === "disconnected";
  const opening = pendingMemberId === member.id;

  async function startDm() {
    if (opening || offline || availability.kind !== "ready") return;
    if (await openDm(member)) close();
  }

  const dmUnavailable =
    availability.kind === "self"
      ? "내 프로필에서는 다이렉트 메시지를 열 수 없습니다."
      : availability.kind === "inactive"
        ? `${availability.label} 상태에서는 다이렉트 메시지를 열 수 없습니다.`
        : null;

  return (
    <>
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결 끊김, 마지막으로 받은 프로필입니다. 연결이 돌아오면 새 대화를 열 수 있습니다."
          messageId="member-profile-offline-reason"
          testId="member-profile-offline"
        />
      )}
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex items-center gap-3">
          <Avatar member={member} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={
                member.kind === "agent"
                  ? "truncate text-title font-semibold text-agent"
                  : "truncate text-title font-semibold text-ink"
              }
            >
              {member.displayName}
            </span>
            <span className="truncate text-body text-ink-muted">
              @{member.handle}
            </span>
          </span>
        </div>

        <dl className="divide-y divide-line border-y border-line">
          <Fact term="종류">
            {member.kind === "agent" ? "에이전트" : "사람"}
          </Fact>
          <Fact term="상태">{status}</Fact>
          {role && <Fact term="역할">{role}</Fact>}
          {member.kind === "agent" && (
            <Fact term="관리">
              {owner ? `${owner.displayName} 님` : "관리자 정보 없음"}
            </Fact>
          )}
        </dl>

        {error?.memberId === member.id && (
          <InlineBanner
            message={error.message}
            actionLabel="다시 시도"
            actionBusy={opening}
            onAction={() => void startDm()}
            separator={false}
            testId="member-profile-dm-error"
          />
        )}
        {dmUnavailable && (
          <p className="text-meta text-ink-muted" data-testid="member-profile-dm-unavailable">
            {dmUnavailable}
          </p>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="secondary"
          data-testid="member-profile-close"
          onClick={close}
        >
          닫기
        </Button>
        {member.kind === "agent" && (
          <Button
            type="button"
            variant="outline"
            data-testid="member-profile-routing"
            onClick={(event) => {
              // WebKit does not focus a clicked button by default. Give the
              // nested routing dialog an explicit active opener for Esc return.
              event.currentTarget.focus();
              openAgentProfile(member.id);
            }}
          >
            라우팅 설정
          </Button>
        )}
        {availability.kind === "ready" && (
          <Button
            type="button"
            autoFocus
            disabled={offline}
            aria-describedby={
              offline ? "member-profile-offline-reason" : undefined
            }
            aria-busy={opening || undefined}
            data-testid="member-profile-dm"
            onClick={() => void startDm()}
          >
            {opening ? "대화 여는 중" : "다이렉트 메시지"}
          </Button>
        )}
      </div>
    </>
  );
}

function MemberProfilePanel({
  target,
  close,
}: {
  target: MemberProfileTarget;
  close: () => void;
}) {
  const { workspaceId, connStatus } = useSession();
  const query = useDirectory(workspaceId);
  const member = memberFor(query.directory, target.memberId);
  const hasNoCachedRoster = query.directory.members.length === 0;
  const viewState = memberProfileViewState({
    hasMember: member !== null,
    pending: query.isPending,
    failed: query.error !== null,
    hasCachedRoster: !hasNoCachedRoster,
    offline: connStatus === "disconnected",
  });
  const title = member ? `${member.displayName} 프로필` : "멤버 프로필";

  return (
    <DialogContent
      opener={target.opener}
      data-testid="member-profile-dialog"
      className="gap-0"
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="sr-only">
          멤버 정보와 다이렉트 메시지 동작을 확인합니다.
        </DialogDescription>
      </div>

      {member ? (
        <ReadyProfile member={member} directory={query.directory} close={close} />
      ) : viewState === "loading" ? (
        <ProfileSkeleton />
      ) : viewState === "error" ? (
        <InlineBanner
          message="멤버 프로필을 불러오지 못했습니다."
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="member-profile-error"
        />
      ) : (
        <>
          {connStatus === "disconnected" && (
            <InlineBanner
              tone="neutral"
              message="연결 끊김, 이 멤버의 마지막 프로필을 찾지 못했습니다."
              testId="member-profile-offline"
            />
          )}
          <EmptyInvite
            headline="이 멤버를 명부에서 찾을 수 없습니다."
            detail="명부를 다시 불러온 뒤 프로필을 확인하세요."
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                명부 다시 불러오기
              </Button>
            }
            testId="member-profile-empty"
          />
        </>
      )}
    </DialogContent>
  );
}

export function MemberProfileProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<MemberProfileTarget | null>(null);
  const open = useCallback<OpenMemberProfile>(
    (memberId, opener = null) => setTarget({ memberId, opener }),
    []
  );
  const close = useCallback(() => setTarget(null), []);

  return (
    <OpenMemberProfileContext.Provider value={open}>
      {children}
      <Dialog open={target !== null} onOpenChange={(next) => !next && close()}>
        {target && (
          <MemberProfilePanel
            key={target.memberId}
            target={target}
            close={close}
          />
        )}
      </Dialog>
    </OpenMemberProfileContext.Provider>
  );
}
