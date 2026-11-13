import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowRight, AtSign, Check, Copy, Mail, MessageSquare, SlidersHorizontal, UserRound, X } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import {
  assignableWorkspaceRoles,
  canIssuePasswordReset,
  canSeeMemberManagement,
  dmAvailability,
  profileEmail,
  roleChangeKind,
  roleKeyLabel,
  roleLabel,
  statusLabel,
  workspaceRoleLock,
  type RoleKey,
  type RoleLabels,
} from "@momo/core/features/directory/model";
import type { MessageService } from "@momo/core/i18n";
import { AvatarWithPresence } from "@/features/presence/HumanPresence";
import { useHumanPresenceDot } from "@/features/presence/useHumanPresenceDot";
import { useSession } from "@/app/session";
import { useOffline } from "@/features/common/useOffline";
import { useRoleLabels } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { Button } from "@/design/ui/button";
import { ConfirmStage } from "@/design/ui/confirm-dialog";
import { useInlineConfirm } from "@/design/ui/inlineConfirm";
import { ListboxSelect } from "@/design/ui/listbox-select";
import { Tooltip } from "@/design/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { BlockedReason } from "@/features/common/BlockedReason";
import { LoadFailureBox } from "@/features/common/LoadFailureBox";
import { loadCauseOf } from "@/features/common/loadFailure";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { useOpenAgentProfile } from "@/features/routing/useAgentProfile";
import { ProfileAvatar } from "@/features/settings/shell/ProfileAvatar";
import { CustomStatusMark } from "@/features/sidebar/CustomStatusMark";
import { useCustomStatusView } from "@/features/sidebar/useCustomStatusView";
import {
  memberFor,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { useMessages } from "@/i18n/useMessages";
import { PasswordResetStage } from "@/features/recovery/PasswordResetStage";
import {
  PasswordResetPhase,
  useIssuePasswordReset,
  type IssuePasswordResetHandle,
} from "@/features/recovery/useIssuePasswordReset";
import {
  useChangeWorkspaceRole,
  type ChangeWorkspaceRoleHandle,
} from "./useChangeWorkspaceRole";
import { useOpenDm } from "./useOpenDm";
import {
  OpenMemberProfileContext,
  type OpenMemberProfile,
} from "./memberProfileContext";
import { memberProfileViewState } from "./memberProfileModel";

// Reading this as: member profile dialog (a person card opened from the directory, a channel, a thread or a
// mention) for internal team users on web+Tauri, density 6/10, motion 2/10.

// =============================================================================
// 멤버 프로필 창 (#5780, owner 2026-11-13 QA 12·13 「UI가 너무 올드한데」).
//
// 폰 프로필 시트(`clients/mobile/src/features/directory/MemberProfileSheet.tsx`, `phone-sheets.md` §5)와 같은 차례다:
//
//   큰 얼굴(점) · 이름 [정지됨·초대됨 칩] · 「@핸들 · 역할」 · 접속 낱말·한 줄 상태
//   → 행동(메시지 보내기 · 멘션 복사 · 에이전트면 라우팅 설정)
//   → 정보(이메일 + 복사 · 에이전트면 책임자)
//   → 관리(역할 · 비밀번호 재설정 링크 — 소유자·관리자에게만. 정지·내보내기 줄(#5781)이 이 묶음에 더해진다)
//
// 옛 창의 「종류」·「상태」 키-값 줄은 없다: 종류는 얼굴 모양·이름 색·「@핸들 · 에이전트」가 말하고, 상태는 대부분 「활성」이라
// 말할 가치가 없어(`statusLabel`) 활성이 아닐 때만 이름 옆 칩이다. 옛 창의 선 넷(머리 아래·목록 위아래·바닥 위)도 없다 —
// 묶음은 선이 아니라 바탕(`bg-sheet`)으로 갈리고, 줄 사이에만 선이 선다(README §3.3 「경계는 나누는 선이다」).
// 닫기는 글자 단추가 아니라 창 오른쪽 위의 X 다(owner 「닫기」 단추 지적, 폰 시트의 원형 X 와 같은 자리).
//
// ## 역할 바꾸기
//
// 줄 안 고르개(`ListboxSelect variant="inline"`)에서 고르면 **확인 단계**가 이 창의 본문 자리에 선다(`ConfirmStage`). 겹쳐 뜬
// 두 번째 대화상자가 아닌 까닭은 디자인 시스템 §3.4(#4986): 표면 위에 표면을 세우면 뒤 스크림이 앞 표면 아래에 깔린다.
// 비밀번호 재설정 단계(`PasswordResetStage`)와 같은 자리·같은 Esc 규칙이다. 확인 뒤 요청이 성공하면 고르개 옆에 「바뀜」이
// 1.6초 선다(`useInlineConfirm`) — 토스트는 이 앱에 없다(README §4 오류 규칙, 스킬 §8). 소유자로 올릴 때는 되돌릴 수 없다는
// 경고와 위험 단추를 거친다. 고르개의 선택지는 서버 사다리의 거울이다(코어 `assignableWorkspaceRoles`).
//
// 허들 행동은 없다: 허들은 채널 머리(`HuddleHeaderControl`)의 채널마다의 수명이고, 프로필에서 DM을 열며 곧장 허들을 거는
// 길이 아직 없다(#5780 인계).
// =============================================================================

// 오프라인 사유를 말하는 배너 줄의 id. 잠긴 단추들이 이 줄을 `aria-describedby`로 가리킨다(#1559).
const OFFLINE_REASON_ID = "member-profile-offline-reason";

type Format = MessageService["formatMessage"];

interface MemberProfileTarget {
  memberId: string;
  opener: HTMLElement | null;
}

/** 역할 확인 단계. 고른 역할이 서 있으면 단계가 본문 자리를 갖는다. */
interface RoleStage {
  pending: RoleKey | null;
  open: (role: RoleKey) => void;
  /** 취소 단추·Esc. 요청이 도는 동안에는 아무 일 없다(요청이 이미 나갔다, #5780 검수 r1 H1). */
  cancel: () => void;
  /** 요청이 성공한 뒤 단계를 내린다. */
  finish: () => void;
}

function ProfileSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-4 px-6 pb-6 pt-8"
      data-testid="member-profile-loading"
    >
      <p className="sr-only" role="status">
        {label}
      </p>
      <span aria-hidden="true" className="avatar-hero rounded-full bg-surface-hover" />
      <span aria-hidden="true" className="h-4 w-pane-sm rounded-sm bg-surface-hover" />
      <span aria-hidden="true" className="h-4 w-action-sm rounded-sm bg-surface-hover" />
      <span aria-hidden="true" className="h-control w-full rounded-lg bg-surface-hover" />
    </div>
  );
}

