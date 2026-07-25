import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { InlineBanner, SkeletonRows } from "@/features/common/States";
import { fetchWorkHostEngine, putWorkHostEngine } from "./api";
import { errorMessage, isOperatorDenied, WORK_ENGINES } from "./model";
import {
  ChoiceRadios,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
} from "./SettingsFields";

// =============================================================================
// 코드 실행 호스트 (R-1 §5): the per-workspace work host engine selection.
// Only an engine LABEL crosses this API (ADR-0004), never a credential or a
// host-local path, which is why the panel is a three-way choice and nothing
// more. `source: "default"` means no row was ever written and the boot default
// (opencode) is in force, so the panel says that instead of implying a save.
// =============================================================================

export function WorkHostSection({ offline }: { offline: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["settings", "work-host-engine"],
    queryFn: fetchWorkHostEngine,
    retry: false,
  });

  const [engine, setEngine] = useState<string | null>(null);

  // Seed the choice from the server once, then let the operator drive it.
  useEffect(() => {
    if (query.data && engine === null) setEngine(query.data.engine);
  }, [query.data, engine]);

  const save = useMutation({
    mutationFn: (next: string) => putWorkHostEngine(next),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["settings", "work-host-engine"] }),
  });

  const lines = [
    "이 워크스페이스의 코드 실행 호스트가 어떤 엔진으로 작업을 돌릴지 정합니다.",
    "여기에는 엔진 이름만 저장됩니다. 키나 호스트 경로는 저장하지 않습니다.",
  ];

  if (query.isPending) {
    return (
      <SectionShell title="코드 실행 호스트" lines={lines}>
        <SkeletonRows rows={3} />
      </SectionShell>
    );
  }

  if (query.isError) {
    return (
      <SectionShell title="코드 실행 호스트" lines={lines}>
        {isOperatorDenied(query.error) ? (
          <OperatorNotice
            who="코드 실행 엔진은 워크스페이스 오너나 관리자만 바꿀 수 있습니다."
            contact="변경이 필요하면 워크스페이스 관리자에게 문의하세요."
          />
        ) : (
          <InlineBanner
            message={errorMessage(query.error)}
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="work-host-error"
          />
        )}
      </SectionShell>
    );
  }

  const current = query.data;
  const selected = engine ?? current.engine;
  const dirty = selected !== current.engine;

  return (
    <SectionShell title="코드 실행 호스트" lines={lines}>
      <div
        className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4"
        data-testid="work-host-card"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-body font-medium text-ink">{current.engine}</h3>
          {current.source === "database" ? (
            <StatusChip tone="ok">이 워크스페이스에 저장됨</StatusChip>
          ) : (
            <StatusChip tone="muted">기본값 사용 중</StatusChip>
          )}
        </div>
        <KeyValueRows
          rows={[
            {
              key: "적용 중인 엔진",
              value:
                current.source === "database"
                  ? "운영자가 고른 값"
                  : "고른 값이 없어 기본값 opencode",
            },
            ...(current.updatedAtMs
              ? [
                  {
                    key: "마지막 저장",
                    value: new Date(current.updatedAtMs).toLocaleString("ko-KR"),
                    numeric: true,
                  },
                ]
              : []),
          ]}
        />
      </div>

      <ChoiceRadios
        name="work-host-engine"
        legend="엔진"
        choices={WORK_ENGINES}
        value={selected}
        onChange={setEngine}
        disabled={save.isPending}
      />

      {save.isError && (
        <p className="text-meta text-danger" role="alert">
          {errorMessage(save.error)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={offline || !dirty || save.isPending}
          onClick={() => save.mutate(selected)}
          data-testid="work-host-save"
        >
          {save.isPending ? "저장 중" : "엔진 저장"}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEngine(current.engine)}
          >
            되돌리기
          </Button>
        )}
      </div>

      <p className="text-meta text-ink-muted">
        실행 하나하나의 승인 경계는 에이전트 카드의 승인 흐름에서 다룹니다. 이
        화면은 어떤 엔진을 쓸지만 정합니다.
      </p>
    </SectionShell>
  );
}
