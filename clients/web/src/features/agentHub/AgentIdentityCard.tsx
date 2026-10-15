import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { renameAgent, type RosterMember } from "@momo/core/lib/api";
import { visibleCustomStatus } from "@momo/core/features/presence/customStatus";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useSession } from "@/app/session";
import { InlineBanner } from "@/features/common/States";
import { MemberAvatar } from "@/features/common/MemberAvatar";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { renameDraftState, renameErrorCopy } from "./identityCardModel";

// 에이전트 › 프로필 탭 맨 위 「프로필 카드」 (#3821). 사진 · 표시 이름 · 소개 · 상태 문구를
// 한 판에 둔다. 이름은 소유자와 admin이 여기서 바꾼다(`PATCH /agents/{agent}`).
// 사진 · 소개 · 상태 문구를 사람이 바꾸는 서버 경로는 아직 없어(#3823) 읽기 전용이고,
// 그 사실을 편집할 수 있는 사람에게만 한 줄로 말한다. 비어 있는 값은 칸을 비우지 않고
// 왜 비었는지 말한다.

function expiryLabel(expiresAtMs: number): string {
  return new Date(expiresAtMs).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AgentIdentityCard({
  agent,
  canEdit,
  offline,
}: {
  agent: RosterMember;
  canEdit: boolean;
  offline: boolean;
}) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  // 편집이 끝나면 입력이 사라지므로 포커스를 열었던 버튼으로 돌려 준다(키보드 길).
  const editButton = useRef<HTMLButtonElement>(null);
  const closeEditor = () => {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  const [draft, setDraft] = useState(agent.displayName);
  const rename = useMutation({
    mutationFn: (name: string) => renameAgent(workspaceId, agent.id, name),
    onSuccess: (member) => {
      client.setQueryData<RosterMember[]>(rosterQueryKey(workspaceId), (rows) =>
        rows?.map((row) =>
          row.id.toLowerCase() === agent.id.toLowerCase()
            ? { ...row, displayName: member.displayName }
            : row
        )
      );
      closeEditor();
    },
  });
  const state = renameDraftState(draft, agent.displayName);
  const status = visibleCustomStatus(agent, Date.now());
  const tagline = agent.tagline?.trim() ?? "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!state.savable || rename.isPending || offline) return;
    rename.mutate(state.name);
  }

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="에이전트 프로필 카드"
      data-testid="agent-identity-card"
    >
      <div className="flex items-start gap-3">
        <MemberAvatar member={agent} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {editing ? (
            <form onSubmit={submit} className="flex flex-col gap-2" noValidate>
              <label className="text-meta text-ink-muted" htmlFor="agent-identity-name">
                표시 이름
              </label>
              <Input
                id="agent-identity-name"
                value={draft}
                maxLength={100}
                autoFocus
                aria-invalid={rename.isError || undefined}
                aria-describedby={rename.isError ? "agent-identity-error" : undefined}
                onChange={(event) => setDraft(event.target.value)}
                data-testid="agent-identity-name-input"
              />
              <p className="text-meta text-ink-muted">
                멘션 이름(@{agent.handle})은 그대로예요.
              </p>
              {offline && (
                <p className="text-meta text-ink-muted">
                  연결이 끊긴 동안에는 저장할 수 없어요.
                </p>
              )}
              {rename.isError && (
                <InlineBanner
                  separator={false}
                  message={renameErrorCopy(rename.error)}
                  messageId="agent-identity-error"
                  testId="agent-identity-error"
                />
              )}
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!state.savable || rename.isPending || offline}
                  aria-busy={rename.isPending || undefined}
                  data-testid="agent-identity-save"
                >
                  {rename.isPending ? "저장 중" : "이름 저장"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={rename.isPending}
                  onClick={() => {
                    rename.reset();
                    setDraft(agent.displayName);
                    closeEditor();
                  }}
                >
                  취소
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <h3
                  className="min-w-0 break-words text-heading font-semibold text-ink"
                  data-testid="agent-identity-name"
                >
                  {agent.displayName}
                </h3>
                <span className="text-meta text-ink-muted">@{agent.handle}</span>
              </div>
              {canEdit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  ref={editButton}
                  className="self-start"
                  disabled={offline}
                  onClick={() => {
                    setDraft(agent.displayName);
                    setEditing(true);
                  }}
                  data-testid="agent-identity-edit"
                >
                  이름 바꾸기
                </Button>
              )}
              {offline && canEdit && (
                <p className="text-meta text-ink-muted">
                  연결이 끊긴 동안에는 바꿀 수 없어요.
                </p>
              )}
            </>
          )}
        </div>
      </div>
      <dl className="flex flex-col gap-2 text-body">
        <div className="grid grid-cols-3 gap-2">
          <dt className="min-w-0 text-ink-muted">소개</dt>
          <dd
            className="col-span-2 min-w-0 whitespace-pre-wrap break-words text-ink"
            data-testid="agent-identity-tagline"
          >
            {tagline !== "" ? tagline : "아직 소개가 없어요."}
          </dd>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <dt className="min-w-0 text-ink-muted">상태 문구</dt>
          <dd
            className="col-span-2 min-w-0 break-words text-ink"
            data-testid="agent-identity-status"
          >
            {status === null ? (
              "설정된 상태 문구가 없어요."
            ) : (
              <>
                {status.emoji !== undefined && (
                  <span aria-hidden="true">{status.emoji} </span>
                )}
                {status.text}
                {agent.statusExpiresAtMs !== undefined && (
                  <span className="block text-meta text-ink-muted">
                    {expiryLabel(agent.statusExpiresAtMs)}까지
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>
      {canEdit && (
        <p className="text-meta text-ink-muted" data-testid="agent-identity-readonly-note">
          사진, 소개, 상태 문구는 아직 에이전트가 직접 바꿔요. 사람이 바꾸는 기능은 준비 중이에요.
        </p>
      )}
    </section>
  );
}
