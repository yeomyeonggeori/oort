import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { createWorkspace, fetchWorkspace, type CreatedWorkspace } from "./api";
import {
  errorMessage,
  isOperatorDenied,
  isSlugConflict,
  normalizeSlug,
  slugError,
  workspaceNameError,
} from "./model";
import {
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
} from "./SettingsFields";

// =============================================================================
// 워크스페이스 (R-1 §5 / ADR-0117): read the current tenant, provision a new
// one. Creating a workspace mints a tenant on the shared instance, so the
// server gates it on the instance operator, not on an ordinary owner. The slug
// rule here is copied from WorkspaceRoutes so a rejected slug is caught before
// the round trip; the 409 is still handled inline because the unique index is
// the only race-free answer.
// =============================================================================

export function WorkspaceSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const query = useQuery({
    queryKey: ["settings", "workspace", workspaceId],
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    slug?: string;
    name?: string;
  }>({});
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);

  const create = useMutation({
    mutationFn: () => createWorkspace(normalizeSlug(slug), name.trim()),
    onSuccess: (result) => {
      setCreated(result);
      setSlug("");
      setName("");
      setFieldErrors({});
    },
    onError: (error) => {
      if (isSlugConflict(error)) {
        setFieldErrors({ slug: "이미 쓰이는 슬러그입니다. 다른 값을 고르세요." });
      }
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const errors = {
      slug: slugError(slug) ?? undefined,
      name: workspaceNameError(name) ?? undefined,
    };
    setFieldErrors(errors);
    if (errors.slug || errors.name) return;
    setCreated(null);
    create.mutate();
  }

  const lines = [
    "지금 열려 있는 워크스페이스를 확인하고, 새 워크스페이스를 만듭니다.",
    "새 워크스페이스는 만든 사람이 오너가 되고 #general 채널 하나로 시작합니다.",
  ];

  return (
    <SectionShell title="워크스페이스" lines={lines}>
      {query.isPending && <SkeletonRows rows={3} />}
      {query.isError && (
        <InlineBanner
          message={errorMessage(query.error)}
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="workspace-error"
        />
      )}
      {query.data && (
        <div
          className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
          data-testid="workspace-card"
        >
          <h3 className="text-body font-medium text-ink">{query.data.name}</h3>
          <KeyValueRows
            rows={[
              { key: "슬러그", value: query.data.slug },
              { key: "워크스페이스 ID", value: query.data.id, numeric: true },
            ]}
          />
        </div>
      )}

      <h3 className="text-body font-medium text-ink">새 워크스페이스 만들기</h3>

      {create.isError && isOperatorDenied(create.error) ? (
        <OperatorNotice
          who="새 워크스페이스는 이 서버의 운영자만 만들 수 있습니다."
          contact="워크스페이스가 필요하면 이 서버를 운영하는 사람에게 문의하세요."
        />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={submit}
          data-testid="workspace-create-form"
        >
          <Field
            label="이름"
            htmlFor="workspace-name"
            hint="사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다."
            error={fieldErrors.name}
          >
            <Input
              id="workspace-name"
              name="name"
              value={name}
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={
                fieldErrors.name ? "workspace-name-error" : undefined
              }
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            label="슬러그"
            htmlFor="workspace-slug"
            hint="영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 서버 전체에서 하나뿐이어야 합니다."
            error={fieldErrors.slug}
          >
            <Input
              id="workspace-slug"
              name="slug"
              value={slug}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(fieldErrors.slug)}
              aria-describedby={
                fieldErrors.slug ? "workspace-slug-error" : undefined
              }
              onChange={(e) => setSlug(e.target.value)}
            />
          </Field>

          {create.isError && !isSlugConflict(create.error) && (
            <p className="text-meta text-danger" role="alert">
              {errorMessage(create.error)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={offline || create.isPending}
              data-testid="workspace-create"
            >
              {create.isPending ? "만드는 중" : "워크스페이스 만들기"}
            </Button>
          </div>
        </form>
      )}

      {created && (
        <div
          className="flex flex-col gap-2 rounded-md border border-ok bg-surface-raised p-4"
          role="status"
          data-testid="workspace-created"
        >
          <p className="text-body text-ink">
            {created.name} 워크스페이스를 만들었습니다.
          </p>
          <KeyValueRows
            rows={[
              { key: "슬러그", value: created.slug },
              { key: "워크스페이스 ID", value: created.workspaceId, numeric: true },
            ]}
          />
          <p className="text-meta text-ink-muted">
            왼쪽 워크스페이스 레일에서 새 워크스페이스로 옮길 수 있습니다.
          </p>
        </div>
      )}
    </SectionShell>
  );
}