/** 이름 옆 칩: 활성이 아닐 때만(정지됨·초대됨·삭제됨). 활성은 말할 가치가 없다(`statusLabel`). */
function MembershipChip({ member }: { member: RosterMember }) {
  const label = statusLabel(member);
  if (label === null) return null;
  return (
    <span
      className="inline-flex shrink-0 rounded-full bg-surface-muted px-2 py-px text-meta text-ink-muted"
      data-testid="member-profile-status-chip"
    >
      {label}
    </span>
  );
}

function ProfileHero({ member, t }: { member: RosterMember; t: Format }) {
  const { workspaceId } = useSession();
  const labels = useRoleLabels(workspaceId);
  const { visible: custom } = useCustomStatusView(member);
  // 선언 상태(자리 비움·방해 금지)가 먼저이고, 선언이 없으면 접속 여부(온라인·오프라인)다. 접속 여부를 모르면
  // (서버가 못 읽은 응답, 구서버) 아무 말도 하지 않는다 - 모름은 오프라인이 아니다(#4692, ADR-0160 D3).
  // 점은 보조기술에서 숨으므로 같은 사실을 낱말로도 둔다.
  const presence = useHumanPresenceDot(member);
  const declared = presence?.label ?? null;
  const isAgent = member.kind === "agent";
  const kindWord = isAgent ? t("directory.profile.kindAgent") : roleLabel(member, labels);
  const face = <ProfileAvatar member={member} size="hero" />;
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 text-center" data-testid="member-profile-hero">
      {isAgent ? (
        face
      ) : (
        // 점은 112 원의 가장자리(45°)에 앉는다: 상자 모서리에서 16px 안이 원의 테두리라 24px 점을 4px 들인다.
        <AvatarWithPresence member={member} dotClassName="bottom-1 right-1 size-6 border-2">
          {face}
        </AvatarWithPresence>
      )}
      <div className="flex min-w-0 max-w-full flex-col items-center gap-1">
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-2">
          <p
            className={cn(
              "min-w-0 break-keep text-display font-semibold [overflow-wrap:anywhere]",
              isAgent ? "text-agent" : "text-ink"
            )}
            data-testid="member-profile-name"
          >
            {member.displayName}
          </p>
          <MembershipChip member={member} />
        </div>
        <p className="min-w-0 max-w-full break-all text-body text-ink-muted" data-testid="member-profile-handle">
          @{member.handle}
          {kindWord ? ` · ${kindWord}` : ""}
        </p>
        {declared || custom ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-meta text-ink-muted">
            {declared ? <span data-testid="member-profile-presence">{declared}</span> : null}
            {custom ? <CustomStatusMark status={custom} wrap className="text-meta text-ink-muted" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 묶음: 선이 아니라 바탕으로 갈린다. 줄 사이에만 선이 선다. */
function Group({
  children,
  testId,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  testId?: string;
  className?: string;
  as?: "div" | "dl";
}) {
  return (
    <Tag
      className={cn("flex min-w-0 flex-col divide-y divide-line rounded-lg bg-sheet", className)}
      data-testid={testId}
    >
      {children}
    </Tag>
  );
}

const ROW_CLASS = "flex min-h-control-lg min-w-0 items-center gap-3 px-4 py-2";

/** 줄 끝의 아이콘 단추(복사). 이름은 `aria-label`, 눈에는 공용 툴팁. */
function IconAction({
  label,
  done,
  onClick,
  testId,
}: {
  label: string;
  done: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Tooltip label={label} side="top" align="end">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        data-testid={testId}
        data-done={done ? "" : undefined}
        className="tap-target press grid size-control shrink-0 place-items-center rounded-full text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
      >
        {done ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}
      </button>
    </Tooltip>
  );
}

function InfoGroup({ member, email, owner, t }: { member: RosterMember; email: string | null; owner: RosterMember | null; t: Format }) {
  const emailCopy = useClipboardCopy(email ?? "");
  const isAgent = member.kind === "agent";
  if (email === null && !isAgent) return null;
  // 묶음 상자 자체가 `dl` 이다(`dl > div > dt + dd`). 감싸는 `display: contents` 는 WebKit 에서 목록 뜻을 잃을 수 있다.
  return (
    <Group as="dl" testId="member-profile-info">
        {email !== null ? (
          <div className={ROW_CLASS}>
            <dt className="flex shrink-0 items-center text-ink-muted">
              <Mail aria-hidden="true" className="size-4" />
              <span className="sr-only">{t("directory.profile.emailLabel")}</span>
            </dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 select-text break-all text-body text-ink" data-testid="member-profile-email">
                {email}
              </span>
              <IconAction
                label={emailCopy.copied ? t("directory.profile.copied") : t("directory.profile.copyEmail")}
                done={emailCopy.copied}
                onClick={() => void emailCopy.copy()}
                testId="member-profile-email-copy"
              />
            </dd>
          </div>
        ) : null}
        {isAgent ? (
          <div className={ROW_CLASS}>
            <dt className="flex shrink-0 items-center text-ink-muted">
              <UserRound aria-hidden="true" className="size-4" />
              <span className="sr-only">{t("directory.profile.ownerLabel")}</span>
            </dt>
            <dd className="min-w-0 flex-1 break-keep text-body text-ink" data-testid="member-profile-owner">
              {owner
                ? t("directory.profile.ownerLine", { name: owner.displayName })
                : t("directory.profile.ownerUnknown")}
            </dd>
          </div>
        ) : null}
    </Group>
  );
}

function RoleRow({
  member,
  assignable,
  labels,
  offline,
  busy,
  receipt,
  roleRowRef,
  lockReason,
  onPick,
  t,
}: {
  member: RosterMember;
  assignable: readonly RoleKey[];
  /** 고르개 대신 글이 설 때 그 까닭(「못 고르는 선택지는 이유와 함께」). 라벨 아래 한 줄. */
  lockReason: string | null;
  labels: RoleLabels;
  offline: boolean;
  busy: boolean;
  receipt: boolean;
  roleRowRef: RefObject<HTMLDivElement>;
  onPick: (role: RoleKey) => void;
  t: Format;
}) {
  const labelId = useId();
  const current = member.role;
  return (
    <div ref={roleRowRef} className={cn(ROW_CLASS, "justify-between")} data-testid="member-profile-role-row">
      <div className="flex min-w-0 flex-col">
        <span id={labelId} className="text-body text-ink">
          {t("directory.role.label")}
        </span>
        {lockReason ? (
          <span className="break-keep text-meta text-ink-muted" data-testid="member-profile-role-locked">
            {lockReason}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* 영수증 자리는 늘 서 있다: 낭독 영역이 미리 등록되고, 글이 와도 고르개가 밀리지 않는다(오른쪽 끝 정렬). */}
        <span
          role="status"
          className="inline-flex shrink-0 items-center gap-1 text-meta text-ink-muted"
          data-testid="member-profile-role-receipt"
        >
          {receipt ? (
            <>
              <Check aria-hidden="true" className="size-4" />
              {t("directory.role.changed")}
            </>
          ) : null}
        </span>
        {assignable.length > 0 ? (
          <ListboxSelect
            variant="inline"
            aria-label={t("directory.role.label")}
            aria-busy={busy || undefined}
            aria-describedby={offline ? OFFLINE_REASON_ID : undefined}
            disabled={offline}
            value={current ?? ""}
            data-testid="member-profile-role"
            onValueChange={(next) => {
              if (next !== current) onPick(next);
            }}
            placeholder={t("directory.role.placeholder")}
            options={assignable.map((role) => ({ value: role, label: roleKeyLabel(role, labels) }))}
          />
        ) : (
          <span
            tabIndex={-1}
            className="rounded-md px-2 text-label font-semibold text-ink focus-visible:focus-ring"
            data-testid="member-profile-role-text"
          >
            {roleLabel(member, labels)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 문장 안의 역할 이름은 워크스페이스가 바꿔 쓴 이름(역할 라벨)을 따른다: 고르개·얼굴 아래 줄과 한 화면에 두 이름이 섞이지
 * 않게(#5780 검수 r1 M1). 이름 뒤에 받침에 따라 바뀌는 조사를 붙이지 않는 문장으로 쓴다(「{admin} 역할은」·「{owner}끼리는」).
 */
function roleNames(labels: RoleLabels) {
  return {
    owner: roleKeyLabel("owner", labels),
    admin: roleKeyLabel("admin", labels),
    member: roleKeyLabel("member", labels),
    guest: roleKeyLabel("guest", labels),
  };
}

function ManageSection({ children, labels, t }: { children: ReactNode; labels: RoleLabels; t: Format }) {
  const headingId = useId();
  const names = roleNames(labels);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2" data-testid="member-profile-manage">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 px-4">
        <h3 id={headingId} className="text-meta font-semibold text-ink-muted">
          {t("directory.manage.heading")}
        </h3>
        <span className="break-keep text-meta text-ink-muted">
          {t("directory.manage.hint", { owner: names.owner, admin: names.admin })}
        </span>
      </div>
      <Group>{children}</Group>
    </section>
  );
}

function RoleConfirm({
  member,
  to,
  labels,
  offline,
  roleChange,
  onCancel,
  onDone,
  t,
}: {
  member: RosterMember;
  to: RoleKey;
  labels: RoleLabels;
  offline: boolean;
  roleChange: ChangeWorkspaceRoleHandle;
  onCancel: () => void;
  onDone: () => void;
  t: Format;
}) {
  const from = member.role;
  const kind = roleChangeKind(from, to);
  const fromLabel = from ? roleKeyLabel(from, labels) : "";
  const toLabel = roleKeyLabel(to, labels);
  const names = roleNames(labels);
  // 관리자가 실제로 할 수 있는 일(서버 `workspace_authorization.rs`: 멤버·게스트의 역할 바꾸기·정지·내보내기·비밀번호 재설정,
  // `bins/momo-server/src/routes/channels.rs`: 채널 만들기·채널에 사람 넣고 빼기)을 줄이지 않고 말한다(#5780 검수 r1 M1).
  const consequence =
    kind === "grantAdmin"
      ? t("directory.role.confirmGrantAdmin", { admin: names.admin, member: names.member, guest: names.guest })
      : kind === "revokeAdmin"
        ? t("directory.role.confirmRevokeAdmin", { member: names.member, guest: names.guest })
        : null;
  return (
    <ConfirmStage
      testId="member-profile-role-stage"
      title={t("directory.role.confirmTitle", { name: member.displayName })}
      description={
        <div className="flex flex-col gap-2">
          <p className="text-body text-ink">
            {/* 눈에는 「관리자 → 멤버」, 귀에는 조사 없이 두 값을 부르는 문장. 역할 이름은 워크스페이스가 바꿀 수 있어 조사를 붙이지 않는다. */}
            <span aria-hidden="true" className="inline-flex flex-wrap items-center gap-2" data-testid="member-profile-role-pair">
              {fromLabel ? <span>{fromLabel}</span> : null}
              {fromLabel ? <ArrowRight className="size-4 text-ink-muted" /> : null}
              <span className="font-semibold">{toLabel}</span>
            </span>
            <span className="sr-only">{t("directory.role.confirmPair", { from: fromLabel, to: toLabel })}</span>
          </p>
          {consequence ? <p className="break-keep text-body text-ink-muted">{consequence}</p> : null}
        </div>
      }
      // 소유자로 올리면 무엇을 넘기는지(나와 같은 권한, 소유자끼리는 서로의 역할을 바꾸거나 내보낼 수 없음)와 되돌릴 수 없음을 말한다.
      warning={
        kind === "promoteOwner"
          ? t("directory.role.confirmOwnerWarning", { name: member.displayName, owner: names.owner })
          : undefined
      }
      tone={kind === "promoteOwner" ? "destructive" : "default"}
      confirmLabel={t("directory.role.confirmAction")}
      busyLabel={t("directory.role.confirmBusy")}
      cancelLabel={t("directory.role.cancel")}
      busy={roleChange.pending}
      error={roleChange.error}
      lockedReason={offline ? <BlockedReason frame="changeIt" /> : undefined}
      onCancel={onCancel}
      onConfirm={() => {
        void roleChange.apply(member, to).then((ok) => {
          if (ok) onDone();
        });
      }}
    />
  );
}

function ReadyProfile({
  member,
  directory,
  close,
  reset,
  roleChange,
  roleStage,
}: {
  member: RosterMember;
  directory: Directory;
  close: () => void;
  reset: IssuePasswordResetHandle;
  roleChange: ChangeWorkspaceRoleHandle;
  roleStage: RoleStage;
}) {
  const { session, workspaceId } = useSession();
  const messages = useMessages();
  const t = messages.formatMessage;
  const labels = useRoleLabels(workspaceId);
  const { pendingMemberId, error, openDm } = useOpenDm();
  const openAgentProfile = useOpenAgentProfile();
  const owner =
    member.kind === "agent"
      ? memberFor(directory, member.ownerHumanId)
      : null;
  const viewer = memberFor(directory, session.member.id);
  const viewerRole = viewer?.role;
  const assignable = assignableWorkspaceRoles(viewerRole, session.member.id, member);
  const lock = workspaceRoleLock(viewerRole, session.member.id, member);
  const canManage = canSeeMemberManagement(viewerRole, session.member.id, member);
  // 「재설정 링크 만들기」(ADR-0215 D6, #4603). 서버 사다리의 거울이고 권위는 서버다.
  const canIssueReset = canIssuePasswordReset(viewerRole, session.member.id, member);
  const email = profileEmail(viewerRole, member);
  const resetOpenRef = useRef<HTMLButtonElement | null>(null);
  const roleRowRef = useRef<HTMLDivElement>(null);
  const receipt = useInlineConfirm();
  const wasStaged = useRef(false);
  const mention = useClipboardCopy(`@${member.handle}`);
  const [mentionFailed, setMentionFailed] = useState(false);
  // 확인 단계를 취소하면 초점이 단계를 연 단추로 돌아온다(단추가 다시 그려진 뒤에).
  useEffect(() => {
    if (reset.cancelTick === 0) return;
    resetOpenRef.current?.focus();
  }, [reset.cancelTick]);
  // 역할 확인 단계가 내려가면(취소·Esc·성공) 초점이 역할 자리로 돌아온다. 소유자로 올린 뒤에는 고르개가 글이 되므로 그 글로.
  useEffect(() => {
    if (roleStage.pending !== null) {
      wasStaged.current = true;
      return;
    }
    if (!wasStaged.current) return;
    wasStaged.current = false;
    roleRowRef.current
      ?.querySelector<HTMLElement>('[data-testid="member-profile-role"], [data-testid="member-profile-role-text"]')
      ?.focus();
  }, [roleStage.pending]);
  const availability = dmAvailability(member, session.member.id);
  const offline = useOffline();
  const opening = pendingMemberId === member.id;

  async function startDm() {
    if (opening || offline || availability.kind !== "ready") return;
    if (await openDm(member)) close();
  }

  const dmUnavailable =
    availability.kind === "self"
      ? t("directory.profile.dmSelf")
      : availability.kind === "inactive"
        ? t("directory.profile.dmInactive", { status: availability.label })
        : null;

  const finishRoleStage = () => {
    roleStage.finish();
    roleChange.clearError();
    receipt.confirm();
  };

  const stageUp = reset.phase !== PasswordResetPhase.Idle || roleStage.pending !== null;
  // 오프라인 사유 줄. 잠긴 단추들이 이 문장을 `aria-describedby` 로 가리키므로 한 번만 선다: 단계가 서 있으면 단계 위의 띠
  // (창 위 모서리를 따라 둥글게 — 창은 넘치는 것을 자르지 않는다), 프로필 본문이면 얼굴 아래·행동 위의 둥근 줄
  // (오른쪽 위 X 자리와 겹치지 않게, 그리고 잠긴 「메시지 보내기」 바로 위에서 까닭을 말하게).
  const offlineBanner = (placement: "band" | "inline") => (
    <InlineBanner
      tone="neutral"
      message={t("directory.profile.offline")}
      messageId={OFFLINE_REASON_ID}
      separator={placement === "band"}
      className={placement === "band" ? "rounded-t-2xl" : "rounded-lg"}
      testId="member-profile-offline"
    />
  );

  return (
    <>
      {offline && stageUp ? offlineBanner("band") : null}
      {reset.phase !== PasswordResetPhase.Idle ? (
        <PasswordResetStage
          member={member}
          reset={reset}
          offline={offline}
          offlineReasonId={offline ? OFFLINE_REASON_ID : undefined}
          close={close}
        />
      ) : roleStage.pending !== null ? (
        <RoleConfirm
          member={member}
          to={roleStage.pending}
          labels={labels}
          offline={offline}
          roleChange={roleChange}
          onCancel={roleStage.cancel}
          onDone={finishRoleStage}
          t={t}
        />
      ) : (
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 pb-6 pt-8" data-testid="member-profile-body">
          <ProfileHero member={member} t={t} />

          {offline ? offlineBanner("inline") : null}

          <div className="flex flex-col items-center gap-2">
            <div className="flex flex-wrap items-center justify-center gap-2" data-testid="member-profile-actions">
              {availability.kind === "ready" && (
                <Button
                  type="button"
                  autoFocus
                  disabled={offline}
                  aria-describedby={offline ? OFFLINE_REASON_ID : undefined}
                  aria-busy={opening || undefined}
                  data-testid="member-profile-dm"
                  onClick={() => void startDm()}
                >
                  <MessageSquare aria-hidden="true" />
                  {opening ? t("directory.profile.messageBusy") : t("directory.profile.message")}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                data-testid="member-profile-copy-mention"
                data-done={mention.copied ? "" : undefined}
                onClick={() =>
                  void mention.copy().then((ok) => {
                    setMentionFailed(!ok);
                  })
                }
              >
                {mention.copied ? <Check aria-hidden="true" /> : <AtSign aria-hidden="true" />}
                {mention.copied ? t("directory.profile.copied") : t("directory.profile.copyMention")}
              </Button>
              {member.kind === "agent" && (
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="member-profile-routing"
                  onClick={(event) => {
                    // WebKit does not focus a clicked button by default. Give the
                    // nested routing dialog an explicit active opener for Esc return.
                    event.currentTarget.focus();
                    openAgentProfile(member.id);
                  }}
                >
                  <SlidersHorizontal aria-hidden="true" />
                  {t("directory.profile.routing")}
                </Button>
              )}
            </div>
            {mentionFailed ? (
              <p role="alert" className="break-keep text-meta text-danger" data-testid="member-profile-copy-error">
                {t("directory.profile.copyFailed")}
              </p>
            ) : null}
            {dmUnavailable && (
              <p className="break-keep text-center text-meta text-ink-muted" data-testid="member-profile-dm-unavailable">
                {dmUnavailable}
              </p>
            )}
          </div>

          {error?.memberId === member.id && (
            <InlineBanner
              message={error.message}
              actionLabel={t("directory.profile.retry")}
              actionBusy={opening}
              onAction={() => void startDm()}
              separator={false}
              testId="member-profile-dm-error"
            />
          )}

          <InfoGroup member={member} email={email} owner={owner} t={t} />

          {canManage && (
            <ManageSection labels={labels} t={t}>
              {(assignable.length > 0 || member.role !== undefined) && (
                <RoleRow
                  member={member}
                  assignable={assignable}
                  labels={labels}
                  offline={offline}
                  busy={roleChange.pending}
                  receipt={receipt.confirmed}
                  roleRowRef={roleRowRef}
                  lockReason={
                    lock === "ownerPeer"
                      ? t("directory.role.lockedOwnerPeer", { owner: roleKeyLabel("owner", labels) })
                      : lock === "adminCeiling"
                        ? t("directory.role.lockedAdminCeiling", {
                            admin: roleKeyLabel("admin", labels),
                            owner: roleKeyLabel("owner", labels),
                          })
                        : null
                  }
                  onPick={(role) => {
                    roleChange.clearError();
                    roleStage.open(role);
                  }}
                  t={t}
                />
              )}
              {canIssueReset && (
                <div className={cn(ROW_CLASS, "flex-wrap justify-between")} data-testid="member-profile-reset-row">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body text-ink">{t("recovery.issue.factTerm")}</span>
                    <span className="break-keep text-meta text-ink-muted">{t("recovery.issue.entryHint")}</span>
                  </div>
                  <Button
                    ref={resetOpenRef}
                    type="button"
                    variant="ghost"
                    size="sm"
                    // 바탕(`bg-sheet`) 위의 보조 알약은 채움이 묻힌다(1.01): 시트 위 문법(면 + rest 그림자)으로 선다(스킬 §2).
                    className="tap-target shrink-0 bg-surface shadow-sm"
                    disabled={offline}
                    aria-describedby={offline ? OFFLINE_REASON_ID : undefined}
                    data-testid="member-profile-reset-open"
                    onClick={reset.begin}
                  >
                    {t("recovery.issue.entryAction")}
                  </Button>
                </div>
              )}
            </ManageSection>
          )}
        </div>
      )}
    </>
  );
}

function CloseButton({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="absolute right-3 top-3">
      <Tooltip label={label} side="bottom" align="end">
        <button
          type="button"
          aria-label={label}
          onClick={onClose}
          data-testid="member-profile-close"
          className="tap-target press grid size-icon-button place-items-center rounded-full text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </Tooltip>
    </div>
  );
}

function MemberProfilePanel({
  target,
  close,
}: {
  target: MemberProfileTarget;
  close: () => void;
}) {
  const { workspaceId } = useSession();
  const messages = useMessages();
  const t = messages.formatMessage;
  const offline = useOffline();
  const reset = useIssuePasswordReset();
  const roleChange = useChangeWorkspaceRole();
  const [pendingRole, setPendingRole] = useState<RoleKey | null>(null);
  // 역할 단계를 「취소」로 내리는 길(취소 단추·Esc)은 이 가드 하나를 거친다: 요청이 나갔으면 취소는 아무것도 되돌리지 못하니
  // 단계는 그대로 서서 결과를 기다린다(#5780 검수 r1 H1). 바깥 누름은 아래 `onInteractOutside` 가 같은 조건으로 막는다.
  const cancelRoleStage = () => {
    if (roleChange.pending) return;
    setPendingRole(null);
    roleChange.clearError();
  };
  const roleStage: RoleStage = {
    pending: pendingRole,
    open: setPendingRole,
    cancel: cancelRoleStage,
    finish: useCallback(() => setPendingRole(null), []),
  };
  const query = useDirectory(workspaceId);
  const member = memberFor(query.directory, target.memberId);
  const hasNoCachedRoster = query.directory.members.length === 0;
  const viewState = memberProfileViewState({
    hasMember: member !== null,
    pending: query.isPending,
    failed: query.error !== null,
    hasCachedRoster: !hasNoCachedRoster,
    offline,
  });
  const title = member
    ? t("directory.profile.title", { name: member.displayName })
    : t("directory.profile.titleUnknown");
  // X 는 단계(비밀번호 재설정·역할 확인)가 서 있지 않을 때만 선다: 링크가 선 뒤에는 「닫기」만 닫아야 하고(다시 볼 길이
  // 없는 값), 확인 단계에서는 그 단계의 취소가 문이다(Esc 도 단계만 내린다). 단계의 제목 줄이 X 자리와 겹치지도 않는다.
  const showClose = reset.phase === PasswordResetPhase.Idle && pendingRole === null;

  return (
    <DialogContent
      opener={target.opener}
      data-testid="member-profile-dialog"
      className="gap-0"
      // Esc는 가장 위 층의 것이다(§3.4): 확인 단계가 서 있으면 그 단계만 닫고, 요청이 나갔거나
      // 링크가 선 뒤에는 아무것도 닫지 않는다. 링크는 다시 볼 길이 없는 값이라 Esc 한 번과
      // 바깥 누름 한 번에 사라지게 두지 않고 「닫기」만 닫는다.
      onEscapeKeyDown={(event) => {
        if (reset.phase !== PasswordResetPhase.Idle) {
          event.preventDefault();
          reset.cancel();
          return;
        }
        if (pendingRole !== null) {
          event.preventDefault();
          // 단계만 내린다(요청이 도는 동안은 아무 일 없다). 초점은 `ReadyProfile` 이 역할 자리로 돌린다.
          cancelRoleStage();
        }
      }}
      onInteractOutside={(event) => {
        if (
          reset.phase === PasswordResetPhase.Issuing ||
          reset.phase === PasswordResetPhase.Issued ||
          roleChange.pending
        ) {
          event.preventDefault();
        }
      }}
    >
      {member ? (
        <>
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{t("directory.profile.description")}</DialogDescription>
        </>
      ) : (
        <div className="flex flex-col gap-1 p-4">
          {/* 오른쪽 위 X(12 + 34)를 비킨다: 칸 여백 16 + 32 = 48. */}
          <DialogTitle className="pe-8">{title}</DialogTitle>
          <DialogDescription className="sr-only">{t("directory.profile.description")}</DialogDescription>
        </div>
      )}

      {member ? (
        <ReadyProfile
          member={member}
          directory={query.directory}
          close={close}
          reset={reset}
          roleChange={roleChange}
          roleStage={roleStage}
        />
      ) : viewState === "loading" ? (
        <ProfileSkeleton label={t("directory.profile.loading")} />
      ) : viewState === "error" ? (
        <LoadFailureBox
          titleKey={CONNECTION_KEYS.loadMemberProfileTitle}
          cause={loadCauseOf(query.error)}
          onRetry={() => void query.refetch()}
          testId="member-profile-error"
        />
      ) : (
        <>
          {offline && (
            <InlineBanner
              tone="neutral"
              message={t("directory.profile.offlineMissing")}
              testId="member-profile-offline"
            />
          )}
          <EmptyInvite
            headline={t("directory.profile.emptyHeadline")}
            detail={t("directory.profile.emptyDetail")}
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {t("directory.profile.emptyAction")}
              </Button>
            }
            testId="member-profile-empty"
          />
        </>
      )}

      {/* X 는 DOM 끝에 둔다: 열릴 때 첫 초점이 X 가 아니라 주 행동(메시지 보내기)으로 가고, 자리는 오른쪽 위다. */}
      {showClose ? <CloseButton label={t("directory.profile.close")} onClose={close} /> : null}
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
